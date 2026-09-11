/**
 * /api/travel/invoices — TravelInvoice CRUD (PRD_TRAVEL_BILLING DD-5.1)
 *
 * Third in the Quote/Invoice/Supplier trio. Schema at commit fdb793e
 * (2026-05-24 tick #94). Mirrors backend/routes/travel_quotes.js (commit
 * b02c091, tick #96) — same auth + sub-brand + audit conventions.
 *
 * Future slices (not in this commit): multi-stage settlement schedules
 * (PRD §3.2), supplier-payable ledger reconciliation (PRD §3.3 cross-PRD
 * with Supplier Master), TCS Sec 206C (PRD §3.5), per-sub-brand PDF
 * templates (DD-5.7 pending Q22 Yasin brand handover), payment-collection
 * webhook (depends on #896 Stripe/Razorpay activation), reminder cadence
 * (DD-5.5 RESOLVED: hard-coded T-7/T-3/T-1 + all-channels with opt-out).
 *
 * invoiceNum format: TINV-YYYY-NNNN (tenant-scoped serial reset annually).
 * Race-safe via $transaction. The @@unique([tenantId, invoiceNum]) on the
 * schema is the backstop for any race that slips the transaction.
 */

const express = require("express");
const multer = require("multer");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const { syncTravelInvoiceStatusForParticipant } = require("../lib/tripPaymentReconciliation");
// G124 (Master PRD A3 residual) — per-document download audit alongside the
// existing TRAVEL_INVOICE_PDF_DOWNLOADED entity row so the audit-viewer's
// Document Access sub-tab surfaces invoice PDF pulls uniformly. Unit-tested
// at backend/test/lib/documentAccessAudit.test.js.
const { recordDocumentAccess } = require("../lib/documentAccessAudit");
const pdfRenderer = require("../services/pdfRenderer");
// Manual milestone reminder ("Notify" button on the Milestone Tracker) reuses
// the same customer-reach transports as the public advance-link flow: email
// (SendGrid) + WhatsApp Web. Both are best-effort and never throw fatally.
const { sendEmail } = require("../lib/emailSender");
const waWebClient = require("../services/whatsappWebClient");
// Hosted pay-link for the reminder. BYOK — uses the tenant's own Razorpay keys
// (or Stripe); returns { error } fail-soft when no gateway is configured, so the
// reminder still sends without a link rather than erroring.
const { createInvoicePaymentLink } = require("../lib/paymentLink");
const { getFrontendUrlFromRequest } = require("../lib/requestOrigin");
const { invoicePrefixFor, fiscalYearStart } = require("../lib/travelFiscalYear");
const { computeTcs, isOverseasDestination } = require("../lib/tcsCalculation");
// Arc 2 #901 slice 21 — TDS withholding sum from lines (lineType==='tds').
const { computeTdsFromLines } = require("../lib/tdsCalculation");
const { enqueueTransaction } = require("../lib/travelTallyMasters");
// Arc 2 #901 slice 24 — late-payment penalty math (pure compute, no Prisma).
const {
  computeLatePenalty,
  DEFAULT_GRACE_DAYS,
  DEFAULT_ANNUAL_RATE_PERCENT,
  DEFAULT_FLAT_FEE_PERCENT,
} = require("../lib/latePenaltyCalculation");
// PRD_TRAVEL_BILLING G025 (FR-3.2.e) — anchor-relative due-date resolver.
const {
  computeDueDate: computeAnchorDueDate,
  isValidAnchorType,
  VALID_ANCHOR_TYPES,
} = require("../lib/scheduleAnchorResolver");
// Arc 2 #902 slice 7 — GST tax-preview pipeline (CGST/SGST/IGST math +
// state-code resolver + SAC codes + GSTR-1 HSN-summary grouping). The
// invoice tax-preview endpoint mirrors backend/routes/travel_quotes.js
// /quotes/:id/tax-preview (slice 6, commit b9833a0e) — same envelope,
// same library consumers, scoped to TravelInvoiceLine instead of
// TravelQuoteLine.
const {
  computeGstForLines,
  isInterstateSupply,
  gstRateForCategory,
} = require("../lib/gstCalculation");
const { resolveStateCodes } = require("../lib/gstStateCodeResolver");
const {
  sacForLineType,
  descriptionForSac,
  groupLinesBySac,
} = require("../lib/hsnSacMapper");
const listProjection = require("../lib/listProjection");
// PRD §4.4 gap A2 — CA / Tally file-download exporters (pure helpers; the
// route handlers below do the Prisma fetch + GST math then delegate).
// Renamed on import to avoid clashing with the generic-CRM exporters
// (lib/tallyXmlExport.js + lib/caCsvExport.js used by routes/billing.js).
const {
  buildTallyXml: buildTravelTallyXml,
  buildCaCsv: buildTravelCaCsv,
  buildAccountingXlsx: buildTravelAccountingXlsx,
} = require("../lib/travelAccountingExport");
const {
  parseSpreadsheetBuffer: parseInvoiceReconciliationSpreadsheet,
  reconcileRows: reconcileInvoiceRows,
  normalizeHeader: normalizeInvoiceHeader,
  normalizeText: normalizeInvoiceText,
} = require("../lib/travelInvoiceReconciliation");
// Sub-brand → legal-entity / GSTIN resolution (Q21 config blob on Tenant).
const { resolveForSubBrand } = require("../lib/subBrandConfig");

const VALID_INVOICE_STATUSES = ["Draft", "Issued", "Partial", "Paid", "Voided"];
const invoiceReconcileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Arc 2 #901 slice 11 — PRD_TRAVEL_BILLING FR-3.x doc-type taxonomy.
// Travel verticals need to issue more than just a "TaxInvoice": Proforma
// (pre-payment quote-like bill), CreditNote / DebitNote (post-invoice
// adjustments), and TravelVoucher (supplier-passthrough receipt). The
// docType field on TravelInvoice persists which class a given row is;
// NULL is treated as "TaxInvoice" for back-compat with pre-slice-11 rows.
// Separate CreditNote/DebitNote routing (different sequence, different
// PDF template) lands in slice 12; this slice ships the field + filter.
const VALID_INVOICE_DOC_TYPES = [
  "Proforma",
  "TaxInvoice",
  "CreditNote",
  "DebitNote",
  "TravelVoucher",
];

function assertValidDocType(s) {
  if (s == null) return;
  if (!VALID_INVOICE_DOC_TYPES.includes(s)) {
    const err = new Error(
      `docType must be one of: ${VALID_INVOICE_DOC_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_DOC_TYPE";
    throw err;
  }
}

// PRD_TRAVEL_BILLING FR-3.1.a — line-type enum for invoice line items.
// Extends the TravelQuoteLine enum (hotel/flight/transport/visa/service/other)
// with billing-side classifications (tax/fee/addon/tcs/tds) needed for the
// per-line tax + withholding ledger surface.
const VALID_INVOICE_LINE_TYPES = [
  "per_pax",
  "per_room",
  "per_night",
  "per_trip",
  "tax",
  "fee",
  "addon",
  "tcs",
  "tds",
  "other",
];

function assertValidInvoiceLineType(t) {
  if (t == null) return;
  if (!VALID_INVOICE_LINE_TYPES.includes(t)) {
    const err = new Error(
      `lineType must be one of: ${VALID_INVOICE_LINE_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_LINE_TYPE";
    throw err;
  }
}

// Duplicated from travel_quotes.js intentionally — the rule-of-3 promotion
// to a shared helper happens when a third caller lands (likely the upcoming
// #903 Supplier Master line variant). Keeping locally for now keeps the
// slice tight.
function parsePositiveDecimal(input, fieldName) {
  if (input == null || input === "") {
    const err = new Error(`${fieldName} is required`);
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(`${fieldName} must be a non-negative number`);
    err.status = 400;
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  return n;
}

function parsePositiveInt(input, fieldName, fallback) {
  if (input == null || input === "") return fallback;
  const n = parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1) {
    const err = new Error(`${fieldName} must be a positive integer`);
    err.status = 400;
    err.code = "INVALID_QUANTITY";
    throw err;
  }
  return n;
}

// PRD_TRAVEL_BILLING FR-3.1.b helpers — PNR / bookingRef caps.
// Free-form strings; we cap lengths to avoid abuse but don't enforce a
// shape (vendors vary: airline 6-char alphanumeric vs hotel CRS strings).
// Empty string after trim returns null so the field stays clean.
const PNR_MAX_LEN = 20;
const BOOKING_REF_MAX_LEN = 50;

function parseBookingRefField(input, fieldName, maxLen, errCode) {
  if (input == null) return undefined;
  // Explicit null clears the field on PUT.
  if (input === null) return null;
  const s = String(input).trim();
  if (s === "") return null;
  if (s.length > maxLen) {
    const err = new Error(`${fieldName} must be <= ${maxLen} characters`);
    err.status = 400;
    err.code = errCode;
    throw err;
  }
  return s;
}

// PRD_TRAVEL_BILLING FR-3.1.d helper — service-date parser.
// Returns a Date instance or null (for explicit null). Returns undefined
// if the field is absent from the body (so PUT partial-updates leave the
// existing value alone). Throws 400 INVALID_SERVICE_DATE on unparseable
// input.
function parseServiceDate(input, fieldName) {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`${fieldName} must be a valid date`);
    err.status = 400;
    err.code = "INVALID_SERVICE_DATE";
    throw err;
  }
  return d;
}

// Arc 2 #901 slice 12 — PRD_TRAVEL_BILLING UC-2.1 multi-currency helpers.
// fxRateToBase is the operator-captured conversion rate from the line's
// currency to the parent invoice's base currency at the time of entry.
// baseAmount = amount * fxRateToBase, computed + persisted (round-half-up
// at 2dp to match the existing Decimal(15,2) convention).
//
// Three semantic states across POST + PUT:
//   undefined → field absent from body; on POST persist null, on PUT
//               leave existing value alone.
//   null      → operator explicitly clearing the field; line becomes
//               single-currency, baseAmount cleared in lockstep.
//   number>0  → valid rate; baseAmount recomputed.
//
// Live FX-rate lookup against an external API is deferred (Q-blocker —
// pending exchange-rate-provider decision).
function parseFxRateToBase(input) {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input === "string" && input.trim() === "") return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error("fxRateToBase must be a positive number");
    err.status = 400;
    err.code = "INVALID_FX_RATE";
    throw err;
  }
  return n;
}

// Round to 2dp using half-up semantics (JavaScript's Math.round is
// half-to-even for negatives in some engines but half-up for positives,
// which is what we want for monetary values).
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Validate the service-date range when BOTH ends are present.
// Inclusive semantics — same-day single-night / single-day transfer is
// legal (start === end). Throws 400 INVALID_SERVICE_DATE_RANGE on
// inversion.
function assertServiceDateRange(start, end) {
  if (start == null || end == null) return;
  if (!(start instanceof Date) || !(end instanceof Date)) return;
  if (end.getTime() < start.getTime()) {
    const err = new Error("serviceEndDate must be on or after serviceStartDate");
    err.status = 400;
    err.code = "INVALID_SERVICE_DATE_RANGE";
    throw err;
  }
}

// Recompute the invoice's totalAmount as the sum of its lines and persist.
// Called from POST/PUT/DELETE /lines. Idempotent. Skipped if the lines
// table is empty (totalAmount stays at whatever the operator typed at
// invoice-create time — operators can author header-only invoices that
// don't need line-itemisation).
async function recomputeInvoiceTotal(invoiceId, tenantId) {
  const lines = await prisma.travelInvoiceLine.findMany({
    where: { invoiceId, tenantId },
    select: { amount: true },
  });
  if (lines.length === 0) return;
  const total = lines.reduce((acc, l) => acc + Number(l.amount || 0), 0);
  await prisma.travelInvoice.update({
    where: { id: invoiceId },
    data: { totalAmount: total },
  });
}

// Allowed forward-only status transitions (any status may also go to Voided).
// Reject backward transitions (e.g. Paid -> Issued) with 422.
const ALLOWED_TRANSITIONS = {
  Draft: new Set(["Issued", "Voided"]),
  Issued: new Set(["Partial", "Paid", "Voided"]),
  Partial: new Set(["Paid", "Voided"]),
  Paid: new Set(["Voided"]),
  Voided: new Set([]),
};

function assertValidStatus(s) {
  if (s == null) return;
  if (!VALID_INVOICE_STATUSES.includes(s)) {
    const err = new Error(
      `status must be one of: ${VALID_INVOICE_STATUSES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

/**
 * Parse + validate a dueDate. Accepts ISO 8601 strings or anything Date
 * can swallow; rejects unparseable input. Past dates are allowed
 * (back-dated invoicing is a legitimate ops case — e.g. issuing an
 * invoice after the trip already departed).
 *
 * Returns the parsed Date (or null if input was nullish).
 */
function parseDueDate(input) {
  if (input == null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("dueDate must be a parseable date");
    err.status = 400;
    err.code = "INVALID_DUE_DATE";
    throw err;
  }
  return d;
}

/**
 * Atomic per-tenant invoice-number generator. Format: TINV-YYYY-NNNN.
 * The serial resets each calendar year; lookup is scoped to (tenantId,
 * invoiceNum LIKE "TINV-YYYY-%") so cross-year reuse never collides.
 *
 * Race safety: wrapped in $transaction so two concurrent POSTs read the
 * same "latest" and assign distinct serials. The @@unique on the schema
 * is the second-line backstop if the transaction's isolation level
 * permits a phantom read on a particular MySQL config.
 */
async function nextInvoiceNum(tenantId) {
  const year = new Date().getFullYear();
  return await prisma.$transaction(async (tx) => {
    const latest = await tx.travelInvoice.findFirst({
      where: { tenantId, invoiceNum: { startsWith: `TINV-${year}-` } },
      orderBy: { invoiceNum: "desc" },
      select: { invoiceNum: true },
    });
    const latestSerial = latest
      ? parseInt(latest.invoiceNum.split("-")[2], 10)
      : 0;
    const next = String(latestSerial + 1).padStart(4, "0");
    return `TINV-${year}-${next}`;
  });
}

/**
 * #901 slice 5 — Per-sub-brand per-fiscal-year invoice serial helper.
 *
 * Coexists with nextInvoiceNum (which keeps the create-time TINV-YYYY-NNNN
 * scheme intact for back-compat with all existing tests and the frontend
 * InvoicesAdmin list view). This helper is invoked ONLY by the operator-
 * triggered Draft -> Issued transition at POST /:id/issue, where the
 * customer-facing invoice number is committed.
 *
 * Format: "<PREFIX>/<NNNN>" where <PREFIX> is produced by
 * invoicePrefixFor(subBrand, date) (e.g. "TMC/26-27", "RFU/26-27",
 * "TS/26-27", "VS/26-27"). Serial pads to 4 digits and resets per
 * (tenantId, subBrand, fiscal year).
 *
 * Race-safe via $transaction, same shape as nextInvoiceNum. The
 * @@unique([tenantId, invoiceNum]) on TravelInvoice is the second-line
 * backstop if the transaction's isolation level permits a phantom read.
 */
async function nextSubBrandInvoiceNum(tenantId, subBrand, date = new Date()) {
  const prefix = invoicePrefixFor(subBrand, date); // e.g. "TMC/26-27"
  return await prisma.$transaction(async (tx) => {
    const latest = await tx.travelInvoice.findFirst({
      where: { tenantId, invoiceNum: { startsWith: `${prefix}/` } },
      orderBy: { invoiceNum: "desc" },
      select: { invoiceNum: true },
    });
    const lastSerial = latest
      ? parseInt(latest.invoiceNum.split("/").pop(), 10) || 0
      : 0;
    return `${prefix}/${String(lastSerial + 1).padStart(4, "0")}`;
  });
}

// GET /api/travel/invoices
// Honors ?subBrand=tmc + ?status=Issued + ?contactId=N + ?quoteId=N + ?tripId=N.
// GET /api/travel/invoices
//
// Slim-shape opt-in (#920 slice S3 — FR-3.5 PII payload reduction).
// Default shape unchanged. Pass `?fields=summary` for the slim
// projection (id + subBrand + contactId + invoiceNum + status + docType
// + totalAmount + currency + dueDate + paidAt + createdAt). TCS columns
// + parentInvoiceId are SQL-dropped on the slim path — they're audit /
// adjustment-trail data, not picker-relevant. Pickers and the aged-
// receivables dashboard tile that just need invoice headers can opt in
// to drop ~15kb of per-row payload at scale.
router.get(
  "/invoices",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      if (req.query.subBrand) {
        assertValidSubBrand(String(req.query.subBrand));
        where.subBrand = String(req.query.subBrand);
      }
      if (req.query.status) {
        assertValidStatus(String(req.query.status));
        where.status = String(req.query.status);
      }
      if (req.query.contactId) {
        const cid = parseInt(req.query.contactId, 10);
        if (!Number.isFinite(cid)) {
          return res.status(400).json({
            error: "contactId must be a number",
            code: "INVALID_CONTACT_ID",
          });
        }
        where.contactId = cid;
      }
      if (req.query.quoteId) {
        const qid = parseInt(req.query.quoteId, 10);
        if (!Number.isFinite(qid)) {
          return res.status(400).json({
            error: "quoteId must be a number",
            code: "INVALID_QUOTE_ID",
          });
        }
        where.quoteId = qid;
      }
      if (req.query.tripId) {
        const tid = parseInt(req.query.tripId, 10);
        if (!Number.isFinite(tid)) {
          return res.status(400).json({
            error: "tripId must be a number",
            code: "INVALID_TRIP_ID",
          });
        }
        where.tripId = tid;
      }
      if (req.query.docType) {
        assertValidDocType(String(req.query.docType));
        where.docType = String(req.query.docType);
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.subBrand = where.subBrand
          ? canAccessSubBrand(allowed, where.subBrand)
            ? where.subBrand
            : "__none__"
          : { in: [...allowed] };
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;

      const isSummary = req.query.fields === "summary";
      const findManyArgs = {
        where,
        orderBy: [{ createdAt: "desc" }],
        take,
        skip,
      };
      if (isSummary) {
        findManyArgs.select = listProjection("TravelInvoice", false);
      }
      const [invoices, total] = await Promise.all([
        prisma.travelInvoice.findMany(findManyArgs),
        prisma.travelInvoice.count({ where }),
      ]);
      // Repair legacy invoices whose installment rows are fully paid but the
      // parent TravelInvoice status was not synchronized by the old payment
      // callback. Summary projections do not include participant/trip keys.
      if (!isSummary) {
        await Promise.all(invoices.map(async (invoice) => {
          if (!invoice.tripId || !invoice.participantId) return null;
          const repaired = await syncTravelInvoiceStatusForParticipant({
            db: prisma,
            tripId: invoice.tripId,
            participantId: invoice.participantId,
            tenantId: req.travelTenant.id,
            fallbackPaidAt: invoice.paidAt || invoice.updatedAt || new Date(),
          });
          if (repaired) Object.assign(invoice, repaired);
          return repaired;
        }));
      }
      res.json({ invoices, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] list error:", e.message);
      res.status(500).json({ error: "Failed to list invoices" });
    }
  },
);

// POST /api/travel/invoices/reconcile/excel-software
// Read-only reconciliation preview for workbook rows exported from the
// accounting.xlsx bridge. The route never mutates CRM records; it only
// compares uploaded rows against the current tenant invoices and returns a
// discrepancy report so the operator can reconcile off-platform without any
// DB risk.
router.post(
  "/invoices/reconcile/excel-software",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  invoiceReconcileUpload.single("file"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
        return res.status(400).json({ error: "file field required (multipart)", code: "FILE_REQUIRED" });
      }

      let parsed;
      try {
        parsed = parseInvoiceReconciliationSpreadsheet(req.file.buffer, req.file);
      } catch (parseErr) {
        return res.status(400).json({ error: parseErr.message, code: "INVALID_FILE" });
      }

      const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
      if (rows.length === 0) {
        return res.status(400).json({ error: "file is empty", code: "EMPTY_FILE" });
      }

      const invoiceNums = new Set();
      for (const raw of rows) {
        const mapped = {};
        for (const [key, value] of Object.entries(raw || {})) {
          mapped[normalizeInvoiceHeader(key)] = value;
        }
        const invoiceNum = normalizeInvoiceText(
          mapped.invoicenumber ||
          mapped.invoicenum ||
          mapped.vouchernumber ||
          mapped.invoiceid,
        );
        if (invoiceNum && invoiceNum.toLowerCase() !== "total") {
          invoiceNums.add(invoiceNum.toUpperCase());
        }
      }
      if (invoiceNums.size === 0) {
        return res.status(400).json({ error: "No invoice numbers found in file", code: "MISSING_FIELDS" });
      }

      const where = {
        tenantId: req.travelTenant.id,
        invoiceNum: { in: Array.from(invoiceNums) },
      };
      if (req.query.subBrand) {
        assertValidSubBrand(String(req.query.subBrand));
        where.subBrand = String(req.query.subBrand);
      }

      const invoices = await prisma.travelInvoice.findMany({
        where,
        select: {
          id: true,
          invoiceNum: true,
          totalAmount: true,
          status: true,
          subBrand: true,
          contactId: true,
          createdAt: true,
        },
      });
      const contactIds = [...new Set(invoices.map((inv) => inv.contactId).filter((id) => Number.isFinite(Number(id))))];
      const contacts = contactIds.length > 0
        ? await prisma.contact.findMany({
            where: { tenantId: req.travelTenant.id, id: { in: contactIds.map((id) => Number(id)) } },
            select: { id: true, name: true },
          })
        : [];
      const contactsById = Object.fromEntries(contacts.map((c) => [c.id, c]));

      const report = reconcileInvoiceRows({ rows, invoices, contactsById });
      report.scannedInvoices = invoices.length;
      report.subBrand = req.query.subBrand ? String(req.query.subBrand) : null;

      res.status(200).json(report);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] excel-software reconciliation error:", e.message);
      res.status(500).json({ error: "Failed to reconcile workbook" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/gstr1-export — Arc 2 #902 slice 10.
//
// PRD_TRAVEL_GST_COMPLIANCE.md GSTR-1 section. Monthly CSV export for GST
// return filing. Operator picks a filing month (YYYY-MM) and optionally a
// single sub-brand; we emit a CSV blob containing three GoI-aligned sections
// stitched together:
//
//   Section 1 (HSN_SUMMARY) — one row per (SAC code, GST rate) pair with
//     aggregate counts + taxable value + IGST / CGST / SGST. Lines whose
//     lineType has no SAC (tax / fee / tcs / tds — withholding lines that
//     don't belong on GSTR-1; those reconcile via Form 27EQ) are skipped by
//     the `groupLinesBySac` helper.
//   Section 2 (B2B_INVOICES) — one row per source invoice with totals.
//     CGST / SGST split when intra-state; IGST when inter-state. Doc_Type
//     column carries TaxInvoice / CreditNote / DebitNote.
//   Section 3 (DOCUMENT_TOTALS) — three roll-up rows summarising counts +
//     taxable + GST totals broken out by docType.
//
// === Doc-type filter ===
//
// Includes TaxInvoice + CreditNote + DebitNote. Excludes Proforma (a
// pre-payment quote-like instrument with no GST output until promoted to a
// TaxInvoice) and TravelVoucher (supplier-passthrough receipts that aren't
// GST-bearing). Pre-slice-11 historical rows where docType is NULL are
// treated as TaxInvoice (matches the existing route convention — see slice
// 11 header comment).
//
// === Date range ===
//
// `month=YYYY-MM` resolves to `[year, month-1, 1, 00:00:00.000)` —
// `[year, month, 1, 00:00:00.000)` (half-open interval, server-local
// timezone). createdAt is the filter field — matches the cohort GSTR-1
// expects (issuance month, not service-rendered month). Using paidAt would
// strand un-paid invoices off the filing return; using service dates would
// drag service-rendered-this-month lines from invoices issued in OTHER
// months into the return. createdAt is the canonical GoI cohort.
//
// === CSV format ===
//
//   - UTF-8 with BOM (U+FEFF prefix) so Excel auto-detects encoding and
//     doesn't mojibake currency symbols / non-ASCII operator names.
//   - CRLF line endings — GoI GSTR-1 portal expects DOS-style.
//   - Sections separated by a blank line + a `# <SECTION_NAME>` marker line
//     so the file is self-documenting. The portal's downstream JSON
//     converter ignores comment lines starting with `#`.
//   - csvEscape: wrap in double-quotes when the cell contains comma /
//     newline / double-quote, doubling inner quotes per RFC 4180.
//
// === Auth ===
//
// ADMIN / MANAGER only — operator-tax-action surface. USER role is blocked
// by verifyRole before any database read.
//
// === Sub-brand scoping ===
//
// Two layers: query `?subBrand=` (optional explicit filter) intersected
// with the caller's `subBrandAccess`. If the explicit filter targets a
// sub-brand the caller can't access, we substitute "__none__" so the
// result is an empty CSV (consistent with the silent-empty pattern used
// across other list endpoints).
//
// === Filename ===
//
// `gstr1-<month>-<subBrand>.csv` when sub-brand was filtered, else
// `gstr1-<month>-all.csv`. Spaces avoided so wget/curl downloads stay
// clean. Quoted in Content-Disposition.
//
// === Error codes ===
//
//   - INVALID_MONTH (400) — missing or wrong-shape `month` query param
//   - INVALID_SUB_BRAND (400) — `subBrand` query value isn't in the
//     recognised list (assertValidSubBrand)
//
// ============================================================================
const GSTR1_DOC_TYPES = ["TaxInvoice", "CreditNote", "DebitNote"];

function csvEscape(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(2);
}

function parseFilingMonth(raw) {
  if (!raw || typeof raw !== "string") {
    const err = new Error("month query parameter is required (format YYYY-MM)");
    err.status = 400;
    err.code = "INVALID_MONTH";
    throw err;
  }
  const m = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (!m) {
    const err = new Error("month must match YYYY-MM (e.g. 2026-04)");
    err.status = 400;
    err.code = "INVALID_MONTH";
    throw err;
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) {
    const err = new Error("month component must be 01..12");
    err.status = 400;
    err.code = "INVALID_MONTH";
    throw err;
  }
  // Half-open [start, end) — month rollover handled by the Date constructor.
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 1, 0, 0, 0, 0);
  return { year, month, start, end };
}

router.get(
  "/invoices/gstr1-export",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "export"),
  async (req, res) => {
    try {
      const { year, month, start, end } = parseFilingMonth(req.query.month);

      let subBrandFilter = null;
      if (req.query.subBrand != null && String(req.query.subBrand).trim() !== "") {
        const sb = String(req.query.subBrand).trim();
        assertValidSubBrand(sb);
        subBrandFilter = sb;
      }

      const where = {
        tenantId: req.travelTenant.id,
        createdAt: { gte: start, lt: end },
        docType: { in: GSTR1_DOC_TYPES },
      };
      if (subBrandFilter) where.subBrand = subBrandFilter;

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.subBrand = where.subBrand
          ? canAccessSubBrand(allowed, where.subBrand)
            ? where.subBrand
            : "__none__"
          : { in: [...allowed] };
      }

      const invoices = await prisma.travelInvoice.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      // Bulk-load all lines for the in-scope invoices in one round-trip;
      // group client-side so we don't issue N+1 queries per invoice.
      const invoiceIds = invoices.map((i) => i.id);
      const allLines =
        invoiceIds.length > 0
          ? await prisma.travelInvoiceLine.findMany({
              where: {
                invoiceId: { in: invoiceIds },
                tenantId: req.travelTenant.id,
              },
              orderBy: [{ invoiceId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
            })
          : [];
      const linesByInvoice = new Map();
      for (const l of allLines) {
        if (!linesByInvoice.has(l.invoiceId)) linesByInvoice.set(l.invoiceId, []);
        linesByInvoice.get(l.invoiceId).push(l);
      }

      // Cache state-code resolutions per (contactId) — multiple invoices
      // for the same contact share the same operator/customer state pair.
      const stateCodeCache = new Map();
      async function getInterstateForInvoice(invoice) {
        if (stateCodeCache.has(invoice.contactId)) {
          return stateCodeCache.get(invoice.contactId);
        }
        const codes = await resolveStateCodes({
          prisma,
          tenantId: req.travelTenant.id,
          contactId: invoice.contactId,
          operatorOverride: null,
          customerOverride: null,
        });
        let isInterstate;
        try {
          isInterstate = isInterstateSupply(
            codes.operatorStateCode,
            codes.customerStateCode,
          );
        } catch (_e) {
          isInterstate = false;
        }
        const result = { ...codes, isInterstate };
        stateCodeCache.set(invoice.contactId, result);
        return result;
      }

      // === Build Section 1: HSN_SUMMARY ===
      // Aggregate ALL lines across ALL in-scope invoices into HSN/SAC
      // buckets. Each row carries IGST/CGST/SGST per the (sacCode,
      // gstPercent) cohort's interstate ratio: lines from interstate-supply
      // invoices contribute to IGST; lines from intra-state invoices
      // contribute to CGST + SGST 50/50.
      const hsnBucketsRaw = new Map();
      for (const inv of invoices) {
        const lines = linesByInvoice.get(inv.id) || [];
        const { isInterstate } = await getInterstateForInvoice(inv);
        const normalized = lines.map((l) => ({
          lineType: l.lineType,
          taxableValue: Number(l.amount || 0),
          gstPercent: gstRateForCategory(l.lineType),
        }));
        const grouped = groupLinesBySac(normalized);
        for (const g of grouped) {
          const key = `${g.sacCode}:${g.gstPercent}`;
          if (!hsnBucketsRaw.has(key)) {
            hsnBucketsRaw.set(key, {
              sacCode: g.sacCode,
              description: g.description,
              gstPercent: g.gstPercent,
              taxableValue: 0,
              count: 0,
              igst: 0,
              cgst: 0,
              sgst: 0,
            });
          }
          const acc = hsnBucketsRaw.get(key);
          const totalTax = Math.round((g.taxableValue * g.gstPercent) / 100 * 100) / 100;
          acc.taxableValue = Math.round((acc.taxableValue + g.taxableValue) * 100) / 100;
          acc.count += g.count;
          if (isInterstate) {
            acc.igst = Math.round((acc.igst + totalTax) * 100) / 100;
          } else {
            const half = Math.round((totalTax / 2) * 100) / 100;
            acc.cgst = Math.round((acc.cgst + half) * 100) / 100;
            acc.sgst = Math.round((acc.sgst + half) * 100) / 100;
          }
        }
      }
      const hsnRows = [...hsnBucketsRaw.values()].sort((a, b) =>
        a.sacCode === b.sacCode
          ? a.gstPercent - b.gstPercent
          : a.sacCode.localeCompare(b.sacCode),
      );

      // === Build Section 2: B2B_INVOICES ===
      // One row per invoice with computed totals.
      const b2bRows = [];
      const docTotals = new Map(); // docType → { count, taxable, gst }
      for (const inv of invoices) {
        const lines = linesByInvoice.get(inv.id) || [];
        const { isInterstate, customerStateCode } =
          await getInterstateForInvoice(inv);
        let taxable = 0;
        let igst = 0;
        let cgst = 0;
        let sgst = 0;
        for (const l of lines) {
          // Skip lines whose lineType is not SAC-bearing (tax / fee /
          // tcs / tds — they're either already double-counted via the
          // parent's gstPercent or are withholding lines that don't
          // belong on GSTR-1).
          if (sacForLineType(l.lineType) === null) continue;
          const amt = Number(l.amount || 0);
          const rate = gstRateForCategory(l.lineType);
          const tax = Math.round((amt * rate) / 100 * 100) / 100;
          taxable = Math.round((taxable + amt) * 100) / 100;
          if (isInterstate) {
            igst = Math.round((igst + tax) * 100) / 100;
          } else {
            const half = Math.round((tax / 2) * 100) / 100;
            cgst = Math.round((cgst + half) * 100) / 100;
            sgst = Math.round((sgst + half) * 100) / 100;
          }
        }
        const totalGst = Math.round((igst + cgst + sgst) * 100) / 100;
        const docType = inv.docType || "TaxInvoice";
        b2bRows.push({
          invoiceNum: inv.invoiceNum,
          // YYYY-MM-DD slice of createdAt — the GoI portal accepts
          // ISO-date but rejects timestamp strings.
          date: inv.createdAt.toISOString().slice(0, 10),
          customerState: customerStateCode,
          taxable,
          igst,
          cgst,
          sgst,
          totalGst,
          docType,
        });
        const dt = docTotals.get(docType) || { count: 0, taxable: 0, gst: 0 };
        dt.count += 1;
        dt.taxable = Math.round((dt.taxable + taxable) * 100) / 100;
        dt.gst = Math.round((dt.gst + totalGst) * 100) / 100;
        docTotals.set(docType, dt);
      }

      // === Stitch the CSV ===
      const CRLF = "\r\n";
      const BOM = "\uFEFF";
      const parts = [];

      parts.push(`# GSTR1_EXPORT month=${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")} subBrand=${subBrandFilter || "ALL"}`);
      parts.push("");

      // Section 1
      parts.push("# HSN_SUMMARY");
      parts.push(
        [
          "SAC_Code",
          "Description",
          "Total_Lines",
          "Taxable_Value",
          "IGST",
          "CGST",
          "SGST",
          "GST_Rate",
        ]
          .map(csvEscape)
          .join(","),
      );
      for (const r of hsnRows) {
        parts.push(
          [
            r.sacCode,
            r.description,
            String(r.count),
            formatMoney(r.taxableValue),
            formatMoney(r.igst),
            formatMoney(r.cgst),
            formatMoney(r.sgst),
            formatMoney(r.gstPercent),
          ]
            .map(csvEscape)
            .join(","),
        );
      }
      parts.push("");

      // Section 2
      parts.push("# B2B_INVOICES");
      parts.push(
        [
          "Invoice_Num",
          "Date",
          "Customer_State",
          "Total_Taxable",
          "Total_IGST",
          "Total_CGST",
          "Total_SGST",
          "Total_GST",
          "Doc_Type",
        ]
          .map(csvEscape)
          .join(","),
      );
      for (const r of b2bRows) {
        parts.push(
          [
            r.invoiceNum,
            r.date,
            r.customerState || "",
            formatMoney(r.taxable),
            formatMoney(r.igst),
            formatMoney(r.cgst),
            formatMoney(r.sgst),
            formatMoney(r.totalGst),
            r.docType,
          ]
            .map(csvEscape)
            .join(","),
        );
      }
      parts.push("");

      // Section 3 — DOCUMENT_TOTALS. Sorted alphabetically by docType so
      // diffs across filing-months stay stable.
      parts.push("# DOCUMENT_TOTALS");
      parts.push(["Type", "Count", "Total_Taxable", "Total_GST"].map(csvEscape).join(","));
      const sortedDocTypes = [...docTotals.keys()].sort((a, b) => a.localeCompare(b));
      for (const t of sortedDocTypes) {
        const v = docTotals.get(t);
        parts.push(
          [t, String(v.count), formatMoney(v.taxable), formatMoney(v.gst)]
            .map(csvEscape)
            .join(","),
        );
      }

      const csv = BOM + parts.join(CRLF) + CRLF;

      const filename = `gstr1-${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${subBrandFilter || "all"}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      return res.status(200).send(csv);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] gstr1-export error:", e.message);
      res.status(500).json({ error: "Failed to generate GSTR-1 CSV" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/export/tally.xml — Tally-importable Sales vouchers
// GET /api/travel/invoices/export/ca.csv   — CA-handover line-level CSV
//
// TRAVEL_CRM_PRD §4.4 ("CA / Tally export — exportable financial reports;
// light accounting only") — gap A2, docs/TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md.
// Travel-invoice analogue of routes/billing.js GET /export/tally.xml +
// /export/ca-summary.csv (generic-CRM Invoice flavour of the same PRD
// section). File building delegated to lib/travelAccountingExport.js (pure);
// these handlers do the fetch + per-invoice GST math + sub-brand
// legal-entity resolution, then stream the attachment.
//
// === Auth ===
// ADMIN | MANAGER only (verifyRole) + travel vertical (requireTravelTenant)
// — mirrors gstr1-export / aged-receivable: finance surfaces are not
// exposed to USER role.
//
// === Query params (both endpoints) ===
//   ?from=YYYY-MM-DD  — optional range start (inclusive) on the invoice date
//   ?to=YYYY-MM-DD    — optional range end (inclusive; date-only values are
//                        pushed to end-of-day). Defaults: current Indian
//                        financial year (Apr 1 → Mar 31) — CA exports are
//                        FY-shaped by convention (mirrors billing.js).
//                        Invalid value → 400 INVALID_DATE_RANGE.
//   ?subBrand=tmc     — optional explicit sub-brand filter (validated via
//                        assertValidSubBrand → 400 INVALID_SUB_BRAND),
//                        intersected with the caller's subBrandAccess set
//                        (silent-empty "__none__" substitution, same as
//                        gstr1-export).
//
// === Invoice-date semantics ===
// TravelInvoice has no issuedAt column (see the slice-5 NOTE near the
// /:id/issue handler) — createdAt is the file-wide invoice-date proxy
// (by-month / by-quarter / gstr1-export all filter on it), so the
// ?from/?to range filters createdAt here too.
//
// === Scope ===
// Voided invoices are EXCLUDED (cancelled paper doesn't belong in the
// books; their financial effect rides on the linked CreditNote rows,
// which ARE exported as their own — negative-total — vouchers/rows).
// All docTypes included. Draft invoices included (light accounting —
// the CA filters by the Status column; Tally users can drop unwanted
// vouchers at import preview).
//
// === GST math ===
// Same conventions as gstr1-export's B2B section: taxable = sum of
// SAC-bearing lines only (tax/fee/tcs/tds withholding lines are skipped —
// TCS rides the invoice-level tcsAmount column instead), per-line rate
// via gstRateForCategory, CGST/SGST-vs-IGST split via the per-contact
// interstate resolution (resolveStateCodes + isInterstateSupply, cached
// per contactId).
// ============================================================================

// Parse optional ?from/?to into an inclusive Date range. Defaults to the
// current Indian financial year (Apr 1 → Mar 31) — mirrors billing.js's
// §4.4 exporters. Throws 400 INVALID_DATE_RANGE on unparseable input.
function parseAccountingExportRange(query) {
  const now = new Date();
  const fyStartYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  let from = new Date(fyStartYear, 3, 1, 0, 0, 0, 0);
  let to = new Date(fyStartYear + 1, 2, 31, 23, 59, 59, 999);

  if (query.from != null && String(query.from).trim() !== "") {
    from = new Date(String(query.from).trim());
  }
  if (query.to != null && String(query.to).trim() !== "") {
    to = new Date(String(query.to).trim());
    // Date-only "YYYY-MM-DD" → push to end-of-day so the inclusive range
    // matches operator expectation ("to 2026-06-30" includes the 30th).
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to).trim())) {
      to.setHours(23, 59, 59, 999);
    }
  }
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    const err = new Error("from/to must be valid dates (YYYY-MM-DD)");
    err.status = 400;
    err.code = "INVALID_DATE_RANGE";
    throw err;
  }
  return { from, to };
}

// Shared collector for both export endpoints: fetch in-scope invoices +
// lines + contacts + sub-brand config, compute per-invoice GST, and return
// normalized rows in the lib/travelAccountingExport.js shape.
async function collectAccountingExportRows(req) {
  const { from, to } = parseAccountingExportRange(req.query);

  let subBrandFilter = null;
  if (req.query.subBrand != null && String(req.query.subBrand).trim() !== "") {
    const sb = String(req.query.subBrand).trim();
    assertValidSubBrand(sb);
    subBrandFilter = sb;
  }

  const where = {
    tenantId: req.travelTenant.id,
    createdAt: { gte: from, lte: to },
    status: { not: "Voided" },
  };
  if (subBrandFilter) where.subBrand = subBrandFilter;

  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (allowed) {
    where.subBrand = where.subBrand
      ? canAccessSubBrand(allowed, where.subBrand)
        ? where.subBrand
        : "__none__"
      : { in: [...allowed] };
  }

  const invoices = await prisma.travelInvoice.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // Bulk-load lines + contacts in one round-trip each (no N+1).
  const invoiceIds = invoices.map((i) => i.id);
  const allLines =
    invoiceIds.length > 0
      ? await prisma.travelInvoiceLine.findMany({
          where: { invoiceId: { in: invoiceIds }, tenantId: req.travelTenant.id },
          orderBy: [{ invoiceId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
        })
      : [];
  const linesByInvoice = new Map();
  for (const l of allLines) {
    if (!linesByInvoice.has(l.invoiceId)) linesByInvoice.set(l.invoiceId, []);
    linesByInvoice.get(l.invoiceId).push(l);
  }

  const contactIds = [...new Set(invoices.map((i) => i.contactId))];
  let contactById = new Map();
  if (contactIds.length > 0) {
    const contacts = await prisma.contact.findMany({
      where: { id: { in: contactIds }, tenantId: req.travelTenant.id },
      select: { id: true, name: true, gst: true },
    });
    contactById = new Map(contacts.map((c) => [c.id, c]));
  }

  // Tenant row with the sub-brand config blob (requireTravelTenant only
  // selects id/vertical/name/slug, so re-fetch with subBrandConfigJson).
  const tenantRow = await prisma.tenant.findUnique({
    where: { id: req.travelTenant.id },
    select: { name: true, slug: true, subBrandConfigJson: true },
  });

  // Per-contact interstate resolution, cached — same pattern as
  // gstr1-export (multiple invoices for one contact share a state pair).
  const interstateCache = new Map();
  async function isInterstateFor(contactId) {
    if (interstateCache.has(contactId)) return interstateCache.get(contactId);
    let result = false;
    try {
      const codes = await resolveStateCodes({
        prisma,
        tenantId: req.travelTenant.id,
        contactId,
        operatorOverride: null,
        customerOverride: null,
      });
      result = isInterstateSupply(codes.operatorStateCode, codes.customerStateCode);
    } catch (_e) {
      result = false; // conservative intra-state fallback (mirrors gstr1-export)
    }
    interstateCache.set(contactId, result);
    return result;
  }

  const rows = [];
  for (const inv of invoices) {
    const isInterstate = await isInterstateFor(inv.contactId);
    const contact = contactById.get(inv.contactId) || {};
    const exportLines = [];
    let taxable = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    for (const l of linesByInvoice.get(inv.id) || []) {
      const sacCode = sacForLineType(l.lineType);
      // Withholding / passthrough lines (tax/fee/tcs/tds → null SAC) are
      // excluded from the taxable base; invoice-level TCS rides the
      // tcsAmount column (same exclusion as gstr1-export's B2B rows).
      if (sacCode === null) continue;
      const amt = Number(l.amount || 0);
      const rate = gstRateForCategory(l.lineType);
      const tax = round2((amt * rate) / 100);
      let lineCgst = 0;
      let lineSgst = 0;
      let lineIgst = 0;
      if (isInterstate) {
        lineIgst = tax;
      } else {
        lineCgst = round2(tax / 2);
        lineSgst = round2(tax / 2);
      }
      taxable = round2(taxable + amt);
      cgst = round2(cgst + lineCgst);
      sgst = round2(sgst + lineSgst);
      igst = round2(igst + lineIgst);
      exportLines.push({
        description: l.description || "",
        sacCode,
        taxableValue: amt,
        cgst: lineCgst,
        sgst: lineSgst,
        igst: lineIgst,
      });
    }
    const tcs = Number(inv.tcsAmount == null ? 0 : inv.tcsAmount);
    const hadLines = exportLines.length > 0;

    // Persisted invoice-level GST (POST /:id/tax-persist) takes precedence
    // over the line-derived figures. Most invoices created via the quick
    // "New Invoice" form are HEADER-ONLY (no TravelInvoiceLine rows), so the
    // line loop above yields zeros — we must source the money from the
    // invoice's own columns or the export shows 0.00 everywhere.
    const useCgst = inv.cgstAmount != null ? Number(inv.cgstAmount) : cgst;
    const useSgst = inv.sgstAmount != null ? Number(inv.sgstAmount) : sgst;
    const useIgst = inv.igstAmount != null ? Number(inv.igstAmount) : igst;
    const taxes = round2(useCgst + useSgst + useIgst + tcs);

    // Invoice total: the header `totalAmount` column is authoritative (it's
    // the figure the operator entered and the list/PDF show). Fall back to
    // the computed sum only when the column is null (legacy rows).
    const headerTotal = Number(inv.totalAmount);
    const total = Number.isFinite(headerTotal) ? round2(headerTotal) : round2(taxable + taxes);

    // Taxable: line-derived when the invoice has lines; otherwise back it
    // out of the header total (total − taxes) so a header-only invoice still
    // reconciles (taxable + taxes = total) instead of exporting as 0.00.
    let useTaxable = taxable;
    if (!hadLines) {
      const derived = round2(total - taxes);
      useTaxable = derived >= 0 ? derived : round2(total);
    }

    const brandConfig = resolveForSubBrand(tenantRow, inv.subBrand);
    rows.push({
      invoiceNum: inv.invoiceNum,
      date: inv.createdAt,
      customerName: contact.name || `Contact #${inv.contactId}`,
      customerGstin: contact.gst || null,
      subBrand: inv.subBrand,
      legalEntityCode: brandConfig.legalEntityCode || null,
      status: inv.status,
      taxableAmount: useTaxable,
      cgstAmount: useCgst,
      sgstAmount: useSgst,
      igstAmount: useIgst,
      tcsAmount: tcs,
      totalAmount: total,
      billReference: inv.invoiceNum,
      lines: exportLines,
    });
  }

  return {
    rows,
    tenantRow,
    subBrandFilter,
    fromIso: from.toISOString().slice(0, 10),
    toIso: to.toISOString().slice(0, 10),
  };
}

router.get(
  "/invoices/export/tally.xml",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "export"),
  async (req, res) => {
    try {
      const { rows, fromIso, toIso, subBrandFilter } =
        await collectAccountingExportRows(req);

      const xml = buildTravelTallyXml(rows, {
        tenantName: req.travelTenant.name,
      });

      const filename = `travel-tally-${fromIso}-${toIso}-${subBrandFilter || "all"}.xml`;
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(xml);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] export/tally.xml error:", e.message);
      res.status(500).json({ error: "Failed to generate Tally XML export" });
    }
  },
);

router.get(
  "/invoices/export/ca.csv",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "export"),
  async (req, res) => {
    try {
      const { rows, fromIso, toIso, subBrandFilter } =
        await collectAccountingExportRows(req);

      // BOM prefix so Excel auto-detects UTF-8 (gstr1-export convention);
      // the lib output itself stays BOM-free for easy test/tooling parses.
      const csv = "\uFEFF" + buildTravelCaCsv(rows);

      const filename = `travel-ca-${fromIso}-${toIso}-${subBrandFilter || "all"}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(csv);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] export/ca.csv error:", e.message);
      res.status(500).json({ error: "Failed to generate CA CSV export" });
    }
  },
);

// GET /api/travel/invoices/export/accounting.xlsx — plain spreadsheet
// (one row per invoice + TOTAL row) the client can hand to their CA or
// import into Excel Software for Travel. PRD §4.4 "Excel Software bridge —
// P1: file import": the file-import leg, built internally so no vendor API
// is needed (the P1.5 live API stays out of scope). Same scope filters
// (?from/?to default to current FY, ?subBrand) + auth/role/vertical gates
// as the Tally/CA exporters; reuses collectAccountingExportRows().
router.get(
  "/invoices/export/accounting.xlsx",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { rows, fromIso, toIso, subBrandFilter } =
        await collectAccountingExportRows(req);

      const buf = buildTravelAccountingXlsx(rows);

      const filename = `travel-accounting-${fromIso}-${toIso}-${subBrandFilter || "all"}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(buf);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] export/accounting.xlsx error:", e.message);
      res.status(500).json({ error: "Failed to generate accounting XLSX export" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/aged-receivable — Aged Receivable report
// (Arc 2 #901 slice 23 — PRD_TRAVEL_BILLING FR-3.6.a).
//
// Returns open (Issued | Partial) invoices bucketed by days past due. The
// bucket layout matches FR-3.6.a verbatim: 0-30 / 31-60 / 61-90 / 90+ (plus
// a `notYetDue` bucket for invoices whose dueDate is in the future or null).
//
// Per-invoice outstanding balance = totalAmount - sum(schedule.receivedAmount).
// Invoices with NO payment schedule rows treat the entire totalAmount as
// outstanding (the slice-17 auto-schedule landed mid-arc — pre-slice-17
// invoices stay schedule-less by design, and operator-issued single-pay
// invoices may stay schedule-less). Balance is half-up rounded to 2 dp.
//
// Auth: ADMIN | MANAGER (mirrors gstr1-export — finance reports are not
// surfaced to USER role per the same UC-2.5 month-end-close framing).
// Sub-brand access narrows the where clause via getSubBrandAccessSet.
//
// Query params (all optional):
//   ?subBrand=tmc                — narrow to one sub-brand
//   ?asOf=2026-05-25             — bucket against this date instead of now
//                                  (ISO-8601 YYYY-MM-DD). Useful for
//                                  reproducible month-end snapshots.
//   ?limit=200                   — clamped to MAX_LIMIT=500, default 100.
//   ?offset=0                    — pagination cursor.
//   ?contactId=999               — narrow to one customer (operator-side
//                                  collections workflow).
//
// Response shape: {
//   asOf: <ISO date>,
//   total: <count of matched invoices>,
//   limit, offset,
//   invoices: [
//     { id, invoiceNum, subBrand, contactId, status, dueDate,
//       totalAmount, receivedAmount, outstandingAmount, daysPastDue,
//       bucket: "0-30" | "31-60" | "61-90" | "90+" | "notYetDue",
//       currency }
//   ],
//   summary: {
//     byBucket: {
//       "0-30":    { count, outstanding },
//       "31-60":   { count, outstanding },
//       "61-90":   { count, outstanding },
//       "90+":     { count, outstanding },
//       notYetDue: { count, outstanding },
//     },
//     totalOutstanding: "X.XX",
//     currencyBreakdown: { INR: "X.XX", USD: "Y.YY", ... }
//   }
// }
//
// Error codes: INVALID_SUB_BRAND, INVALID_AS_OF, INVALID_LIMIT,
// INVALID_OFFSET, INVALID_CONTACT_ID.
// ============================================================================
function parseAsOf(input) {
  if (input == null || input === "") return new Date();
  const s = String(input);
  // Accept ISO-8601 date OR datetime. Reject obviously-bad input.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("asOf must be a valid ISO-8601 date");
    err.status = 400;
    err.code = "INVALID_AS_OF";
    throw err;
  }
  return d;
}

function bucketForDaysPastDue(days) {
  if (days == null || days < 0) return "notYetDue";
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

// Half-up rounding to 2dp on a Number. Mirrors the addDecimal convention
// (Decimal(15,2) — Number precision is fine well below 1e15). Math.round
// uses round-half-away-from-zero in V8 which is the half-up we want for
// non-negative currency amounts.
function roundHalfUp2(n) {
  const v = Number(n == null ? 0 : n);
  return (Math.round(v * 100) / 100).toFixed(2);
}

router.get(
  "/invoices/aged-receivable",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "read"),
  async (req, res) => {
    try {
      const asOf = parseAsOf(req.query.asOf);

      let subBrandFilter = null;
      if (req.query.subBrand != null && String(req.query.subBrand).trim() !== "") {
        const sb = String(req.query.subBrand).trim();
        assertValidSubBrand(sb);
        subBrandFilter = sb;
      }

      let contactIdFilter = null;
      if (req.query.contactId != null && String(req.query.contactId).trim() !== "") {
        const cid = parseInt(req.query.contactId, 10);
        if (!Number.isFinite(cid) || cid <= 0) {
          return res.status(400).json({
            error: "contactId must be a positive integer",
            code: "INVALID_CONTACT_ID",
          });
        }
        contactIdFilter = cid;
      }

      const limit = parseLimitForSummary(req.query.limit);
      const offset = parseOffsetForSummary(req.query.offset);

      const where = {
        tenantId: req.travelTenant.id,
        // "Open" = not paid, not voided, not draft. Issued | Partial are
        // the customer-owed states.
        status: { in: ["Issued", "Partial"] },
      };
      if (subBrandFilter) where.subBrand = subBrandFilter;
      if (contactIdFilter) where.contactId = contactIdFilter;

      // Sub-brand access narrowing mirrors gstr1-export.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (where.subBrand) {
          if (!canAccessSubBrand(allowed, where.subBrand)) {
            where.subBrand = "__none__";
          }
        } else {
          where.subBrand = allowed.size > 0 ? { in: [...allowed] } : "__none__";
        }
      }

      const [invoices, total] = await Promise.all([
        prisma.travelInvoice.findMany({
          where,
          include: {
            schedule: {
              select: { receivedAmount: true, status: true },
            },
          },
          orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          take: limit,
          skip: offset,
        }),
        prisma.travelInvoice.count({ where }),
      ]);

      const asOfMs = asOf.getTime();
      const buckets = {
        "0-30": { count: 0, outstanding: "0.00" },
        "31-60": { count: 0, outstanding: "0.00" },
        "61-90": { count: 0, outstanding: "0.00" },
        "90+": { count: 0, outstanding: "0.00" },
        notYetDue: { count: 0, outstanding: "0.00" },
      };
      const currencyBreakdown = {};
      let totalOutstanding = "0.00";

      const rows = invoices.map((inv) => {
        const sched = Array.isArray(inv.schedule) ? inv.schedule : [];
        let received = 0;
        for (const s of sched) {
          received += Number(s.receivedAmount == null ? 0 : s.receivedAmount);
        }
        const totalAmt = Number(inv.totalAmount == null ? 0 : inv.totalAmount);
        const outstandingNum = totalAmt - received;
        const outstanding = roundHalfUp2(outstandingNum);
        const dueMs =
          inv.dueDate instanceof Date
            ? inv.dueDate.getTime()
            : inv.dueDate
              ? new Date(inv.dueDate).getTime()
              : null;
        const daysPastDue =
          dueMs == null ? null : Math.floor((asOfMs - dueMs) / 86_400_000);
        const bucket = bucketForDaysPastDue(daysPastDue);

        buckets[bucket].count += 1;
        buckets[bucket].outstanding = addDecimal(
          buckets[bucket].outstanding,
          outstanding,
        );
        totalOutstanding = addDecimal(totalOutstanding, outstanding);

        const cur = inv.currency || "INR";
        currencyBreakdown[cur] = addDecimal(
          currencyBreakdown[cur] || "0.00",
          outstanding,
        );

        return {
          id: inv.id,
          invoiceNum: inv.invoiceNum,
          subBrand: inv.subBrand,
          contactId: inv.contactId,
          status: inv.status,
          dueDate: inv.dueDate,
          totalAmount: roundHalfUp2(totalAmt),
          receivedAmount: roundHalfUp2(received),
          outstandingAmount: outstanding,
          daysPastDue,
          bucket,
          currency: cur,
        };
      });

      res.json({
        asOf: asOf.toISOString(),
        total,
        limit,
        offset,
        invoices: rows,
        summary: {
          byBucket: buckets,
          totalOutstanding,
          currencyBreakdown,
        },
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] aged-receivable error:", e.message);
      res.status(500).json({ error: "Failed to generate aged receivable" });
    }
  },
);

// ============================================================================
// C8 (PRD_TRAVEL_BILLING UC-2.4 / FR-3.6.b / FR-3.5.b) — three new finance-side
// endpoints layered alongside the existing /aged-receivable + /payables/aging:
//
//   GET /invoices/aged-receivable-report  — Aged A/R with named C8 buckets
//                                            (Current/31-60/61-90/Over 90)
//   GET /invoices/aged-payable-report     — Aged A/P over TravelSupplierPayable
//                                            (joined from this route per C8
//                                            contract; companion to
//                                            travel_suppliers.js /payables/aging
//                                            slice 8 but with the C8 fixed
//                                            label spec)
//   GET /invoices/tcs/27eq                — Quarterly Form 27EQ (Sec 206C(1G))
//                                            per-buyer TCS rollup, JSON or CSV
//
// These are SEPARATE from slice 23's existing /aged-receivable (different
// bucket-label contract, kept untouched per the C8 dispatch rules) and slice
// 8's /payables/aging on routes/travel_suppliers.js — the C8 deliverable pins
// a fixed contract shape (named labels "Current (0-30 days)" / "31-60 days" /
// etc.) the Finance dashboard + month-end-close packet depend on.
//
// IMPORTANT — route ordering: these handlers MUST stay above the GET
// /invoices/:id handler later in this file, otherwise Express interprets the
// path fragments `aged-receivable-report`, `aged-payable-report`, and `tcs`
// as `:id` parameter values and 404s the routes.
//
// Auth: ADMIN + MANAGER, tenant-scoped. Sub-brand access narrowing applies.
// ============================================================================

const C8_BUCKETS = [
  { label: "Current (0-30 days)", min: 0, max: 30 },
  { label: "31-60 days", min: 31, max: 60 },
  { label: "61-90 days", min: 61, max: 90 },
  { label: "Over 90 days", min: 91, max: null },
];

function c8BucketForDaysOverdue(days) {
  for (const b of C8_BUCKETS) {
    if (b.max == null) {
      if (days >= b.min) return b;
    } else if (days >= b.min && days <= b.max) {
      return b;
    }
  }
  return C8_BUCKETS[0];
}

function emptyC8Buckets() {
  return C8_BUCKETS.map((b) => ({
    label: b.label,
    minDaysOverdue: b.min,
    maxDaysOverdue: b.max,
    invoiceCount: 0,
    totalAmount: 0,
  }));
}

function parseAsOfDate(input) {
  if (input == null || input === "") return new Date();
  const s = String(input).trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("asOfDate must be a valid ISO-8601 date");
    err.status = 400;
    err.code = "INVALID_AS_OF_DATE";
    throw err;
  }
  return d;
}

// GET /api/travel/invoices/aged-receivable-report — C8 aged-A/R with named
// buckets (PRD_TRAVEL_BILLING FR-3.6.b). Distinct from slice 23's
// /aged-receivable; pins the customer-facing labels the Finance dashboard
// + month-end-close packet expect.
router.get(
  "/invoices/aged-receivable-report",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "read"),
  async (req, res) => {
    try {
      const asOf = parseAsOfDate(req.query.asOfDate);

      let subBrandFilter = null;
      if (req.query.subBrand != null && String(req.query.subBrand).trim() !== "") {
        const sb = String(req.query.subBrand).trim();
        assertValidSubBrand(sb);
        subBrandFilter = sb;
      }

      const where = {
        tenantId: req.travelTenant.id,
        status: { notIn: ["Paid", "Voided"] },
      };
      if (subBrandFilter) where.subBrand = subBrandFilter;

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        if (where.subBrand && typeof where.subBrand === "string") {
          if (!canAccessSubBrand(allowed, where.subBrand)) {
            where.subBrand = "__none__";
          }
        } else {
          where.subBrand = allowed.size > 0 ? { in: [...allowed] } : "__none__";
        }
      }

      const invoices = await prisma.travelInvoice.findMany({
        where,
        include: {
          schedule: { select: { receivedAmount: true } },
        },
        take: 10_000,
      });

      const asOfMs = asOf.getTime();
      const buckets = emptyC8Buckets();
      const drillRows = [];
      let totalReceivable = 0;
      let currency = null;

      for (const inv of invoices) {
        const sched = Array.isArray(inv.schedule) ? inv.schedule : [];
        let received = 0;
        for (const s of sched) {
          received += Number(s.receivedAmount == null ? 0 : s.receivedAmount);
        }
        const totalAmt = Number(inv.totalAmount == null ? 0 : inv.totalAmount);
        const outstanding = Math.max(0, totalAmt - received);
        if (outstanding <= 0) continue;

        const dueMs =
          inv.dueDate instanceof Date
            ? inv.dueDate.getTime()
            : inv.dueDate
              ? new Date(inv.dueDate).getTime()
              : asOfMs;
        const daysOverdue = Math.max(
          0,
          Math.floor((asOfMs - dueMs) / 86_400_000),
        );
        const bucketSpec = c8BucketForDaysOverdue(daysOverdue);
        const bucketRow = buckets.find((b) => b.label === bucketSpec.label);
        bucketRow.invoiceCount += 1;
        bucketRow.totalAmount = round2(bucketRow.totalAmount + outstanding);
        totalReceivable = round2(totalReceivable + outstanding);

        if (currency == null) currency = inv.currency || "INR";

        drillRows.push({
          id: inv.id,
          invoiceNum: inv.invoiceNum,
          subBrand: inv.subBrand,
          contactId: inv.contactId,
          dueDate: inv.dueDate,
          totalAmount: round2(totalAmt),
          receivedAmount: round2(received),
          outstandingAmount: round2(outstanding),
          daysOverdue,
          bucket: bucketSpec.label,
          currency: inv.currency || "INR",
        });
      }

      drillRows.sort((a, b) => b.daysOverdue - a.daysOverdue);

      res.json({
        asOfDate: asOf.toISOString().slice(0, 10),
        currency: currency || "INR",
        buckets,
        totalReceivable,
        invoices: drillRows,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] aged-receivable-report error:", e.message);
      res
        .status(500)
        .json({ error: "Failed to generate aged-receivable report" });
    }
  },
);

// GET /api/travel/invoices/aged-payable-report — C8 aged-A/P over
// TravelSupplierPayable (PRD_TRAVEL_BILLING FR-3.6.c). Distinct from slice
// 8's /payables/aging in routes/travel_suppliers.js — same bucket spec as
// the C8 aged-receivable above so the Finance dashboard can render both
// reports side-by-side with consistent labels.
router.get(
  "/invoices/aged-payable-report",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "read"),
  async (req, res) => {
    try {
      const asOf = parseAsOfDate(req.query.asOfDate);

      let subBrandFilter = null;
      if (req.query.subBrand != null && String(req.query.subBrand).trim() !== "") {
        const sb = String(req.query.subBrand).trim();
        assertValidSubBrand(sb);
        subBrandFilter = sb;
      }

      const where = {
        tenantId: req.travelTenant.id,
        status: { notIn: ["paid", "cancelled"] },
      };

      const allowed = await getSubBrandAccessSet(req.user.userId);
      const supplierFilter = {};
      if (subBrandFilter) {
        if (allowed !== null && !canAccessSubBrand(allowed, subBrandFilter)) {
          supplierFilter.subBrand = "__none__";
        } else {
          supplierFilter.subBrand = subBrandFilter;
        }
      } else if (allowed !== null) {
        supplierFilter.subBrand =
          allowed.size > 0 ? { in: [...allowed] } : "__none__";
      }
      if (Object.keys(supplierFilter).length > 0) {
        where.supplier = { is: supplierFilter };
      }

      const payables = await prisma.travelSupplierPayable.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true, subBrand: true } },
        },
        take: 10_000,
      });

      const asOfMs = asOf.getTime();
      const buckets = emptyC8Buckets();
      const drillRows = [];
      let totalPayable = 0;
      let currency = null;

      for (const p of payables) {
        const amt = Number(p.amount == null ? 0 : p.amount);
        if (amt <= 0) continue;
        const dueMs =
          p.dueDate instanceof Date
            ? p.dueDate.getTime()
            : p.dueDate
              ? new Date(p.dueDate).getTime()
              : asOfMs;
        const daysOverdue = Math.max(
          0,
          Math.floor((asOfMs - dueMs) / 86_400_000),
        );
        const bucketSpec = c8BucketForDaysOverdue(daysOverdue);
        const bucketRow = buckets.find((b) => b.label === bucketSpec.label);
        bucketRow.invoiceCount += 1;
        bucketRow.totalAmount = round2(bucketRow.totalAmount + amt);
        totalPayable = round2(totalPayable + amt);

        if (currency == null) currency = p.currency || "INR";

        drillRows.push({
          id: p.id,
          supplierId: p.supplierId,
          supplierName: p.supplier ? p.supplier.name : null,
          subBrand: p.supplier ? p.supplier.subBrand : null,
          poNumber: p.poNumber,
          dueDate: p.dueDate,
          amount: round2(amt),
          daysOverdue,
          bucket: bucketSpec.label,
          currency: p.currency || "INR",
        });
      }

      drillRows.sort((a, b) => b.daysOverdue - a.daysOverdue);

      res.json({
        asOfDate: asOf.toISOString().slice(0, 10),
        currency: currency || "INR",
        buckets,
        totalPayable,
        payables: drillRows,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] aged-payable-report error:", e.message);
      res
        .status(500)
        .json({ error: "Failed to generate aged-payable report" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/tcs/27eq — Quarterly Form 27EQ rollup
// (PRD_TRAVEL_BILLING FR-3.5.b — Section 206C(1G) TCS return).
//
// Returns per-buyer TCS-collected totals for the given financial year +
// quarter. Sec 206C requires this report quarterly; this endpoint is the
// data feed for the Form 27EQ filing surface.
//
// FY convention: Indian FY runs Apr 1 → Mar 31. `?fy=2025-26` means
// 2025-04-01 → 2026-03-31. Quarters Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec,
// Q4=Jan-Mar (next calendar year for Q4 of the FY).
//
// Includes only invoices where `tcsAppliedAt IS NOT NULL` (slice 10
// promoted TCS persistence; this is the post-application cohort). Cohort
// field is `tcsAppliedAt` (when TCS was applied), not createdAt — the
// taxable event for 27EQ is the application date.
//
// Auth: ADMIN | MANAGER. Sub-brand access narrowing applies.
//
// Query params:
//   ?fy=2025-26                     — REQUIRED. FY YYYY-YY format.
//   ?quarter=Q1|Q2|Q3|Q4            — REQUIRED. Quarter within the FY.
//   ?format=json|csv (default json) — output format. CSV emits 27EQ-style
//                                      columns + Content-Disposition.
//
// Response (json):
//   {
//     fy: "2025-26",
//     quarter: "Q1",
//     dateRange: { from: "2025-04-01", to: "2025-06-30" },
//     rows: [
//       { buyerName, buyerPan, totalTcsCollected, invoiceCount }
//     ],
//     totals: { totalRows, totalTcs }
//   }
//
// Response (csv):
//   Header row: Buyer_Name,Buyer_PAN,Total_TCS,Invoice_Count
//   BOM-prefixed UTF-8 + CRLF (matches gstr1-export convention).
//   Filename: `tcs-27eq-<fy>-<quarter>.csv`.
//
// Error codes: MISSING_FY, MISSING_QUARTER, INVALID_FY, INVALID_QUARTER,
// INVALID_FORMAT.
// ============================================================================

function parseFy(raw) {
  if (!raw || typeof raw !== "string") {
    const err = new Error("fy query parameter is required (format YYYY-YY)");
    err.status = 400;
    err.code = "MISSING_FY";
    throw err;
  }
  const m = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (!m) {
    const err = new Error("fy must match YYYY-YY (e.g. 2025-26)");
    err.status = 400;
    err.code = "INVALID_FY";
    throw err;
  }
  const startYear = parseInt(m[1], 10);
  const endYearShort = parseInt(m[2], 10);
  // The trailing component is the LAST two digits of (startYear + 1).
  const expectedEndShort = (startYear + 1) % 100;
  if (endYearShort !== expectedEndShort) {
    const err = new Error(
      `fy second component must equal (startYear+1) % 100 — got ${m[2]}, expected ${String(expectedEndShort).padStart(2, "0")}`,
    );
    err.status = 400;
    err.code = "INVALID_FY";
    throw err;
  }
  return { startYear, endYear: startYear + 1 };
}

function parseQuarterRange(quarterRaw, fy) {
  if (!quarterRaw || typeof quarterRaw !== "string") {
    const err = new Error("quarter query parameter is required (Q1|Q2|Q3|Q4)");
    err.status = 400;
    err.code = "MISSING_QUARTER";
    throw err;
  }
  const q = quarterRaw.trim().toUpperCase();
  if (!["Q1", "Q2", "Q3", "Q4"].includes(q)) {
    const err = new Error("quarter must be one of Q1|Q2|Q3|Q4");
    err.status = 400;
    err.code = "INVALID_QUARTER";
    throw err;
  }
  // Indian FY quarter mapping:
  //   Q1 = Apr-Jun (startYear)
  //   Q2 = Jul-Sep (startYear)
  //   Q3 = Oct-Dec (startYear)
  //   Q4 = Jan-Mar (endYear)
  const ranges = {
    Q1: { year: fy.startYear, startMonth: 3, endMonthExclusive: 6 },
    Q2: { year: fy.startYear, startMonth: 6, endMonthExclusive: 9 },
    Q3: { year: fy.startYear, startMonth: 9, endMonthExclusive: 12 },
    Q4: { year: fy.endYear, startMonth: 0, endMonthExclusive: 3 },
  };
  const r = ranges[q];
  // Use UTC dates so the date-range string is timezone-independent
  // (matches the deploy convention for monthly cohorts).
  const start = new Date(Date.UTC(r.year, r.startMonth, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(r.year, r.endMonthExclusive, 1, 0, 0, 0, 0));
  // toRange string for the response envelope (inclusive last day of Q).
  const lastDay = new Date(end.getTime() - 86_400_000);
  return {
    quarter: q,
    start,
    end,
    fromIso: start.toISOString().slice(0, 10),
    toIso: lastDay.toISOString().slice(0, 10),
  };
}

// The Indian GSTIN encodes the buyer's PAN as characters 3..12 (1-based)
// — e.g. "07ABCDE1234F1Z5" → PAN = "ABCDE1234F". For 27EQ rows we expose
// the derived PAN when a GSTIN is present; null otherwise.
function panFromGst(gstin) {
  if (!gstin || typeof gstin !== "string") return null;
  const s = gstin.trim().toUpperCase();
  if (s.length < 12) return null;
  const pan = s.slice(2, 12);
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return null;
  return pan;
}

router.get(
  "/invoices/tcs/27eq",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "read"),
  async (req, res) => {
    try {
      const fy = parseFy(req.query.fy);
      const qr = parseQuarterRange(req.query.quarter, fy);

      const fmt =
        req.query.format == null || req.query.format === ""
          ? "json"
          : String(req.query.format).toLowerCase();
      if (!["json", "csv"].includes(fmt)) {
        const err = new Error("format must be 'json' or 'csv'");
        err.status = 400;
        err.code = "INVALID_FORMAT";
        throw err;
      }

      const where = {
        tenantId: req.travelTenant.id,
        tcsAppliedAt: { gte: qr.start, lt: qr.end },
        tcsAmount: { gt: 0 },
      };

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.subBrand = allowed.size > 0 ? { in: [...allowed] } : "__none__";
      }

      const invoices = await prisma.travelInvoice.findMany({
        where,
        select: {
          id: true,
          contactId: true,
          tcsAmount: true,
        },
        take: 50_000,
      });

      // Roll up per-buyer (contactId). Fetch contact details once we know
      // which buyers contributed; this avoids loading 50K contacts when only
      // a handful actually have TCS-applied invoices in the quarter.
      const byContact = new Map();
      for (const inv of invoices) {
        const cid = inv.contactId;
        const tcs = Number(inv.tcsAmount == null ? 0 : inv.tcsAmount);
        if (!byContact.has(cid)) {
          byContact.set(cid, { totalTcs: 0, invoiceCount: 0 });
        }
        const row = byContact.get(cid);
        row.totalTcs = round2(row.totalTcs + tcs);
        row.invoiceCount += 1;
      }

      let contactById = new Map();
      if (byContact.size > 0) {
        const contacts = await prisma.contact.findMany({
          where: { id: { in: [...byContact.keys()] }, tenantId: req.travelTenant.id },
          select: { id: true, name: true, gst: true },
        });
        contactById = new Map(contacts.map((c) => [c.id, c]));
      }

      const rows = [];
      let totalTcs = 0;
      for (const [cid, agg] of byContact.entries()) {
        const c = contactById.get(cid) || {};
        rows.push({
          buyerName: c.name || `Contact #${cid}`,
          buyerPan: panFromGst(c.gst),
          totalTcsCollected: agg.totalTcs,
          invoiceCount: agg.invoiceCount,
        });
        totalTcs = round2(totalTcs + agg.totalTcs);
      }
      rows.sort((a, b) => b.totalTcsCollected - a.totalTcsCollected);

      if (fmt === "csv") {
        const CRLF = "\r\n";
        const BOM = "﻿";
        const parts = [];
        parts.push(
          ["Buyer_Name", "Buyer_PAN", "Total_TCS", "Invoice_Count"]
            .map(csvEscape)
            .join(","),
        );
        for (const r of rows) {
          parts.push(
            [
              r.buyerName,
              r.buyerPan || "",
              formatMoney(r.totalTcsCollected),
              String(r.invoiceCount),
            ]
              .map(csvEscape)
              .join(","),
          );
        }
        const csv = BOM + parts.join(CRLF) + CRLF;
        const filename = `tcs-27eq-${req.query.fy}-${qr.quarter}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        return res.status(200).send(csv);
      }

      return res.status(200).json({
        fy: req.query.fy,
        quarter: qr.quarter,
        dateRange: { from: qr.fromIso, to: qr.toIso },
        rows,
        totals: { totalRows: rows.length, totalTcs },
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] tcs/27eq error:", e.message);
      res.status(500).json({ error: "Failed to generate Form 27EQ" });
    }
  },
);

// GET /api/travel/invoices/by-month — any verified token (tenant + sub-brand scoped).
//
// Slice 29 of #901 (PRD_TRAVEL_BILLING §3 — tenant-wide invoice
// analytics rolled up by calendar month). Mirrors #900 slice 16
// (/quotes/by-month) — same UTC YYYY-MM bucketing template, same
// defensive math, same orderBy semantics, swapping TravelQuote for
// TravelInvoice. One row per UTC-month present in the scoped invoice
// set, summarising the count + status splits across all 5 TravelInvoice
// statuses (Draft/Issued/Partial/Paid/Voided) for that month plus
// totalValue + paidValue + openValue sums. Read-only; consumed by the
// operator-facing "invoices trend" chart on the billing dashboard and
// the per-month picker for drill-downs into the underlying /invoices
// list.
//
// Why a separate endpoint instead of extending /invoices/aged-receivable:
//   - Different aggregation granularity (per-month time-series, not
//     per-bucket-age-band).
//   - Different lifecycle posture (covers Draft + Voided too — open
//     receivable only spans Issued + Partial).
//   - Pre-fills a different UI surface (line/bar trend chart vs the
//     aged-receivable table).
//
// Bucket key shape: ISO YYYY-MM string (e.g. "2026-05") derived from
// TravelInvoice.createdAt's UTC year + month. UTC chosen deliberately
// so bucket labels stay stable across operator timezones — finance
// reconciliation works in calendar-month UTC for cross-border volume.
//
// Scope rules:
//   - Tenant-scoped on TravelInvoice.tenantId.
//   - Sub-brand-restricted: respects the caller's subBrandAccess set
//     (MANAGER restricted to their sub-brand; ADMIN full access).
//   - Any verified token; no RBAC narrowing — operator-readable read.
//     (Differs from aged-receivable's ADMIN/MANAGER gate because this
//     surface is a high-level trend chart, not a per-customer balance
//     report that warrants role narrowing.)
//
// Query string:
//   status    optional TravelInvoice.status filter
//             (Draft/Issued/Partial/Paid/Voided)
//   from      optional inclusive lower bound on bucket (YYYY-MM); rows
//             with month < from are excluded
//   to        optional inclusive upper bound on bucket (YYYY-MM); rows
//             with month > to are excluded
//   orderBy   default "month:asc" (chronological); also accepts
//             "month:desc", "totalValue:asc|desc", "invoiceCount:asc|desc",
//             "paidCount:asc|desc". Unknown tokens degrade silently
//             to default (same graceful posture as slice 16).
//   limit     default 12 (one year of months), max 60 (5 years).
//   offset    default 0
//
// Response shape:
//   {
//     months: [ {
//       month: "2026-05",
//       invoiceCount, totalValue,
//       draftCount, issuedCount, partialCount, paidCount, voidedCount,
//       paidValue, openValue
//     } ],
//     totalMonths,
//     grandInvoiceCount,
//     grandTotalValue,
//     grandPaidValue,
//     grandOpenValue,
//     limit, offset
//   }
//
// openValue per row = totalValue - paidValue - voidedValue (where
// voidedValue is the sum of totalAmount on Voided rows — voided
// invoices contribute to totalValue but neither paid nor open).
// grandOpenValue is the sum of per-row openValue, half-up rounded.
//
// Defensive behaviour: null/invalid TravelInvoice.totalAmount contributes
// 0 (no NaN poisoning); null/invalid createdAt → "unknown" bucket
// (excluded when ?from / ?to is set, kept otherwise so the count surface
// stays accurate). Half-up 2dp rounding via Number.EPSILON, matching
// the canonical round2 used in slice 16.
//
// Route ordering: declared BEFORE GET /invoices/:id so Express doesn't
// try to parse "by-month" as a numeric :id (which would 400 INVALID_ID).
router.get("/invoices/by-month", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 60);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "month:asc";

    if (statusFilter) {
      try {
        assertValidStatus(statusFilter);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message, code: e.code });
      }
    }

    // YYYY-MM validation — same regex slice 16 uses. Bucket labels we
    // emit follow this exact shape so callers passing month-tokens to
    // from/to should already be using it.
    const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw !== null && !MONTH_RE.test(fromRaw)) {
      return res.status(400).json({
        error: "from must be in YYYY-MM format",
        code: "INVALID_MONTH_FORMAT",
      });
    }
    if (toRaw !== null && !MONTH_RE.test(toRaw)) {
      return res.status(400).json({
        error: "to must be in YYYY-MM format",
        code: "INVALID_MONTH_FORMAT",
      });
    }

    const VALID_ORDER_BY = new Set([
      "month:asc",
      "month:desc",
      "totalValue:asc",
      "totalValue:desc",
      "invoiceCount:asc",
      "invoiceCount:desc",
      "paidCount:asc",
      "paidCount:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "month:asc";

    // Build the tenant-scoped where. Sub-brand narrowing mirrors the
    // /invoices list handler — empty access set → all-zeros rollup (not
    // 403) so the dashboard tile renders cleanly for not-yet-onboarded
    // operators.
    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({
        months: [],
        totalMonths: 0,
        grandInvoiceCount: 0,
        grandTotalValue: 0,
        grandPaidValue: 0,
        grandOpenValue: 0,
        limit: take,
        offset: skip,
      });
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-MM. Input size bound is the same as
    // /invoices/aged-receivable (low thousands at platinum scale).
    const invoices = await prisma.travelInvoice.findMany({
      where,
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    const round2 = (n) =>
      Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-month. Map "YYYY-MM" → { ...row counts/sums }.
    // Invoices with null/invalid createdAt go into "unknown" so counts
    // stay accurate. Null/invalid totalAmount contributes 0. voidedValue
    // is tracked separately so openValue can subtract it (voided rows
    // contribute to totalValue but are neither paid nor open).
    const byMonth = new Map();
    for (const inv of invoices) {
      let monthKey = "unknown";
      if (inv.createdAt) {
        const dt = new Date(inv.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
          monthKey = `${yyyy}-${mm}`;
        }
      }

      let row = byMonth.get(monthKey);
      if (!row) {
        row = {
          month: monthKey,
          invoiceCount: 0,
          totalValue: 0,
          draftCount: 0,
          issuedCount: 0,
          partialCount: 0,
          paidCount: 0,
          voidedCount: 0,
          paidValue: 0,
          voidedValue: 0,
        };
        byMonth.set(monthKey, row);
      }

      row.invoiceCount += 1;
      const amt = Number(inv.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      row.totalValue += safeAmt;

      switch (inv.status) {
        case "Draft":
          row.draftCount += 1;
          break;
        case "Issued":
          row.issuedCount += 1;
          break;
        case "Partial":
          row.partialCount += 1;
          break;
        case "Paid":
          row.paidCount += 1;
          row.paidValue += safeAmt;
          break;
        case "Voided":
          row.voidedCount += 1;
          row.voidedValue += safeAmt;
          break;
        default:
          break;
      }
    }

    // Finalise rounding on per-row sums + compute openValue.
    // openValue = totalValue - paidValue - voidedValue (the
    // customer-owed-but-not-yet-paid surface).
    let months = [...byMonth.values()].map((r) => {
      const openValue = r.totalValue - r.paidValue - r.voidedValue;
      return {
        month: r.month,
        invoiceCount: r.invoiceCount,
        totalValue: round2(r.totalValue),
        draftCount: r.draftCount,
        issuedCount: r.issuedCount,
        partialCount: r.partialCount,
        paidCount: r.paidCount,
        voidedCount: r.voidedCount,
        paidValue: round2(r.paidValue),
        openValue: round2(openValue),
      };
    });

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (they have no comparable month token); when
    // no bounds are set, "unknown" stays so the count surface remains
    // complete. Mirrors slice 16's posture.
    if (fromRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month >= fromRaw);
    }
    if (toRaw !== null) {
      months = months.filter((r) => r.month !== "unknown" && r.month <= toRaw);
    }

    // Sort. "month" sorts lexicographically on YYYY-MM which is also
    // chronological. "unknown" sorts last in asc / first in desc by
    // virtue of being lexicographically > "9999-12" — acceptable for
    // a defensive fallback bucket that should rarely appear.
    const [field, dir] = orderBy.split(":");
    const mult = dir === "asc" ? 1 : -1;
    months.sort((a, b) => {
      if (field === "month") {
        if (a.month < b.month) return -1 * mult;
        if (a.month > b.month) return 1 * mult;
        return 0;
      }
      return ((a[field] || 0) - (b[field] || 0)) * mult;
    });

    const totalMonths = months.length;
    const grandInvoiceCount = months.reduce(
      (acc, r) => acc + (Number(r.invoiceCount) || 0),
      0,
    );
    const grandTotalValue = round2(
      months.reduce((acc, r) => acc + (Number(r.totalValue) || 0), 0),
    );
    const grandPaidValue = round2(
      months.reduce((acc, r) => acc + (Number(r.paidValue) || 0), 0),
    );
    const grandOpenValue = round2(
      months.reduce((acc, r) => acc + (Number(r.openValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter, same as slice 16.
    const paged = months.slice(skip, skip + take);

    res.json({
      months: paged,
      totalMonths,
      grandInvoiceCount,
      grandTotalValue,
      grandPaidValue,
      grandOpenValue,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-invoices] by-month error:", e.message);
    res.status(500).json({ error: "Failed to compute monthly rollup" });
  }
});

// GET /api/travel/invoices/by-quarter — any verified token (tenant + sub-brand scoped).
//
// Slice 30 of #901 (PRD_TRAVEL_BILLING §3 — tenant-wide invoice
// analytics rolled up by calendar quarter). Mirrors #900 slice 17
// (/quotes/by-quarter) + slice 29 (/invoices/by-month) with the
// coarser-granularity quarter bucket (Q1=Jan-Mar, Q2=Apr-Jun,
// Q3=Jul-Sep, Q4=Oct-Dec — calendar quarters, not Indian-FY April-
// March). Same UTC rationale as by-month — finance reconciliation
// works in calendar quarters; FY tooling is a future overlay on top
// of this calendar-quarter primitive. Surfaces the full 5-status
// TravelInvoice envelope (Draft/Issued/Partial/Paid/Voided) plus
// paidValue + openValue (totalValue - paidValue - voidedValue).
//
// Why a separate endpoint instead of aggregate=quarter on by-month:
// callers expect different defaults (12 quarters = 3 years at quarter
// granularity is a sensible UI default; 36 months ≠ 12 quarters in the
// same fixed-width chart slot). Pre-fills the quarterly-trend tile on
// the billing dashboard with ~12 bars.
//
// Bucket key shape: "YYYY-Qn" string (e.g. "2026-Q2") derived from
// TravelInvoice.createdAt's UTC year + quarter (`Math.floor(month/3)+1`).
//
// Scope rules:
//   - Tenant-scoped on TravelInvoice.tenantId.
//   - Sub-brand-restricted: respects the caller's subBrandAccess set
//     (MANAGER restricted to their sub-brand; ADMIN full access).
//   - Any verified token; no RBAC narrowing — operator-readable read.
//
// Query string:
//   status    optional TravelInvoice.status filter
//             (Draft/Issued/Partial/Paid/Voided)
//   from      optional inclusive lower bound on bucket (YYYY-Qn); rows
//             with quarter < from are excluded
//   to        optional inclusive upper bound on bucket (YYYY-Qn); rows
//             with quarter > to are excluded
//   orderBy   default "quarter:asc" (chronological); also accepts
//             "quarter:desc", "totalValue:asc|desc", "invoiceCount:asc|desc",
//             "paidCount:asc|desc". Unknown tokens degrade silently
//             to default.
//   limit     default 12 (3 years of quarters), max 40 (10 years).
//   offset    default 0
//
// Response shape:
//   {
//     quarters: [ {
//       quarter: "2026-Q2",
//       invoiceCount, totalValue,
//       draftCount, issuedCount, partialCount, paidCount, voidedCount,
//       paidValue, openValue
//     } ],
//     totalQuarters,
//     grandInvoiceCount,
//     grandTotalValue,
//     grandPaidValue,
//     grandOpenValue,
//     limit, offset
//   }
//
// openValue per row = totalValue - paidValue - voidedValue (where
// voidedValue is the sum of totalAmount on Voided rows — voided
// invoices contribute to totalValue but neither paid nor open).
// grandOpenValue is the sum of per-row openValue, half-up rounded.
//
// Defensive behaviour: null/invalid TravelInvoice.totalAmount contributes
// 0 (no NaN poisoning); null/invalid createdAt → "unknown" bucket
// (excluded when ?from / ?to is set, kept otherwise so the count surface
// stays accurate). Half-up 2dp rounding via Number.EPSILON.
//
// Route ordering: declared BEFORE GET /invoices/:id so Express doesn't
// try to parse "by-quarter" as a numeric :id (which would 400 INVALID_ID).
router.get("/invoices/by-quarter", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 12, 40);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "quarter:asc";

    if (statusFilter) {
      try {
        assertValidStatus(statusFilter);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message, code: e.code });
      }
    }

    // YYYY-Qn validation — same regex slice 17 (/quotes/by-quarter) uses.
    // Bucket labels we emit follow this exact shape so callers passing
    // quarter-tokens to from/to should already be using it. Anything else
    // is a 400 INVALID_QUARTER_FORMAT.
    const QUARTER_RE = /^\d{4}-Q[1-4]$/;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw !== null && !QUARTER_RE.test(fromRaw)) {
      return res.status(400).json({
        error: "from must be in YYYY-Qn format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }
    if (toRaw !== null && !QUARTER_RE.test(toRaw)) {
      return res.status(400).json({
        error: "to must be in YYYY-Qn format",
        code: "INVALID_QUARTER_FORMAT",
      });
    }

    const VALID_ORDER_BY = new Set([
      "quarter:asc",
      "quarter:desc",
      "totalValue:asc",
      "totalValue:desc",
      "invoiceCount:asc",
      "invoiceCount:desc",
      "paidCount:asc",
      "paidCount:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "quarter:asc";

    // Build the tenant-scoped where. Sub-brand narrowing mirrors the
    // /invoices list handler — empty access set → all-zeros rollup (not
    // 403) so the dashboard tile renders cleanly for not-yet-onboarded
    // operators.
    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({
        quarters: [],
        totalQuarters: 0,
        grandInvoiceCount: 0,
        grandTotalValue: 0,
        grandPaidValue: 0,
        grandOpenValue: 0,
        limit: take,
        offset: skip,
      });
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY-Qn. Input size bound is the same as
    // /invoices/by-month + /invoices/aged-receivable (low thousands at
    // platinum scale).
    const invoices = await prisma.travelInvoice.findMany({
      where,
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    const round2 = (n) =>
      Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-quarter. Map "YYYY-Qn" → { ...row counts/sums }.
    // Invoices with null/invalid createdAt go into "unknown" so counts
    // stay accurate. Null/invalid totalAmount contributes 0. voidedValue
    // is tracked separately so openValue can subtract it (voided rows
    // contribute to totalValue but are neither paid nor open).
    const byQuarter = new Map();
    for (const inv of invoices) {
      let quarterKey = "unknown";
      if (inv.createdAt) {
        const dt = new Date(inv.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getUTCFullYear();
          const qn = Math.floor(dt.getUTCMonth() / 3) + 1;
          quarterKey = `${yyyy}-Q${qn}`;
        }
      }

      let row = byQuarter.get(quarterKey);
      if (!row) {
        row = {
          quarter: quarterKey,
          invoiceCount: 0,
          totalValue: 0,
          draftCount: 0,
          issuedCount: 0,
          partialCount: 0,
          paidCount: 0,
          voidedCount: 0,
          paidValue: 0,
          voidedValue: 0,
        };
        byQuarter.set(quarterKey, row);
      }

      row.invoiceCount += 1;
      const amt = Number(inv.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      row.totalValue += safeAmt;

      switch (inv.status) {
        case "Draft":
          row.draftCount += 1;
          break;
        case "Issued":
          row.issuedCount += 1;
          break;
        case "Partial":
          row.partialCount += 1;
          break;
        case "Paid":
          row.paidCount += 1;
          row.paidValue += safeAmt;
          break;
        case "Voided":
          row.voidedCount += 1;
          row.voidedValue += safeAmt;
          break;
        default:
          break;
      }
    }

    // Finalise rounding on per-row sums + compute openValue.
    // openValue = totalValue - paidValue - voidedValue (the
    // customer-owed-but-not-yet-paid surface).
    let quarters = [...byQuarter.values()].map((r) => {
      const openValue = r.totalValue - r.paidValue - r.voidedValue;
      return {
        quarter: r.quarter,
        invoiceCount: r.invoiceCount,
        totalValue: round2(r.totalValue),
        draftCount: r.draftCount,
        issuedCount: r.issuedCount,
        partialCount: r.partialCount,
        paidCount: r.paidCount,
        voidedCount: r.voidedCount,
        paidValue: round2(r.paidValue),
        openValue: round2(openValue),
      };
    });

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (no comparable token); when no bounds are set,
    // "unknown" stays so the count surface remains complete. Mirrors
    // slice 17 / slice 29's posture.
    if (fromRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter >= fromRaw);
    }
    if (toRaw !== null) {
      quarters = quarters.filter((r) => r.quarter !== "unknown" && r.quarter <= toRaw);
    }

    // Sort. "quarter" sorts lexicographically on YYYY-Qn which is also
    // chronological (Q1<Q2<Q3<Q4 sorts correctly as ASCII). "unknown"
    // lexicographically > "9999-Q4" so it sorts last in asc / first in
    // desc — acceptable for a defensive fallback bucket.
    const [field, dir] = orderBy.split(":");
    const mult = dir === "asc" ? 1 : -1;
    quarters.sort((a, b) => {
      if (field === "quarter") {
        if (a.quarter < b.quarter) return -1 * mult;
        if (a.quarter > b.quarter) return 1 * mult;
        return 0;
      }
      return ((a[field] || 0) - (b[field] || 0)) * mult;
    });

    const totalQuarters = quarters.length;
    const grandInvoiceCount = quarters.reduce(
      (acc, r) => acc + (Number(r.invoiceCount) || 0),
      0,
    );
    const grandTotalValue = round2(
      quarters.reduce((acc, r) => acc + (Number(r.totalValue) || 0), 0),
    );
    const grandPaidValue = round2(
      quarters.reduce((acc, r) => acc + (Number(r.paidValue) || 0), 0),
    );
    const grandOpenValue = round2(
      quarters.reduce((acc, r) => acc + (Number(r.openValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter, same as
    // slice 17 / slice 29.
    const paged = quarters.slice(skip, skip + take);

    res.json({
      quarters: paged,
      totalQuarters,
      grandInvoiceCount,
      grandTotalValue,
      grandPaidValue,
      grandOpenValue,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-invoices] by-quarter error:", e.message);
    res.status(500).json({ error: "Failed to compute quarterly rollup" });
  }
});

// GET /api/travel/invoices/by-year — any verified token (tenant + sub-brand scoped).
//
// Slice 31 of #901 (PRD_TRAVEL_BILLING §3 — tenant-wide invoice
// analytics rolled up by calendar year). Completes the
// by-month/by-quarter/by-year time-series triplet (slices 29/30/31) for
// the billing dashboard. Mirrors slice 30's /invoices/by-quarter with
// the coarsest-granularity year bucket; same UTC rationale as by-month
// + by-quarter (finance reconciliation works in calendar years; FY
// tooling is a future overlay on top of this calendar-year primitive).
// Also mirrors #900 slice 18 (/quotes/by-year) for shape consistency
// across the quote + invoice time-series surfaces. Surfaces the full
// 5-status TravelInvoice envelope (Draft/Issued/Partial/Paid/Voided)
// plus paidValue + openValue (totalValue - paidValue - voidedValue).
//
// Why a separate endpoint instead of aggregate=year on by-quarter:
// callers expect different defaults (10 years is a sensible UI default
// for an "annual trend" tile; 40 quarters ≠ 10 years in the same
// fixed-width chart slot). Pre-fills the annual-trend tile on the
// billing dashboard with ~10 bars.
//
// Bucket key shape: "YYYY" string (e.g. "2026") derived from
// TravelInvoice.createdAt's UTC year (`getUTCFullYear()`).
//
// Scope rules:
//   - Tenant-scoped on TravelInvoice.tenantId.
//   - Sub-brand-restricted: respects the caller's subBrandAccess set
//     (MANAGER restricted to their sub-brand; ADMIN full access).
//   - Any verified token; no RBAC narrowing — operator-readable read.
//
// Query string:
//   status    optional TravelInvoice.status filter
//             (Draft/Issued/Partial/Paid/Voided)
//   from      optional inclusive lower bound on bucket (YYYY); rows
//             with year < from are excluded
//   to        optional inclusive upper bound on bucket (YYYY); rows
//             with year > to are excluded
//   orderBy   default "year:asc" (chronological); also accepts
//             "year:desc", "totalValue:asc|desc", "invoiceCount:asc|desc",
//             "paidCount:asc|desc". Unknown tokens degrade silently
//             to default.
//   limit     default 10 (a decade), max 30.
//   offset    default 0
//
// Response shape:
//   {
//     years: [ {
//       year: "2026",
//       invoiceCount, totalValue,
//       draftCount, issuedCount, partialCount, paidCount, voidedCount,
//       paidValue, openValue
//     } ],
//     totalYears,
//     grandInvoiceCount,
//     grandTotalValue,
//     grandPaidValue,
//     grandOpenValue,
//     limit, offset
//   }
//
// openValue per row = totalValue - paidValue - voidedValue (where
// voidedValue is the sum of totalAmount on Voided rows — voided
// invoices contribute to totalValue but neither paid nor open).
// grandOpenValue is the sum of per-row openValue, half-up rounded.
//
// Defensive behaviour: null/invalid TravelInvoice.totalAmount contributes
// 0 (no NaN poisoning); null/invalid createdAt → "unknown" bucket
// (excluded when ?from / ?to is set, kept otherwise so the count surface
// stays accurate). Half-up 2dp rounding via Number.EPSILON.
//
// Route ordering: declared BEFORE GET /invoices/:id so Express doesn't
// try to parse "by-year" as a numeric :id (which would 400 INVALID_ID).
router.get("/invoices/by-year", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const take = Math.min(parseInt(req.query.limit, 10) || 10, 30);
    const skip = parseInt(req.query.offset, 10) || 0;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const orderByRaw = req.query.orderBy ? String(req.query.orderBy) : "year:asc";

    if (statusFilter) {
      try {
        assertValidStatus(statusFilter);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message, code: e.code });
      }
    }

    // YYYY validation — bucket labels we emit follow this exact shape so
    // callers passing year-tokens to from/to should already be using it.
    // Anything else is a 400 INVALID_YEAR_FORMAT.
    const YEAR_RE = /^\d{4}$/;
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw !== null && !YEAR_RE.test(fromRaw)) {
      return res.status(400).json({
        error: "from must be in YYYY format",
        code: "INVALID_YEAR_FORMAT",
      });
    }
    if (toRaw !== null && !YEAR_RE.test(toRaw)) {
      return res.status(400).json({
        error: "to must be in YYYY format",
        code: "INVALID_YEAR_FORMAT",
      });
    }

    const VALID_ORDER_BY = new Set([
      "year:asc",
      "year:desc",
      "totalValue:asc",
      "totalValue:desc",
      "invoiceCount:asc",
      "invoiceCount:desc",
      "paidCount:asc",
      "paidCount:desc",
    ]);
    const orderBy = VALID_ORDER_BY.has(orderByRaw) ? orderByRaw : "year:asc";

    // Build the tenant-scoped where. Sub-brand narrowing mirrors the
    // /invoices list handler — empty access set → all-zeros rollup (not
    // 403) so the dashboard tile renders cleanly for not-yet-onboarded
    // operators.
    const where = { tenantId: req.travelTenant.id };
    if (statusFilter) where.status = statusFilter;

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed instanceof Set && allowed.size === 0) {
      return res.json({
        years: [],
        totalYears: 0,
        grandInvoiceCount: 0,
        grandTotalValue: 0,
        grandPaidValue: 0,
        grandOpenValue: 0,
        limit: take,
        offset: skip,
      });
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    // No DB-level pagination — aggregation runs in-process so we can
    // bucket by UTC YYYY. Input size bound is the same as
    // /invoices/by-month + /invoices/by-quarter (low thousands at
    // platinum scale).
    const invoices = await prisma.travelInvoice.findMany({
      where,
      select: {
        id: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    const round2 = (n) =>
      Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    // Aggregate per-UTC-year. Map "YYYY" → { ...row counts/sums }.
    // Invoices with null/invalid createdAt go into "unknown" so counts
    // stay accurate. Null/invalid totalAmount contributes 0. voidedValue
    // is tracked separately so openValue can subtract it (voided rows
    // contribute to totalValue but are neither paid nor open).
    const byYear = new Map();
    for (const inv of invoices) {
      let yearKey = "unknown";
      if (inv.createdAt) {
        const dt = new Date(inv.createdAt);
        if (!Number.isNaN(dt.getTime())) {
          yearKey = String(dt.getUTCFullYear());
        }
      }

      let row = byYear.get(yearKey);
      if (!row) {
        row = {
          year: yearKey,
          invoiceCount: 0,
          totalValue: 0,
          draftCount: 0,
          issuedCount: 0,
          partialCount: 0,
          paidCount: 0,
          voidedCount: 0,
          paidValue: 0,
          voidedValue: 0,
        };
        byYear.set(yearKey, row);
      }

      row.invoiceCount += 1;
      const amt = Number(inv.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      row.totalValue += safeAmt;

      switch (inv.status) {
        case "Draft":
          row.draftCount += 1;
          break;
        case "Issued":
          row.issuedCount += 1;
          break;
        case "Partial":
          row.partialCount += 1;
          break;
        case "Paid":
          row.paidCount += 1;
          row.paidValue += safeAmt;
          break;
        case "Voided":
          row.voidedCount += 1;
          row.voidedValue += safeAmt;
          break;
        default:
          break;
      }
    }

    // Finalise rounding on per-row sums + compute openValue.
    // openValue = totalValue - paidValue - voidedValue (the
    // customer-owed-but-not-yet-paid surface).
    let years = [...byYear.values()].map((r) => {
      const openValue = r.totalValue - r.paidValue - r.voidedValue;
      return {
        year: r.year,
        invoiceCount: r.invoiceCount,
        totalValue: round2(r.totalValue),
        draftCount: r.draftCount,
        issuedCount: r.issuedCount,
        partialCount: r.partialCount,
        paidCount: r.paidCount,
        voidedCount: r.voidedCount,
        paidValue: round2(r.paidValue),
        openValue: round2(openValue),
      };
    });

    // Apply ?from / ?to bucket filter. "unknown" rows are excluded when
    // either bound is set (no comparable token); when no bounds are set,
    // "unknown" stays so the count surface remains complete. Mirrors
    // slices 29 + 30's posture.
    if (fromRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year >= fromRaw);
    }
    if (toRaw !== null) {
      years = years.filter((r) => r.year !== "unknown" && r.year <= toRaw);
    }

    // Sort. "year" sorts lexicographically on YYYY which is also
    // chronological (4-digit zero-padded years sort correctly as ASCII).
    // "unknown" lexicographically > "9999" so it sorts last in asc /
    // first in desc — acceptable for a defensive fallback bucket.
    const [field, dir] = orderBy.split(":");
    const mult = dir === "asc" ? 1 : -1;
    years.sort((a, b) => {
      if (field === "year") {
        if (a.year < b.year) return -1 * mult;
        if (a.year > b.year) return 1 * mult;
        return 0;
      }
      return ((a[field] || 0) - (b[field] || 0)) * mult;
    });

    const totalYears = years.length;
    const grandInvoiceCount = years.reduce(
      (acc, r) => acc + (Number(r.invoiceCount) || 0),
      0,
    );
    const grandTotalValue = round2(
      years.reduce((acc, r) => acc + (Number(r.totalValue) || 0), 0),
    );
    const grandPaidValue = round2(
      years.reduce((acc, r) => acc + (Number(r.paidValue) || 0), 0),
    );
    const grandOpenValue = round2(
      years.reduce((acc, r) => acc + (Number(r.openValue) || 0), 0),
    );

    // Pagination applied AFTER aggregation + sort + filter, same as
    // slices 29 + 30.
    const paged = years.slice(skip, skip + take);

    res.json({
      years: paged,
      totalYears,
      grandInvoiceCount,
      grandTotalValue,
      grandPaidValue,
      grandOpenValue,
      limit: take,
      offset: skip,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-invoices] by-year error:", e.message);
    res.status(500).json({ error: "Failed to compute annual rollup" });
  }
});

// ============================================================================
// GET /api/travel/invoices/hsn-summary — Arc 2 #902 slice 17.
//
// PRD_TRAVEL_GST_COMPLIANCE.md FR-3.4.3: HSN/SAC summary report for a filing
// period. One row per (SAC code, GST rate) cohort with aggregate count,
// taxable value, IGST, CGST, and SGST. Differs from /gstr1-export in three
// ways:
//   (1) JSON by default (?format=csv opts into the CSV alternate);
//   (2) single section only (no B2B_INVOICES / DOCUMENT_TOTALS roll-ups);
//   (3) ?docType= optional filter — operators reconciling a specific class
//       (e.g. CreditNote-only HSN summary) get a narrow slice. Default
//       includes the same docType set as GSTR-1 (TaxInvoice + CreditNote +
//       DebitNote; excludes Proforma + TravelVoucher).
//
// === Date range ===
//
// `month=YYYY-MM` resolves to a half-open `[start, end)` interval on
// createdAt — same cohort convention as /gstr1-export so the two reports
// always reconcile to the same denominator.
//
// === Auth ===
//
// ADMIN / MANAGER only — finance-report surface, mirrors /gstr1-export.
//
// === Sub-brand scoping ===
//
// Caller's subBrandAccess narrows the result; explicit ?subBrand= filter
// is intersected with the access set (silent empty when caller can't
// access the requested brand — same pattern as gstr1-export).
//
// === Output shape (JSON) ===
//
//   {
//     month: 'YYYY-MM',
//     subBrand: 'tmc' | 'all',
//     docTypes: ['TaxInvoice', 'CreditNote', 'DebitNote'],
//     rows: [
//       { sacCode, description, gstPercent, taxableValue, igst, cgst, sgst,
//         totalTax, count }
//     ],
//     totals: { taxableValue, igst, cgst, sgst, totalTax, lineCount }
//   }
//
// === Output shape (CSV) ===
//
// Single section, BOM-prefixed UTF-8 with CRLF (mirrors gstr1-export
// conventions). Filename: `hsn-summary-<month>-<subBrand>.csv`.
//
// === Error codes ===
//
//   - INVALID_MONTH (400)
//   - INVALID_SUB_BRAND (400)
//   - INVALID_DOC_TYPE (400) — when ?docType= isn't in the canonical set
//   - INVALID_FORMAT (400) — when ?format= is anything other than
//     'json' (default) or 'csv'
//
// ============================================================================
const HSN_SUMMARY_DEFAULT_DOC_TYPES = ["TaxInvoice", "CreditNote", "DebitNote"];

router.get(
  "/invoices/hsn-summary",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "read"),
  async (req, res) => {
    try {
      const { year, month, start, end } = parseFilingMonth(req.query.month);

      let subBrandFilter = null;
      if (req.query.subBrand != null && String(req.query.subBrand).trim() !== "") {
        const sb = String(req.query.subBrand).trim();
        assertValidSubBrand(sb);
        subBrandFilter = sb;
      }

      let docTypes = HSN_SUMMARY_DEFAULT_DOC_TYPES;
      if (req.query.docType != null && String(req.query.docType).trim() !== "") {
        const dt = String(req.query.docType).trim();
        if (!HSN_SUMMARY_DEFAULT_DOC_TYPES.includes(dt)) {
          return res.status(400).json({
            error: `docType must be one of: ${HSN_SUMMARY_DEFAULT_DOC_TYPES.join(", ")}`,
            code: "INVALID_DOC_TYPE",
          });
        }
        docTypes = [dt];
      }

      const format = req.query.format != null
        ? String(req.query.format).trim().toLowerCase()
        : "json";
      if (format !== "json" && format !== "csv") {
        return res.status(400).json({
          error: "format must be 'json' or 'csv'",
          code: "INVALID_FORMAT",
        });
      }

      const where = {
        tenantId: req.travelTenant.id,
        createdAt: { gte: start, lt: end },
        docType: { in: docTypes },
      };
      if (subBrandFilter) where.subBrand = subBrandFilter;

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.subBrand = where.subBrand
          ? canAccessSubBrand(allowed, where.subBrand)
            ? where.subBrand
            : "__none__"
          : { in: [...allowed] };
      }

      const invoices = await prisma.travelInvoice.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      const invoiceIds = invoices.map((i) => i.id);
      const allLines =
        invoiceIds.length > 0
          ? await prisma.travelInvoiceLine.findMany({
              where: {
                invoiceId: { in: invoiceIds },
                tenantId: req.travelTenant.id,
              },
              orderBy: [{ invoiceId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
            })
          : [];
      const linesByInvoice = new Map();
      for (const l of allLines) {
        if (!linesByInvoice.has(l.invoiceId)) linesByInvoice.set(l.invoiceId, []);
        linesByInvoice.get(l.invoiceId).push(l);
      }

      // Cache state-code resolutions per contact — multiple invoices for
      // the same customer share the same operator/customer state pair.
      const stateCodeCache = new Map();
      async function getInterstateForInvoice(invoice) {
        if (stateCodeCache.has(invoice.contactId)) {
          return stateCodeCache.get(invoice.contactId);
        }
        const codes = await resolveStateCodes({
          prisma,
          tenantId: req.travelTenant.id,
          contactId: invoice.contactId,
          operatorOverride: null,
          customerOverride: null,
        });
        let isInterstate;
        try {
          isInterstate = isInterstateSupply(
            codes.operatorStateCode,
            codes.customerStateCode,
          );
        } catch (_e) {
          isInterstate = false;
        }
        const result = { ...codes, isInterstate };
        stateCodeCache.set(invoice.contactId, result);
        return result;
      }

      // Aggregate lines into (sacCode, gstPercent) buckets — same math as
      // gstr1-export but emitted as a standalone payload (no other sections).
      const buckets = new Map();
      for (const inv of invoices) {
        const lines = linesByInvoice.get(inv.id) || [];
        const { isInterstate } = await getInterstateForInvoice(inv);
        const normalized = lines.map((l) => ({
          lineType: l.lineType,
          taxableValue: Number(l.amount || 0),
          gstPercent: gstRateForCategory(l.lineType),
        }));
        const grouped = groupLinesBySac(normalized);
        for (const g of grouped) {
          const key = `${g.sacCode}:${g.gstPercent}`;
          if (!buckets.has(key)) {
            buckets.set(key, {
              sacCode: g.sacCode,
              description: g.description,
              gstPercent: g.gstPercent,
              taxableValue: 0,
              count: 0,
              igst: 0,
              cgst: 0,
              sgst: 0,
            });
          }
          const acc = buckets.get(key);
          const totalTax =
            Math.round(((g.taxableValue * g.gstPercent) / 100) * 100) / 100;
          acc.taxableValue =
            Math.round((acc.taxableValue + g.taxableValue) * 100) / 100;
          acc.count += g.count;
          if (isInterstate) {
            acc.igst = Math.round((acc.igst + totalTax) * 100) / 100;
          } else {
            const half = Math.round((totalTax / 2) * 100) / 100;
            acc.cgst = Math.round((acc.cgst + half) * 100) / 100;
            acc.sgst = Math.round((acc.sgst + half) * 100) / 100;
          }
        }
      }

      const rows = [...buckets.values()]
        .map((r) => ({
          ...r,
          totalTax: Math.round((r.igst + r.cgst + r.sgst) * 100) / 100,
        }))
        .sort((a, b) =>
          a.sacCode === b.sacCode
            ? a.gstPercent - b.gstPercent
            : a.sacCode.localeCompare(b.sacCode),
        );

      const totals = rows.reduce(
        (acc, r) => {
          acc.taxableValue = Math.round((acc.taxableValue + r.taxableValue) * 100) / 100;
          acc.igst = Math.round((acc.igst + r.igst) * 100) / 100;
          acc.cgst = Math.round((acc.cgst + r.cgst) * 100) / 100;
          acc.sgst = Math.round((acc.sgst + r.sgst) * 100) / 100;
          acc.totalTax = Math.round((acc.totalTax + r.totalTax) * 100) / 100;
          acc.lineCount += r.count;
          return acc;
        },
        { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, totalTax: 0, lineCount: 0 },
      );

      const monthLabel = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;

      if (format === "csv") {
        const CRLF = "\r\n";
        const BOM = "﻿";
        const parts = [];
        parts.push(
          `# HSN_SUMMARY month=${monthLabel} subBrand=${subBrandFilter || "ALL"} docTypes=${docTypes.join("|")}`,
        );
        parts.push("");
        parts.push(
          [
            "SAC_Code",
            "Description",
            "GST_Rate",
            "Total_Lines",
            "Taxable_Value",
            "IGST",
            "CGST",
            "SGST",
            "Total_Tax",
          ]
            .map(csvEscape)
            .join(","),
        );
        for (const r of rows) {
          parts.push(
            [
              r.sacCode,
              r.description,
              formatMoney(r.gstPercent),
              String(r.count),
              formatMoney(r.taxableValue),
              formatMoney(r.igst),
              formatMoney(r.cgst),
              formatMoney(r.sgst),
              formatMoney(r.totalTax),
            ]
              .map(csvEscape)
              .join(","),
          );
        }
        const csv = BOM + parts.join(CRLF) + CRLF;
        const filename = `hsn-summary-${monthLabel}-${subBrandFilter || "all"}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        return res.status(200).send(csv);
      }

      return res.status(200).json({
        month: monthLabel,
        subBrand: subBrandFilter || "all",
        docTypes,
        rows,
        totals,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] hsn-summary error:", e.message);
      res.status(500).json({ error: "Failed to generate HSN summary" });
    }
  },
);

// ============================================================================
// Arc 2 #902 slice 18 — GET /api/travel/invoices/gstr-3b
// (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.4.2 GSTR-3B summary).
//
// Monthly GSTR-3B summary export — single govt-spec aggregate (5 sections)
// per filing month. Bucket math reuses the SAC-bearing + interstate logic
// established by gstr1-export (slice 10) + hsn-summary (slice 17).
//
// === Sections emitted ===
//
//   3.1.a  Outward taxable supplies (excl. zero-rated / nil-rated)
//          — non-export INR invoices, lines with gstPercent > 0
//   3.1.b  Outward zero-rated supplies
//          — non-INR (export of service, NFR-4.4)
//   3.1.c  Outward nil-rated / exempt
//          — INR lines whose lineType maps to gstRateForCategory === 0
//   3.1.d  Inward supplies liable to RCM (operator-side purchases)
//          — placeholder 0 at launch (no inward RCM persistence yet;
//          will land with DD-5.3 once operator-toggled per-invoice RCM
//          flag schema lands; doc-comment + zeroed envelope so the
//          shape is stable today)
//   3.2    Inter-state to unregistered (b2cl + b2cs aggregate)
//          — invoices where isInterstate AND contact has no GSTIN
//          (Contact.gstin not in scope yet, so currently the gate
//          collapses to "all inter-state non-export invoices" — when
//          Contact.gstin lands per FR-3.3.4, the gate tightens)
//   6.1    Net tax payable
//          — sum(3.1.a CGST/SGST/IGST) + (3.1.d RCM, currently 0)
//          minus ITC (not tracked here — 0)
//
// === Query params ===
//
//   ?month=YYYY-MM     REQUIRED   filing month (e.g. 2026-05)
//   ?subBrand=tmc      OPTIONAL   narrow to one sub-brand
//   ?format=json|csv   OPTIONAL   default json
//
// === Response (JSON) ===
//
//   {
//     month: "2026-05",
//     subBrand: "tmc" | "all",
//     sections: {
//       "3.1.a": { taxableValue, igst, cgst, sgst, totalTax, invoiceCount },
//       "3.1.b": { taxableValue, invoiceCount },
//       "3.1.c": { taxableValue, invoiceCount },
//       "3.1.d": { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 },
//       "3.2":   { taxableValue, igst, invoiceCount },
//       "6.1":   { netPayable, totalIgst, totalCgst, totalSgst }
//     }
//   }
//
// CSV format: BOM + CRLF, one section block per row group, filename
// `gstr-3b-<month>-<subBrand|all>.csv`. Mirrors gstr1-export conventions.
//
// === Auth ===
//
//   verifyToken + verifyRole(ADMIN | MANAGER) + requireTravelTenant +
//   sub-brand access narrowing via getSubBrandAccessSet.
//
// === Error codes ===
//
//   - INVALID_MONTH (400)
//   - INVALID_SUB_BRAND (400)
//   - INVALID_FORMAT (400)
//
// ============================================================================
const GSTR3B_DOC_TYPES = ["TaxInvoice", "CreditNote", "DebitNote"];

router.get(
  "/invoices/gstr-3b",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "read"),
  async (req, res) => {
    try {
      const { year, month, start, end } = parseFilingMonth(req.query.month);

      let subBrandFilter = null;
      if (req.query.subBrand != null && String(req.query.subBrand).trim() !== "") {
        const sb = String(req.query.subBrand).trim();
        assertValidSubBrand(sb);
        subBrandFilter = sb;
      }

      const format = req.query.format != null
        ? String(req.query.format).trim().toLowerCase()
        : "json";
      if (format !== "json" && format !== "csv") {
        return res.status(400).json({
          error: "format must be 'json' or 'csv'",
          code: "INVALID_FORMAT",
        });
      }

      const where = {
        tenantId: req.travelTenant.id,
        createdAt: { gte: start, lt: end },
        docType: { in: GSTR3B_DOC_TYPES },
      };
      if (subBrandFilter) where.subBrand = subBrandFilter;

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.subBrand = where.subBrand
          ? canAccessSubBrand(allowed, where.subBrand)
            ? where.subBrand
            : "__none__"
          : { in: [...allowed] };
      }

      const invoices = await prisma.travelInvoice.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      const invoiceIds = invoices.map((i) => i.id);
      const allLines =
        invoiceIds.length > 0
          ? await prisma.travelInvoiceLine.findMany({
              where: {
                invoiceId: { in: invoiceIds },
                tenantId: req.travelTenant.id,
              },
              orderBy: [{ invoiceId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
            })
          : [];
      const linesByInvoice = new Map();
      for (const l of allLines) {
        if (!linesByInvoice.has(l.invoiceId)) linesByInvoice.set(l.invoiceId, []);
        linesByInvoice.get(l.invoiceId).push(l);
      }

      // Cache state-code resolutions per contactId.
      const stateCodeCache = new Map();
      async function getInterstateForInvoice(invoice) {
        if (stateCodeCache.has(invoice.contactId)) {
          return stateCodeCache.get(invoice.contactId);
        }
        const codes = await resolveStateCodes({
          prisma,
          tenantId: req.travelTenant.id,
          contactId: invoice.contactId,
          operatorOverride: null,
          customerOverride: null,
        });
        let isInterstate;
        try {
          isInterstate = isInterstateSupply(
            codes.operatorStateCode,
            codes.customerStateCode,
          );
        } catch (_e) {
          isInterstate = false;
        }
        const result = { ...codes, isInterstate };
        stateCodeCache.set(invoice.contactId, result);
        return result;
      }

      // === Aggregate sections ===
      // 3.1.a — taxable INR supplies (gstPercent > 0)
      // 3.1.b — zero-rated (non-INR / export)
      // 3.1.c — nil-rated (gstPercent === 0 on INR lines)
      // 3.1.d — inward RCM (placeholder 0)
      // 3.2   — inter-state to unregistered
      const sec_3_1_a = {
        taxableValue: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
        totalTax: 0,
        invoiceCount: 0,
      };
      const sec_3_1_b = { taxableValue: 0, invoiceCount: 0 };
      const sec_3_1_c = { taxableValue: 0, invoiceCount: 0 };
      const sec_3_1_d = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 };
      const sec_3_2 = { taxableValue: 0, igst: 0, invoiceCount: 0 };

      for (const inv of invoices) {
        const lines = linesByInvoice.get(inv.id) || [];
        const invoiceCurrency = String(inv.currency || "INR").toUpperCase();
        const isExport = invoiceCurrency !== "INR";
        const { isInterstate } = isExport
          ? { isInterstate: false }
          : await getInterstateForInvoice(inv);

        let invoiceContributedToA = false;
        let invoiceContributedToB = false;
        let invoiceContributedToC = false;
        let invoiceContributedTo32 = false;
        let invoiceTaxable32 = 0;
        let invoiceIgst32 = 0;

        for (const l of lines) {
          // Skip non-SAC-bearing line types (tax / fee / tcs / tds —
          // double-counted in parent gstPercent or withholding-only).
          if (sacForLineType(l.lineType) === null) continue;
          const amt = Number(l.amount || 0);

          if (isExport) {
            // 3.1.b — zero-rated. No CGST/SGST/IGST routing.
            sec_3_1_b.taxableValue =
              Math.round((sec_3_1_b.taxableValue + amt) * 100) / 100;
            invoiceContributedToB = true;
            continue;
          }

          const rate = gstRateForCategory(l.lineType);
          if (rate === 0) {
            // 3.1.c — nil-rated / exempt.
            sec_3_1_c.taxableValue =
              Math.round((sec_3_1_c.taxableValue + amt) * 100) / 100;
            invoiceContributedToC = true;
            continue;
          }

          // 3.1.a — outward taxable supplies (taxable INR with gstPercent > 0).
          const tax = Math.round(((amt * rate) / 100) * 100) / 100;
          sec_3_1_a.taxableValue =
            Math.round((sec_3_1_a.taxableValue + amt) * 100) / 100;
          if (isInterstate) {
            sec_3_1_a.igst = Math.round((sec_3_1_a.igst + tax) * 100) / 100;
            // 3.2 — inter-state to unregistered. At launch the
            // "unregistered" gate is implicit (Contact.gstin doesn't
            // exist in schema yet — FR-3.3.4 lands later); all
            // inter-state non-export rows contribute.
            invoiceTaxable32 = Math.round((invoiceTaxable32 + amt) * 100) / 100;
            invoiceIgst32 = Math.round((invoiceIgst32 + tax) * 100) / 100;
            invoiceContributedTo32 = true;
          } else {
            const half = Math.round((tax / 2) * 100) / 100;
            sec_3_1_a.cgst = Math.round((sec_3_1_a.cgst + half) * 100) / 100;
            sec_3_1_a.sgst = Math.round((sec_3_1_a.sgst + half) * 100) / 100;
          }
          invoiceContributedToA = true;
        }

        if (invoiceContributedToA) sec_3_1_a.invoiceCount += 1;
        if (invoiceContributedToB) sec_3_1_b.invoiceCount += 1;
        if (invoiceContributedToC) sec_3_1_c.invoiceCount += 1;
        if (invoiceContributedTo32) {
          sec_3_2.taxableValue =
            Math.round((sec_3_2.taxableValue + invoiceTaxable32) * 100) / 100;
          sec_3_2.igst = Math.round((sec_3_2.igst + invoiceIgst32) * 100) / 100;
          sec_3_2.invoiceCount += 1;
        }
      }

      sec_3_1_a.totalTax =
        Math.round((sec_3_1_a.igst + sec_3_1_a.cgst + sec_3_1_a.sgst) * 100) /
        100;

      // 6.1 — net payable. Output tax (3.1.a + 3.1.d) minus ITC (0).
      const sec_6_1 = {
        netPayable:
          Math.round((sec_3_1_a.totalTax + sec_3_1_d.igst + sec_3_1_d.cgst + sec_3_1_d.sgst) * 100) /
          100,
        totalIgst: Math.round((sec_3_1_a.igst + sec_3_1_d.igst) * 100) / 100,
        totalCgst: Math.round((sec_3_1_a.cgst + sec_3_1_d.cgst) * 100) / 100,
        totalSgst: Math.round((sec_3_1_a.sgst + sec_3_1_d.sgst) * 100) / 100,
      };

      const monthLabel = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;

      const sections = {
        "3.1.a": sec_3_1_a,
        "3.1.b": sec_3_1_b,
        "3.1.c": sec_3_1_c,
        "3.1.d": sec_3_1_d,
        "3.2": sec_3_2,
        "6.1": sec_6_1,
      };

      if (format === "csv") {
        const CRLF = "\r\n";
        const BOM = "﻿";
        const parts = [];
        parts.push(
          `# GSTR3B_SUMMARY month=${monthLabel} subBrand=${subBrandFilter || "ALL"}`,
        );
        parts.push("");
        parts.push("# 3.1.a OUTWARD_TAXABLE");
        parts.push(
          ["Section", "Taxable_Value", "IGST", "CGST", "SGST", "Total_Tax", "Invoice_Count"]
            .map(csvEscape)
            .join(","),
        );
        parts.push(
          [
            "3.1.a",
            formatMoney(sec_3_1_a.taxableValue),
            formatMoney(sec_3_1_a.igst),
            formatMoney(sec_3_1_a.cgst),
            formatMoney(sec_3_1_a.sgst),
            formatMoney(sec_3_1_a.totalTax),
            String(sec_3_1_a.invoiceCount),
          ]
            .map(csvEscape)
            .join(","),
        );
        parts.push("");
        parts.push("# 3.1.b OUTWARD_ZERO_RATED");
        parts.push(["Section", "Taxable_Value", "Invoice_Count"].map(csvEscape).join(","));
        parts.push(
          ["3.1.b", formatMoney(sec_3_1_b.taxableValue), String(sec_3_1_b.invoiceCount)]
            .map(csvEscape)
            .join(","),
        );
        parts.push("");
        parts.push("# 3.1.c OUTWARD_NIL_RATED");
        parts.push(["Section", "Taxable_Value", "Invoice_Count"].map(csvEscape).join(","));
        parts.push(
          ["3.1.c", formatMoney(sec_3_1_c.taxableValue), String(sec_3_1_c.invoiceCount)]
            .map(csvEscape)
            .join(","),
        );
        parts.push("");
        parts.push("# 3.1.d INWARD_RCM");
        parts.push(["Section", "Taxable_Value", "IGST", "CGST", "SGST"].map(csvEscape).join(","));
        parts.push(
          [
            "3.1.d",
            formatMoney(sec_3_1_d.taxableValue),
            formatMoney(sec_3_1_d.igst),
            formatMoney(sec_3_1_d.cgst),
            formatMoney(sec_3_1_d.sgst),
          ]
            .map(csvEscape)
            .join(","),
        );
        parts.push("");
        parts.push("# 3.2 INTER_STATE_UNREGISTERED");
        parts.push(["Section", "Taxable_Value", "IGST", "Invoice_Count"].map(csvEscape).join(","));
        parts.push(
          [
            "3.2",
            formatMoney(sec_3_2.taxableValue),
            formatMoney(sec_3_2.igst),
            String(sec_3_2.invoiceCount),
          ]
            .map(csvEscape)
            .join(","),
        );
        parts.push("");
        parts.push("# 6.1 NET_PAYABLE");
        parts.push(["Section", "Net_Payable", "Total_IGST", "Total_CGST", "Total_SGST"].map(csvEscape).join(","));
        parts.push(
          [
            "6.1",
            formatMoney(sec_6_1.netPayable),
            formatMoney(sec_6_1.totalIgst),
            formatMoney(sec_6_1.totalCgst),
            formatMoney(sec_6_1.totalSgst),
          ]
            .map(csvEscape)
            .join(","),
        );

        const csv = BOM + parts.join(CRLF) + CRLF;
        const filename = `gstr-3b-${monthLabel}-${subBrandFilter || "all"}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        return res.status(200).send(csv);
      }

      return res.status(200).json({
        month: monthLabel,
        subBrand: subBrandFilter || "all",
        sections,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] gstr-3b error:", e.message);
      res.status(500).json({ error: "Failed to generate GSTR-3B summary" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/tax-summary — Arc 2 #902 slice 19.
//
// PRD_TRAVEL_GST_COMPLIANCE.md FR-3.4 (returns + reports family). An executive
// cross-sub-brand tax rollup over a flexible date range — complements the
// month-bucketed filing exports (gstr1-export, gstr-3b, hsn-summary) by
// answering: "across all sub-brands, what tax did we collect between
// these two dates?". Useful for FY closes, quarter reviews, cash-flow
// planning, and CFO dashboards — none of which align to a single GST
// filing month.
//
// === Differs from existing exports ===
//
//   - Flexible date range (?from + ?to) — not month-bucketed.
//   - Per-sub-brand rollup rows + a grandTotal envelope — surfaces
//     cross-brand contribution at a glance.
//   - JSON only (no CSV) — dashboard-shaped, not filing-shaped. Operators
//     who want CSV use gstr1-export / hsn-summary instead.
//   - INR-only by default (?currency=ALL opts in to including non-INR).
//     NFR-4.4 specifies GST is computed only on INR invoices; non-INR
//     rows therefore have zero tax contribution and would clutter the
//     summary without being actionable.
//   - No state-of-supply expansion: per-sub-brand row carries the same
//     taxableValue / IGST / CGST / SGST shape as hsn-summary (interstate
//     vs intrastate decided per-invoice via resolveStateCodes).
//
// === Query params ===
//
//   ?from=YYYY-MM-DD   REQUIRED   inclusive start (UTC midnight)
//   ?to=YYYY-MM-DD     REQUIRED   inclusive end (next-day UTC midnight, half-open)
//   ?subBrand=tmc      OPTIONAL   narrow to one sub-brand
//   ?currency=INR|ALL  OPTIONAL   default INR (NFR-4.4 — non-INR rows
//                                 carry zero tax contribution)
//
// === Response (JSON) ===
//
//   {
//     from: "2026-04-01",
//     to: "2026-06-30",
//     subBrand: "all" | "tmc",
//     currency: "INR" | "ALL",
//     docTypes: ["TaxInvoice", "CreditNote", "DebitNote"],
//     perSubBrand: [
//       { subBrand, taxableValue, igst, cgst, sgst, totalTax,
//         invoiceCount, lineCount },
//       ...
//     ],
//     grandTotal: { taxableValue, igst, cgst, sgst, totalTax,
//                   invoiceCount, lineCount }
//   }
//
// === Auth ===
//
//   verifyToken + verifyRole(ADMIN | MANAGER) + requireTravelTenant +
//   sub-brand access narrowing via getSubBrandAccessSet.
//
// === Error codes ===
//
//   - INVALID_DATE_RANGE (400) — missing from/to, malformed, or to < from
//   - INVALID_SUB_BRAND (400)
//   - INVALID_CURRENCY (400) — when ?currency= isn't 'INR' or 'ALL'
//
// === Math ===
//
//   Reuses gstRateForCategory + groupLinesBySac (line-level SAC grouping)
//   then folds each invoice's interstate/intrastate decision via
//   resolveStateCodes + isInterstateSupply (same per-contact cache pattern
//   as hsn-summary). All money values rounded half-up to 2dp.
//
// ============================================================================
const TAX_SUMMARY_DOC_TYPES = ["TaxInvoice", "CreditNote", "DebitNote"];

function parseTaxSummaryDateRange(rawFrom, rawTo) {
  const dateRe = /^(\d{4})-(\d{2})-(\d{2})$/;
  if (rawFrom == null || rawTo == null) {
    const e = new Error("from and to query params are required (YYYY-MM-DD)");
    e.status = 400;
    e.code = "INVALID_DATE_RANGE";
    throw e;
  }
  const fromStr = String(rawFrom).trim();
  const toStr = String(rawTo).trim();
  const fm = fromStr.match(dateRe);
  const tm = toStr.match(dateRe);
  if (!fm || !tm) {
    const e = new Error("from/to must be YYYY-MM-DD");
    e.status = 400;
    e.code = "INVALID_DATE_RANGE";
    throw e;
  }
  const start = new Date(Date.UTC(+fm[1], +fm[2] - 1, +fm[3]));
  const endInclusive = new Date(Date.UTC(+tm[1], +tm[2] - 1, +tm[3]));
  if (Number.isNaN(start.getTime()) || Number.isNaN(endInclusive.getTime())) {
    const e = new Error("from/to are not valid calendar dates");
    e.status = 400;
    e.code = "INVALID_DATE_RANGE";
    throw e;
  }
  if (endInclusive < start) {
    const e = new Error("to must be on or after from");
    e.status = 400;
    e.code = "INVALID_DATE_RANGE";
    throw e;
  }
  // Half-open [start, end) — end is one day past the inclusive `to`.
  const end = new Date(endInclusive.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, fromStr, toStr };
}

router.get(
  "/invoices/tax-summary",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "read"),
  async (req, res) => {
    try {
      const { start, end, fromStr, toStr } = parseTaxSummaryDateRange(
        req.query.from,
        req.query.to,
      );

      let subBrandFilter = null;
      if (req.query.subBrand != null && String(req.query.subBrand).trim() !== "") {
        const sb = String(req.query.subBrand).trim();
        assertValidSubBrand(sb);
        subBrandFilter = sb;
      }

      const currencyParam =
        req.query.currency != null
          ? String(req.query.currency).trim().toUpperCase()
          : "INR";
      if (currencyParam !== "INR" && currencyParam !== "ALL") {
        return res.status(400).json({
          error: "currency must be 'INR' or 'ALL'",
          code: "INVALID_CURRENCY",
        });
      }

      const where = {
        tenantId: req.travelTenant.id,
        createdAt: { gte: start, lt: end },
        docType: { in: TAX_SUMMARY_DOC_TYPES },
      };
      if (subBrandFilter) where.subBrand = subBrandFilter;
      if (currencyParam === "INR") where.currency = "INR";

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.subBrand = where.subBrand
          ? canAccessSubBrand(allowed, where.subBrand)
            ? where.subBrand
            : "__none__"
          : { in: [...allowed] };
      }

      const invoices = await prisma.travelInvoice.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      const invoiceIds = invoices.map((i) => i.id);
      const allLines =
        invoiceIds.length > 0
          ? await prisma.travelInvoiceLine.findMany({
              where: {
                invoiceId: { in: invoiceIds },
                tenantId: req.travelTenant.id,
              },
              orderBy: [{ invoiceId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
            })
          : [];
      const linesByInvoice = new Map();
      for (const l of allLines) {
        if (!linesByInvoice.has(l.invoiceId)) linesByInvoice.set(l.invoiceId, []);
        linesByInvoice.get(l.invoiceId).push(l);
      }

      // Per-contact state-code cache (same pattern as hsn-summary).
      const stateCodeCache = new Map();
      async function getInterstateForInvoice(invoice) {
        if (stateCodeCache.has(invoice.contactId)) {
          return stateCodeCache.get(invoice.contactId);
        }
        const codes = await resolveStateCodes({
          prisma,
          tenantId: req.travelTenant.id,
          contactId: invoice.contactId,
          operatorOverride: null,
          customerOverride: null,
        });
        let isInterstate;
        try {
          isInterstate = isInterstateSupply(
            codes.operatorStateCode,
            codes.customerStateCode,
          );
        } catch (_e) {
          isInterstate = false;
        }
        const result = { isInterstate };
        stateCodeCache.set(invoice.contactId, result);
        return result;
      }

      // Per-sub-brand accumulator. Initialised lazily on first hit.
      const perSubBrand = new Map();
      function getOrInitBucket(sb) {
        if (!perSubBrand.has(sb)) {
          perSubBrand.set(sb, {
            subBrand: sb,
            taxableValue: 0,
            igst: 0,
            cgst: 0,
            sgst: 0,
            totalTax: 0,
            invoiceCount: 0,
            lineCount: 0,
          });
        }
        return perSubBrand.get(sb);
      }

      for (const inv of invoices) {
        const bucket = getOrInitBucket(inv.subBrand);
        bucket.invoiceCount += 1;
        const lines = linesByInvoice.get(inv.id) || [];
        const { isInterstate } = await getInterstateForInvoice(inv);
        const normalized = lines.map((l) => ({
          lineType: l.lineType,
          taxableValue: Number(l.amount || 0),
          gstPercent: gstRateForCategory(l.lineType),
        }));
        const grouped = groupLinesBySac(normalized);
        for (const g of grouped) {
          const totalTax =
            Math.round(((g.taxableValue * g.gstPercent) / 100) * 100) / 100;
          bucket.taxableValue =
            Math.round((bucket.taxableValue + g.taxableValue) * 100) / 100;
          bucket.lineCount += g.count;
          if (isInterstate) {
            bucket.igst = Math.round((bucket.igst + totalTax) * 100) / 100;
          } else {
            const half = Math.round((totalTax / 2) * 100) / 100;
            bucket.cgst = Math.round((bucket.cgst + half) * 100) / 100;
            bucket.sgst = Math.round((bucket.sgst + half) * 100) / 100;
          }
          bucket.totalTax =
            Math.round((bucket.igst + bucket.cgst + bucket.sgst) * 100) / 100;
        }
      }

      const perSubBrandRows = [...perSubBrand.values()].sort((a, b) =>
        a.subBrand.localeCompare(b.subBrand),
      );

      const grandTotal = perSubBrandRows.reduce(
        (acc, r) => {
          acc.taxableValue =
            Math.round((acc.taxableValue + r.taxableValue) * 100) / 100;
          acc.igst = Math.round((acc.igst + r.igst) * 100) / 100;
          acc.cgst = Math.round((acc.cgst + r.cgst) * 100) / 100;
          acc.sgst = Math.round((acc.sgst + r.sgst) * 100) / 100;
          acc.totalTax = Math.round((acc.totalTax + r.totalTax) * 100) / 100;
          acc.invoiceCount += r.invoiceCount;
          acc.lineCount += r.lineCount;
          return acc;
        },
        {
          taxableValue: 0,
          igst: 0,
          cgst: 0,
          sgst: 0,
          totalTax: 0,
          invoiceCount: 0,
          lineCount: 0,
        },
      );

      return res.status(200).json({
        from: fromStr,
        to: toStr,
        subBrand: subBrandFilter || "all",
        currency: currencyParam,
        docTypes: TAX_SUMMARY_DOC_TYPES,
        perSubBrand: perSubBrandRows,
        grandTotal,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] tax-summary error:", e.message);
      res.status(500).json({ error: "Failed to generate tax summary" });
    }
  },
);

// GET /api/travel/invoices/stats
//
// #901 slice 32 (PRD_TRAVEL_BILLING §3) — tenant-wide rollup KPI tile for
// the Travel billing dashboard. Mirrors #900 slice 19 (/quotes/stats) +
// #903 slice 23 (/suppliers/stats) — same envelope shape, swapping
// TravelQuote → TravelInvoice + 4-status → 5-status taxonomy
// (Draft|Issued|Partial|Paid|Voided) + acceptanceRate → paidRate +
// expiredCount → overdueCount + lastUpdatedAt → lastIssuedAt.
//
// Behavior:
//   - Tenant-scoped count + breakdown of ALL TravelInvoice rows.
//   - USER-readable (anodyne aggregate; same as /quotes/stats).
//   - MANAGER scoped to subBrandAccess via getSubBrandAccessSet — empty
//     access set returns the zeroed shape (not 403) so the dashboard
//     tile renders cleanly for not-yet-onboarded operators.
//   - Optional ?from / ?to ISO-date bounds on createdAt.
//
// Response shape:
//   {
//     total,
//     byStatus: { Draft|Issued|Partial|Paid|Voided: {count, totalValue} },
//     bySubBrand: { tmc|rfu|...|_tenant: {count} },
//     grandTotalValue, grandPaidValue, grandOpenValue,
//     paidRate,        // paid / (paid + open); null if denom = 0
//     overdueCount,    // status IN (Issued, Partial) AND dueDate < now
//     lastIssuedAt,    // most-recent updatedAt where status='Issued'
//   }
//
// Half-up 2dp on all money values. Defensive: null/non-numeric totalAmount → 0,
// no NaN poisoning.
//
// Route-ordering: declared BEFORE GET /:id so Express doesn't try to parse
// "stats" as a numeric :id and 400.
router.get("/invoices/stats", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };

    // Optional ISO date bounds on createdAt.
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    // Sub-brand narrowing — empty access set → zeroed shape (not 403).
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const zeroed = {
      total: 0,
      byStatus: {
        Draft: { count: 0, totalValue: 0 },
        Issued: { count: 0, totalValue: 0 },
        Partial: { count: 0, totalValue: 0 },
        Paid: { count: 0, totalValue: 0 },
        Voided: { count: 0, totalValue: 0 },
      },
      bySubBrand: {},
      grandTotalValue: 0,
      grandPaidValue: 0,
      grandOpenValue: 0,
      paidRate: null,
      overdueCount: 0,
      lastIssuedAt: null,
    };

    if (allowed instanceof Set && allowed.size === 0) {
      return res.json(zeroed);
    }
    if (allowed instanceof Set) {
      where.subBrand = { in: [...allowed] };
    }

    const invoices = await prisma.travelInvoice.findMany({
      where,
      select: {
        id: true,
        subBrand: true,
        status: true,
        totalAmount: true,
        dueDate: true,
        updatedAt: true,
      },
    });

    if (invoices.length === 0) {
      return res.json(zeroed);
    }

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const now = Date.now();

    const byStatus = {
      Draft: { count: 0, totalValue: 0 },
      Issued: { count: 0, totalValue: 0 },
      Partial: { count: 0, totalValue: 0 },
      Paid: { count: 0, totalValue: 0 },
      Voided: { count: 0, totalValue: 0 },
    };
    const bySubBrand = {};
    let grandTotalValue = 0;
    let grandPaidValue = 0;
    let grandVoidedValue = 0;
    let overdueCount = 0;
    let lastIssuedAt = null;

    for (const inv of invoices) {
      const amt = Number(inv.totalAmount);
      const safeAmt = Number.isFinite(amt) ? amt : 0;
      grandTotalValue += safeAmt;

      if (byStatus[inv.status]) {
        byStatus[inv.status].count += 1;
        byStatus[inv.status].totalValue += safeAmt;
      }

      if (inv.status === "Paid") {
        grandPaidValue += safeAmt;
      }
      if (inv.status === "Voided") {
        grandVoidedValue += safeAmt;
      }

      // overdueCount: non-terminal billing-active status AND dueDate past.
      if (
        (inv.status === "Issued" || inv.status === "Partial")
        && inv.dueDate
      ) {
        const dd = inv.dueDate instanceof Date ? inv.dueDate : new Date(inv.dueDate);
        if (!Number.isNaN(dd.getTime()) && dd.getTime() < now) {
          overdueCount += 1;
        }
      }

      // bySubBrand: defensively coalesce null → "_tenant".
      const sbKey = inv.subBrand ? String(inv.subBrand) : "_tenant";
      if (!bySubBrand[sbKey]) bySubBrand[sbKey] = { count: 0 };
      bySubBrand[sbKey].count += 1;

      // lastIssuedAt: most-recent updatedAt of any Issued-status row (no
      // dedicated issuedAt column on TravelInvoice — updatedAt under
      // status='Issued' is the closest available semantic).
      if (inv.status === "Issued") {
        const ts = inv.updatedAt instanceof Date ? inv.updatedAt : new Date(inv.updatedAt);
        if (!Number.isNaN(ts.getTime())) {
          if (!lastIssuedAt || ts > lastIssuedAt) lastIssuedAt = ts;
        }
      }
    }

    // Round per-status sums.
    for (const s of Object.keys(byStatus)) {
      byStatus[s].totalValue = round2(byStatus[s].totalValue);
    }

    // grandOpenValue: total revenue surface MINUS paid MINUS voided.
    const grandOpenValue = grandTotalValue - grandPaidValue - grandVoidedValue;

    // paidRate: paid / (paid + open); null if denom = 0.
    const paidDenom = grandPaidValue + grandOpenValue;
    const paidRate = paidDenom > 0
      ? round2(grandPaidValue / paidDenom)
      : null;

    res.json({
      total: invoices.length,
      byStatus,
      bySubBrand,
      grandTotalValue: round2(grandTotalValue),
      grandPaidValue: round2(grandPaidValue),
      grandOpenValue: round2(grandOpenValue),
      paidRate,
      overdueCount,
      lastIssuedAt: lastIssuedAt ? lastIssuedAt.toISOString() : null,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-invoices] stats error:", e.message);
    res.status(500).json({ error: "Failed to summarise invoices" });
  }
});

// GET /api/travel/invoices/expired-summary — any verified token (tenant + sub-brand-scoped).
//
// Arc 2 #901 (PRD_TRAVEL_BILLING §3 — overdue-collections rollup).
// Mirrors /quotes/expired-summary (commit c6b169f2) for TravelInvoice
// rows. Companion to /invoices/aged-receivable (full row list + dueDate
// bucketing) + /invoices/stats (single overdueCount aggregate). This
// endpoint returns an ACTIONABLE tenant-wide rollup of currently-overdue
// invoices (status IN Issued|Partial AND dueDate < now) grouped by
// sub-brand, overdue-age range, and top customers — the shape an
// operator dashboard "collections-recovery" tile needs to prioritise
// outreach.
//
// Response shape:
//   {
//     total,                          // count of currently-overdue invoices
//     totalValue,                     // sum of totalAmount (half-up 2dp)
//     totalOpenValue,                 // sum of (totalAmount - sum(schedule.receivedAmount))
//     bySubBrand: { tmc|rfu|...|_tenant: {count, value, openValue} },
//     byAgeRange: {
//       "0-7d":   {count, value, openValue},   // overdue 0-7 days
//       "8-30d":  {count, value, openValue},   // overdue 8-30 days
//       "31-90d": {count, value, openValue},
//       "90+d":   {count, value, openValue},
//     },
//     topCustomers: [                 // top-5 by overdue count
//       { contactId, count, totalValue, openValue }, ...
//     ],
//     generatedAt,                    // ISO timestamp
//   }
//
// Scope rules:
//   - Tenant-scoped on TravelInvoice.tenantId.
//   - Sub-brand restricted: MANAGER with subBrandAccess narrowed via
//     getSubBrandAccessSet — empty set → zeroed shape (not 403) so
//     dashboard tiles render cleanly for not-yet-onboarded operators.
//   - USER-readable (anodyne aggregate; no invoice bodies leak — only
//     counts + sums + contactIds, no customer names).
//
// openValue derivation: TravelInvoice has NO `paidAmount` column. The
// outstanding balance is computed as totalAmount - sum(schedule.receivedAmount)
// per the existing /invoices/aged-receivable pattern (slice 23). Invoices
// with no TravelPaymentSchedule rows treat the entire totalAmount as
// outstanding. This keeps the rollup actionable without depending on a
// non-existent schema field.
//
// Defensive: null/non-numeric totalAmount → 0 (no NaN poisoning);
// null subBrand coalesces to "_tenant" (matches /invoices/stats shape);
// invoices with null dueDate are skipped (not "overdue" without a due
// date); half-up 2dp rounding via Number.EPSILON.
//
// Age-range buckets are inclusive at the low bound:
//   "0-7d"   → 0 <= overdueDays <= 7
//   "8-30d"  → 8 <= overdueDays <= 30
//   "31-90d" → 31 <= overdueDays <= 90
//   "90+d"   → 91 <= overdueDays
//
// IMPORTANT: this route MUST be declared BEFORE GET /:id so Express
// doesn't match "expired-summary" as a numeric :id (which would 400
// INVALID_ID).
router.get(
  "/invoices/expired-summary",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const round2 = (n) =>
        Math.round((Number(n) + Number.EPSILON) * 100) / 100;
      const zeroBucket = () => ({ count: 0, value: 0, openValue: 0 });
      const zeroed = () => ({
        total: 0,
        totalValue: 0,
        totalOpenValue: 0,
        bySubBrand: {},
        byAgeRange: {
          "0-7d": zeroBucket(),
          "8-30d": zeroBucket(),
          "31-90d": zeroBucket(),
          "90+d": zeroBucket(),
        },
        topCustomers: [],
        generatedAt: new Date().toISOString(),
      });

      const allowed = await getSubBrandAccessSet(req.user.userId);
      // Empty access set → zeroed shape (not 403).
      if (allowed instanceof Set && allowed.size === 0) {
        return res.json(zeroed());
      }

      const now = new Date();
      const where = {
        tenantId: req.travelTenant.id,
        status: { in: ["Issued", "Partial"] },
        dueDate: { lt: now },
      };
      if (allowed instanceof Set) {
        where.subBrand = { in: [...allowed] };
      }

      const invoices = await prisma.travelInvoice.findMany({
        where,
        select: {
          id: true,
          subBrand: true,
          contactId: true,
          totalAmount: true,
          dueDate: true,
          schedule: { select: { receivedAmount: true } },
        },
      });

      if (invoices.length === 0) {
        return res.json(zeroed());
      }

      const bySubBrand = {};
      const byAgeRange = {
        "0-7d": zeroBucket(),
        "8-30d": zeroBucket(),
        "31-90d": zeroBucket(),
        "90+d": zeroBucket(),
      };
      const perContact = new Map();
      let total = 0;
      let totalValue = 0;
      let totalOpenValue = 0;
      const nowMs = now.getTime();

      for (const inv of invoices) {
        // Defensive: skip rows whose dueDate failed Prisma's lt filter
        // (shouldn't happen, but the test mock returns whatever it likes).
        if (!inv.dueDate) continue;
        const dd =
          inv.dueDate instanceof Date ? inv.dueDate : new Date(inv.dueDate);
        if (Number.isNaN(dd.getTime()) || dd.getTime() >= nowMs) continue;

        const amt = Number(inv.totalAmount);
        const safeAmt = Number.isFinite(amt) ? amt : 0;

        // openValue = totalAmount - sum(schedule.receivedAmount). No
        // schedule rows → entire totalAmount is outstanding (matches
        // /invoices/aged-receivable slice 23 semantics).
        const sched = Array.isArray(inv.schedule) ? inv.schedule : [];
        let received = 0;
        for (const s of sched) {
          const r = Number(s.receivedAmount);
          if (Number.isFinite(r)) received += r;
        }
        const openAmt = safeAmt - received;

        total += 1;
        totalValue += safeAmt;
        totalOpenValue += openAmt;

        // bySubBrand: null subBrand → "_tenant" (matches /invoices/stats shape).
        const sbKey = inv.subBrand ? String(inv.subBrand) : "_tenant";
        if (!bySubBrand[sbKey]) bySubBrand[sbKey] = zeroBucket();
        bySubBrand[sbKey].count += 1;
        bySubBrand[sbKey].value += safeAmt;
        bySubBrand[sbKey].openValue += openAmt;

        // byAgeRange: how long ago did the invoice fall due (in days).
        const ageDays = Math.floor((nowMs - dd.getTime()) / 86_400_000);
        let bucket;
        if (ageDays <= 7) bucket = "0-7d";
        else if (ageDays <= 30) bucket = "8-30d";
        else if (ageDays <= 90) bucket = "31-90d";
        else bucket = "90+d";
        byAgeRange[bucket].count += 1;
        byAgeRange[bucket].value += safeAmt;
        byAgeRange[bucket].openValue += openAmt;

        // perContact tally for topCustomers.
        if (inv.contactId != null) {
          const cid = inv.contactId;
          if (!perContact.has(cid)) {
            perContact.set(cid, {
              contactId: cid,
              count: 0,
              totalValue: 0,
              openValue: 0,
            });
          }
          const entry = perContact.get(cid);
          entry.count += 1;
          entry.totalValue += safeAmt;
          entry.openValue += openAmt;
        }
      }

      // Round per-bucket sums.
      for (const sb of Object.keys(bySubBrand)) {
        bySubBrand[sb].value = round2(bySubBrand[sb].value);
        bySubBrand[sb].openValue = round2(bySubBrand[sb].openValue);
      }
      for (const ar of Object.keys(byAgeRange)) {
        byAgeRange[ar].value = round2(byAgeRange[ar].value);
        byAgeRange[ar].openValue = round2(byAgeRange[ar].openValue);
      }

      // topCustomers: sort desc by count (tie-break by openValue desc, then
      // totalValue desc), top 5.
      const topCustomers = [...perContact.values()]
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          if (b.openValue !== a.openValue) return b.openValue - a.openValue;
          return b.totalValue - a.totalValue;
        })
        .slice(0, 5)
        .map((c) => ({
          contactId: c.contactId,
          count: c.count,
          totalValue: round2(c.totalValue),
          openValue: round2(c.openValue),
        }));

      res.json({
        total,
        totalValue: round2(totalValue),
        totalOpenValue: round2(totalOpenValue),
        bySubBrand,
        byAgeRange,
        topCustomers,
        generatedAt: now.toISOString(),
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] expired-summary error:", e.message);
      res.status(500).json({ error: "Failed to summarise overdue invoices" });
    }
  },
);

// GET /api/travel/invoices/:id
//
// #901 slice 3 (PRD_TRAVEL_BILLING UC-2.5): supports ?include=lines to return
// the invoice's TravelInvoiceLine rows in the same response (single round-trip
// composite document read). Multiple includes can be comma-separated for
// forward compat (e.g. ?include=lines,payments), but only "lines" is honored
// in this slice; unknown tokens are silently skipped. Omitting the param
// preserves the original header-only response shape (no `lines` field added).
router.get(
  "/invoices/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const invoice = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!invoice) {
        return res
          .status(404)
          .json({ error: "Invoice not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, invoice.subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // Parse ?include=lines[,...]. Comma-separated, trimmed, case-sensitive.
      // Only the "lines" token is honored in this slice — unknown tokens are
      // silently skipped (forward-compat for future include=payments etc.).
      const includeTokens = req.query.include
        ? String(req.query.include)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      const payload = { ...invoice };
      if (includeTokens.includes("lines")) {
        const lines = await prisma.travelInvoiceLine.findMany({
          where: { invoiceId: id, tenantId: req.travelTenant.id },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        });
        payload.lines = lines;
      }
      res.json(payload);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] get error:", e.message);
      res.status(500).json({ error: "Failed to get invoice" });
    }
  },
);

// POST /api/travel/invoices — ADMIN/MANAGER only.
// Required: contactId, totalAmount, currency, dueDate.
// Optional: subBrand (per Q25 — defaults to "tmc"), quoteId, status (default "Draft").
router.post(
  "/invoices",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "write"),
  async (req, res) => {
    try {
      const {
        contactId,
        totalAmount,
        currency,
        dueDate,
        subBrand,
        quoteId,
        tripId,
        status,
        docType,
      } = req.body || {};

      if (
        contactId == null ||
        totalAmount == null ||
        !currency ||
        dueDate == null
      ) {
        return res.status(400).json({
          error: "contactId, totalAmount, currency, dueDate required",
          code: "MISSING_FIELDS",
        });
      }

      const contactIdInt = parseInt(contactId, 10);
      if (!Number.isFinite(contactIdInt)) {
        return res.status(400).json({
          error: "contactId must be a number",
          code: "INVALID_CONTACT_ID",
        });
      }

      let quoteIdInt = null;
      if (quoteId != null) {
        quoteIdInt = parseInt(quoteId, 10);
        if (!Number.isFinite(quoteIdInt)) {
          return res.status(400).json({
            error: "quoteId must be a number",
            code: "INVALID_QUOTE_ID",
          });
        }
      }

      let tripIdInt = null;
      if (tripId != null && tripId !== "") {
        tripIdInt = parseInt(tripId, 10);
        if (!Number.isFinite(tripIdInt)) {
          return res.status(400).json({
            error: "tripId must be a number",
            code: "INVALID_TRIP_ID",
          });
        }
        const tripExists = await prisma.tmcTrip.findFirst({
          where: { id: tripIdInt, tenantId: req.travelTenant.id },
          select: { id: true },
        });
        if (!tripExists) {
          return res.status(422).json({
            error: `Trip #${tripIdInt} not found in this tenant`,
            code: "TRIP_NOT_FOUND",
          });
        }
      }

      assertValidStatus(status);
      if (subBrand) assertValidSubBrand(subBrand);
      // Slice 11 — explicit empty string is treated as "use default" (NULL on
      // create, so Prisma applies the column default "TaxInvoice"); a present
      // non-empty value is validated against the enum. Undefined means "field
      // not in body" — fall through to Prisma's default.
      if (docType !== undefined && docType !== "") {
        assertValidDocType(docType);
      }
      const parsedDueDate = parseDueDate(dueDate);

      // Sub-brand isolation: reject create that targets a sub-brand the
      // caller can't access. Same pattern as travel_quotes POST.
      const targetSubBrand = subBrand || "tmc";
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, targetSubBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      // #996 — Contact existence check. Pre-fix, operators could save an
      // invoice for a non-existent contactId; the row landed orphaned and
      // the CONTACT column rendered "#<id>" with no resolvable name.
      // Block with 422 CONTACT_NOT_FOUND when the contact isn't in the
      // caller's tenant (same-tenant scope; the contact table is multi-
      // tenant-isolated, so a cross-tenant contactId reads as "missing").
      // deletedAt: null guards the soft-delete window — without it, a row
      // GDPR-erased or operator-deleted via the standard Contact DELETE
      // (which sets deletedAt, doesn't remove) would still pass this check
      // and let an invoice be raised against a tombstoned contact.
      const contactExists = await prisma.contact.findFirst({
        where: { id: contactIdInt, tenantId: req.travelTenant.id, deletedAt: null },
        select: { id: true },
      });
      if (!contactExists) {
        return res.status(422).json({
          error: `Contact #${contactIdInt} not found in this tenant`,
          code: "CONTACT_NOT_FOUND",
        });
      }

      // #996 — Draft-invoice dedup guard. Pre-fix, clicking "New Invoice"
      // twice with identical values created two byte-identical TINV rows
      // for the same contact + total + dueDate. Block any create that
      // would land a second Draft matching an existing Draft on
      // (tenantId, contactId, subBrand, currency, totalAmount, dueDate).
      //
      // No time window: a previous version of this guard used a 5-minute
      // window so operators could "intentionally repeat" identical
      // Drafts later in the session, but pen-test #996 showed every
      // observed duplicate was the same byte-identical shape across
      // arbitrary delays — there is no legitimate operator workflow that
      // produces two indistinguishable Drafts for the same contact. If
      // the operator genuinely needs two invoices with identical values,
      // they change a distinguishing field (dueDate, subBrand, or the
      // associated line items via the line-item editor on the saved
      // Draft). Scope stays Draft-only — promoting Draft → Issued
      // removes the row from the dedup set, so the operator's normal
      // "issue this one, draft another for the next cycle" flow still
      // works.
      const targetStatus = status || "Draft";
      if (targetStatus === "Draft") {
        const dupe = await prisma.travelInvoice.findFirst({
          where: {
            tenantId: req.travelTenant.id,
            contactId: contactIdInt,
            subBrand: targetSubBrand,
            status: "Draft",
            currency: String(currency),
            totalAmount: totalAmount,
            dueDate: parsedDueDate,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, invoiceNum: true, createdAt: true },
        });
        if (dupe) {
          return res.status(409).json({
            error: `An identical Draft invoice (${dupe.invoiceNum}) already exists for this contact.`,
            code: "DUPLICATE_DRAFT_INVOICE",
            existing: {
              id: dupe.id,
              invoiceNum: dupe.invoiceNum,
              createdAt: dupe.createdAt,
            },
          });
        }
      }

      const invoiceNum = await nextInvoiceNum(req.travelTenant.id);

      const createData = {
        tenantId: req.travelTenant.id,
        subBrand: targetSubBrand,
        contactId: contactIdInt,
        quoteId: quoteIdInt,
        tripId: tripIdInt,
        invoiceNum,
        status: status || "Draft",
        totalAmount: totalAmount,
        currency: String(currency),
        dueDate: parsedDueDate,
      };
      // Only pass docType if the caller supplied a non-empty value — empty
      // string / undefined falls through to the schema default ("TaxInvoice").
      if (docType !== undefined && docType !== "") {
        createData.docType = docType;
      }
      const created = await prisma.travelInvoice.create({
        data: createData,
      });

      try {
        await enqueueTransaction({
          tenantId: req.travelTenant.id,
          subBrand: created.subBrand,
          sourceType: "TRAVEL_INVOICE",
          sourceId: created.id,
          reference: created.invoiceNum,
          transactionType: "SALES",
          tripId: created.tripId || created.itineraryId || null,
          partyName: `Customer #${created.contactId}`,
          amount: created.totalAmount,
          voucherType: created.docType === "CreditNote" ? "CREDIT NOTE" : created.docType === "DebitNote" ? "DEBIT NOTE" : "SALES",
          payload: {
            invoiceId: created.id,
            invoiceNum: created.invoiceNum,
            contactId: created.contactId,
            totalAmount: String(created.totalAmount),
            currency: created.currency,
            status: created.status,
            docType: created.docType,
          },
        });
      } catch (queueError) {
        console.warn("[travel-invoices] Tally queue preparation failed:", queueError.message);
      }

      await writeAudit(
        "TravelInvoice",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          subBrand: created.subBrand,
          contactId: created.contactId,
          quoteId: created.quoteId,
          tripId: created.tripId,
          invoiceNum: created.invoiceNum,
          status: created.status,
          currency: created.currency,
          docType: created.docType,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] create error:", e.message);
      res.status(500).json({ error: "Failed to create invoice" });
    }
  },
);

// PUT /api/travel/invoices/:id — ADMIN/MANAGER only.
// invoiceNum is immutable; status transitions enforced forward-only
// (any status may also go to Voided).
router.put(
  "/invoices/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ error: "Invoice not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const data = {};
      const {
        contactId,
        totalAmount,
        currency,
        dueDate,
        subBrand,
        quoteId,
        tripId,
        status,
        paidAt,
        docType,
      } = req.body || {};

      if (contactId !== undefined) {
        const ci = parseInt(contactId, 10);
        if (!Number.isFinite(ci)) {
          return res.status(400).json({
            error: "contactId must be a number",
            code: "INVALID_CONTACT_ID",
          });
        }
        data.contactId = ci;
      }
      if (quoteId !== undefined) {
        if (quoteId === null) {
          data.quoteId = null;
        } else {
          const qi = parseInt(quoteId, 10);
          if (!Number.isFinite(qi)) {
            return res.status(400).json({
              error: "quoteId must be a number",
              code: "INVALID_QUOTE_ID",
            });
          }
          data.quoteId = qi;
        }
      }
      if (tripId !== undefined) {
        if (tripId === null || tripId === "") {
          data.tripId = null;
        } else {
          const ti = parseInt(tripId, 10);
          if (!Number.isFinite(ti)) {
            return res.status(400).json({
              error: "tripId must be a number",
              code: "INVALID_TRIP_ID",
            });
          }
          const tripExists = await prisma.tmcTrip.findFirst({
            where: { id: ti, tenantId: req.travelTenant.id },
            select: { id: true },
          });
          if (!tripExists) {
            return res.status(422).json({
              error: `Trip #${ti} not found in this tenant`,
              code: "TRIP_NOT_FOUND",
            });
          }
          data.tripId = ti;
        }
      }
      if (totalAmount !== undefined) data.totalAmount = totalAmount;
      if (currency !== undefined) data.currency = String(currency);
      if (status !== undefined) {
        assertValidStatus(status);
        // Enforce forward-only transitions (any -> Voided always allowed).
        if (status !== existing.status) {
          const allowedNext = ALLOWED_TRANSITIONS[existing.status] || new Set();
          if (!allowedNext.has(status)) {
            return res.status(422).json({
              error: `Cannot transition from ${existing.status} to ${status}`,
              code: "INVALID_INVOICE_TRANSITION",
            });
          }
        }
        data.status = status;
      }
      if (subBrand !== undefined) {
        assertValidSubBrand(subBrand);
        if (!canAccessSubBrand(allowed, subBrand)) {
          return res.status(403).json({
            error: "Sub-brand access denied",
            code: "SUB_BRAND_DENIED",
          });
        }
        data.subBrand = subBrand;
      }
      if (dueDate !== undefined) {
        data.dueDate = parseDueDate(dueDate);
      }
      if (paidAt !== undefined) {
        if (paidAt === null) {
          data.paidAt = null;
        } else {
          const p = new Date(paidAt);
          if (Number.isNaN(p.getTime())) {
            return res.status(400).json({
              error: "paidAt must be a parseable date",
              code: "INVALID_PAID_AT",
            });
          }
          data.paidAt = p;
        }
      }
      if (docType !== undefined) {
        // Empty string OR explicit null on PUT clears back to default
        // ("TaxInvoice" via schema default — Prisma write null then the
        // route layer treats null as "TaxInvoice" on read).
        if (docType === null || docType === "") {
          data.docType = null;
        } else {
          assertValidDocType(docType);
          data.docType = docType;
        }
      }

      if (Object.keys(data).length === 0) {
        return res
          .status(400)
          .json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelInvoice.update({
        where: { id },
        data,
      });

      try {
        await enqueueTransaction({
          tenantId: req.travelTenant.id,
          subBrand: updated.subBrand,
          sourceType: "TRAVEL_INVOICE",
          sourceId: updated.id,
          reference: updated.invoiceNum,
          transactionType: "SALES",
          tripId: updated.tripId || updated.itineraryId || null,
          partyName: `Customer #${updated.contactId}`,
          amount: updated.totalAmount,
          voucherType: updated.docType === "CreditNote" ? "CREDIT NOTE" : updated.docType === "DebitNote" ? "DEBIT NOTE" : "SALES",
          payload: { invoiceId: updated.id, invoiceNum: updated.invoiceNum, contactId: updated.contactId, totalAmount: String(updated.totalAmount), currency: updated.currency, status: updated.status, docType: updated.docType, updatedAt: updated.updatedAt },
        });
      } catch (queueError) {
        console.warn("[travel-invoices] Tally queue refresh failed:", queueError.message);
      }
      if (updated.status === "Voided" && prisma.travelTallySyncQueue) {
        try {
          await prisma.travelTallySyncQueue.updateMany({ where: { tenantId: req.travelTenant.id, sourceType: "TRAVEL_INVOICE", sourceId: updated.id }, data: { status: "CANCELLED", lastError: "Source invoice was voided" } });
        } catch (queueError) {
          console.warn("[travel-invoices] Tally queue cancellation failed:", queueError.message);
        }
      }

      await writeAudit(
        "TravelInvoice",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] update error:", e.message);
      res.status(500).json({ error: "Failed to update invoice" });
    }
  },
);

// DELETE /api/travel/invoices/:id — ADMIN/MANAGER only.
// Only Draft invoices may be hard-deleted. Voided invoices stay for
// audit trail; any other status -> 422 INVOICE_DELETE_FORBIDDEN.
router.delete(
  "/invoices/:id",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "delete"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res
          .status(404)
          .json({ error: "Invoice not found", code: "NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, existing.subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      if (existing.status !== "Draft") {
        return res.status(422).json({
          error: `Only Draft invoices may be deleted (current status: ${existing.status})`,
          code: "INVOICE_DELETE_FORBIDDEN",
        });
      }

      // Audit BEFORE delete (same pattern as travel_quotes).
      await writeAudit(
        "TravelInvoice",
        "DELETE",
        id,
        req.user.userId,
        req.travelTenant.id,
        {
          hardDelete: true,
          subBrand: existing.subBrand,
          contactId: existing.contactId,
          invoiceNum: existing.invoiceNum,
          status: existing.status,
        },
      );

      if (prisma.travelTallySyncQueue) {
        try {
          await prisma.travelTallySyncQueue.updateMany({
            where: { tenantId: req.travelTenant.id, sourceType: "TRAVEL_INVOICE", sourceId: id },
            data: { status: "CANCELLED", lastError: "Source invoice was deleted" },
          });
        } catch (queueError) {
          console.warn("[travel-invoices] Tally queue cancellation failed:", queueError.message);
        }
      }

      await prisma.travelInvoice.delete({ where: { id } });
      res.status(204).end();
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete invoice" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/issue — Arc 2 #901 slice 5.
//
// Operator-action state transition: Draft -> Issued. Replaces the
// create-time TINV-YYYY-NNNN serial with a per-sub-brand per-fiscal-year
// customer-facing number (e.g. "TMC/26-27/0001"). PRD_TRAVEL_BILLING UC-2.5.
//
// Auth: ADMIN/MANAGER only.
// Pre-conditions: invoice exists, tenant-scoped, sub-brand-accessible,
//   status === 'Draft'.
// Side effects: invoiceNum reassigned via nextSubBrandInvoiceNum,
//   status -> 'Issued', audit row stamped action='TRAVEL_INVOICE_ISSUED'
//   with details { oldInvoiceNum, newInvoiceNum, subBrand }.
//
// Returns: 200 + updated invoice row (NOT 201 — this is a state
// transition, not a resource creation).
//
// Error codes: INVALID_ID (400), INVOICE_NOT_FOUND (404),
//   SUB_BRAND_DENIED (403), INVALID_STATE (400 — not in Draft).
//
// NOTE on schema: TravelInvoice has no issuedAt column today. The
// existing updatedAt @updatedAt timestamp captures the transition moment
// transparently; if Q-future surfaces a need for a dedicated issuedAt
// column for reporting, that's an additive schema change in a later
// slice (out of scope here per the slice-5 file budget).
// ============================================================================
router.post(
  "/invoices/:id/issue",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const invoice = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!invoice) {
        return res.status(404).json({
          error: "Invoice not found",
          code: "INVOICE_NOT_FOUND",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, invoice.subBrand)) {
        return res.status(403).json({
          error: "Sub-brand access denied",
          code: "SUB_BRAND_DENIED",
        });
      }

      if (invoice.status !== "Draft") {
        return res.status(400).json({
          error: `Only Draft invoices may be issued (current status: ${invoice.status})`,
          code: "INVALID_STATE",
        });
      }

      const oldInvoiceNum = invoice.invoiceNum;
      const newInvoiceNum = await nextSubBrandInvoiceNum(
        req.travelTenant.id,
        invoice.subBrand,
      );

      const updated = await prisma.travelInvoice.update({
        where: { id },
        data: {
          invoiceNum: newInvoiceNum,
          status: "Issued",
        },
      });

      // Arc 2 #901 slice 17 — auto-create default 25/50/25 PaymentSchedule.
      // Per PRD_TRAVEL_BILLING UC-2.1 (Umrah staged settlement). The operator
      // can pre-populate a custom schedule BEFORE calling /issue — in that
      // case we skip auto-create so the operator's intent isn't clobbered.
      // After issue, operator can still freely edit milestones via the
      // CRUD endpoints from slice 6.
      //
      // Rounding semantics: round each milestone independently to 2 decimal
      // places (paise / cent). The last milestone (25%) absorbs any 1-paise
      // residual from rounding so the three rows always sum exactly to
      // totalAmount. This matters because dashboards aggregate the schedule
      // to derive "outstanding" and a 1-paise drift would surface forever.
      let scheduleAutoCreated = false;
      let autoCreatedCount = 0;
      try {
        const existingSchedule = await prisma.travelPaymentSchedule.findFirst({
          where: { invoiceId: updated.id, tenantId: req.travelTenant.id },
        });
        if (!existingSchedule) {
          const total = Number(updated.totalAmount);
          if (Number.isFinite(total) && total > 0) {
            const round2 = (n) => Math.round(n * 100) / 100;
            const m1 = round2(total * 0.25);
            const m2 = round2(total * 0.5);
            // Last milestone absorbs rounding residual so the sum is exact.
            const m3 = round2(total - m1 - m2);
            const now = new Date();
            const addDays = (d, days) =>
              new Date(d.getTime() + days * 86_400_000);
            await prisma.travelPaymentSchedule.createMany({
              data: [
                {
                  tenantId: req.travelTenant.id,
                  invoiceId: updated.id,
                  milestoneOrder: 1,
                  dueDate: now,
                  expectedAmount: String(m1),
                  expectedCurrency: updated.currency,
                  status: "pending",
                },
                {
                  tenantId: req.travelTenant.id,
                  invoiceId: updated.id,
                  milestoneOrder: 2,
                  dueDate: addDays(now, 21),
                  expectedAmount: String(m2),
                  expectedCurrency: updated.currency,
                  status: "pending",
                },
                {
                  tenantId: req.travelTenant.id,
                  invoiceId: updated.id,
                  milestoneOrder: 3,
                  dueDate: addDays(now, 90),
                  expectedAmount: String(m3),
                  expectedCurrency: updated.currency,
                  status: "pending",
                },
              ],
            });
            scheduleAutoCreated = true;
            autoCreatedCount = 3;
          }
        }
      } catch (scheduleErr) {
        // Don't fail the /issue transition just because the auto-create
        // failed (e.g. transient DB hiccup). The operator can manually
        // create the schedule via slice 6's POST endpoint. Log + continue.
        console.error(
          "[travel-invoices] schedule auto-create failed:",
          scheduleErr.message,
        );
      }

      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_ISSUED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          oldInvoiceNum,
          newInvoiceNum,
          subBrand: updated.subBrand,
          scheduleAutoCreated,
          ...(scheduleAutoCreated ? { milestoneCount: autoCreatedCount } : {}),
        },
      );

      // Arc 2 #901 slice 21 — TDS withholding envelope (PRD_TRAVEL_BILLING §3).
      // Sum amounts on lineType==='tds' rows; compute payableAfterTds =
      // totalAmount - totalTds. Both go on the response envelope ALONGSIDE
      // the top-level invoice fields so existing slice-5 / slice-17 callers
      // (which destructure body.status / body.invoiceNum at top-level) keep
      // working. Additive-envelope pattern — see standing rule "API response
      // shape change → prefer additive envelope with back-compat top-level
      // fields" in CLAUDE.md.
      //
      // Defensive against test mocks where findMany isn't stubbed: either
      // returning null/undefined or throwing both yield empty arrays so the
      // envelope still ships with totalTds=0 (the back-compat case for
      // invoices with no TDS line, which is the majority pre-slice-21).
      let lines = [];
      let paymentSchedule = [];
      try {
        const rawLines = await prisma.travelInvoiceLine.findMany({
          where: { invoiceId: updated.id, tenantId: req.travelTenant.id },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        });
        lines = Array.isArray(rawLines) ? rawLines : [];
      } catch (linesErr) {
        console.error("[travel-invoices] /issue lines fetch failed:", linesErr.message);
      }
      try {
        const rawSchedule = await prisma.travelPaymentSchedule.findMany({
          where: { invoiceId: updated.id, tenantId: req.travelTenant.id },
          orderBy: [{ milestoneOrder: "asc" }, { id: "asc" }],
        });
        paymentSchedule = Array.isArray(rawSchedule) ? rawSchedule : [];
      } catch (scheduleListErr) {
        console.error(
          "[travel-invoices] /issue schedule fetch failed:",
          scheduleListErr.message,
        );
      }

      const { totalTds, perLineTds } = computeTdsFromLines(lines);
      const totalAmountNum = Number(updated.totalAmount);
      const payableAfterTds = Number.isFinite(totalAmountNum)
        ? round2(totalAmountNum - totalTds)
        : null;

      res.status(200).json({
        // Spread the invoice row at top-level for back-compat with existing
        // callers (slice-5 + slice-17 tests destructure body.status etc.).
        ...updated,
        // Additive envelope fields (slice 21):
        invoice: updated,
        paymentSchedule,
        totalTds,
        perLineTds,
        payableAfterTds,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] issue error:", e.message);
      res.status(500).json({ error: "Failed to issue invoice" });
    }
  },
);

// ============================================================================
// /api/travel/invoices/:id/lines — line-item composition (PRD_TRAVEL_BILLING
// FR-3.1.a). Mirrors travel_quotes.js /quotes/:id/lines (commit f7203b8e) —
// same auth + sub-brand + audit conventions. Each write triggers an audit
// row + recomputeInvoiceTotal to keep the invoice header consistent with
// its composition. Lines inherit tenant + sub-brand scoping from their
// parent invoice (no separate sub-brand column on the line — looked up
// via the FK).
//
// Auth: read endpoints accept any verified token; write endpoints require
// ADMIN/MANAGER. Same shape as the parent invoice routes.
// ============================================================================

// Helper: load the parent invoice tenant-scoped + sub-brand-scoped.
// Returns the invoice on success or sends an HTTP response on failure
// (caller short-circuits if !invoice).
async function loadParentInvoice(req, res, invoiceId) {
  if (!Number.isFinite(invoiceId)) {
    res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    return null;
  }
  const invoice = await prisma.travelInvoice.findFirst({
    where: { id: invoiceId, tenantId: req.travelTenant.id },
  });
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found", code: "INVOICE_NOT_FOUND" });
    return null;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, invoice.subBrand)) {
    res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    return null;
  }
  return invoice;
}

// GET /api/travel/invoices/:id/lines — list lines for an invoice.
router.get(
  "/invoices/:id/lines",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const lines = await prisma.travelInvoiceLine.findMany({
        where: { invoiceId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      res.json({ lines, total: lines.length });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] list lines error:", e.message);
      res.status(500).json({ error: "Failed to list invoice lines" });
    }
  },
);

// POST /api/travel/invoices/:id/lines — ADMIN/MANAGER only.
// Required: description, unitPrice. Optional: lineType (default "other"),
// quantity (default 1), currency (default invoice currency), sortOrder, notes,
// pnr, bookingRef, serviceStartDate, serviceEndDate (PRD §3.1.b + §3.1.d).
router.post(
  "/invoices/:id/lines",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "write"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const {
        lineType, description, quantity, unitPrice,
        currency, sortOrder, notes,
        pnr, bookingRef, serviceStartDate, serviceEndDate,
        fxRateToBase,
      } = req.body || {};

      if (!description || typeof description !== "string" || !description.trim()) {
        return res.status(400).json({
          error: "description is required",
          code: "MISSING_FIELDS",
        });
      }
      assertValidInvoiceLineType(lineType);
      const qty = parsePositiveInt(quantity, "quantity", 1);
      const unit = parsePositiveDecimal(unitPrice, "unitPrice");
      const amount = qty * unit;
      // PRD FR-3.1.b — PNR + bookingRef parsing (length-capped, empty→null).
      const parsedPnr = parseBookingRefField(pnr, "pnr", PNR_MAX_LEN, "INVALID_PNR");
      const parsedBookingRef = parseBookingRefField(
        bookingRef, "bookingRef", BOOKING_REF_MAX_LEN, "INVALID_BOOKING_REF",
      );
      // PRD FR-3.1.d — service-date parsing + inversion check.
      const parsedStart = parseServiceDate(serviceStartDate, "serviceStartDate");
      const parsedEnd = parseServiceDate(serviceEndDate, "serviceEndDate");
      assertServiceDateRange(parsedStart, parsedEnd);
      // Arc 2 #901 slice 12 — UC-2.1 FX-aware multi-currency line.
      // null / undefined → single-currency line (baseAmount stays null);
      // positive number → server computes baseAmount = round2(amount * fx).
      const parsedFx = parseFxRateToBase(fxRateToBase);
      const fxFields = parsedFx == null
        ? { fxRateToBase: null, baseAmount: null }
        : { fxRateToBase: parsedFx, baseAmount: round2(amount * parsedFx) };

      const created = await prisma.travelInvoiceLine.create({
        data: {
          tenantId: req.travelTenant.id,
          invoiceId,
          lineType: lineType || "other",
          description: description.trim(),
          quantity: qty,
          unitPrice: unit,
          amount,
          currency: currency ? String(currency) : invoice.currency,
          sortOrder: Number.isFinite(parseInt(sortOrder, 10))
            ? parseInt(sortOrder, 10) : 0,
          notes: notes ? String(notes) : null,
          // Only persist the new fields when the body provided them — keeps
          // the row null-friendly when operator doesn't supply them.
          ...(parsedPnr !== undefined ? { pnr: parsedPnr } : {}),
          ...(parsedBookingRef !== undefined ? { bookingRef: parsedBookingRef } : {}),
          ...(parsedStart !== undefined ? { serviceStartDate: parsedStart } : {}),
          ...(parsedEnd !== undefined ? { serviceEndDate: parsedEnd } : {}),
          // FX fields always written — null for single-currency, computed
          // baseAmount for multi-currency. No `parsedFx !== undefined` gate
          // because both null and a real number are valid persisted states.
          ...fxFields,
        },
      });

      await recomputeInvoiceTotal(invoiceId, req.travelTenant.id);

      await writeAudit(
        "TravelInvoiceLine",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId,
          lineType: created.lineType,
          amount: String(created.amount),
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] create line error:", e.message);
      res.status(500).json({ error: "Failed to create line" });
    }
  },
);

// PUT /api/travel/invoices/:id/lines/:lineId — ADMIN/MANAGER only.
router.put(
  "/invoices/:id/lines/:lineId",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const existing = await prisma.travelInvoiceLine.findFirst({
        where: { id: lineId, invoiceId, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }

      const data = {};
      const {
        lineType, description, quantity, unitPrice,
        currency, sortOrder, notes,
        pnr, bookingRef, serviceStartDate, serviceEndDate,
        fxRateToBase,
      } = req.body || {};

      if (lineType !== undefined) {
        assertValidInvoiceLineType(lineType);
        data.lineType = lineType;
      }
      if (description !== undefined) {
        if (typeof description !== "string" || !description.trim()) {
          return res.status(400).json({
            error: "description must be non-empty",
            code: "MISSING_FIELDS",
          });
        }
        data.description = description.trim();
      }
      const nextQty = quantity !== undefined
        ? parsePositiveInt(quantity, "quantity", existing.quantity)
        : existing.quantity;
      const nextUnit = unitPrice !== undefined
        ? parsePositiveDecimal(unitPrice, "unitPrice")
        : Number(existing.unitPrice);
      if (quantity !== undefined) data.quantity = nextQty;
      if (unitPrice !== undefined) data.unitPrice = nextUnit;
      // Recompute amount whenever either qty or unitPrice changed.
      if (quantity !== undefined || unitPrice !== undefined) {
        data.amount = nextQty * nextUnit;
      }
      if (currency !== undefined) data.currency = String(currency);
      if (sortOrder !== undefined) {
        const so = parseInt(sortOrder, 10);
        if (!Number.isFinite(so)) {
          return res.status(400).json({
            error: "sortOrder must be a number",
            code: "INVALID_SORT_ORDER",
          });
        }
        data.sortOrder = so;
      }
      if (notes !== undefined) data.notes = notes === null ? null : String(notes);

      // PRD FR-3.1.b — PNR + bookingRef parsing on PUT.
      if (pnr !== undefined) {
        data.pnr = parseBookingRefField(pnr, "pnr", PNR_MAX_LEN, "INVALID_PNR");
      }
      if (bookingRef !== undefined) {
        data.bookingRef = parseBookingRefField(
          bookingRef, "bookingRef", BOOKING_REF_MAX_LEN, "INVALID_BOOKING_REF",
        );
      }
      // PRD FR-3.1.d — service-date partial-update + range check against the
      // existing DB row when only one end is being changed. We pull the
      // "effective" start/end (incoming body if present, otherwise existing
      // row's value) and validate; this catches the case where PUT sets only
      // serviceEndDate and the new end is < the existing start.
      let nextStart = existing.serviceStartDate || null;
      let nextEnd = existing.serviceEndDate || null;
      if (serviceStartDate !== undefined) {
        const parsedStart = parseServiceDate(serviceStartDate, "serviceStartDate");
        data.serviceStartDate = parsedStart;
        nextStart = parsedStart;
      }
      if (serviceEndDate !== undefined) {
        const parsedEnd = parseServiceDate(serviceEndDate, "serviceEndDate");
        data.serviceEndDate = parsedEnd;
        nextEnd = parsedEnd;
      }
      if (serviceStartDate !== undefined || serviceEndDate !== undefined) {
        assertServiceDateRange(nextStart, nextEnd);
      }

      // Arc 2 #901 slice 12 — UC-2.1 FX-aware PUT partial-update.
      // Three cases that touch the FX pair (fxRateToBase + baseAmount):
      //  (a) fxRateToBase explicit null → operator clears multi-currency;
      //      baseAmount cleared in lockstep regardless of amount.
      //  (b) fxRateToBase positive number → set rate + recompute baseAmount
      //      from the EFFECTIVE amount (incoming body if qty/unitPrice
      //      changed, otherwise the existing row's amount).
      //  (c) fxRateToBase undefined BUT amount changed (qty or unitPrice)
      //      AND existing row already had a non-null fxRateToBase →
      //      recompute baseAmount using the existing rate + new amount.
      // The effective-amount pattern mirrors the service-date partial-update
      // pattern above (incoming body if present, otherwise existing).
      const parsedFx = parseFxRateToBase(fxRateToBase);
      const effectiveAmount = (quantity !== undefined || unitPrice !== undefined)
        ? nextQty * nextUnit
        : Number(existing.amount);
      if (parsedFx === null) {
        // Case (a) — explicit clear.
        data.fxRateToBase = null;
        data.baseAmount = null;
      } else if (parsedFx !== undefined) {
        // Case (b) — explicit set.
        data.fxRateToBase = parsedFx;
        data.baseAmount = round2(effectiveAmount * parsedFx);
      } else if ((quantity !== undefined || unitPrice !== undefined)
                 && existing.fxRateToBase != null) {
        // Case (c) — amount changed, fxRateToBase unchanged but present.
        data.baseAmount = round2(effectiveAmount * Number(existing.fxRateToBase));
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.travelInvoiceLine.update({
        where: { id: lineId },
        data,
      });

      await recomputeInvoiceTotal(invoiceId, req.travelTenant.id);

      await writeAudit(
        "TravelInvoiceLine",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        { invoiceId, fields: Object.keys(data) },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] update line error:", e.message);
      res.status(500).json({ error: "Failed to update line" });
    }
  },
);

// DELETE /api/travel/invoices/:id/lines/:lineId — ADMIN/MANAGER only.
router.delete(
  "/invoices/:id/lines/:lineId",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "delete"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res.status(400).json({ error: "lineId must be a number", code: "INVALID_LINE_ID" });
      }
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const existing = await prisma.travelInvoiceLine.findFirst({
        where: { id: lineId, invoiceId, tenantId: req.travelTenant.id },
      });
      if (!existing) {
        return res.status(404).json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }

      // Audit BEFORE delete (same pattern as travel_quotes lines).
      await writeAudit(
        "TravelInvoiceLine",
        "DELETE",
        lineId,
        req.user.userId,
        req.travelTenant.id,
        { invoiceId, lineType: existing.lineType, amount: String(existing.amount) },
      );

      await prisma.travelInvoiceLine.delete({ where: { id: lineId } });
      await recomputeInvoiceTotal(invoiceId, req.travelTenant.id);

      res.status(204).end();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] delete line error:", e.message);
      res.status(500).json({ error: "Failed to delete line" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/:id/pdf — ADMIN/MANAGER only (Arc 2 #901 slice 2).
//
// Loads the invoice tenant-scoped + sub-brand-scoped, fetches its lines,
// then hands {invoice, lines, tenant} to pdfRenderer.generateTravelInvoicePdf
// which returns a Promise<Buffer>. We stream the Buffer back with attachment
// headers so the operator browser triggers a download dialog.
//
// Audit row is stamped BEFORE the body is sent so the audit trail is
// durable even if the client aborts mid-download. Mirrors the quote
// /pdf handler's ordering at travel_quotes.js:840+.
//
// PDF render failures are wrapped as 500 PDF_RENDER_FAILED rather than
// the generic "Failed to..." catch — pdfkit can throw on bad font / asset
// resolution and the operator-facing surface needs an actionable code.
//
// NOTE: pdfRenderer.generateTravelInvoicePdf is referenced via the
// module-exports indirection (`pdfRenderer.generateTravelInvoicePdf(...)`)
// so unit tests can `vi.spyOn(pdfRenderer, 'generateTravelInvoicePdf')`
// and intercept render failures. Same CJS self-mocking seam pattern used
// by adsGptClient / ratehawkClient / callifiedClient (cron learning
// 2026-05-24 ~01:43 UTC).
// ============================================================================
router.get(
  "/invoices/:id/pdf",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "export"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const invoice = await prisma.travelInvoice.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!invoice) {
        return res
          .status(404)
          .json({ error: "Invoice not found", code: "INVOICE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, invoice.subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      const lines = await prisma.travelInvoiceLine.findMany({
        where: { invoiceId: id, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      // Fetch payment schedule to calculate actual amount paid.
      // openValue = totalAmount - sum(schedule.receivedAmount). No schedule
      // rows → entire totalAmount is outstanding.
      const schedule = await prisma.travelPaymentSchedule.findMany({
        where: { invoiceId: id, tenantId: req.travelTenant.id },
        select: { receivedAmount: true },
      });
      let amountPaid = 0;
      for (const s of schedule) {
        const r = Number(s.receivedAmount);
        if (Number.isFinite(r)) amountPaid += r;
      }

      // Load the bill-to contact so the PDF "Bill To" block isn't blank.
      // TravelInvoice stores only contactId; the renderer reads contactName/
      // contactEmail/contactPhone off the invoice object, so we resolve them
      // here. Non-fatal — a missing contact just falls back to "—".
      let contact = null;
      if (invoice.contactId != null) {
        try {
          contact = await prisma.contact.findFirst({
            where: { id: invoice.contactId, tenantId: req.travelTenant.id },
            select: { name: true, email: true, phone: true },
          });
        } catch (_) {
          // ignore — Bill To falls back to "—"
        }
      }

      // Tenant is optional input to the helper — load it for the footer
      // line. Failure to load (e.g. soft-deleted tenant) is non-fatal;
      // the helper handles a null tenant cleanly.
      let tenant = null;
      try {
        tenant = await prisma.tenant.findUnique({
          where: { id: req.travelTenant.id },
        });
      } catch (_) {
        // ignore — proceed with null tenant
      }

      let pdfBuffer;
      try {
        pdfBuffer = await pdfRenderer.generateTravelInvoicePdf({
          invoice: {
            ...invoice,
            amountPaid,
            contactName: contact?.name || null,
            contactEmail: contact?.email || null,
            contactPhone: contact?.phone || null,
          },
          lines,
          tenant,
        });
      } catch (renderErr) {
        console.error(
          "[travel-invoices] PDF render error:",
          renderErr && renderErr.message,
        );
        return res.status(500).json({
          error: "Failed to render invoice PDF",
          code: "PDF_RENDER_FAILED",
        });
      }

      // Audit BEFORE sending the body so the row is durable even if the
      // client aborts mid-download. Mirrors the quote /pdf handler.
      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_PDF_DOWNLOADED",
        invoice.id,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId: invoice.id,
          subBrand: invoice.subBrand,
          lineCount: lines.length,
        },
      );
      // G124 — uniform DOCUMENT_DOWNLOAD row for the Document Access sub-tab.
      // Best-effort (helper swallows errors); never blocks the PDF response.
      recordDocumentAccess({
        tenantId: req.travelTenant.id,
        userId: req.user.userId,
        documentType: "TravelInvoice",
        documentId: invoice.id,
        event: "download",
        ipAddress: req.ip,
        userAgent: req.headers && req.headers["user-agent"],
        extra: { subBrand: invoice.subBrand, lineCount: lines.length },
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="invoice-${invoice.id}.pdf"`,
      );
      res.status(200).end(pdfBuffer);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] pdf error:", e.message);
      res.status(500).json({ error: "Failed to generate invoice PDF" });
    }
  },
);

// ============================================================================
// /api/travel/invoices/:id/schedule — payment-schedule milestones (PRD §3.2.a).
//
// Arc 2 #901 slice 6 — TravelPaymentSchedule CRUD scaffold. Mirrors the
// supplier-payable ledger pattern in backend/routes/travel_suppliers.js
// (commit 59336ab7) — same auth + sub-brand + audit conventions.
//
// Staged settlement: an invoice can have multiple milestones (e.g. 25% advance,
// 50% pre-departure, 25% on-return per UC-2.1). Each row is one milestone
// row with its own dueDate + expectedAmount + status. Operator-driven for
// now — auto-create-on-issue (default 25/50/25 split, etc.) is slice 7.
//
// Status enum: pending | partial | paid | overdue | waived
//   - pending  : not yet received (default)
//   - partial  : some received but not full expectedAmount
//   - paid     : fully settled (paidAt auto-set when transitioning here)
//   - overdue  : dueDate past + not paid (cron will flip in slice 9)
//   - waived   : operator wrote off the milestone (e.g. complimentary)
//
// Auth: read endpoints accept any verified token; write endpoints require
// ADMIN/MANAGER. Sub-brand isolation flows through the parent invoice via
// loadParentInvoice() — payable scope is inherited via FK.
//
// Error codes: INVALID_ID, INVOICE_NOT_FOUND, MILESTONE_NOT_FOUND,
//   SUB_BRAND_DENIED, MISSING_FIELDS, INVALID_MILESTONE_ORDER, INVALID_AMOUNT,
//   INVALID_DUE_DATE, INVALID_STATUS, INVALID_CURRENCY, EMPTY_BODY.
// ============================================================================

const VALID_SCHEDULE_STATUSES = [
  "pending",
  "partial",
  "paid",
  "overdue",
  "waived",
];

function assertValidScheduleStatus(s) {
  if (s == null) return;
  if (!VALID_SCHEDULE_STATUSES.includes(s)) {
    const err = new Error(
      `status must be one of: ${VALID_SCHEDULE_STATUSES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

function assertValidMilestoneOrder(n) {
  if (n == null || n === "") {
    const err = new Error("milestoneOrder is required");
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isInteger(v) || v < 1) {
    const err = new Error("milestoneOrder must be a positive integer");
    err.status = 400;
    err.code = "INVALID_MILESTONE_ORDER";
    throw err;
  }
  return v;
}

function assertValidExpectedAmount(a) {
  if (a == null || a === "") {
    const err = new Error("expectedAmount is required");
    err.status = 400;
    err.code = "MISSING_FIELDS";
    throw err;
  }
  const v = typeof a === "number" ? a : Number(a);
  if (!Number.isFinite(v) || v < 0) {
    const err = new Error("expectedAmount must be a non-negative number");
    err.status = 400;
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  return v;
}

// Parse + validate a dueDate on the milestone. Same shape as parseDueDate
// above but with a distinct error code for the schedule surface so
// frontend can render the right field's validation feedback.
function parseMilestoneDueDate(input) {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("dueDate must be a parseable date");
    err.status = 400;
    err.code = "INVALID_DUE_DATE";
    throw err;
  }
  return d;
}

// Parse + validate a paidAt timestamp. Same shape as dueDate but allows
// explicit null to clear a previously-set value.
function parsePaidAt(input) {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("paidAt must be a parseable date");
    err.status = 400;
    err.code = "INVALID_DUE_DATE";
    throw err;
  }
  return d;
}

// GET /api/travel/invoices/:id/schedule — list milestones for an invoice.
// Returns { schedule: [...], total }, ordered by milestoneOrder asc.
router.get(
  "/invoices/:id/schedule",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const schedule = await prisma.travelPaymentSchedule.findMany({
        where: { invoiceId, tenantId: req.travelTenant.id },
        orderBy: [{ milestoneOrder: "asc" }, { id: "asc" }],
      });
      res.json({ schedule, total: schedule.length });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] list schedule error:", e.message);
      res.status(500).json({ error: "Failed to list schedule" });
    }
  },
);

// POST /api/travel/invoices/:id/schedule — ADMIN/MANAGER only.
// Required: milestoneOrder, expectedAmount.
// Optional: dueDate, expectedCurrency (default parent invoice currency),
//   receivedAmount, notes, status, paidAt.
router.post(
  "/invoices/:id/schedule",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "write"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const {
        milestoneOrder,
        expectedAmount,
        dueDate,
        expectedCurrency,
        receivedAmount,
        notes,
        status,
        paidAt,
        // G025 — anchor-relative due-date metadata.
        anchorType,
        anchorOffset,
      } = req.body || {};

      const order = assertValidMilestoneOrder(milestoneOrder);
      const expected = assertValidExpectedAmount(expectedAmount);
      assertValidScheduleStatus(status);
      const parsedDueDate = parseMilestoneDueDate(dueDate);
      const parsedPaidAt = parsePaidAt(paidAt);

      // G025 — anchor validation + resolution. anchorType/anchorOffset must
      // come together. Anchor metadata is persisted regardless of whether
      // the explicit dueDate is also supplied — the dueDate-vs-anchor diff
      // is what powers G027 deviation detection.
      let resolvedAnchorType = null;
      let resolvedAnchorOffset = null;
      let anchorComputedDueDate = null;
      if (anchorType !== undefined || anchorOffset !== undefined) {
        if (anchorType === null || anchorOffset === null) {
          // Explicit clear of both.
          resolvedAnchorType = null;
          resolvedAnchorOffset = null;
        } else {
          if (!isValidAnchorType(anchorType)) {
            return res.status(400).json({
              error: `anchorType must be one of: ${VALID_ANCHOR_TYPES.join(", ")}`,
              code: "INVALID_ANCHOR_TYPE",
            });
          }
          const offset = Number(anchorOffset);
          if (!Number.isFinite(offset) || !Number.isInteger(offset)) {
            return res.status(400).json({
              error: "anchorOffset must be an integer",
              code: "INVALID_ANCHOR_OFFSET",
            });
          }
          resolvedAnchorType = String(anchorType);
          resolvedAnchorOffset = offset;
          anchorComputedDueDate = computeAnchorDueDate({
            anchorType: resolvedAnchorType,
            anchorOffset: resolvedAnchorOffset,
            invoice,
            trip: null,
          });
        }
      }

      // Final dueDate resolution order:
      //   1. operator-supplied dueDate (req.body.dueDate) → source of truth
      //   2. anchor-computed dueDate (from anchor metadata)
      //   3. null (no due date)
      // When (1) is supplied AND differs from (2), G027 deviation tag fires.
      let finalDueDate;
      if (parsedDueDate !== undefined) {
        finalDueDate = parsedDueDate;
      } else if (anchorComputedDueDate) {
        finalDueDate = anchorComputedDueDate;
      } else {
        finalDueDate = null;
      }

      // G027 — schedule-override deviation tag. When the operator's explicit
      // dueDate differs from the anchor-computed one (or no anchor exists
      // but a manual due date was supplied that diverges from the template
      // default — left as a future hook), tag the audit row.
      let deviation = false;
      let deviationDelta = null;
      if (
        parsedDueDate !== undefined &&
        parsedDueDate !== null &&
        anchorComputedDueDate
      ) {
        const explicitMs = parsedDueDate.getTime();
        const computedMs = anchorComputedDueDate.getTime();
        if (explicitMs !== computedMs) {
          deviation = true;
          deviationDelta = Math.round((explicitMs - computedMs) / (1000 * 60 * 60 * 24));
        }
      }

      // receivedAmount is optional on POST. Validate when supplied.
      let received = undefined;
      if (receivedAmount !== undefined && receivedAmount !== null) {
        const v = Number(receivedAmount);
        if (!Number.isFinite(v) || v < 0) {
          return res.status(400).json({
            error: "receivedAmount must be a non-negative number",
            code: "INVALID_AMOUNT",
          });
        }
        received = v;
      }

      const created = await prisma.travelPaymentSchedule.create({
        data: {
          tenantId: req.travelTenant.id,
          invoiceId,
          milestoneOrder: order,
          expectedAmount: String(expected),
          expectedCurrency: expectedCurrency
            ? String(expectedCurrency)
            : invoice.currency,
          dueDate: finalDueDate,
          anchorType: resolvedAnchorType,
          anchorOffset: resolvedAnchorOffset,
          ...(received !== undefined ? { receivedAmount: String(received) } : {}),
          notes: notes ? String(notes) : null,
          status: status || undefined,
          ...(parsedPaidAt !== undefined ? { paidAt: parsedPaidAt } : {}),
        },
      });

      await writeAudit(
        "TravelPaymentSchedule",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId,
          milestoneOrder: created.milestoneOrder,
          expectedAmount: String(created.expectedAmount),
          status: created.status,
          ...(resolvedAnchorType
            ? {
                anchorType: resolvedAnchorType,
                anchorOffset: resolvedAnchorOffset,
                anchorComputedDueDate: anchorComputedDueDate
                  ? anchorComputedDueDate.toISOString()
                  : null,
              }
            : {}),
          // G027 — deviation tag. Surfaces in audit reports as a "manual
          // override of template default" indicator.
          ...(deviation ? { deviation: true, deviationDeltaDays: deviationDelta } : {}),
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] create schedule error:", e.message);
      res.status(500).json({ error: "Failed to create milestone" });
    }
  },
);

// PUT /api/travel/invoices/:id/schedule/:milestoneId — ADMIN/MANAGER only.
// Partial update. status='paid' auto-sets paidAt=now() if not already set.
router.put(
  "/invoices/:id/schedule/:milestoneId",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const milestoneId = parseInt(req.params.milestoneId, 10);
      if (!Number.isFinite(milestoneId)) {
        return res.status(400).json({
          error: "milestoneId must be a number",
          code: "INVALID_ID",
        });
      }
      const existing = await prisma.travelPaymentSchedule.findFirst({
        where: {
          id: milestoneId,
          invoiceId,
          tenantId: req.travelTenant.id,
        },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Milestone not found",
          code: "MILESTONE_NOT_FOUND",
        });
      }

      const data = {};
      const {
        milestoneOrder,
        expectedAmount,
        dueDate,
        expectedCurrency,
        receivedAmount,
        notes,
        status,
        paidAt,
        // G025 — anchor-relative due-date metadata.
        anchorType,
        anchorOffset,
      } = req.body || {};

      if (milestoneOrder !== undefined) {
        data.milestoneOrder = assertValidMilestoneOrder(milestoneOrder);
      }
      if (expectedAmount !== undefined) {
        data.expectedAmount = String(assertValidExpectedAmount(expectedAmount));
      }
      if (expectedCurrency !== undefined) {
        if (expectedCurrency === null || expectedCurrency === "") {
          return res.status(400).json({
            error: "expectedCurrency must be a non-empty string",
            code: "INVALID_CURRENCY",
          });
        }
        data.expectedCurrency = String(expectedCurrency);
      }

      // G025 — anchor metadata update + recompute.
      let resolvedAnchorType = existing.anchorType;
      let resolvedAnchorOffset = existing.anchorOffset;
      if (anchorType !== undefined) {
        if (anchorType === null) {
          resolvedAnchorType = null;
          data.anchorType = null;
        } else {
          if (!isValidAnchorType(anchorType)) {
            return res.status(400).json({
              error: `anchorType must be one of: ${VALID_ANCHOR_TYPES.join(", ")}`,
              code: "INVALID_ANCHOR_TYPE",
            });
          }
          resolvedAnchorType = String(anchorType);
          data.anchorType = resolvedAnchorType;
        }
      }
      if (anchorOffset !== undefined) {
        if (anchorOffset === null) {
          resolvedAnchorOffset = null;
          data.anchorOffset = null;
        } else {
          const offset = Number(anchorOffset);
          if (!Number.isFinite(offset) || !Number.isInteger(offset)) {
            return res.status(400).json({
              error: "anchorOffset must be an integer",
              code: "INVALID_ANCHOR_OFFSET",
            });
          }
          resolvedAnchorOffset = offset;
          data.anchorOffset = offset;
        }
      }

      // Recompute anchor-derived dueDate when the anchor changed AND no
      // explicit dueDate is also supplied in this request.
      let anchorComputedDueDate = null;
      if (resolvedAnchorType != null && resolvedAnchorOffset != null) {
        anchorComputedDueDate = computeAnchorDueDate({
          anchorType: resolvedAnchorType,
          anchorOffset: resolvedAnchorOffset,
          invoice,
          trip: null,
        });
        // If the anchor metadata changed AND the operator didn't pass an
        // explicit dueDate, materialise the anchor-derived dueDate.
        if (
          dueDate === undefined &&
          anchorComputedDueDate &&
          (anchorType !== undefined || anchorOffset !== undefined)
        ) {
          data.dueDate = anchorComputedDueDate;
        }
      }

      if (dueDate !== undefined) {
        data.dueDate = parseMilestoneDueDate(dueDate);
      }

      // G027 — deviation detection on UPDATE. Same shape as POST: explicit
      // dueDate vs anchor-computed dueDate. The deviation tag fires only
      // when the explicit dueDate is supplied in THIS request AND it
      // diverges from the anchor-computed date.
      let deviation = false;
      let deviationDelta = null;
      if (
        dueDate !== undefined &&
        data.dueDate !== null &&
        data.dueDate !== undefined &&
        anchorComputedDueDate
      ) {
        const explicitMs = new Date(data.dueDate).getTime();
        const computedMs = anchorComputedDueDate.getTime();
        if (explicitMs !== computedMs) {
          deviation = true;
          deviationDelta = Math.round((explicitMs - computedMs) / (1000 * 60 * 60 * 24));
        }
      }
      if (receivedAmount !== undefined) {
        if (receivedAmount === null) {
          data.receivedAmount = null;
        } else {
          const v = Number(receivedAmount);
          if (!Number.isFinite(v) || v < 0) {
            return res.status(400).json({
              error: "receivedAmount must be a non-negative number",
              code: "INVALID_AMOUNT",
            });
          }
          data.receivedAmount = String(v);
        }
      }
      if (notes !== undefined) {
        data.notes = notes === null ? null : String(notes);
      }
      if (status !== undefined) {
        assertValidScheduleStatus(status);
        data.status = status;
        // Auto-set paidAt when transitioning to 'paid' (caller didn't supply one).
        if (status === "paid" && paidAt === undefined && !existing.paidAt) {
          data.paidAt = new Date();
        }
      }
      if (paidAt !== undefined) {
        data.paidAt = parsePaidAt(paidAt);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({
          error: "no updatable fields provided",
          code: "EMPTY_BODY",
        });
      }

      const updated = await prisma.travelPaymentSchedule.update({
        where: { id: milestoneId },
        data,
      });

      await writeAudit(
        "TravelPaymentSchedule",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId,
          fields: Object.keys(data),
          // G025 — anchor metadata snapshot.
          ...(resolvedAnchorType
            ? {
                anchorType: resolvedAnchorType,
                anchorOffset: resolvedAnchorOffset,
                anchorComputedDueDate: anchorComputedDueDate
                  ? anchorComputedDueDate.toISOString()
                  : null,
              }
            : {}),
          // G027 — deviation tag for "manual override" detection.
          ...(deviation ? { deviation: true, deviationDeltaDays: deviationDelta } : {}),
        },
      );

      res.json(updated);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] update schedule error:", e.message);
      res.status(500).json({ error: "Failed to update milestone" });
    }
  },
);

// DELETE /api/travel/invoices/:id/schedule/:milestoneId — ADMIN/MANAGER only.
// Hard delete (waived status is the soft-decline path — operators choose
// status='waived' if they want the milestone to remain in history).
router.delete(
  "/invoices/:id/schedule/:milestoneId",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "delete"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const milestoneId = parseInt(req.params.milestoneId, 10);
      if (!Number.isFinite(milestoneId)) {
        return res.status(400).json({
          error: "milestoneId must be a number",
          code: "INVALID_ID",
        });
      }
      const existing = await prisma.travelPaymentSchedule.findFirst({
        where: {
          id: milestoneId,
          invoiceId,
          tenantId: req.travelTenant.id,
        },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Milestone not found",
          code: "MILESTONE_NOT_FOUND",
        });
      }

      // Audit BEFORE delete (same pattern as supplier-payable DELETE).
      await writeAudit(
        "TravelPaymentSchedule",
        "DELETE",
        milestoneId,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId,
          milestoneOrder: existing.milestoneOrder,
          expectedAmount: String(existing.expectedAmount),
          status: existing.status,
        },
      );

      await prisma.travelPaymentSchedule.delete({ where: { id: milestoneId } });
      res.status(204).end();
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] delete schedule error:", e.message);
      res.status(500).json({ error: "Failed to delete milestone" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/manual-payment
// Record an offline customer payment directly against an invoice that has no
// payment schedule (legacy/header-only invoices). Scheduled invoices continue
// to use the milestone endpoint below.
router.post(
  "/invoices/:id/manual-payment",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      if (invoice.tripId) {
        return res.status(409).json({
          error: "TMC trip invoices are settled through participant installments.",
          code: "TMC_INSTALLMENT_ONLY",
        });
      }

      if (!["Issued", "Partial"].includes(invoice.status)) {
        return res.status(400).json({
          error: "Only Issued or Partial invoices can receive a payment",
          code: "INVALID_INVOICE_STATUS",
        });
      }

      const { amount, method, reference, paidAt } = req.body || {};
      const amountNumber = Number(amount);
      if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
        return res.status(400).json({
          error: "amount must be a positive number",
          code: "INVALID_AMOUNT",
        });
      }
      if (!method || typeof method !== "string" || method.trim() === "") {
        return res.status(400).json({
          error: "method is required",
          code: "MISSING_METHOD",
        });
      }
      const paidAtDate = parsePaidAt(paidAt);
      const effectivePaidAt = paidAtDate === undefined ? new Date() : paidAtDate;
      const amountRounded = round2(amountNumber);
      const totalReceivedBeforePayment = await successfulTravelInvoicePaymentTotal(
        req.travelTenant.id,
        invoice.id,
      );
      const outstandingBeforePayment = round2(
        Math.max(0, Number(invoice.totalAmount || 0) - totalReceivedBeforePayment),
      );
      if (amountRounded > outstandingBeforePayment) {
        return res.status(400).json({
          error: `Payment cannot exceed the outstanding amount of ${outstandingBeforePayment.toFixed(2)}`,
          code: "PAYMENT_EXCEEDS_OUTSTANDING",
          outstandingAmount: outstandingBeforePayment,
        });
      }

      const payment = await prisma.payment.create({
        data: {
          tenantId: req.travelTenant.id,
          invoiceId,
          amount: amountRounded,
          currency: invoice.currency,
          gateway: method.trim(),
          gatewayId: reference ? String(reference).trim().slice(0, 128) : null,
          status: "SUCCESS",
          paidAt: effectivePaidAt,
          metadata: JSON.stringify({
            type: "travel-invoice-manual-payment",
            invoiceNum: invoice.invoiceNum,
            subBrand: invoice.subBrand,
          }),
        },
      });

      try {
        await enqueueTransaction({
          tenantId: req.travelTenant.id,
          subBrand: invoice.subBrand,
          sourceType: "TRAVEL_INVOICE_PAYMENT",
          sourceId: payment.id,
          reference: reference ? String(reference).trim() : `RECEIPT-${payment.id}`,
          transactionType: "RECEIPT",
          tripId: invoice.itineraryId,
          partyName: `Customer #${invoice.contactId}`,
          amount: amountRounded,
          voucherType: "RECEIPT",
          payload: {
            paymentId: payment.id,
            invoiceId: invoice.id,
            invoiceNum: invoice.invoiceNum,
            amount: amountRounded,
            currency: invoice.currency,
            method: method.trim(),
            reference: reference || null,
            paidAt: effectivePaidAt,
            billReference: invoice.invoiceNum,
          },
        });
      } catch (queueError) {
        console.warn("[travel-invoices] Tally receipt queue preparation failed:", queueError.message);
      }

      const successfulPayments = await prisma.payment.findMany({
        where: { tenantId: req.travelTenant.id, invoiceId, status: "SUCCESS" },
        select: { amount: true },
      });
      const totalReceived = round2(
        successfulPayments.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      );
      const totalDue = Number(invoice.totalAmount || 0);
      const nextStatus = totalDue > 0 && totalReceived >= totalDue ? "Paid" : "Partial";

      const updatedInvoice = await prisma.travelInvoice.update({
        where: { id: invoice.id },
        data: {
          status: nextStatus,
          ...(nextStatus === "Paid" ? { paidAt: effectivePaidAt } : {}),
        },
      });

      await writeAudit(
        "TravelInvoice",
        "MANUAL_PAYMENT",
        invoice.id,
        req.user.userId,
        req.travelTenant.id,
        {
          paymentId: payment.id,
          amount: String(amountRounded),
          method: method.trim(),
          reference: reference ? String(reference).trim().slice(0, 128) : null,
          totalReceived: String(totalReceived),
          status: nextStatus,
        },
      );

      res.status(201).json({ payment, invoice: updatedInvoice, totalReceived });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-invoices] manual payment error:", e.message);
      res.status(500).json({ error: "Failed to record manual payment" });
    }
  },
);

// POST /api/travel/invoices/:id/schedule/:milestoneId/mark-paid
// PRD_TRAVEL_BILLING §3 — slice 19 (operator-driven installment settlement).
//
// Slice 17 (commit 572cb107) auto-creates a 25/50/25 PaymentSchedule on
// /:id/issue. Slice 18 shipped the TravelVoucher PDF subtype. This slice
// closes the settlement loop: when an installment is collected (cash / UPI /
// bank-transfer / gateway-callback), the operator hits this endpoint and we:
//   1. Create a Payment row (financial record-of-record) linked back to the
//      milestone + invoice via metadata JSON. We don't add a Prisma FK from
//      Payment → TravelPaymentSchedule (schema freeze; metadata link is
//      enough for reporting + GST audit-trail purposes).
//   2. Update the TravelPaymentSchedule with status='paid', paidAt=<body or
//      now>, and receivedAmount=<body.amount>.
//   3. Check sibling milestones — if all schedules on this invoice are now
//      'paid' or 'waived', flip the parent invoice status to 'Paid' and
//      emit `travel.invoice.paid` via eventBus for downstream cron + audit.
//      Otherwise transition the invoice to 'Partial' (so dashboards reflect
//      mid-settlement state correctly).
//
// Body shape:
//   { amount: <number, required>, method: <string, required>,
//     reference?: <string — gateway charge ID, UPI ref, bank txn ref>,
//     paidAt?: <ISO date string — defaults to now> }
//
// Idempotency: re-marking an already-paid milestone is a no-op (returns the
// existing row with payment=null, idempotent=true). This guards the gateway-
// webhook retry case where Razorpay/Stripe deliver the same charge twice;
// the second hit MUST NOT double-credit.
//
// Auth: ADMIN/MANAGER only (USER cannot reconcile finances — same gate as
// slice-6 schedule POST/PUT/DELETE).
//
// Returns 200 + { milestone, payment, invoice, idempotent, allPaid }.
//
// Error codes: INVALID_ID, INVALID_AMOUNT, MISSING_METHOD, MILESTONE_NOT_FOUND,
// INVALID_DATE.
// ============================================================================
router.post(
  "/invoices/:id/schedule/:milestoneId/mark-paid",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      const milestoneId = parseInt(req.params.milestoneId, 10);
      if (!Number.isFinite(milestoneId)) {
        return res.status(400).json({
          error: "milestoneId must be a number",
          code: "INVALID_ID",
        });
      }

      const existing = await prisma.travelPaymentSchedule.findFirst({
        where: {
          id: milestoneId,
          invoiceId,
          tenantId: req.travelTenant.id,
        },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Milestone not found",
          code: "MILESTONE_NOT_FOUND",
        });
      }

      // Idempotency: already-paid milestone is a no-op. Returns the row
      // unchanged + idempotent=true. Webhook retries (Razorpay/Stripe deliver
      // the same charge twice) MUST NOT double-credit; this is the guard.
      if (existing.status === "paid") {
        // Compute allPaid against current state so the response still
        // tells the truth about the parent invoice.
        const siblings = await prisma.travelPaymentSchedule.findMany({
          where: { invoiceId, tenantId: req.travelTenant.id },
        });
        const allPaid = siblings.every(
          (s) => s.status === "paid" || s.status === "waived",
        );
        return res.status(200).json({
          milestone: existing,
          payment: null,
          invoice,
          idempotent: true,
          allPaid,
        });
      }

      const { amount, method, reference, paidAt } = req.body || {};

      // amount validation — must be a positive finite number. Half-up
      // round to 2 decimal places per standing rule.
      if (amount == null || amount === "") {
        return res.status(400).json({
          error: "amount is required",
          code: "INVALID_AMOUNT",
        });
      }
      const amtNum = Number(amount);
      if (!Number.isFinite(amtNum) || amtNum <= 0) {
        return res.status(400).json({
          error: "amount must be a positive number",
          code: "INVALID_AMOUNT",
        });
      }
      const amountRounded =
        Math.round((amtNum + Number.EPSILON) * 100) / 100;

      // method is required — gateway/channel attribution (cash, upi, neft,
      // razorpay, stripe, manual). Operator-supplied string; we don't
      // whitelist because PRD §3 hasn't pinned the enum yet.
      if (!method || typeof method !== "string" || method.trim() === "") {
        return res.status(400).json({
          error: "method is required",
          code: "MISSING_METHOD",
        });
      }
      const methodNorm = String(method).trim();

      // paidAt: optional ISO date string, defaults to now.
      let paidAtDate = new Date();
      if (paidAt !== undefined && paidAt !== null && paidAt !== "") {
        const parsed = new Date(paidAt);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "paidAt must be a valid ISO date string",
            code: "INVALID_DATE",
          });
        }
        paidAtDate = parsed;
      }

      const totalReceivedBeforePayment = await successfulTravelInvoicePaymentTotal(
        req.travelTenant.id,
        invoice.id,
      );
      const outstandingBeforePayment = Math.round(
        Math.max(0, Number(invoice.totalAmount || 0) - totalReceivedBeforePayment) * 100,
      ) / 100;
      if (amountRounded > outstandingBeforePayment) {
        return res.status(400).json({
          error: `Payment cannot exceed the outstanding amount of ${outstandingBeforePayment.toFixed(2)}`,
          code: "PAYMENT_EXCEEDS_OUTSTANDING",
          outstandingAmount: outstandingBeforePayment,
        });
      }

      // 1. Create the Payment row (financial record-of-record).
      // Payment.invoiceId is generic Int? — we re-use it for the TravelInvoice
      // id (the schema doesn't separate Payment from TravelPayment; the
      // metadata JSON disambiguates).
      const payment = await prisma.payment.create({
        data: {
          tenantId: req.travelTenant.id,
          invoiceId,
          amount: amountRounded,
          currency: existing.expectedCurrency || invoice.currency,
          gateway: methodNorm,
          gatewayId: reference ? String(reference) : null,
          status: "SUCCESS",
          paidAt: paidAtDate,
          metadata: JSON.stringify({
            type: "travel-payment-schedule",
            scheduleId: milestoneId,
            milestoneOrder: existing.milestoneOrder,
            invoiceNum: invoice.invoiceNum,
            subBrand: invoice.subBrand,
          }),
        },
      });

      try {
        await enqueueTransaction({
          tenantId: req.travelTenant.id,
          subBrand: invoice.subBrand,
          sourceType: "TRAVEL_INVOICE_PAYMENT",
          sourceId: payment.id,
          reference: reference ? String(reference) : `RECEIPT-${payment.id}`,
          transactionType: "RECEIPT",
          tripId: invoice.itineraryId,
          partyName: `Customer #${invoice.contactId}`,
          amount: amountRounded,
          voucherType: "RECEIPT",
          payload: {
            paymentId: payment.id,
            invoiceId: invoice.id,
            invoiceNum: invoice.invoiceNum,
            scheduleId: milestoneId,
            amount: amountRounded,
            currency: existing.expectedCurrency || invoice.currency,
            method: methodNorm,
            reference: reference || null,
            paidAt: paidAtDate,
            billReference: invoice.invoiceNum,
          },
        });
      } catch (queueError) {
        console.warn("[travel-invoices] Tally scheduled receipt queue preparation failed:", queueError.message);
      }

      // 2. Update the milestone: status='paid', paidAt, receivedAmount.
      const updatedMilestone = await prisma.travelPaymentSchedule.update({
        where: { id: milestoneId },
        data: {
          status: "paid",
          paidAt: paidAtDate,
          receivedAmount: String(amountRounded),
        },
      });

      // 3. Check siblings — if all are paid/waived, flip invoice to Paid;
      // otherwise flip to Partial (mid-settlement state). #945 defensive check:
      // Only mark invoice as "Paid" if there is at least one milestone AND all
      // are paid/waived. This prevents edge cases where an invoice with zero
      // milestones could incorrectly be marked Paid.
      const siblings = await prisma.travelPaymentSchedule.findMany({
        where: { invoiceId, tenantId: req.travelTenant.id },
      });
      const allPaid = siblings.length > 0 && siblings.every(
        (s) => s.status === "paid" || s.status === "waived",
      );
      const anyPaid = siblings.some((s) => s.status === "paid");
      let invoiceAfter = invoice;
      const targetInvoiceStatus = allPaid
        ? "Paid"
        : anyPaid
          ? "Partial"
          : invoice.status;
      if (
        invoice.status !== "Voided" &&
        targetInvoiceStatus !== invoice.status
      ) {
        invoiceAfter = await prisma.travelInvoice.update({
          where: { id: invoiceId },
          data: { status: targetInvoiceStatus },
        });
      }

      // 4. Audit row — TRAVEL_PAYMENT_SCHEDULE_MARK_PAID. Includes amount,
      // method, reference (if any), allPaid flag, invoice status transition.
      await writeAudit(
        "TravelPaymentSchedule",
        "TRAVEL_PAYMENT_SCHEDULE_MARK_PAID",
        milestoneId,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId,
          milestoneOrder: existing.milestoneOrder,
          amount: amountRounded,
          method: methodNorm,
          reference: reference ? String(reference) : null,
          allPaid,
          invoiceStatusAfter: invoiceAfter.status,
          paymentId: payment.id,
        },
      );

      // 5. Emit invoice.paid event on full settlement (downstream cron +
      // notification consumers). Best-effort; eventBus is optional.
      if (allPaid && invoiceAfter.status === "Paid") {
        try {
          require("../lib/eventBus").emitEvent(
            "travel.invoice.paid",
            {
              invoiceId,
              invoiceNum: invoice.invoiceNum,
              subBrand: invoice.subBrand,
              tenantId: req.travelTenant.id,
              totalAmount: String(invoice.totalAmount),
              currency: invoice.currency,
            },
            req.travelTenant.id,
            req.io,
          );
        } catch (_e) {
          /* event bus optional */
        }
      }

      return res.status(200).json({
        milestone: updatedMilestone,
        payment,
        invoice: invoiceAfter,
        idempotent: false,
        allPaid,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] mark-paid error:", e.message);
      res.status(500).json({ error: "Failed to mark milestone as paid" });
    }
  },
);

// ============================================================================
// /api/travel/payment-schedules/upcoming — cross-invoice milestone summary
// (PRD_TRAVEL_BILLING UC-2.5 month-end-close + DD-5.5 reminders cadence).
//
// Arc 2 #901 slice 7 — aggregate read endpoint over TravelPaymentSchedule
// rows joined to their parent TravelInvoice (invoiceNum + subBrand + contactId).
// Operator-facing "all milestones due in the next N days" / "all overdue
// milestones across all customers" view. Slice 6 (commit af0c6709) shipped
// the per-invoice CRUD; this slice ships the cross-invoice rollup.
//
// Auth: any verified token; tenant-scoped via req.travelTenant; sub-brand
// access enforced via getSubBrandAccessSet so a sub-brand-restricted MANAGER
// only sees milestones for invoices in their allowed sub-brands.
//
// Query params (all optional):
//   ?status=pending|partial|paid|overdue|waived  — filter (default: all)
//   ?allDates=true                               — no dueDate restriction.
//   ?within=7|14|30|60|90                        — dueDate within N future
//                                                  days from now (default: 30).
//                                                  Accepts any positive
//                                                  integer; the documented
//                                                  presets are conveniences,
//                                                  not constraints.
//   ?subBrand=tmc|rfu|travelstall|visasure       — filter to one sub-brand
//                                                  (within the caller's allowed
//                                                  set; outside-allowed → empty).
//   ?overdueOnly=true                            — past-due unsettled
//                                                  milestones (overrides
//                                                  ?within when truthy).
//   ?limit=N (default 100, clamped to [1, 500]).
//   ?offset=N (default 0).
//
// Response shape:
//   {
//     milestones: [
//       { id, invoiceId, invoiceNum, subBrand, contactId,
//         milestoneOrder, dueDate, expectedAmount, expectedCurrency,
//         status, receivedAmount, daysUntilDue, createdAt }
//     ],
//     total,
//     limit,
//     offset,
//     summary: {
//       byStatus: { pending: <int>, partial: <int>, ... },
//       totalExpected: "<decimal-string>",
//       totalReceived: "<decimal-string>",
//       currencyBreakdown: { INR: "<decimal-string>", USD: "..." }
//     }
//   }
//
// Decisions:
//   - daysUntilDue is JS-computed (Math.floor((due - now) / 86_400_000)).
//     Negative ⇒ overdue. NULL dueDate ⇒ daysUntilDue is null. Also NULL for
//     status paid/waived — a settled milestone's original dueDate would
//     otherwise still read as "N days overdue" next to its own Paid badge.
//   - summary is computed across the FULL filtered set (pre-pagination) so
//     the KPI cards stay stable while the operator scrolls through pages.
//     The table itself still respects ?limit / ?offset.
//   - totalExpected/totalReceived/currencyBreakdown emit as decimal STRINGS
//     (toFixed(2)) for Prisma Decimal-string compatibility; JS Number
//     precision would round 60000.005 + 0.005 silently. Mirrors the
//     `expectedAmount` shape on the milestone rows themselves.
//   - Error codes: INVALID_STATUS, INVALID_WITHIN, INVALID_SUB_BRAND,
//     INVALID_LIMIT.
// ============================================================================

const DEFAULT_WITHIN_DAYS = 30;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

function parseWithinDays(input) {
  if (input == null || input === "") return DEFAULT_WITHIN_DAYS;
  const v = Number(input);
  if (!Number.isInteger(v) || v <= 0) {
    const err = new Error("within must be a positive integer (days)");
    err.status = 400;
    err.code = "INVALID_WITHIN";
    throw err;
  }
  return v;
}

function parseLimitForSummary(input) {
  if (input == null || input === "") return DEFAULT_LIMIT;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 1) {
    const err = new Error("limit must be a positive integer");
    err.status = 400;
    err.code = "INVALID_LIMIT";
    throw err;
  }
  return Math.min(v, MAX_LIMIT);
}

function parseOffsetForSummary(input) {
  if (input == null || input === "") return 0;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 0) return 0;
  return v;
}

// Add two decimal strings safely. Both inputs are normalised to Number,
// summed, then toFixed(2)'d. For the scales we operate at (per-tenant
// monthly milestone totals — well below 1e15) Number precision is fine;
// the toFixed sidesteps the float-display artefact (60000 + 60000.01 →
// "120000.01" not "120000.0099999...").
function addDecimal(a, b) {
  const x = Number(a == null ? 0 : a);
  const y = Number(b == null ? 0 : b);
  return (x + y).toFixed(2);
}

router.get(
  "/payment-schedules/upcoming",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      if (status) assertValidScheduleStatus(status);

      const subBrand = req.query.subBrand ? String(req.query.subBrand) : null;
      if (subBrand) assertValidSubBrand(subBrand);

      const overdueOnly =
        req.query.overdueOnly === "true" || req.query.overdueOnly === true;
      const allDates = req.query.allDates === "true" || req.query.allDates === true;

      const limit = parseLimitForSummary(req.query.limit);
      const offset = parseOffsetForSummary(req.query.offset);

      const now = new Date();
      const where = { tenantId: req.travelTenant.id };
      if (status) where.status = status;

      // Date window: overdueOnly means "past-due unsettled milestones" and
      // only widens to a settled-state exclusion when no explicit status is
      // already supplied.
      if (overdueOnly) {
        where.dueDate = { lt: now };
        if (!status) {
          where.status = { notIn: ["paid", "waived"] };
        }
      } else if (allDates) {
        // Intentionally no dueDate constraint.
      } else {
        const withinDays = parseWithinDays(req.query.within);
        const upper = new Date(now.getTime() + withinDays * 86_400_000);
        where.dueDate = { gte: now, lte: upper };
      }

      // Sub-brand filtering joins through the parent invoice. Prisma can't
      // filter on a related field's column inside a top-level findMany
      // where-clause without `is:` — use the nested filter shape.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      const invoiceFilter = {};
      if (subBrand) {
        if (allowed !== null && !canAccessSubBrand(allowed, subBrand)) {
          // Filter requested a sub-brand the caller can't see — return
          // empty silently (consistent with the existing /invoices list
          // pattern: substitute a never-matching value instead of 403).
          invoiceFilter.subBrand = "__none__";
        } else {
          invoiceFilter.subBrand = subBrand;
        }
      } else if (allowed !== null) {
        // No explicit subBrand filter + restricted access ⇒ narrow to the
        // allowed set. Empty set ⇒ never-match.
        invoiceFilter.subBrand =
          allowed.size > 0 ? { in: [...allowed] } : "__none__";
      }
      if (Object.keys(invoiceFilter).length > 0) {
        where.invoice = { is: invoiceFilter };
      }

      const [rows, total, summaryRows] = await Promise.all([
        prisma.travelPaymentSchedule.findMany({
          where,
          include: {
            invoice: {
              select: { invoiceNum: true, subBrand: true, contactId: true },
            },
          },
          orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          take: limit,
          skip: offset,
        }),
        prisma.travelPaymentSchedule.count({ where }),
        prisma.travelPaymentSchedule.findMany({
          where,
          select: {
            status: true,
            dueDate: true,
            expectedAmount: true,
            receivedAmount: true,
            expectedCurrency: true,
          },
        }),
      ]);

      const nowMs = now.getTime();
      const milestones = rows.map((r) => {
        const dueMs =
          r.dueDate instanceof Date
            ? r.dueDate.getTime()
            : r.dueDate
              ? new Date(r.dueDate).getTime()
              : null;
        // A milestone that's already settled (paid/waived) keeps its
        // original dueDate in the DB, so pure date math would still report
        // it "N days overdue" even though there's nothing left to chase —
        // contradicting its own Paid/Waived badge. Null it out (renders as
        // "—" client-side) for those terminal statuses only; pending/
        // partial/overdue rows keep the real countdown.
        const isSettled = r.status === "paid" || r.status === "waived";
        const daysUntilDue =
          dueMs == null || isSettled ? null : Math.floor((dueMs - nowMs) / 86_400_000);
        return {
          id: r.id,
          invoiceId: r.invoiceId,
          invoiceNum: r.invoice ? r.invoice.invoiceNum : null,
          subBrand: r.invoice ? r.invoice.subBrand : null,
          contactId: r.invoice ? r.invoice.contactId : null,
          milestoneOrder: r.milestoneOrder,
          dueDate: r.dueDate,
          expectedAmount: r.expectedAmount,
          expectedCurrency: r.expectedCurrency,
          status: r.status,
          receivedAmount: r.receivedAmount,
          daysUntilDue,
          createdAt: r.createdAt,
          // Contact fields populated below (batch lookup avoids N+1).
          contactName: null,
          contactPhone: null,
          contactEmail: null,
        };
      });

      // Attach the customer behind each milestone so the operator can SEE who
      // owes (and the "Notify" action knows where to send). Batch-fetch the
      // distinct contactIds in one query (tenant-scoped), then map onto rows —
      // avoids an N+1 against Contact.
      const contactIds = [
        ...new Set(milestones.map((m) => m.contactId).filter((x) => x != null)),
      ];
      // Fail-soft: contact data is enrichment, not core. A lookup failure (or a
      // Prisma client without the contact model in a stubbed env) must never
      // break the milestone list — rows just keep null contact fields.
      if (contactIds.length > 0 && prisma.contact && typeof prisma.contact.findMany === "function") {
        try {
          const contacts = await prisma.contact.findMany({
            where: { id: { in: contactIds }, tenantId: req.travelTenant.id },
            select: { id: true, name: true, phone: true, email: true },
          });
          const byId = new Map(contacts.map((c) => [c.id, c]));
          for (const m of milestones) {
            const c = m.contactId != null ? byId.get(m.contactId) : null;
            if (c) {
              m.contactName = c.name || null;
              m.contactPhone = c.phone || null;
              m.contactEmail = c.email || null;
            }
          }
        } catch (e) {
          console.error("[travel-invoices] milestone contact enrichment failed (non-fatal):", e.message);
        }
      }

      // Summary aggregates — computed over the full filtered set so the KPI
      // cards reflect the entire window, not just the current page.
      const byStatus = {};
      const currencyBreakdown = {};
      let totalExpected = "0.00";
      let totalReceived = "0.00";
      for (const m of summaryRows) {
        byStatus[m.status] = (byStatus[m.status] || 0) + 1;
        const dueMs =
          m.dueDate instanceof Date
            ? m.dueDate.getTime()
            : m.dueDate
              ? new Date(m.dueDate).getTime()
              : null;
        const isSettled = m.status === "paid" || m.status === "waived";
        // Past-due unsettled rows are additionally bucketed as overdue so the
        // KPI surfaces them alongside explicit overdue-status rows. Rows that
        // already carry status='overdue' are counted once (in the status bucket
        // above), not double-counted here.
        if (!isSettled && m.status !== "overdue" && dueMs != null && dueMs < nowMs) {
          byStatus.overdue = (byStatus.overdue || 0) + 1;
        }
        totalExpected = addDecimal(totalExpected, m.expectedAmount);
        totalReceived = addDecimal(totalReceived, m.receivedAmount);
        const cur = m.expectedCurrency || "INR";
        currencyBreakdown[cur] = addDecimal(
          currencyBreakdown[cur] || "0.00",
          m.expectedAmount,
        );
      }

      res.json({
        milestones,
        total,
        limit,
        offset,
        summary: {
          byStatus,
          totalExpected,
          totalReceived,
          currencyBreakdown,
        },
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] schedule upcoming error:", e.message);
      res.status(500).json({ error: "Failed to list upcoming milestones" });
    }
  },
);

// ============================================================================
// POST /api/travel/payment-schedules/:scheduleId/remind — manual customer
// payment reminder (the Milestone Tracker "Notify" button).
//
// The paymentScheduleReminderEngine cron chases pending/partial milestones on a
// fixed T-7/T-3/T-1 cadence; this is the operator's on-demand "nudge this
// customer now" surface for any single milestone. Sends to the invoice's
// contact over the SAME transports as the public advance-link flow — email
// (SendGrid) + WhatsApp Web — both best-effort, then bumps the per-schedule
// reminder counter + writes an audit row.
//
// Auth: verifyToken + requireTravelTenant + invoices:update (same gate as
// mark-paid — a customer-facing send is an operator action, not USER-level).
// Sub-brand access enforced via getSubBrandAccessSet.
//
// Returns 200 { ok, channels: ["email","whatsapp"], milestoneId, contactName,
//   lastReminderSentAt }. ok=false (channels empty) means the recipient exists
// but every channel send was skipped/failed (e.g. SendGrid unconfigured +
// WhatsApp not linked) — the UI surfaces that distinctly from a hard error.
//
// Error codes: INVALID_ID, MILESTONE_NOT_FOUND, SUB_BRAND_DENIED,
//   NOTHING_TO_REMIND (paid/waived), NO_CONTACT_CHANNEL (no email AND no phone).
// ============================================================================
router.post(
  "/payment-schedules/:scheduleId/remind",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const scheduleId = parseInt(req.params.scheduleId, 10);
      if (!Number.isFinite(scheduleId)) {
        return res
          .status(400)
          .json({ error: "scheduleId must be a number", code: "INVALID_ID" });
      }

      const schedule = await prisma.travelPaymentSchedule.findFirst({
        where: { id: scheduleId, tenantId: req.travelTenant.id },
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNum: true,
              subBrand: true,
              contactId: true,
              currency: true,
            },
          },
        },
      });
      if (!schedule || !schedule.invoice) {
        return res
          .status(404)
          .json({ error: "Milestone not found", code: "MILESTONE_NOT_FOUND" });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, schedule.invoice.subBrand)) {
        return res
          .status(403)
          .json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }

      if (schedule.status === "paid" || schedule.status === "waived") {
        return res.status(400).json({
          error: `Nothing to remind — this milestone is already ${schedule.status}.`,
          code: "NOTHING_TO_REMIND",
        });
      }

      const contact = await prisma.contact.findFirst({
        where: { id: schedule.invoice.contactId, tenantId: req.travelTenant.id },
        select: { id: true, name: true, email: true, phone: true },
      });
      if (!contact || (!contact.email && !contact.phone)) {
        return res.status(422).json({
          error: "This customer has no email or phone on file to notify.",
          code: "NO_CONTACT_CHANNEL",
        });
      }

      // Branding for the message body — best-effort tenant name.
      let brand = "our team";
      try {
        const t = await prisma.tenant.findUnique({
          where: { id: req.travelTenant.id },
          select: { name: true },
        });
        if (t && t.name) brand = t.name;
      } catch { /* keep generic brand */ }

      const cur = schedule.expectedCurrency || schedule.invoice.currency || "INR";
      const amt = Number(schedule.expectedAmount || 0).toLocaleString("en-IN");
      const due = schedule.dueDate
        ? new Date(schedule.dueDate).toISOString().slice(0, 10)
        : null;
      const isOverdue =
        schedule.dueDate && new Date(schedule.dueDate).getTime() < Date.now();
      const dueLine = due
        ? isOverdue
          ? `was due on ${due}`
          : `is due on ${due}`
        : "is now due";
      const name = (contact.name && contact.name.trim()) || "there";

      // Generate a hosted "click & pay" link for THIS milestone's amount via the
      // tenant's own (BYOK) gateway. A PENDING Payment row is created so the
      // existing webhook reconciles it to PAID on completion. Fail-soft: if no
      // gateway is configured (or the gateway rejects) the reminder still sends,
      // just without a link.
      let payUrl = null;
      try {
        const frontendBase = getFrontendUrlFromRequest(req);
        const linkRes = await createInvoicePaymentLink({
          tenantId: req.travelTenant.id,
          invoice: {
            id: schedule.invoice.id,
            invoiceNum: `${schedule.invoice.invoiceNum} — instalment ${schedule.milestoneOrder}`,
            amount: Number(schedule.expectedAmount),
          },
          contact: { name: contact.name, email: contact.email, phone: contact.phone },
          contactId: contact.id,
          currency: cur,
          tenantName: brand !== "our team" ? brand : undefined,
          baseUrl: frontendBase,
          travelContext: { scheduleId: schedule.id, travelInvoiceId: schedule.invoice.id },
        });
        if (linkRes && linkRes.url) {
          payUrl = linkRes.url;
        } else if (linkRes && linkRes.error) {
          console.warn(
            `[travel-invoices] reminder pay-link unavailable (${linkRes.code}): ${linkRes.error}`,
          );
        }
      } catch (e) {
        console.error("[travel-invoices] reminder pay-link failed (non-fatal):", e.message);
      }

      const text =
        `Hi ${name},\n\n` +
        `This is a friendly reminder that your payment of ${cur} ${amt} for booking ` +
        `${schedule.invoice.invoiceNum} (instalment ${schedule.milestoneOrder}) ${dueLine}.\n\n` +
        (payUrl ? `Pay securely here:\n${payUrl}\n\n` : "") +
        `Please complete the payment at your earliest convenience. If you've already paid, ` +
        `kindly ignore this message.\n\n— ${brand}`;

      const html =
        `<p>Hi ${name},</p>` +
        `<p>This is a friendly reminder that your payment of ${cur} ${amt} for booking ` +
        `${schedule.invoice.invoiceNum} (instalment ${schedule.milestoneOrder}) ${dueLine}.</p>` +
        (payUrl
          ? `<p>Pay securely: <a href="${payUrl}" target="_blank" rel="noopener noreferrer">Pay now</a></p>`
          : "") +
        `<p>Please complete the payment at your earliest convenience. ` +
        `If you&rsquo;ve already paid, kindly ignore this message.</p>` +
        `<p>&mdash; ${brand}</p>`;

      const channels = [];
      if (contact.email) {
        try {
          const r = await sendEmail({
            to: contact.email,
            subject: `Payment reminder — ${schedule.invoice.invoiceNum} (${cur} ${amt})`,
            text,
            html,
          });
          if (r && r.sent) channels.push("email");
        } catch (e) {
          console.error("[travel-invoices] reminder email failed (non-fatal):", e.message);
        }
      }
      if (contact.phone) {
        try {
          const r = await waWebClient.sendBestEffort({
            tenantId: req.travelTenant.id,
            subBrand: schedule.invoice.subBrand,
            toPhone: contact.phone,
            contactId: contact.id,
            fallbackText:
              `Hi ${name}! Reminder: ${cur} ${amt} for booking ${schedule.invoice.invoiceNum} ` +
              `(instalment ${schedule.milestoneOrder}) ${dueLine}.` +
              (payUrl
                ? ` Pay securely here: ${payUrl}`
                : ` Please complete your payment when you can.`) +
              ` — ${brand}`,
          });
          if (r && r.sent) channels.push("whatsapp");
        } catch (e) {
          console.error("[travel-invoices] reminder WhatsApp failed (non-fatal):", e.message);
        }
      }

      // Bump the per-schedule reminder counter + timestamp (best-effort — a
      // failed counter write must not fail the send that already happened).
      const now = new Date();
      try {
        await prisma.travelPaymentSchedule.update({
          where: { id: schedule.id },
          data: {
            remindersSentCount: Number(schedule.remindersSentCount || 0) + 1,
            lastReminderSentAt: now,
          },
        });
      } catch (e) {
        console.error("[travel-invoices] reminder counter bump failed (non-fatal):", e.message);
      }

      await writeAudit(
        "TravelPaymentSchedule",
        "PAYMENT_SCHEDULE_REMINDER_SENT",
        schedule.id,
        req.user.userId,
        req.travelTenant.id,
        {
          invoiceId: schedule.invoiceId,
          invoiceNum: schedule.invoice.invoiceNum,
          milestoneOrder: schedule.milestoneOrder,
          manual: true,
          channels: {
            email: channels.includes("email"),
            whatsapp: channels.includes("whatsapp"),
          },
          payLinkSent: Boolean(payUrl),
          expectedAmount: String(schedule.expectedAmount),
          expectedCurrency: cur,
        },
      ).catch((e) =>
        console.warn("[travel-invoices] reminder audit failed (non-fatal):", e.message),
      );

      return res.json({
        ok: channels.length > 0,
        channels,
        payUrl,
        milestoneId: schedule.id,
        contactName: contact.name || null,
        lastReminderSentAt: now,
      });
    } catch (e) {
      console.error("[travel-invoices] manual reminder error:", e.message);
      res.status(500).json({ error: "Failed to send reminder", code: "REMINDER_FAILED" });
    }
  },
);

function parsePaymentMetadata(metadata) {
  try { return JSON.parse(metadata || "{}"); } catch (_e) { return {}; }
}

function isSuccessfulPaymentStatus(status) {
  return ["SUCCESS", "PAID", "paid", "success"].includes(String(status || ""));
}

function isPaymentLinkedToTravelInvoice(payment, meta, invoiceId) {
  return (
    (meta.type === "travel-payment-schedule" && payment.invoiceId === invoiceId) ||
    (meta.type === "travel-invoice-manual-payment" && payment.invoiceId === invoiceId) ||
    ((meta.kind === "travel-milestone" || meta.kind === "travel-invoice") && Number(meta.travelInvoiceId) === invoiceId) ||
    (meta.type === "travel-quote-advance" && Number(meta.travelInvoiceId) === invoiceId)
  );
}

async function successfulTravelInvoicePaymentTotal(tenantId, invoiceId) {
  try {
    const candidates = await prisma.payment.findMany({
      where: {
        tenantId,
        OR: [
          { invoiceId },
          { metadata: { contains: `\"travelInvoiceId\":${invoiceId}` } },
        ],
      },
      select: { id: true, invoiceId: true, amount: true, status: true, metadata: true },
    });
    return candidates
      .map((pmt) => ({ pmt, meta: parsePaymentMetadata(pmt.metadata) }))
      .filter(({ pmt, meta }) => isSuccessfulPaymentStatus(pmt.status) && isPaymentLinkedToTravelInvoice(pmt, meta, invoiceId))
      .reduce((sum, { pmt }) => sum + Number(pmt.amount || 0), 0);
  } catch (_e) {
    return 0;
  }
}

// ============================================================================
// POST /api/travel/invoices/:id/payment-link — generate a hosted "click & pay"
// link for the WHOLE travel invoice's outstanding balance. Parity with the
// generic billing "Generate payment link" action, but BYOK (tenant Razorpay)
// and tagged kind='travel-invoice' so the webhook reconciles it back to THIS
// TravelInvoice + its milestones (not the generic Invoice table).
//
// Auth: invoices:update. Returns { url, gateway, amount, currency } or an error
// code (NO_AMOUNT, ALREADY_PAID, NO_GATEWAY, LINK_FAILED).
// ============================================================================
router.post(
  "/invoices/:id/payment-link",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, id);
      if (!invoice) return;

      if (invoice.tripId) {
        return res.status(409).json({
          error: "TMC trip invoices are settled through participant installments.",
          code: "TMC_INSTALLMENT_ONLY",
        });
      }

      const total = Number(invoice.totalAmount || 0);
      if (!(total > 0)) {
        return res
          .status(400)
          .json({ error: "Invoice has no payable amount.", code: "NO_AMOUNT" });
      }

      // Outstanding = total minus money already captured for this travel invoice.
      // Milestone rows are authoritative when present, but direct travel-invoice
      // and quote-advance links may have no milestones at all, so also subtract
      // successful Payment rows linked by travelInvoiceId. Use max() to avoid
      // double-counting when a payment also updated a milestone row.
      let outstanding = total;
      try {
        const [schedules, paymentReceived] = await Promise.all([
          prisma.travelPaymentSchedule.findMany({
            where: { invoiceId: invoice.id, tenantId: req.travelTenant.id },
            select: { receivedAmount: true, status: true, expectedAmount: true },
          }),
          successfulTravelInvoicePaymentTotal(req.travelTenant.id, invoice.id),
        ]);
        const scheduleReceived = schedules.reduce((sum, r) => {
          const got = r.receivedAmount != null
            ? Number(r.receivedAmount)
            : r.status === "paid"
              ? Number(r.expectedAmount || 0)
              : 0;
          return sum + got;
        }, 0);
        const alreadyReceived = Math.max(scheduleReceived, paymentReceived);
        outstanding = round2(Math.max(0, total - alreadyReceived));
      } catch { /* fall back to full total */ }

      if (!(outstanding > 0)) {
        return res
          .status(400)
          .json({ error: "This invoice is already fully paid.", code: "ALREADY_PAID" });
      }

      const contact = await prisma.contact
        .findFirst({
          where: { id: invoice.contactId, tenantId: req.travelTenant.id },
          select: { id: true, name: true, email: true, phone: true },
        })
        .catch(() => null);

      let brand;
      try {
        const t = await prisma.tenant.findUnique({
          where: { id: req.travelTenant.id },
          select: { name: true },
        });
        brand = t && t.name ? t.name : undefined;
      } catch { brand = undefined; }

      const cur = invoice.currency || "INR";
      const frontendBase = getFrontendUrlFromRequest(req);
      console.log(`[travel-invoices] payment-link: frontendBase=${frontendBase}, FRONTEND_URL env=${process.env.FRONTEND_URL}`);
      const result = await createInvoicePaymentLink({
        tenantId: req.travelTenant.id,
        invoice: { id: invoice.id, invoiceNum: invoice.invoiceNum, amount: outstanding },
        contact: contact
          ? { name: contact.name, email: contact.email, phone: contact.phone }
          : undefined,
        contactId: contact ? contact.id : undefined,
        currency: cur,
        tenantName: brand,
        travelContext: { kind: "travel-invoice", travelInvoiceId: invoice.id },
        baseUrl: frontendBase,
      });

      if (result && result.url) {
        await writeAudit(
          "TravelInvoice",
          "TRAVEL_INVOICE_PAYMENT_LINK",
          invoice.id,
          req.user.userId,
          req.travelTenant.id,
          { amount: String(outstanding), currency: cur, gateway: result.gateway },
        ).catch(() => {});
        return res.json({ url: result.url, gateway: result.gateway, amount: outstanding, currency: cur });
      }
      return res.status(400).json({
        error: result?.error || "Could not create payment link",
        code: result?.code || "LINK_FAILED",
      });
    } catch (e) {
      console.error("[travel-invoices] payment-link error:", e.message);
      res.status(500).json({ error: "Failed to generate payment link", code: "LINK_FAILED" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/:id/transactions — settlement history for ONE
// invoice. Returns its milestones (expected vs received, status, paid date) +
// the underlying Payment rows (method / reference / gateway). Powers the
// "History" modal so an operator can see — especially for a PARTIAL invoice —
// exactly WHEN and HOW MUCH the customer has paid so far.
//
// Auth: invoices:read. Returns { invoice, milestones, payments, summary }.
// ============================================================================
router.get(
  "/invoices/:id/transactions",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "read"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, id);
      if (!invoice) return;

      // TMC invoices settle through TripInstalmentPayment, not the generic
      // TravelPaymentSchedule / hosted-invoice payment records. Use the
      // participant installment rows as the source of truth so a pending
      // payment-link record cannot mask an already-paid installment.
      if (invoice.tripId && invoice.participantId) {
        const installmentRows = await prisma.tripInstalmentPayment.findMany({
          where: {
            tripId: invoice.tripId,
            participantId: invoice.participantId,
            invoiceId: invoice.id,
          },
          orderBy: [{ instalmentIndex: "asc" }, { id: "asc" }],
          select: {
            id: true,
            instalmentIndex: true,
            dueDate: true,
            amount: true,
            paidAmount: true,
            status: true,
            paidAt: true,
          },
        });
        const milestones = installmentRows.map((row) => ({
          id: row.id,
          milestoneOrder: row.instalmentIndex + 1,
          dueDate: row.dueDate,
          expectedAmount: row.amount,
          receivedAmount: row.paidAmount,
          status: row.status,
          paidAt: row.paidAt,
        }));
        const payments = installmentRows
          .filter((row) => Number(row.paidAmount || 0) > 0)
          .map((row) => ({
            id: `tmc-installment-${row.id}`,
            amount: row.paidAmount,
            currency: invoice.currency || "INR",
            method: "TMC installment",
            reference: invoice.invoiceNum,
            status: row.status === "paid" ? "PAID" : "PARTIAL",
            paidAt: row.paidAt,
            milestoneOrder: row.instalmentIndex + 1,
          }));
        const total = Number(invoice.totalAmount || 0);
        const totalReceived = installmentRows.reduce(
          (sum, row) => sum + Number(row.paidAmount || 0),
          0,
        );
        return res.json({
          invoice: {
            id: invoice.id,
            invoiceNum: invoice.invoiceNum,
            status: invoice.status,
            totalAmount: invoice.totalAmount,
            currency: invoice.currency,
          },
          milestones,
          payments,
          summary: {
            total: total.toFixed(2),
            totalReceived: totalReceived.toFixed(2),
            outstanding: Math.max(0, total - totalReceived).toFixed(2),
            currency: invoice.currency || "INR",
          },
        });
      }

      const milestones = await prisma.travelPaymentSchedule.findMany({
        where: { invoiceId: invoice.id, tenantId: req.travelTenant.id },
        orderBy: [{ milestoneOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          milestoneOrder: true,
          dueDate: true,
          expectedAmount: true,
          receivedAmount: true,
          status: true,
          paidAt: true,
        },
      });

      // Payments for THIS travel invoice. Two shapes:
      //   - mark-paid rows reuse Payment.invoiceId = travelInvoiceId + metadata
      //     { type: 'travel-payment-schedule', scheduleId, milestoneOrder }.
      //   - pay-link rows carry { kind: 'travel-*', travelInvoiceId } in metadata
      //     (invoiceId is null).
      // We over-fetch on either signal, then JS-filter to travel-tagged rows
      // for THIS invoice so a same-numbered GENERIC invoice's payments never
      // leak in. Fail-soft — payment history is best-effort enrichment.
      let payments = [];
      try {
        const candidates = await prisma.payment.findMany({
          where: {
            tenantId: req.travelTenant.id,
            OR: [
              { invoiceId: invoice.id },
              { metadata: { contains: `"travelInvoiceId":${invoice.id}` } },
            ],
          },
          orderBy: { paidAt: "desc" },
          select: {
            id: true,
            invoiceId: true,
            amount: true,
            currency: true,
            gateway: true,
            gatewayId: true,
            status: true,
            paidAt: true,
            createdAt: true,
            metadata: true,
          },
        });
        payments = candidates
          .map((p) => {
            const m = parsePaymentMetadata(p.metadata);
            return { p, m };
          })
          .filter(
            ({ p, m }) =>
              isPaymentLinkedToTravelInvoice(p, m, invoice.id),
          )
          .map(({ p, m }) => ({
            id: p.id,
            amount: p.amount,
            currency: p.currency,
            method: p.gateway, // cash / upi / neft / razorpay / stripe …
            reference: p.gatewayId || null,
            status: p.status,
            paidAt: p.paidAt || p.createdAt,
            milestoneOrder: m.milestoneOrder != null ? m.milestoneOrder : null,
          }));
      } catch (e) {
        console.error("[travel-invoices] transactions payment lookup failed (non-fatal):", e.message);
      }

      const total = Number(invoice.totalAmount || 0);
      const totalReceived = payments
        .filter((p) => isSuccessfulPaymentStatus(p.status))
        .reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const outstanding = Math.max(0, total - totalReceived);

      res.json({
        invoice: {
          id: invoice.id,
          invoiceNum: invoice.invoiceNum,
          status: invoice.status,
          totalAmount: invoice.totalAmount,
          currency: invoice.currency,
        },
        milestones,
        payments,
        summary: {
          total: total.toFixed(2),
          totalReceived: totalReceived.toFixed(2),
          outstanding: outstanding.toFixed(2),
          currency: invoice.currency || "INR",
        },
      });
    } catch (e) {
      console.error("[travel-invoices] transactions error:", e.message);
      res.status(500).json({ error: "Failed to load transaction history", code: "TX_FAILED" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/:id/tcs-preview — Section 206C(1G) preview
// (Arc 2 #901 slice 9 — PRD_TRAVEL_BILLING UC-2.6 + FR-3.5).
//
// READ-ONLY endpoint. Returns the TCS that WOULD apply if this invoice were
// issued today, factoring in the customer's cumulative FY spend across all
// other TravelInvoice rows for the same contactId + tenant. Does NOT mutate
// the invoice or persist a TCS line — persistence on a TravelInvoiceLine
// row lands in slice 10 (needs a schema field for `tcsAmount` cache).
//
// Auth: any verified token, tenant + sub-brand scoped via loadParentInvoice.
//
// Query params (all optional):
//   ?isOverseasPackage=true|false   — default true (TCS-eligible by default
//                                     since travel is overseas-leaning)
//   ?isNonFiler=true|false          — default false (filer; 5% rate)
//   ?customerCountryCode=AE         — if provided, overrides isOverseasPackage
//                                     via the isOverseasDestination heuristic
//
// FY-window source: TravelInvoice has no dedicated issuedAt column today
// (see the slice-5 NOTE near the /issue handler). Falls back to `createdAt`
// for the priorFySpend filter — additive schema change to introduce a
// dedicated issue-timestamp column is deferred to a later slice.
//
// Response: {
//   invoiceId, contactId, invoiceAmount, priorFySpend,
//   isOverseasPackage, isNonFiler,
//   applies, exceedingAmount, rate, tcsAmount, newFyTotal
// }
//
// Error codes: INVALID_ID, INVOICE_NOT_FOUND, SUB_BRAND_DENIED.
// ============================================================================
router.get(
  "/invoices/:id/tcs-preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // ---- Resolve isOverseasPackage ----
      // If customerCountryCode is provided, the destination-heuristic
      // overrides the explicit boolean (a "IN" destination always wins,
      // even when isOverseasPackage=true was passed by mistake). If absent,
      // the boolean defaults to TRUE (TCS-eligible default for travel).
      const ccRaw = req.query.customerCountryCode;
      const hasCountryCode = typeof ccRaw === "string" && ccRaw.trim() !== "";
      const isOverseasPackage = hasCountryCode
        ? isOverseasDestination(ccRaw)
        : req.query.isOverseasPackage === "false"
          ? false
          : true;

      const isNonFiler = req.query.isNonFiler === "true";

      // ---- Compute priorFySpend ----
      // Sum totalAmount across all OTHER TravelInvoice rows belonging to
      // the same contactId + tenant whose createdAt falls within the
      // current FY window. Excludes the current invoice (so the preview
      // is "what would TCS be IF this invoice were the marginal one").
      const fyStart = fiscalYearStart(new Date());
      const priorInvoices = await prisma.travelInvoice.findMany({
        where: {
          tenantId: req.travelTenant.id,
          contactId: invoice.contactId,
          createdAt: { gte: fyStart },
          NOT: { id: invoice.id },
        },
        select: { totalAmount: true },
      });
      const priorFySpend = priorInvoices.reduce(
        (sum, inv) => sum + Number(inv.totalAmount || 0),
        0,
      );

      const invoiceAmount = Number(invoice.totalAmount || 0);
      const result = computeTcs({
        invoiceAmount,
        priorFySpend,
        isNonFiler,
        isOverseasPackage,
      });

      return res.status(200).json({
        invoiceId: invoice.id,
        contactId: invoice.contactId,
        invoiceAmount,
        priorFySpend,
        isOverseasPackage,
        isNonFiler,
        applies: result.applies,
        exceedingAmount: result.exceedingAmount,
        rate: result.rate,
        tcsAmount: result.tcsAmount,
        newFyTotal: result.newFyTotal,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] tcs-preview error:", e.message);
      res.status(500).json({ error: "Failed to compute TCS preview" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/apply-tcs — Section 206C(1G) PERSISTENCE
// (Arc 2 #901 slice 10 — PRD_TRAVEL_BILLING UC-2.6 + FR-3.5).
//
// Operator action: commits the TCS computed by /tcs-preview to the invoice
// itself by writing the 4 additive nullable fields (tcsAmount, tcsRate,
// tcsExceedingAmount, tcsAppliedAt). Mirrors the tcs-preview window-source
// (createdAt-based prior-FY-spend scan, current-invoice excluded via
// NOT: { id }) — pinning the same math at apply time guarantees the
// preview-vs-applied invariant.
//
// Why a SEPARATE endpoint from /issue (not extending it):
//   - /issue does the invoiceNum-reassignment + status flip (slice 5);
//     keeping TCS persistence as its own operator action lets the operator
//     issue an invoice and later "apply TCS" once filer-status is confirmed
//     (e.g. customer's PAN/non-filer flag arrives after issuance).
//   - Idempotency surface is local — tcsAppliedAt set → reject with 409
//     TCS_ALREADY_APPLIED. Mixing into /issue would force re-issuance to
//     undo, which is wrong (issuance is a one-way state transition).
//
// Auth: ADMIN/MANAGER only (writes).
// Pre-conditions: invoice exists, tenant-scoped, sub-brand-accessible,
//   tcsAppliedAt IS NULL (one-shot apply). Status is NOT checked — TCS can
//   be applied to Draft / Issued / Partial / Paid alike; the operator may
//   apply TCS after collection if the buyer's filer-status changed.
//
// Body (all optional):
//   applyTcs              — default true. If false, runs the math + returns
//                           the payload WITHOUT persisting (preview parity).
//   isNonFiler            — default false (filer rate 5%).
//   isOverseasPackage     — default true (TCS-eligible default for travel).
//   customerCountryCode   — if provided, overrides isOverseasPackage via
//                           isOverseasDestination heuristic.
//
// Side effects on applies===true + applyTcs===true:
//   - travelInvoice.update sets the 4 TCS fields.
//   - Audit row stamped action='TRAVEL_INVOICE_TCS_APPLIED' with details
//     { tcsAmount, tcsRate, exceedingAmount, applies:true }.
//
// On applies===false (domestic, below-threshold, zero-amount):
//   - NO update. 4 fields stay null.
//   - NO audit row. (The decision-not-to-apply isn't worth a row; operator
//     can re-call to recompute. Re-evaluate if Q-TCS-2 surfaces a need.)
//   - Returns 200 with the computed payload + applied:false.
//
// Returns: 200 + { invoiceId, contactId, applied, applies, exceedingAmount,
//   rate, tcsAmount, newFyTotal, tcsAppliedAt | null }.
//
// Error codes: INVALID_ID (400), INVOICE_NOT_FOUND (404), SUB_BRAND_DENIED
//   (403), TCS_ALREADY_APPLIED (409).
// ============================================================================
router.post(
  "/invoices/:id/apply-tcs",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // Idempotency gate — once TCS has been persisted, the operator must
      // not silently re-apply (would clobber the original tcsAppliedAt
      // timestamp and rate, breaking the audit trail).
      if (invoice.tcsAppliedAt != null) {
        return res.status(409).json({
          error: "TCS has already been applied to this invoice",
          code: "TCS_ALREADY_APPLIED",
        });
      }

      const body = req.body || {};
      const applyTcs = body.applyTcs !== false; // default true
      const isNonFiler = body.isNonFiler === true;

      // Resolve isOverseasPackage — country-code heuristic wins when present,
      // otherwise the explicit boolean, default true.
      const ccRaw = body.customerCountryCode;
      const hasCountryCode = typeof ccRaw === "string" && ccRaw.trim() !== "";
      const isOverseasPackage = hasCountryCode
        ? isOverseasDestination(ccRaw)
        : body.isOverseasPackage === false
          ? false
          : true;

      // Mirror the tcs-preview FY-window math (createdAt-based, current
      // invoice excluded). Pinning the same math at apply time guarantees
      // preview === applied for the same inputs.
      const fyStart = fiscalYearStart(new Date());
      const priorInvoices = await prisma.travelInvoice.findMany({
        where: {
          tenantId: req.travelTenant.id,
          contactId: invoice.contactId,
          createdAt: { gte: fyStart },
          NOT: { id: invoice.id },
        },
        select: { totalAmount: true },
      });
      const priorFySpend = priorInvoices.reduce(
        (sum, inv) => sum + Number(inv.totalAmount || 0),
        0,
      );

      const invoiceAmount = Number(invoice.totalAmount || 0);
      const result = computeTcs({
        invoiceAmount,
        priorFySpend,
        isNonFiler,
        isOverseasPackage,
      });

      // Two branches: applies + applyTcs requested → persist; otherwise
      // return the math without touching the row.
      let applied = false;
      let tcsAppliedAt = null;
      if (result.applies && applyTcs) {
        const now = new Date();
        await prisma.travelInvoice.update({
          where: { id: invoice.id },
          data: {
            tcsAmount: result.tcsAmount,
            tcsRate: result.rate,
            tcsExceedingAmount: result.exceedingAmount,
            tcsAppliedAt: now,
          },
        });
        applied = true;
        tcsAppliedAt = now;

        await writeAudit(
          "TravelInvoice",
          "TRAVEL_INVOICE_TCS_APPLIED",
          invoice.id,
          req.user.userId,
          req.travelTenant.id,
          {
            tcsAmount: result.tcsAmount,
            tcsRate: result.rate,
            exceedingAmount: result.exceedingAmount,
            applies: true,
          },
        );
      }

      return res.status(200).json({
        invoiceId: invoice.id,
        contactId: invoice.contactId,
        invoiceAmount,
        priorFySpend,
        isOverseasPackage,
        isNonFiler,
        applies: result.applies,
        exceedingAmount: result.exceedingAmount,
        rate: result.rate,
        tcsAmount: result.tcsAmount,
        newFyTotal: result.newFyTotal,
        applied,
        tcsAppliedAt,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] apply-tcs error:", e.message);
      res.status(500).json({ error: "Failed to apply TCS" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/credit-note — Arc 2 #901 slice 14.
//
// PRD_TRAVEL_BILLING UC-2.7 (cancellation + refund flow). Operator-action
// "Issue Credit Note" against an existing invoice: creates a NEW
// TravelInvoice row with docType='CreditNote', linked to the original
// via parentInvoiceId (self-relation added in the slice-14 schema bump).
// The credit note's totalAmount is stored NEGATIVE — the operator UI +
// AR reports render it as a subtraction against the parent invoice's
// receivable.
//
// invoiceNum format: "CN-<parent.invoiceNum>". Leverages parent's
// tenant-scoped uniqueness (the @@unique([tenantId, invoiceNum]) backstop
// on the schema). Concise + grep-friendly. A multi-credit-note scenario
// (rare — typically one credit per parent for partial refunds) would
// collide on the second issuance; future slice will add a sequence
// suffix if/when that comes up.
//
// Auth: ADMIN/MANAGER only.
//
// Body:
//   - amount (required, positive number > 0)
//   - reason (optional, string)
//   - lineDescription (optional, short description for narrative)
//
// Pre-conditions:
//   1. Parent invoice exists, tenant-scoped, sub-brand-accessible.
//   2. Parent status in [Issued, Partial, Paid] — Draft cannot be credited
//      (issue it first), Voided cannot be credited (nothing to refund).
//   3. amount <= parent.totalAmount — can't refund more than was billed.
//   4. Parent is NOT itself a CreditNote — no nested credit-of-credit.
//
// Side effects:
//   - New TravelInvoice row created with docType='CreditNote',
//     totalAmount = -amount, parentInvoiceId set, status = 'Issued'.
//   - Audit row stamped action='TRAVEL_INVOICE_CREDIT_NOTE_ISSUED'
//     with details { parentId, parentInvoiceNum, amount, reason,
//     lineDescription }.
//
// Returns: 201 + the new CreditNote row.
//
// Error codes: INVALID_ID (400), INVOICE_NOT_FOUND (404),
//   SUB_BRAND_DENIED (403), MISSING_FIELDS (400 — amount absent),
//   INVALID_AMOUNT (400 — amount <= 0 or non-numeric),
//   AMOUNT_EXCEEDS_PARENT (400 — amount > parent.totalAmount),
//   CANNOT_CREDIT_CREDIT_NOTE (400 — parent.docType === 'CreditNote'),
//   INVALID_PARENT_STATE (400 — parent.status not in creditable set).
// ============================================================================
const CREDITABLE_PARENT_STATUSES = ["Issued", "Partial", "Paid"];

router.post(
  "/invoices/:id/credit-note",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "write"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const parent = await loadParentInvoice(req, res, invoiceId);
      if (!parent) return;

      // Parent must not itself be a CreditNote. NULL docType is treated as
      // "TaxInvoice" (per slice-11 back-compat convention) — only explicit
      // CreditNote rows are blocked.
      if (parent.docType === "CreditNote") {
        return res.status(400).json({
          error: "Cannot issue a credit note against an existing credit note",
          code: "CANNOT_CREDIT_CREDIT_NOTE",
        });
      }

      // Parent must be in a creditable state.
      if (!CREDITABLE_PARENT_STATUSES.includes(parent.status)) {
        return res.status(400).json({
          error: `Parent invoice must be in one of [${CREDITABLE_PARENT_STATUSES.join(", ")}] to issue a credit note (current: ${parent.status})`,
          code: "INVALID_PARENT_STATE",
        });
      }

      const { amount, reason, lineDescription } = req.body || {};

      // amount required + numeric. parsePositiveDecimal returns 0 for "0",
      // but a zero-amount credit note has no business meaning — add an
      // explicit > 0 gate after the basic parse.
      if (amount == null || amount === "") {
        return res.status(400).json({
          error: "amount is required",
          code: "MISSING_FIELDS",
        });
      }
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({
          error: "amount must be a positive number",
          code: "INVALID_AMOUNT",
        });
      }

      const parentTotal = Number(parent.totalAmount || 0);
      if (amt > parentTotal) {
        return res.status(400).json({
          error: `Credit amount (${amt}) exceeds parent invoice total (${parentTotal})`,
          code: "AMOUNT_EXCEEDS_PARENT",
        });
      }

      const creditInvoiceNum = `CN-${parent.invoiceNum}`;

      const created = await prisma.travelInvoice.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: parent.subBrand,
          contactId: parent.contactId,
          invoiceNum: creditInvoiceNum,
          docType: "CreditNote",
          status: "Issued",
          totalAmount: -amt,
          currency: parent.currency,
          parentInvoiceId: parent.id,
        },
      });

      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_CREDIT_NOTE_ISSUED",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          parentId: parent.id,
          parentInvoiceNum: parent.invoiceNum,
          amount: amt,
          reason: reason ? String(reason) : null,
          lineDescription: lineDescription ? String(lineDescription) : null,
          subBrand: parent.subBrand,
        },
      );

      return res.status(201).json(created);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] credit-note error:", e.message);
      res.status(500).json({ error: "Failed to issue credit note" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/debit-note — Arc 2 #901 slice 15.
//
// PRD_TRAVEL_BILLING UC-2.7 (cancellation + refund flow — inverse arm).
// Operator-action "Issue Debit Note" against an existing invoice: creates
// a NEW TravelInvoice row with docType='DebitNote', linked to the original
// via parentInvoiceId (the self-relation added in slice 14). The debit
// note's totalAmount is stored POSITIVE — it INCREASES the customer's
// payable for additional charges (late fees, T&C revisions, supplemental
// services, supplier-side surcharge pass-through).
//
// Mirrors the slice-14 credit-note workflow with three differences:
//   - totalAmount = +amount (positive, vs credit-note's negative)
//   - docType = 'DebitNote'
//   - invoiceNum prefix = 'DN-' (vs credit-note's 'CN-')
//   - NO AMOUNT_EXCEEDS_PARENT gate (debit notes can legitimately exceed
//     the parent — that's the whole point: charging MORE than originally
//     billed, e.g. an INR 5000 trip's INR 8000 cancellation fee).
//   - CANNOT_DEBIT_CREDIT_NOTE rejection covers BOTH DebitNote AND
//     CreditNote parents (you can't pile a debit onto either a credit
//     or another debit — only onto a primary TaxInvoice).
//
// invoiceNum format: "DN-<parent.invoiceNum>". Same tenant-scoped
// uniqueness backstop via @@unique([tenantId, invoiceNum]).
//
// Auth: ADMIN/MANAGER only.
//
// Body:
//   - amount (required, positive number > 0)
//   - reason (optional, string)
//   - lineDescription (optional, short description for narrative)
//
// Pre-conditions:
//   1. Parent invoice exists, tenant-scoped, sub-brand-accessible.
//   2. Parent status in [Issued, Partial, Paid] — Draft cannot be debited
//      (issue it first), Voided cannot be debited (settled non-event).
//   3. Parent is NOT itself a DebitNote or CreditNote — debit-of-credit
//      or debit-of-debit would muddy the AR ledger semantics; if more
//      charges arise after a credit note, raise them against the original
//      TaxInvoice not the note.
//
// Side effects:
//   - New TravelInvoice row created with docType='DebitNote',
//     totalAmount = +amount, parentInvoiceId set, status = 'Issued'.
//   - Audit row stamped action='TRAVEL_INVOICE_DEBIT_NOTE_ISSUED'
//     with details { parentId, parentInvoiceNum, amount, reason,
//     lineDescription, subBrand }.
//
// Returns: 201 + the new DebitNote row.
//
// Error codes: INVALID_ID (400), INVOICE_NOT_FOUND (404),
//   SUB_BRAND_DENIED (403), MISSING_FIELDS (400 — amount absent),
//   INVALID_AMOUNT (400 — amount <= 0 or non-numeric),
//   CANNOT_DEBIT_CREDIT_NOTE (400 — parent.docType in [DebitNote, CreditNote]),
//   INVALID_PARENT_STATE (400 — parent.status not in debitable set).
// ============================================================================
router.post(
  "/invoices/:id/debit-note",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "write"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const parent = await loadParentInvoice(req, res, invoiceId);
      if (!parent) return;

      // Parent must not itself be a CreditNote or DebitNote. NULL docType
      // is treated as "TaxInvoice" (per slice-11 back-compat convention)
      // — only explicit DebitNote / CreditNote rows are blocked.
      if (parent.docType === "DebitNote" || parent.docType === "CreditNote") {
        return res.status(400).json({
          error:
            "Cannot issue a debit note against an existing credit or debit note",
          code: "CANNOT_DEBIT_CREDIT_NOTE",
        });
      }

      // Parent must be in a debitable state. Reuses CREDITABLE_PARENT_STATUSES
      // because the gate is structurally identical (same set: Issued/Partial/Paid).
      if (!CREDITABLE_PARENT_STATUSES.includes(parent.status)) {
        return res.status(400).json({
          error: `Parent invoice must be in one of [${CREDITABLE_PARENT_STATUSES.join(", ")}] to issue a debit note (current: ${parent.status})`,
          code: "INVALID_PARENT_STATE",
        });
      }

      const { amount, reason, lineDescription } = req.body || {};

      // amount required + numeric > 0.
      if (amount == null || amount === "") {
        return res.status(400).json({
          error: "amount is required",
          code: "MISSING_FIELDS",
        });
      }
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({
          error: "amount must be a positive number",
          code: "INVALID_AMOUNT",
        });
      }

      // NOTE: deliberately NO AMOUNT_EXCEEDS_PARENT gate. Debit notes
      // commonly exceed the parent (a 5000 trip can incur an 8000
      // cancellation fee). The slice-14 credit-note gate (amount <=
      // parent.totalAmount) does NOT apply here.

      const debitInvoiceNum = `DN-${parent.invoiceNum}`;

      const created = await prisma.travelInvoice.create({
        data: {
          tenantId: req.travelTenant.id,
          subBrand: parent.subBrand,
          contactId: parent.contactId,
          invoiceNum: debitInvoiceNum,
          docType: "DebitNote",
          status: "Issued",
          totalAmount: amt,
          currency: parent.currency,
          parentInvoiceId: parent.id,
        },
      });

      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_DEBIT_NOTE_ISSUED",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          parentId: parent.id,
          parentInvoiceNum: parent.invoiceNum,
          amount: amt,
          reason: reason ? String(reason) : null,
          lineDescription: lineDescription ? String(lineDescription) : null,
          subBrand: parent.subBrand,
        },
      );

      return res.status(201).json(created);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] debit-note error:", e.message);
      res.status(500).json({ error: "Failed to issue debit note" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/:id/tax-preview — any verified token.
// ============================================================================
//
// Arc 2 #902 slice 7 (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.2.3 / FR-3.4.3 /
// NFR-4.2). Invoice analog of /quotes/:id/tax-preview (slice 6, commit
// b9833a0e). Same response envelope, same library consumers — only the
// parent type + line query differ (TravelInvoiceLine instead of
// TravelQuoteLine).
//
// READ-ONLY surface: zero writes. Loads the parent invoice via
// loadParentInvoice (tenant + sub-brand scoped — same INVALID_ID /
// INVOICE_NOT_FOUND / SUB_BRAND_DENIED shape as every other invoice
// child endpoint), resolves the operator + customer state codes via
// lib/gstStateCodeResolver.js, decides intra-vs-inter-state via
// isInterstateSupply, derives each line's GST rate from lineType via
// gstRateForCategory, decorates each line with its SAC code +
// description via lib/hsnSacMapper.js, and aggregates per-line +
// per-rate-bucket + GSTR-1-style HSN-summary totals via
// computeGstForLines + groupLinesBySac.
//
// === Invoice-side lineType taxonomy ===
//
// TravelInvoiceLine extends TravelQuoteLine with billing-specific
// types: per_pax / per_room / per_night / per_trip / tax / fee / addon
// / tcs / tds / other. hsnSacMapper.sacForLineType handles all of
// these — per_room/per_night map to SAC 9963 (accommodation),
// per_pax/per_trip/addon map to SAC 9985 (travel-tourism support),
// tax/fee/tcs/tds return null SAC (groupLinesBySac skips them so
// they don't pollute the GSTR-1 HSN summary — withholding taxes are
// reported on Form 27EQ, not GSTR-1). gstRateForCategory does not
// know these invoice-specific types so they fall through to the 18%
// DEFAULT_RATE — operator-safe (highest common slab); when the
// TaxRateMaster slice (FR-3.1) lands it will override per-tenant.
//
// === Place-of-supply resolution ===
//
// Source-of-truth chain (FR-3.x):
//   1. Truthy override (query param ?operatorStateCode= /
//      ?customerStateCode=) wins.
//   2. DB column — Tenant.gstStateCode for operator,
//      Contact.stateCode for customer (slice 3 schema adds).
//   3. Hard-coded "IN-MH" fallback (slice 2 back-compat).
// Customer-side: when override + DB are both null, mirror operator
// (intra-state default) — handled inside resolveStateCodes.
//
// Empty-string for an explicit param is rejected with 400
// INVALID_STATE_CODE (defense-in-depth — prevents silent fall-through
// to defaults when caller sends `?operatorStateCode=`).
//
// === Envelope contract (mirrors slice 6 exactly) ===
//
// Per-line: { id, lineType, amount, gstPercent, sacCode,
//             sacDescription, cgst, sgst, igst, totalTax, amountWithTax }
// Top-level: { invoiceId, subtotal, isInterstate, operatorStateCode,
//              customerStateCode, lines[], totalCgst, totalSgst,
//              totalIgst, totalTax, grandTotal, buckets[], hsnSummary[] }
//
// Invariants (rounding-safe to 2 decimals — every step round2'd in
// gstCalculation.js):
//   totalTax === totalCgst + totalSgst + totalIgst    (split consistency)
//   subtotal + totalTax === grandTotal                 (gross consistency)
//
// Per-line vs bucket aggregation: per-line totals are computed inline
// (mirrors gstCalculation.computeGstSplit; inlined for one extra
// require avoidance). Bucket summary is computed via computeGstForLines
// which sums taxable into per-rate buckets FIRST then taxes the bucket
// (per FR-3.4.3 HSN-summary shape). Envelope-level totals come from
// the bucket summary so the spec-aligned numbers win the invariants;
// per-line drift (≤1 paise on multi-line invoices) stays contained in
// the lines[] array.
router.get(
  "/invoices/:id/tax-preview",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // Empty-string state-code validation BEFORE the resolver fires
      // (mirrors slice 6 — keeps the user-facing 400 contract even
      // though the resolver itself treats empty as no-override).
      const rawOp = req.query.operatorStateCode;
      const rawCu = req.query.customerStateCode;
      if (rawOp != null && String(rawOp).trim() === "") {
        return res.status(400).json({
          error: "operatorStateCode must not be empty",
          code: "INVALID_STATE_CODE",
        });
      }
      if (rawCu != null && String(rawCu).trim() === "") {
        return res.status(400).json({
          error: "customerStateCode must not be empty",
          code: "INVALID_STATE_CODE",
        });
      }

      const { operatorStateCode, customerStateCode } = await resolveStateCodes({
        prisma,
        tenantId: req.travelTenant.id,
        contactId: invoice.contactId,
        operatorOverride: rawOp != null ? String(rawOp).trim() : null,
        customerOverride: rawCu != null ? String(rawCu).trim() : null,
      });

      let isInterstate;
      try {
        isInterstate = isInterstateSupply(operatorStateCode, customerStateCode);
      } catch (e) {
        return res.status(400).json({
          error: e.message,
          code: "INVALID_STATE_CODE",
        });
      }

      const lines = await prisma.travelInvoiceLine.findMany({
        where: { invoiceId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      const round2 = (n) => Math.round(n * 100) / 100;

      // Per-line decoration: each line gets its own gstPercent +
      // CGST/SGST/IGST split + SAC code/description. Composite-supply
      // per FR-3.2.4 — every line taxed at its own rate.
      const decoratedLines = [];
      const normalizedForBuckets = [];
      let subtotalAccum = 0;
      let totalCgstAccum = 0;
      let totalSgstAccum = 0;
      let totalIgstAccum = 0;
      let totalTaxAccum = 0;

      for (const l of lines) {
        const amt = Number(l.amount || 0);
        subtotalAccum = round2(subtotalAccum + amt);
        const gstPercent = gstRateForCategory(l.lineType);

        const totalTax = round2((amt * gstPercent) / 100);
        let cgst = 0;
        let sgst = 0;
        let igst = 0;
        if (isInterstate) {
          igst = totalTax;
        } else {
          const halfRate = gstPercent / 2;
          cgst = round2((amt * halfRate) / 100);
          sgst = round2((amt * halfRate) / 100);
        }
        const amountWithTax = round2(amt + totalTax);

        const sacCode = sacForLineType(l.lineType);
        const sacDescription = sacCode ? descriptionForSac(sacCode) : null;

        decoratedLines.push({
          id: l.id,
          lineType: l.lineType,
          amount: round2(amt),
          gstPercent,
          sacCode,
          sacDescription,
          cgst,
          sgst,
          igst,
          totalTax,
          amountWithTax,
        });
        normalizedForBuckets.push({ taxableAmount: amt, gstPercent });

        totalCgstAccum = round2(totalCgstAccum + cgst);
        totalSgstAccum = round2(totalSgstAccum + sgst);
        totalIgstAccum = round2(totalIgstAccum + igst);
        totalTaxAccum = round2(totalTaxAccum + totalTax);
      }

      // Bucket summary via lib helper — per-rate aggregation matches
      // GSTR-1 HSN-summary shape (FR-3.4.3). Use bucket totals as
      // envelope totals so the spec-aligned numbers win the consistency
      // invariants (per-line drift contained to lines[]).
      const bucketSummary = computeGstForLines(
        normalizedForBuckets,
        isInterstate,
      );

      // HSN/SAC summary grouping per FR-3.4.3 (GSTR-1 export-ready
      // shape: one row per (sacCode, gstPercent) pair with summed
      // taxableValue + line count). Sibling to buckets[] (which groups
      // by gstPercent only). tax/fee/tcs/tds lines have null SAC →
      // skipped by the helper (withholding taxes don't belong in
      // GSTR-1; they're Form 27EQ).
      const hsnSummary = groupLinesBySac(
        lines.map((l) => ({
          lineType: l.lineType,
          taxableValue: Number(l.amount || 0),
          gstPercent: gstRateForCategory(l.lineType),
        })),
      );

      res.json({
        invoiceId: invoice.id,
        subtotal: bucketSummary.subtotal,
        isInterstate,
        operatorStateCode,
        customerStateCode,
        lines: decoratedLines,
        totalCgst: bucketSummary.totalCgst,
        totalSgst: bucketSummary.totalSgst,
        totalIgst: bucketSummary.totalIgst,
        totalTax: bucketSummary.totalTax,
        grandTotal: bucketSummary.grandTotal,
        buckets: bucketSummary.buckets,
        hsnSummary,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] tax-preview error:", e.message);
      res.status(500).json({ error: "Failed to compute tax preview" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/tax-persist — G028 + G029 + G021/G034 wire-up.
//
// PRD_TRAVEL_GST_COMPLIANCE FR-3.2.1 (G028 — invoice-level cgst/sgst/igst/
// placeOfSupply persistence) + FR-3.2.2 (G029 — per-line GST split persistence
// on TravelInvoiceLine.cgst/sgst/igstPercent/Amount columns). Pairs with G021
// (line-extension columns including HSN/SAC) + G034 (Contact.billingStateCode
// preferred over residence stateCode via the resolver).
//
// RBAC: ADMIN / MANAGER only — writes are mutations to the persisted tax
// record; USER role can preview via /tax-preview but cannot persist.
//
// Idempotency: re-running OVERWRITES the existing tax columns + bumps
// gstComputedAt to now. No 409 — the operator workflow is "I corrected
// a line, rerun the persist." If a future slice needs an immutability
// lock at issue-time, gate it via status (Draft-only persist) — for now
// any non-Voided invoice may re-persist.
//
// Body shape:
//   { operatorStateCode?: string, customerStateCode?: string }
// Both optional. When provided, they override the resolver's default
// chain (same semantics as /tax-preview's query-string overrides).
// Empty-string is rejected with 400 INVALID_STATE_CODE (defense-in-depth).
//
// Response envelope: matches /tax-preview's envelope + adds
//   { gstComputedAt, persisted: true, linesPersistedCount }
// so the operator UI can confirm both the WRITE happened AND the values
// match the preview surface. Per-line totals come from the SAME compute
// path as /tax-preview — drift between the two endpoints is intentional-
// ly impossible (single source of truth: lib/gstCalculation.js).
//
// Write strategy:
//   1. Resolve state codes (same chain as tax-preview).
//   2. Load lines, compute per-line GST split (mirrors tax-preview math).
//   3. Compute bucket-level totals via computeGstForLines (spec-aligned).
//   4. Open a $transaction:
//      a. Update each TravelInvoiceLine with its computed
//         cgstPercent/cgstAmount/sgstPercent/sgstAmount/igstPercent/igstAmount.
//      b. Update the parent TravelInvoice with the rolled-up totals +
//         placeOfSupply (customerStateCode) + gstComputedAt = now().
//   5. Re-read + return the persisted envelope.
//
// Cross-cutting note: existing invoices without `gstComputedAt` continue
// to use the on-the-fly /tax-preview compute. Frontend consumers that
// read cgstAmount etc. directly off the invoice should fall back to
// computing via /tax-preview if those columns are NULL.
//
// Auto-call from status flip (deferred): when an invoice transitions
// Draft → Issued, the PUT /:id handler MAY auto-fire this endpoint if
// gstComputedAt is null. NOT wired in this slice — the explicit
// operator-driven persist keeps the surface debuggable. Future slice
// can wire it as a side-effect after the persist contract beds in.
// ============================================================================
router.post(
  "/invoices/:id/tax-persist",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // Empty-string validation (mirrors tax-preview) — defensive against
      // callers sending {"operatorStateCode": ""} expecting "no override"
      // semantics; we reject explicitly instead of falling through to the
      // resolver's empty-string-as-no-override coercion.
      const rawOp = req.body && req.body.operatorStateCode;
      const rawCu = req.body && req.body.customerStateCode;
      if (rawOp != null && String(rawOp).trim() === "") {
        return res.status(400).json({
          error: "operatorStateCode must not be empty",
          code: "INVALID_STATE_CODE",
        });
      }
      if (rawCu != null && String(rawCu).trim() === "") {
        return res.status(400).json({
          error: "customerStateCode must not be empty",
          code: "INVALID_STATE_CODE",
        });
      }

      const { operatorStateCode, customerStateCode } = await resolveStateCodes({
        prisma,
        tenantId: req.travelTenant.id,
        contactId: invoice.contactId,
        operatorOverride: rawOp != null ? String(rawOp).trim() : null,
        customerOverride: rawCu != null ? String(rawCu).trim() : null,
      });

      let isInterstate;
      try {
        isInterstate = isInterstateSupply(operatorStateCode, customerStateCode);
      } catch (e) {
        return res.status(400).json({
          error: e.message,
          code: "INVALID_STATE_CODE",
        });
      }

      const lines = await prisma.travelInvoiceLine.findMany({
        where: { invoiceId, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      const round2 = (n) => Math.round(n * 100) / 100;

      // Per-line compute — same math as tax-preview.
      const lineUpdates = [];
      const normalizedForBuckets = [];
      for (const l of lines) {
        const amt = Number(l.amount || 0);
        const gstPercent = gstRateForCategory(l.lineType);
        const totalTax = round2((amt * gstPercent) / 100);
        let cgst = 0;
        let sgst = 0;
        let igst = 0;
        let cgstP = 0;
        let sgstP = 0;
        let igstP = 0;
        if (isInterstate) {
          igst = totalTax;
          igstP = gstPercent;
        } else {
          const halfRate = gstPercent / 2;
          cgst = round2((amt * halfRate) / 100);
          sgst = round2((amt * halfRate) / 100);
          cgstP = halfRate;
          sgstP = halfRate;
        }
        const sacCode = sacForLineType(l.lineType);
        lineUpdates.push({
          id: l.id,
          // G021 — persist HSN/SAC at compute-time so historical exports
          // stay pinned to the mapper's value at issue-time. Preserve any
          // pre-existing hsnSac (operator override) — fall back to the
          // mapper only when the column is currently NULL.
          hsnSac: l.hsnSac != null ? l.hsnSac : sacCode,
          cgstPercent: cgstP,
          cgstAmount: cgst,
          sgstPercent: sgstP,
          sgstAmount: sgst,
          igstPercent: igstP,
          igstAmount: igst,
        });
        normalizedForBuckets.push({ taxableAmount: amt, gstPercent });
      }

      // Bucket-level totals — spec-aligned per FR-3.4.3 (matches
      // /tax-preview's envelope).
      const bucketSummary = computeGstForLines(
        normalizedForBuckets,
        isInterstate,
      );

      // Aggregate the dominant per-line GST percent for the invoice
      // header columns. When all lines share a rate the percent is
      // exact; on mixed-rate invoices we pin the BUCKET-MAX rate as a
      // representative label (operators viewing the header still see
      // the "highest GST band" — the lines[] array carries the per-line
      // truth + the buckets[] array carries the rate-grouped truth).
      let headerCgstP = 0;
      let headerSgstP = 0;
      let headerIgstP = 0;
      for (const b of bucketSummary.buckets) {
        if (isInterstate) {
          if (b.gstPercent > headerIgstP) headerIgstP = b.gstPercent;
        } else {
          const half = b.gstPercent / 2;
          if (half > headerCgstP) headerCgstP = half;
          if (half > headerSgstP) headerSgstP = half;
        }
      }

      const computedAt = new Date();

      // $transaction — line writes + invoice write atomic. Sequencing the
      // line updates inside a transaction makes the "all lines correct or
      // no change" guarantee. updateMany on a per-line basis isn't
      // available (different values per line) so we issue N updates
      // inside one transaction.
      await prisma.$transaction([
        ...lineUpdates.map((u) =>
          prisma.travelInvoiceLine.update({
            where: { id: u.id },
            data: {
              hsnSac: u.hsnSac,
              cgstPercent: u.cgstPercent,
              cgstAmount: u.cgstAmount,
              sgstPercent: u.sgstPercent,
              sgstAmount: u.sgstAmount,
              igstPercent: u.igstPercent,
              igstAmount: u.igstAmount,
            },
          }),
        ),
        prisma.travelInvoice.update({
          where: { id: invoice.id },
          data: {
            placeOfSupply: customerStateCode,
            cgstAmount: bucketSummary.totalCgst,
            sgstAmount: bucketSummary.totalSgst,
            igstAmount: bucketSummary.totalIgst,
            cgstPercent: headerCgstP,
            sgstPercent: headerSgstP,
            igstPercent: headerIgstP,
            totalTaxAmount: bucketSummary.totalTax,
            gstComputedAt: computedAt,
          },
        }),
      ]);

      // Audit row — operator-driven mutation; pin the totals + state
      // codes so a future audit query can see what was persisted.
      try {
        await writeAudit(
          "TravelInvoice",
          "GST_PERSIST",
          invoice.id,
          req.user.userId,
          req.travelTenant.id,
          {
            placeOfSupply: customerStateCode,
            isInterstate,
            totalTax: bucketSummary.totalTax,
            lineCount: lineUpdates.length,
          },
        );
      } catch (_e) {
        // Audit failures are non-fatal — the persist already landed.
      }

      res.json({
        invoiceId: invoice.id,
        persisted: true,
        gstComputedAt: computedAt.toISOString(),
        linesPersistedCount: lineUpdates.length,
        operatorStateCode,
        customerStateCode,
        placeOfSupply: customerStateCode,
        isInterstate,
        subtotal: bucketSummary.subtotal,
        totalCgst: bucketSummary.totalCgst,
        totalSgst: bucketSummary.totalSgst,
        totalIgst: bucketSummary.totalIgst,
        totalTax: bucketSummary.totalTax,
        grandTotal: bucketSummary.grandTotal,
        buckets: bucketSummary.buckets,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] tax-persist error:", e.message);
      res.status(500).json({ error: "Failed to persist tax breakdown" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/clone-as-recurring — Arc 2 #901 slice 16.
//
// PRD_TRAVEL_BILLING §3.4 (recurring billing). Operator-action "Clone for
// next cycle" against an Issued or Paid invoice: duplicates the source
// invoice (header + lines) into a NEW Draft TravelInvoice that the
// operator can review, tweak, and issue independently. Common usage:
//   - Monthly retainer (corporate travel desk) — clone last month's
//     issued invoice, update service-dates, issue.
//   - Quarterly package re-billing — clone last quarter's paid invoice,
//     refresh PNR/booking-ref, issue.
//   - Ad-hoc operator convenience — duplicate any cleared invoice as a
//     starting template instead of retyping line items.
//
// This is NOT the full recurring-cron engine — a separate slice (17)
// ships the schedule-driven auto-clone. This slice gives operators the
// manual "clone as template" surface; the cron will eventually call
// the same flow on its schedule tick.
//
// === Design decisions ===
//
// parentInvoiceId stays NULL on the clone (distinct from slice 14/15
// CreditNote/DebitNote which set the FK). Recurring invoices are
// INDEPENDENT billing instruments — the relationship between cycle-N
// and cycle-N+1 is informational (operator-tracked), not structural;
// linking them via parentInvoiceId would corrupt the credit-note
// subgraph semantics (we'd start seeing "recurring children" mixed in
// with credit/debit notes when traversing parent.creditNotes).
//
// status = 'Draft' on the clone — never inherit the source's Issued/
// Paid status. The new cycle's invoice needs to be reviewed (service
// dates, PNRs, FX rates, customer state-code for GST) before being
// issued; pre-issuing on clone would skip the operator's gate.
//
// invoiceNum is fresh (via nextInvoiceNum). The source's serial is
// historical; the clone gets the next TINV-YYYY-NNNN slot (slice-5
// per-sub-brand serial only applies at Draft→Issued transition).
//
// dueDate default = NOW + 30 days. Source's dueDate is historical and
// likely past; recurring cycles need a fresh future due-date. Body
// override accepted.
//
// clearTcs (default true): TCS Sec 206C(1G) depends on the buyer's
// CURRENT-FY cumulative spend with the tenant — a clone that inherits
// the source's tcsAmount would be wrong because the FY-cumulative
// counter has advanced since source was issued. Default to clearing
// (operator re-runs /tcs-preview + /apply-tcs on the new invoice when
// they issue it). clearTcs=false is an escape hatch for the niche
// case where the operator deliberately wants to inherit (e.g. cloning
// within the same FY for the same buyer where TCS already applied).
//
// === Reject sources that aren't operator-cleared templates ===
//
// Source must be in [Issued, Paid] — Draft sources are still being
// composed (not template-quality), Voided sources have no business
// being reused, Partial sources are mid-collection (operator should
// close them out first). CreditNote/DebitNote sources are rejected
// outright (CANNOT_CLONE_NOTE) — those are adjustments, not standalone
// templates; cloning a credit note would create an INR -200 Draft
// invoice which is meaningless.
//
// === Auth: ADMIN/MANAGER only ===
//
// Operator-action surface — read-only roles can't create new invoices,
// even from a template.
//
// === Body ===
//   - dueDate (optional, parseable date) — overrides default (NOW+30d)
//   - clearTcs (optional boolean) — default true; false inherits source TCS
//
// === Side effects ===
//   - New TravelInvoice row (Draft, fresh invoiceNum, parentInvoiceId=NULL).
//   - All source lines duplicated via createMany — preserves lineType,
//     description, qty, unitPrice, amount, sortOrder, notes, PNR/bookingRef,
//     service dates, currency, FX fields. New tenantId+invoiceId stamped.
//   - Audit row stamped action='TRAVEL_INVOICE_CLONED_RECURRING' with
//     details { sourceId, sourceInvoiceNum, lineCount, dueDate, clearTcs,
//     subBrand }.
//
// === Returns ===
//   - 201 + { invoice: <new row>, lineCount: <int> }
//
// === Error codes ===
//   - INVALID_ID (400 — :id not a number)
//   - INVOICE_NOT_FOUND (404 — cross-tenant or missing)
//   - SUB_BRAND_DENIED (403 — caller can't access source's sub-brand)
//   - INVALID_SOURCE_STATE (400 — source not in [Issued, Paid])
//   - CANNOT_CLONE_NOTE (400 — source is CreditNote or DebitNote)
//   - INVALID_DUE_DATE (400 — unparseable body.dueDate; from parseDueDate)
// ============================================================================
const CLONEABLE_SOURCE_STATUSES = ["Issued", "Paid"];

router.post(
  "/invoices/:id/clone-as-recurring",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "write"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const source = await loadParentInvoice(req, res, invoiceId);
      if (!source) return;

      // Reject CreditNote / DebitNote sources outright — adjustments
      // aren't standalone templates. Cloning a CN with totalAmount=-200
      // would produce a meaningless negative-Draft.
      if (source.docType === "CreditNote" || source.docType === "DebitNote") {
        return res.status(400).json({
          error:
            "Cannot clone a credit note or debit note as a recurring invoice",
          code: "CANNOT_CLONE_NOTE",
        });
      }

      // Source must be in a cloneable state — Issued or Paid only.
      // Draft = still composing (not template-quality); Voided = no
      // business reusing; Partial = still mid-collection (operator should
      // close it out first via /receive-payment + /void or wait for Paid).
      if (!CLONEABLE_SOURCE_STATUSES.includes(source.status)) {
        return res.status(400).json({
          error: `Source invoice must be in one of [${CLONEABLE_SOURCE_STATUSES.join(", ")}] to clone (current: ${source.status})`,
          code: "INVALID_SOURCE_STATE",
        });
      }

      const { dueDate: dueDateOverride, clearTcs } = req.body || {};
      // clearTcs defaults to TRUE — TCS is FY-cumulative-spend-dependent
      // and historical values are stale. Operator opts into inheritance
      // by explicitly sending clearTcs=false.
      const shouldClearTcs = clearTcs === false ? false : true;

      // dueDate: body override (parseDueDate validates) → fallback to
      // NOW + 30 days. Source's dueDate is historical and likely past;
      // recurring cycles need a fresh future date.
      const parsedOverride = parseDueDate(dueDateOverride);
      const cloneDueDate =
        parsedOverride != null
          ? parsedOverride
          : new Date(Date.now() + 30 * 86_400_000);

      // Fresh invoice number — slice-5 per-sub-brand serial only applies
      // at Draft→Issued; the clone is born Draft so we use the legacy
      // nextInvoiceNum (TINV-YYYY-NNNN scheme).
      const newInvoiceNum = await nextInvoiceNum(req.travelTenant.id);

      // Load source lines BEFORE creating the new invoice — minimises
      // the window where a half-cloned invoice could exist if the
      // line duplication fails.
      const sourceLines = await prisma.travelInvoiceLine.findMany({
        where: { invoiceId: source.id, tenantId: req.travelTenant.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });

      const newInvoiceData = {
        tenantId: req.travelTenant.id,
        subBrand: source.subBrand,
        contactId: source.contactId,
        invoiceNum: newInvoiceNum,
        status: "Draft",
        totalAmount: source.totalAmount,
        currency: source.currency,
        dueDate: cloneDueDate,
        // docType inherits from source (TaxInvoice / Proforma /
        // TravelVoucher all OK — CreditNote/DebitNote rejected above).
        docType: source.docType || "TaxInvoice",
        // parentInvoiceId stays NULL — recurring cycles are independent
        // billing instruments, not credit-note-style adjustments.
        parentInvoiceId: null,
      };

      // TCS fields: clear by default (FY-cumulative dependency makes
      // historical values stale). clearTcs=false inherits source values.
      if (shouldClearTcs) {
        newInvoiceData.tcsAmount = null;
        newInvoiceData.tcsRate = null;
        newInvoiceData.tcsExceedingAmount = null;
        newInvoiceData.tcsAppliedAt = null;
      } else {
        newInvoiceData.tcsAmount = source.tcsAmount;
        newInvoiceData.tcsRate = source.tcsRate;
        newInvoiceData.tcsExceedingAmount = source.tcsExceedingAmount;
        newInvoiceData.tcsAppliedAt = source.tcsAppliedAt;
      }

      const created = await prisma.travelInvoice.create({ data: newInvoiceData });

      // Clone lines via createMany — preserves all per-line fields
      // (lineType, description, qty, unitPrice, amount, currency,
      // sortOrder, notes, PNR/bookingRef, service dates, FX fields).
      // tenantId + invoiceId re-stamped to the new parent.
      let lineCount = 0;
      if (sourceLines.length > 0) {
        const lineData = sourceLines.map((l) => ({
          tenantId: req.travelTenant.id,
          invoiceId: created.id,
          lineType: l.lineType,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
          currency: l.currency,
          sortOrder: l.sortOrder,
          notes: l.notes,
          pnr: l.pnr,
          bookingRef: l.bookingRef,
          serviceStartDate: l.serviceStartDate,
          serviceEndDate: l.serviceEndDate,
          fxRateToBase: l.fxRateToBase,
          baseAmount: l.baseAmount,
        }));
        const result = await prisma.travelInvoiceLine.createMany({
          data: lineData,
        });
        lineCount = result.count != null ? result.count : sourceLines.length;
      }

      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_CLONED_RECURRING",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          sourceId: source.id,
          sourceInvoiceNum: source.invoiceNum,
          lineCount,
          dueDate: cloneDueDate.toISOString(),
          clearTcs: shouldClearTcs,
          subBrand: source.subBrand,
        },
      );

      return res.status(201).json({ invoice: created, lineCount });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] clone-as-recurring error:", e.message);
      res.status(500).json({ error: "Failed to clone invoice as recurring" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/:id/late-penalty
// Arc 2 #901 slice 24 — PRD_TRAVEL_BILLING §3 late-payment penalty preview.
//
// READ-ONLY. Computes the penalty that WOULD apply if the operator were to
// surcharge an overdue customer invoice as-of `asOf` (defaults to wall clock).
// Pure compute — does NOT persist a penalty line, does NOT mutate state,
// does NOT write audit. Operator turns this into a real charge by adding
// a regular invoice line (lineType='fee') once they decide to enforce.
//
// Auth: any verified token, tenant + sub-brand scoped via loadParentInvoice.
//
// Query params (all optional):
//   ?asOf=<ISO8601>             — reference "now"; defaults to wall clock.
//                                  Parse failure → 400 INVALID_AS_OF.
//   ?graceDays=<int>            — grace window override (default 7).
//   ?annualRatePercent=<num>    — simple-mode annual rate override
//                                  (default 18 — 1.5% / month, under RBI cap).
//   ?flatFeePercent=<num>       — flat-mode % override (default 2).
//   ?mode=simple|flat           — penalty model (default simple).
//
// Response envelope: { invoiceId, status, totalAmount, dueDate, asOf,
//   applies, daysOverdue, chargeableDays, graceDays, mode, ratePercent,
//   penalty, newBalance, reason }.
//
// Error codes: INVALID_ID, INVOICE_NOT_FOUND, SUB_BRAND_DENIED,
//   INVALID_AS_OF, INVALID_NUMERIC_QUERY, INVALID_MODE.
// ============================================================================
router.get(
  "/invoices/:id/late-penalty",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // Parse asOf — wall-clock default, body override must be a valid date.
      let asOf = new Date();
      if (req.query.asOf != null && req.query.asOf !== "") {
        const parsed = new Date(req.query.asOf);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "asOf must be a valid ISO 8601 date string",
            code: "INVALID_AS_OF",
          });
        }
        asOf = parsed;
      }

      // Parse numeric overrides — each must coerce cleanly OR be absent.
      function parseOptionalNonNeg(name) {
        const raw = req.query[name];
        if (raw == null || raw === "") return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          const err = new Error(`${name} must be a non-negative number`);
          err.status = 400;
          err.code = "INVALID_NUMERIC_QUERY";
          throw err;
        }
        return n;
      }

      const graceDays = parseOptionalNonNeg("graceDays");
      const annualRatePercent = parseOptionalNonNeg("annualRatePercent");
      const flatFeePercent = parseOptionalNonNeg("flatFeePercent");

      let mode;
      if (req.query.mode != null && req.query.mode !== "") {
        if (req.query.mode !== "simple" && req.query.mode !== "flat") {
          return res.status(400).json({
            error: "mode must be 'simple' or 'flat'",
            code: "INVALID_MODE",
          });
        }
        mode = req.query.mode;
      }

      const result = computeLatePenalty({
        invoiceAmount: invoice.totalAmount,
        dueDate: invoice.dueDate,
        status: invoice.status,
        asOf,
        graceDays,
        annualRatePercent,
        flatFeePercent,
        mode,
      });

      return res.status(200).json({
        invoiceId: invoice.id,
        status: invoice.status,
        totalAmount: Number(invoice.totalAmount || 0),
        dueDate: invoice.dueDate,
        asOf: asOf.toISOString(),
        defaults: {
          graceDays: DEFAULT_GRACE_DAYS,
          annualRatePercent: DEFAULT_ANNUAL_RATE_PERCENT,
          flatFeePercent: DEFAULT_FLAT_FEE_PERCENT,
        },
        ...result,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] late-penalty error:", e.message);
      res.status(500).json({ error: "Failed to compute late-payment penalty" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/apply-penalty
// Arc 2 #901 slice 25 — PRD_TRAVEL_BILLING §3 late-payment penalty PERSIST.
//
// Counterpart to slice 24's read-only GET /:id/late-penalty. Materialises
// the computed penalty as a TravelInvoiceLine (lineType='fee') against the
// parent invoice + recomputes totalAmount via the existing pipeline + writes
// an audit row. Idempotency surface: idempotencyKey body field, threaded
// through to TravelInvoiceLine.notes (no schema change — the per-invoice
// uniqueness search runs against existing lines on each request).
//
// Why a SEPARATE endpoint from /lines (not just "create a line manually"):
//   - Operator decision flow: preview → review → apply. Surfacing it as a
//     first-class verb lets the UI render "Apply penalty for ₹113.42?" with
//     the math pinned, instead of asking the operator to retype the amount.
//   - The math runs server-side a second time at apply-time, guaranteeing
//     preview-vs-applied parity (same /asOf, same policy overrides → same
//     penalty value). Operator can't typo a stale preview value into a
//     manual /lines POST.
//   - Audit trail carries 'TRAVEL_INVOICE_PENALTY_APPLIED' with the math
//     details (daysOverdue, chargeableDays, ratePercent, mode, penalty) —
//     a manual /lines POST would only log 'CREATE' on the line with no
//     policy context.
//
// Idempotency model: caller-supplied idempotencyKey (string, optional).
// When present + a prior line on this invoice has the same key (matched
// against notes containing 'penaltyKey:<key>'), returns the EXISTING line
// + status:'already_applied'. When absent, every call creates a fresh
// penalty line (operator-confirmed escalation — they meant to add another).
//
// Auth: ADMIN/MANAGER only (writes).
// Pre-conditions: invoice exists, tenant-scoped, sub-brand-accessible.
// Status guard: REJECT if status not in PAYABLE_STATUSES (Issued/Partial).
//   Returns 409 INVOICE_NOT_PAYABLE for Draft/Paid/Voided. Distinct from
//   the preview's applies:false+reason:'INVOICE_CLOSED' shape because this
//   is a write operation and we want to surface the precondition violation
//   explicitly rather than silently no-op.
//
// Body (all optional, mirrors slice-24 query params):
//   asOf, graceDays, annualRatePercent, flatFeePercent, mode, idempotencyKey,
//   description (override the auto-generated penalty-line description).
//
// Response on apply: 201 + { invoiceId, line, penalty, daysOverdue,
//   chargeableDays, mode, ratePercent, status:'applied' }.
// Response on idempotent hit: 200 + { invoiceId, line, status:'already_applied' }.
// Response when penalty does not apply (in-grace, not-yet-due, zero-principal):
//   200 + { applies:false, reason, status:'not_applied' }. NO line created.
//
// Error codes: INVALID_ID, INVOICE_NOT_FOUND, SUB_BRAND_DENIED,
//   INVALID_AS_OF, INVALID_NUMERIC_QUERY, INVALID_MODE, INVALID_IDEMPOTENCY_KEY,
//   INVOICE_NOT_PAYABLE.
// ============================================================================
router.post(
  "/invoices/:id/apply-penalty",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // Status pre-condition. Draft can't be penalised (no obligation yet);
      // Paid/Voided are closed states.
      if (!["Issued", "Partial"].includes(invoice.status)) {
        return res.status(409).json({
          error:
            "Late-payment penalty can only be applied to invoices in Issued or Partial status",
          code: "INVOICE_NOT_PAYABLE",
          currentStatus: invoice.status,
        });
      }

      const body = req.body || {};

      // Parse asOf — wall-clock default, body override must be a valid date.
      let asOf = new Date();
      if (body.asOf != null && body.asOf !== "") {
        const parsed = new Date(body.asOf);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({
            error: "asOf must be a valid ISO 8601 date string",
            code: "INVALID_AS_OF",
          });
        }
        asOf = parsed;
      }

      // Parse numeric overrides — each must coerce cleanly OR be absent.
      function parseOptionalNonNeg(name) {
        const raw = body[name];
        if (raw == null || raw === "") return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          const err = new Error(`${name} must be a non-negative number`);
          err.status = 400;
          err.code = "INVALID_NUMERIC_QUERY";
          throw err;
        }
        return n;
      }

      const graceDays = parseOptionalNonNeg("graceDays");
      const annualRatePercent = parseOptionalNonNeg("annualRatePercent");
      const flatFeePercent = parseOptionalNonNeg("flatFeePercent");

      let mode;
      if (body.mode != null && body.mode !== "") {
        if (body.mode !== "simple" && body.mode !== "flat") {
          return res.status(400).json({
            error: "mode must be 'simple' or 'flat'",
            code: "INVALID_MODE",
          });
        }
        mode = body.mode;
      }

      // Idempotency key — optional, free-form string capped at 64 chars.
      let idempotencyKey = null;
      if (body.idempotencyKey != null && body.idempotencyKey !== "") {
        if (
          typeof body.idempotencyKey !== "string" ||
          body.idempotencyKey.length > 64
        ) {
          return res.status(400).json({
            error: "idempotencyKey must be a string ≤64 chars",
            code: "INVALID_IDEMPOTENCY_KEY",
          });
        }
        idempotencyKey = body.idempotencyKey;
      }

      // Idempotency probe — search this invoice's existing lines for a
      // notes-token marking the same caller-supplied key. Scoped by
      // tenantId + invoiceId so cross-invoice keys don't collide.
      if (idempotencyKey) {
        const existing = await prisma.travelInvoiceLine.findFirst({
          where: {
            tenantId: req.travelTenant.id,
            invoiceId: invoice.id,
            lineType: "fee",
            notes: { contains: `penaltyKey:${idempotencyKey}` },
          },
        });
        if (existing) {
          return res.status(200).json({
            invoiceId: invoice.id,
            line: existing,
            status: "already_applied",
            idempotencyKey,
          });
        }
      }

      const result = computeLatePenalty({
        invoiceAmount: invoice.totalAmount,
        dueDate: invoice.dueDate,
        status: invoice.status,
        asOf,
        graceDays,
        annualRatePercent,
        flatFeePercent,
        mode,
      });

      // Penalty did not apply → 200 envelope, NO line created, NO audit row.
      // Mirrors apply-tcs's "applies===false" branch which also no-ops.
      if (!result.applies) {
        return res.status(200).json({
          invoiceId: invoice.id,
          status: "not_applied",
          applies: false,
          reason: result.reason,
          daysOverdue: result.daysOverdue,
          chargeableDays: result.chargeableDays,
          graceDays: result.graceDays,
          mode: result.mode,
          ratePercent: result.ratePercent,
          penalty: 0,
        });
      }

      // Build the line. Description auto-generated unless operator overrode
      // (audit-trail-friendly default). Notes carries the policy details +
      // the idempotency key marker (when supplied).
      const autoDesc =
        result.mode === "flat"
          ? `Late-payment penalty (${result.ratePercent}% flat, ${result.daysOverdue}d overdue)`
          : `Late-payment penalty (${result.ratePercent}% p.a., ${result.chargeableDays}d chargeable)`;
      const description =
        typeof body.description === "string" && body.description.trim()
          ? body.description.trim().slice(0, 255)
          : autoDesc;

      const notesParts = [
        `mode:${result.mode}`,
        `ratePercent:${result.ratePercent}`,
        `daysOverdue:${result.daysOverdue}`,
        `chargeableDays:${result.chargeableDays}`,
        `asOf:${asOf.toISOString()}`,
      ];
      if (idempotencyKey) notesParts.push(`penaltyKey:${idempotencyKey}`);
      const notes = notesParts.join("; ");

      const line = await prisma.travelInvoiceLine.create({
        data: {
          tenantId: req.travelTenant.id,
          invoiceId: invoice.id,
          lineType: "fee",
          description,
          quantity: 1,
          unitPrice: result.penalty,
          amount: result.penalty,
          currency: invoice.currency,
          sortOrder: 9999, // penalty rows render last (operator can re-sort).
          notes,
        },
      });

      await recomputeInvoiceTotal(invoice.id, req.travelTenant.id);

      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_PENALTY_APPLIED",
        invoice.id,
        req.user.userId,
        req.travelTenant.id,
        {
          lineId: line.id,
          penalty: result.penalty,
          mode: result.mode,
          ratePercent: result.ratePercent,
          daysOverdue: result.daysOverdue,
          chargeableDays: result.chargeableDays,
          asOf: asOf.toISOString(),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      );

      return res.status(201).json({
        invoiceId: invoice.id,
        line,
        status: "applied",
        penalty: result.penalty,
        daysOverdue: result.daysOverdue,
        chargeableDays: result.chargeableDays,
        graceDays: result.graceDays,
        mode: result.mode,
        ratePercent: result.ratePercent,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] apply-penalty error:", e.message);
      res.status(500).json({ error: "Failed to apply late-payment penalty" });
    }
  },
);

// ============================================================================
// POST /api/travel/invoices/:id/convert-to-tax-invoice — Arc 2 #901 slice 26.
//
// PRD_TRAVEL_BILLING FR-3.8 (doc-type taxonomy) + UC-2.6 (overseas TCS
// estimation). Operator-action "Convert Proforma -> Tax Invoice": flips a
// Draft Proforma to a Draft TaxInvoice in-place, reassigning invoiceNum
// from the proforma-namespace to the regular sub-brand TaxInvoice serial.
//
// Why this exists: A Proforma is a non-binding price estimate (commonly
// issued for visa application support, overseas package pre-quoting before
// FX is finalized, customer-side internal approval). Once the price is
// locked + customer commits, the operator converts to a TaxInvoice WITHOUT
// re-entering line items + tax calculations. The conversion preserves:
//   - lines (TravelInvoiceLine rows untouched)
//   - totalAmount + currency + dueDate + contactId + subBrand
//   - parentInvoiceId remains null (a Proforma is not a child of anything)
// And mutates:
//   - docType: Proforma -> TaxInvoice
//   - invoiceNum: rewritten via nextSubBrandInvoiceNum() so the new
//     TaxInvoice gets a gap-less per-sub-brand serial. The old proforma
//     number is preserved in the audit log under prevInvoiceNum.
// Status stays Draft — operator must explicitly call /issue to lock it
// (matches the existing create-then-issue flow; conversion does NOT skip
// the Draft -> Issued transition matrix).
//
// Auth: ADMIN/MANAGER only.
//
// Body: (empty — no input needed; conversion is a pure type-flip)
//
// Pre-conditions:
//   1. Invoice exists, tenant-scoped, sub-brand-accessible.
//   2. docType == 'Proforma' (NULL docType is treated as 'TaxInvoice' per
//      the slice-11 back-compat convention; back-compat rows are NOT
//      eligible for conversion since they're already TaxInvoice).
//   3. status == 'Draft' (Issued/Partial/Paid/Voided are settled states
//      — converting after issue would invalidate downstream audit trails;
//      operator should issue a CreditNote + start fresh).
//
// Side effects:
//   - In-place update of the TravelInvoice row (docType + invoiceNum).
//   - Audit row stamped TRAVEL_INVOICE_CONVERTED_TO_TAX_INVOICE with
//     details { prevInvoiceNum, newInvoiceNum, subBrand }.
//
// Returns: 200 + the updated invoice row.
//
// Error codes: INVALID_ID (400), INVOICE_NOT_FOUND (404),
//   SUB_BRAND_DENIED (403), NOT_A_PROFORMA (400 — docType != 'Proforma'),
//   INVALID_INVOICE_STATE (400 — status != 'Draft').
// ============================================================================
router.post(
  "/invoices/:id/convert-to-tax-invoice",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      if (invoice.docType !== "Proforma") {
        return res.status(400).json({
          error: `Only Proforma invoices can be converted to TaxInvoice (current docType: ${invoice.docType || "TaxInvoice"})`,
          code: "NOT_A_PROFORMA",
        });
      }

      if (invoice.status !== "Draft") {
        return res.status(400).json({
          error: `Only Draft proformas can be converted (current status: ${invoice.status}). Settled proformas should be voided + reissued.`,
          code: "INVALID_INVOICE_STATE",
        });
      }

      const prevInvoiceNum = invoice.invoiceNum;
      const newInvoiceNum = await nextSubBrandInvoiceNum(
        req.travelTenant.id,
        invoice.subBrand,
      );

      const updated = await prisma.travelInvoice.update({
        where: { id: invoice.id },
        data: {
          docType: "TaxInvoice",
          invoiceNum: newInvoiceNum,
        },
      });

      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_CONVERTED_TO_TAX_INVOICE",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          prevInvoiceNum,
          newInvoiceNum,
          subBrand: invoice.subBrand,
        },
      );

      return res.status(200).json(updated);
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] convert-to-tax-invoice error:", e.message);
      res.status(500).json({ error: "Failed to convert proforma to tax invoice" });
    }
  },
);

// POST /api/travel/invoices/:id/void — dedicated audit-logged void action.
// Body: { reason: string (required, 5..500 chars) }
// Mirrors the action-endpoint pattern used by mark-paid, apply-penalty,
// convert-to-tax-invoice. ADMIN/MANAGER only. PRD_TRAVEL_BILLING FR-3.7
// (cancellation/refund flow — voiding is a precondition for reissuance).
//
// Behaviour:
//   - Any non-Voided status flips to "Voided" (the existing PUT /:id allows
//     this too, but doesn't require a reason and doesn't carry one in audit).
//   - Already-Voided returns 400 ALREADY_VOIDED (idempotent guard so callers
//     don't accidentally overwrite the original void reason).
//   - Paid invoices CAN be voided here (mirrors the PUT-status transition map
//     which permits Paid -> Voided) — needed for refund/cancellation flow.
//   - Reason persisted in the audit log only (TravelInvoice has no `notes`
//     column; the audit-row is the authoritative reason record).
//
// S33 (#920) — PRD_TRAVEL_BILLING FR-3.7.b cancellation-policy wire-up.
//   When a non-Draft invoice is voided, the handler looks up the applicable
//   CancellationPolicy (by invoice.cancellationPolicyId if set, otherwise
//   by sub-brand default, otherwise tenant-wide default). If a policy is
//   matched AND any line has a serviceStartDate AND the tier-resolved
//   refundPercent > 0, the handler ALSO auto-creates a CreditNote row
//   (parentInvoiceId = the voided invoice, totalAmount = NEGATIVE refund
//   amount, docType = 'CreditNote'). Draft invoices never auto-issue
//   (nothing was billed yet; no refund obligation).
//
//   Response envelope (additive — single top-level invoice keeps working
//   for existing destructurers):
//     {
//       ...voided invoice fields...,
//       creditNote: { ...CR row... } | null,
//       policyApplied: { policyId, policyName, tier, refundPercent } | null,
//     }
router.post(
  "/invoices/:id/void",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "update"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);

      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (reason.length < 5 || reason.length > 500) {
        return res.status(400).json({
          error: "reason must be 5..500 characters",
          code: "INVALID_VOID_REASON",
        });
      }

      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      if (invoice.status === "Voided") {
        return res.status(400).json({
          error: "Invoice already voided",
          code: "ALREADY_VOIDED",
        });
      }

      const prevStatus = invoice.status;

      const updated = await prisma.travelInvoice.update({
        where: { id: invoice.id },
        data: { status: "Voided" },
      });

      await writeAudit(
        "TravelInvoice",
        "TRAVEL_INVOICE_VOIDED",
        updated.id,
        req.user.userId,
        req.travelTenant.id,
        {
          prevStatus,
          reason,
          invoiceNum: invoice.invoiceNum,
          subBrand: invoice.subBrand,
        },
      );

      // S33 — Cancellation-policy → auto-CreditNote issuance.
      // Skip on Draft (nothing was billed; no refund obligation). Skip on
      // CreditNote / DebitNote parents (you don't re-credit an adjustment).
      let creditNote = null;
      let policyApplied = null;
      try {
        if (
          prevStatus !== "Draft" &&
          invoice.docType !== "CreditNote" &&
          invoice.docType !== "DebitNote"
        ) {
          const resolved = await resolveCancellationOutcome(
            req,
            invoice,
          );
          if (resolved && resolved.refundAmount > 0) {
            const creditInvoiceNum = `CN-${invoice.invoiceNum}`;
            creditNote = await prisma.travelInvoice.create({
              data: {
                tenantId: req.travelTenant.id,
                subBrand: invoice.subBrand,
                contactId: invoice.contactId,
                invoiceNum: creditInvoiceNum,
                docType: "CreditNote",
                status: "Issued",
                totalAmount: -resolved.refundAmount,
                currency: invoice.currency,
                parentInvoiceId: invoice.id,
              },
            });
            await writeAudit(
              "TravelInvoice",
              "TRAVEL_INVOICE_CREDIT_NOTE_ISSUED",
              creditNote.id,
              req.user.userId,
              req.travelTenant.id,
              {
                parentId: invoice.id,
                parentInvoiceNum: invoice.invoiceNum,
                amount: resolved.refundAmount,
                reason: `Auto-issued from cancellation policy: ${resolved.policyName}`,
                policyId: resolved.policyId,
                tier: resolved.tier,
                refundPercent: resolved.refundPercent,
                subBrand: invoice.subBrand,
                autoIssued: true,
              },
            );
            policyApplied = {
              policyId: resolved.policyId,
              policyName: resolved.policyName,
              tier: resolved.tier,
              refundPercent: resolved.refundPercent,
            };
          } else if (resolved) {
            // Policy matched but refund was 0% (no-refund tier) or invoice
            // had no service-start date or totalAmount was null. We still
            // surface the policy in the envelope for operator clarity.
            policyApplied = {
              policyId: resolved.policyId,
              policyName: resolved.policyName,
              tier: resolved.tier,
              refundPercent: resolved.refundPercent,
            };
          }
        }
      } catch (cancelErr) {
        // Defensive — auto-issuance failure should NOT roll back the void
        // itself. The invoice IS voided; the credit-note can be issued
        // manually via the existing POST /credit-note endpoint. Log and
        // continue.
        console.error(
          "[travel-invoices] cancellation-policy auto-issuance error:",
          cancelErr.message,
        );
      }

      return res.status(200).json({
        ...updated,
        creditNote,
        policyApplied,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] void error:", e.message);
      res.status(500).json({ error: "Failed to void invoice" });
    }
  },
);

// ============================================================================
// GET /api/travel/invoices/:id/cancel-preview
// S58 — PRD_TRAVEL_BILLING FR-3.7.b cancellation-policy preview surface.
//
// READ-ONLY. Calls the shared resolveCancellationOutcome() helper (the same
// resolver that POST /:id/void uses to drive its auto-CreditNote issuance)
// WITHOUT mutating the invoice or creating any rows. Powers the void-
// confirmation modal (S56 InvoiceDetail.jsx): operators can see the refund
// amount + matched policy tier BEFORE clicking "Confirm Void", so they
// don't accidentally trigger a refund they didn't intend.
//
// Auth: same gate as POST /:id/void — verifyToken + verifyRole(ADMIN,MANAGER).
// USER role denied (helper-shape; can't void → can't preview either).
// Tenant + sub-brand scoped via loadParentInvoice (same path as void).
//
// Status guard: already-Voided invoices return 409 ALREADY_VOIDED (matches
// the void endpoint's idempotency guard semantics, surfaced one tier
// stricter via 409 instead of 400 since the resource state is the conflict,
// not the input shape).
//
// Response envelope (200):
//   {
//     invoiceId,
//     status,                       // current invoice status (Issued/Paid/Draft/Partial)
//     policyApplied: { policyId, policyName, tier, refundPercent } | null,
//     refundAmount: number | null,  // INR / invoice.currency; null if no policy resolved
//     refundPercent: number | null,
//     daysBeforeServiceStart: number | null,
//     serviceStartDate: ISO string | null,
//     reason: 'OK' | 'NO_POLICY_RESOLVED'  // why preview is null/empty
//   }
//
// Error envelopes:
//   400 INVALID_ID            (from loadParentInvoice)
//   403 SUB_BRAND_DENIED      (from loadParentInvoice)
//   404 INVOICE_NOT_FOUND     (cross-tenant or nonexistent)
//   409 ALREADY_VOIDED        (invoice already Voided — cannot preview a void)
// ============================================================================
router.get(
  "/invoices/:id/cancel-preview",
  verifyToken,
  requireTravelTenant,
  requirePermission("invoices", "read"),
  async (req, res) => {
    try {
      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      if (invoice.status === "Voided") {
        return res.status(409).json({
          error: "Invoice already voided",
          code: "ALREADY_VOIDED",
        });
      }

      // Defensive try/catch around the resolver — mirrors the void
      // endpoint's defensive shell so a transient DB hiccup on policy
      // lookup yields a "no preview available" response instead of a 500.
      let resolved = null;
      try {
        resolved = await resolveCancellationOutcome(req, invoice);
      } catch (resolverErr) {
        console.error(
          "[travel-invoices] cancel-preview resolver error:",
          resolverErr.message,
        );
        resolved = null;
      }

      if (!resolved) {
        return res.status(200).json({
          invoiceId: invoice.id,
          status: invoice.status,
          policyApplied: null,
          refundAmount: null,
          refundPercent: null,
          daysBeforeServiceStart: null,
          serviceStartDate: null,
          reason: "NO_POLICY_RESOLVED",
        });
      }

      return res.status(200).json({
        invoiceId: invoice.id,
        status: invoice.status,
        policyApplied: {
          policyId: resolved.policyId,
          policyName: resolved.policyName,
          tier: resolved.tier,
          refundPercent: resolved.refundPercent,
        },
        refundAmount: resolved.refundAmount,
        refundPercent: resolved.refundPercent,
        daysBeforeServiceStart: resolved.daysBeforeStart,
        serviceStartDate: resolved.serviceStartDate,
        reason: "OK",
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] cancel-preview error:", e.message);
      res.status(500).json({ error: "Failed to preview cancellation" });
    }
  },
);

// S33 (#920) — Cancellation-policy resolver helper.
//
// Given a voided invoice, finds the applicable CancellationPolicy and
// computes the refund amount under it. Returns:
//   {
//     policyId, policyName, tier, refundPercent, refundAmount,
//     daysBeforeStart, serviceStartDate
//   }
// or null if no policy applies OR the invoice has no service-start date
// (we can't compute days-before-start without one).
//
// Lookup precedence:
//   1. invoice.cancellationPolicyId (operator-pinned at issue time).
//   2. invoice.itineraryId (trip-scoped policy for the booked itinerary).
//   3. Active policy where subBrand === invoice.subBrand (sub-brand-specific).
//   4. Active policy where subBrand IS NULL (tenant-wide default).
//   First match wins; deterministic ordering by id ASC for repeatability.
//
// Tier-walking algorithm:
//   - Parse tiersJson (assertValidTiers canonicalises sort DESC by
//     daysBeforeServiceStart at write-time, but we re-sort here defensively).
//   - daysBeforeStart = floor( (earliestServiceStartDate - now) / 1 day ).
//   - Walk tiers in DESC threshold order; pick the FIRST tier whose
//     daysBeforeServiceStart <= daysBeforeStart. That tier's refundPercent
//     drives the refund amount.
//   - If daysBeforeStart < smallest threshold (e.g. all tiers say >= 7
//     days but cancellation is today), no tier matches ? refundPercent = 0.
//
// refundAmount = invoice.totalAmount * (refundPercent / 100), rounded
// to 2dp (matching the Decimal(15,2) column precision on TravelInvoice).
async function resolveCancellationOutcome(req, invoice) {
  // Resolve policy.
  let policy = null;
  if (invoice.cancellationPolicyId) {
    policy = await prisma.cancellationPolicy.findFirst({
      where: {
        id: invoice.cancellationPolicyId,
        tenantId: req.travelTenant.id,
        isActive: true,
      },
    });
  }
  if (!policy && invoice.itineraryId) {
    policy = await prisma.cancellationPolicy.findFirst({
      where: {
        tenantId: req.travelTenant.id,
        itineraryId: invoice.itineraryId,
        isActive: true,
      },
    });
  }
  if (!policy) {
    policy = await prisma.cancellationPolicy.findFirst({
      where: {
        tenantId: req.travelTenant.id,
        subBrand: invoice.subBrand,
        isActive: true,
      },
      orderBy: { id: "asc" },
    });
  }
  if (!policy) {
    policy = await prisma.cancellationPolicy.findFirst({
      where: {
        tenantId: req.travelTenant.id,
        subBrand: null,
        isActive: true,
      },
      orderBy: { id: "asc" },
    });
  }
  if (!policy) return null;

  // Parse tiers.
  let tiers;
  try {
    tiers = JSON.parse(policy.tiersJson);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  // Defensive re-sort DESC by daysBeforeServiceStart (assertValidTiers
  // canonicalises at write, but legacy / manually-inserted rows may not).
  tiers.sort(
    (a, b) =>
      Number(b.daysBeforeServiceStart) - Number(a.daysBeforeServiceStart),
  );

  // Find earliest service-start date across lines.
  const lines = await prisma.travelInvoiceLine.findMany({
    where: { invoiceId: invoice.id, tenantId: req.travelTenant.id },
    select: { serviceStartDate: true },
  });
  let earliest = null;
  for (const l of lines) {
    if (!l.serviceStartDate) continue;
    const d =
      l.serviceStartDate instanceof Date
        ? l.serviceStartDate
        : new Date(l.serviceStartDate);
    if (Number.isNaN(d.getTime())) continue;
    if (!earliest || d < earliest) earliest = d;
  }
  if (!earliest) return null; // No service-start date → cannot compute tier.

  const now = new Date();
  const daysBeforeStart = Math.floor(
    (earliest.getTime() - now.getTime()) / 86_400_000,
  );

  // Walk tiers DESC; pick first whose threshold <= daysBeforeStart.
  let matched = null;
  for (const t of tiers) {
    const threshold = Number(t.daysBeforeServiceStart);
    if (Number.isFinite(threshold) && daysBeforeStart >= threshold) {
      matched = t;
      break;
    }
  }
  // No match (cancellation closer than the smallest threshold) → 0% refund.
  const refundPercent = matched ? Number(matched.refundPercent) : 0;
  const total = Number(invoice.totalAmount || 0);
  const refundAmount = Math.round(total * (refundPercent / 100) * 100) / 100;

  return {
    policyId: policy.id,
    policyName: policy.name,
    tier: matched
      ? {
          daysBeforeServiceStart: Number(matched.daysBeforeServiceStart),
          refundPercent: Number(matched.refundPercent),
        }
      : null,
    refundPercent,
    refundAmount,
    daysBeforeStart,
    serviceStartDate: earliest.toISOString(),
  };
}

// ============================================================================
// GET /api/travel/invoices/:id/timeline
// Arc 2 #901 slice 28 — PRD_TRAVEL_BILLING NFR-4.3 (audit trail consumer).
//
// READ-ONLY. Returns the chronological event timeline for a single invoice,
// reconstructed from AuditLog rows where:
//   entity='TravelInvoice' AND entityId=invoiceId               (invoice events)
//   entity='TravelInvoiceLine' AND details.invoiceId=invoiceId  (line events)
//
// Powers an "Activity" tab on the InvoiceDetail UI: a single chronological
// feed of create / update / issue / mark-paid / apply-penalty / convert /
// void / credit-note / debit-note / clone-as-recurring + per-line CRUD.
// All events that the existing slice-19..27 handlers already write via
// writeAudit() are surfaced — this endpoint adds zero new audit-event types;
// it's purely a presentation layer over the existing chain.
//
// Auth: any verified token; tenant + sub-brand scoped via loadParentInvoice.
//
// Query params (all optional):
//   ?limit=<int 1..200>   — page size (default 100; capped at 200).
//   ?includeLines=true    — also pull TravelInvoiceLine audit rows whose
//                            details.invoiceId matches (default true).
//
// Response: { invoiceId, count, events: [ { id, action, entity, at,
//   userId, details } ] }. Sorted createdAt DESC (newest first).
// Error codes: INVALID_ID, INVOICE_NOT_FOUND, SUB_BRAND_DENIED,
//   INVALID_NUMERIC_QUERY.
// ============================================================================
router.get(
  "/invoices/:id/timeline",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      // Parse limit (1..200, default 100) BEFORE loading the invoice so the
      // validation guard fires without a DB round-trip on malformed input.
      let limit = 100;
      if (req.query.limit != null && req.query.limit !== "") {
        const n = Number(req.query.limit);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 200) {
          return res.status(400).json({
            error: "limit must be an integer in [1, 200]",
            code: "INVALID_NUMERIC_QUERY",
          });
        }
        limit = n;
      }

      // includeLines defaults true; only the literal string "false" disables.
      const includeLines = req.query.includeLines !== "false";

      const invoiceId = parseInt(req.params.id, 10);
      const invoice = await loadParentInvoice(req, res, invoiceId);
      if (!invoice) return;

      // Pull invoice-level events directly via the indexed lookup.
      const invoiceRows = await prisma.auditLog.findMany({
        where: {
          tenantId: req.travelTenant.id,
          entity: "TravelInvoice",
          entityId: invoice.id,
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          createdAt: true,
          userId: true,
          details: true,
        },
      });

      // Pull line-level events for this invoice, if requested. We can't
      // directly index on details (it's a TEXT JSON column), so we pull the
      // recent line audit rows for this tenant and post-filter by parsing
      // details.invoiceId. Keep the prisma fetch bounded by 5x limit so the
      // post-filter doesn't unbound — operators almost never have >500
      // line edits on a single invoice anyway.
      let lineRows = [];
      if (includeLines) {
        const rawLineRows = await prisma.auditLog.findMany({
          where: {
            tenantId: req.travelTenant.id,
            entity: "TravelInvoiceLine",
          },
          orderBy: { createdAt: "desc" },
          take: limit * 5,
          select: {
            id: true,
            action: true,
            entity: true,
            entityId: true,
            createdAt: true,
            userId: true,
            details: true,
          },
        });
        lineRows = rawLineRows.filter((r) => {
          if (!r.details) return false;
          try {
            const parsed = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
            return parsed && parsed.invoiceId === invoice.id;
          } catch {
            return false;
          }
        });
      }

      // Merge + sort + cap at limit. Each event normalises details JSON
      // (string -> object) so the client doesn't have to re-parse.
      const merged = [...invoiceRows, ...lineRows]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((r) => {
          let details = r.details;
          if (typeof details === "string") {
            try {
              details = JSON.parse(details);
            } catch {
              // Leave as string if it isn't JSON — legacy rows or
              // free-form descriptions slip through here.
            }
          }
          return {
            id: r.id,
            action: r.action,
            entity: r.entity,
            entityId: r.entityId,
            at: r.createdAt,
            userId: r.userId,
            details,
          };
        });

      return res.status(200).json({
        invoiceId: invoice.id,
        count: merged.length,
        events: merged,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[travel-invoices] timeline error:", e.message);
      res.status(500).json({ error: "Failed to load invoice timeline" });
    }
  },
);

module.exports = router;
