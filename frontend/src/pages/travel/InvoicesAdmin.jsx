// Travel CRM — Invoices admin page.
//
// Lands at /travel/invoices-admin. Operator-facing list of TravelInvoice
// rows — Draft / Issued / Partial / Paid / Voided. CRUD wires to the
// /api/travel/invoices endpoints (commit b2a9dcb):
//   GET    /api/travel/invoices                    list (filters:
//                                                  subBrand / status /
//                                                  contactId / quoteId)
//   POST   /api/travel/invoices                    create (ADMIN+MANAGER);
//                                                  invoiceNum is server-
//                                                  assigned (TINV-YYYY-NNNN)
//   PUT    /api/travel/invoices/:id                edit (ADMIN+MANAGER);
//                                                  invoiceNum immutable;
//                                                  forward-only status
//                                                  transitions enforced
//                                                  server-side
//   DELETE /api/travel/invoices/:id                hard-delete (returns 204).
//                                                  ONLY Draft may be
//                                                  deleted; other statuses
//                                                  return 422
//                                                  INVOICE_DELETE_FORBIDDEN
//                                                  so the audit trail stays
//                                                  intact for Voided rows.
//
// Template: cloned from frontend/src/pages/travel/QuotesAdmin.jsx
// (commit aaf8cb2) — the canonical pattern for operator admin pages on
// the travel-vertical fork models (Quote / Invoice / Supplier trio).
// Empty-state honors the #829 permission-denied vs no-rows distinction.
//
// Status-transition matrix (forward-only, any -> Voided always allowed):
//   Draft   -> Issued | Voided
//   Issued  -> Partial | Paid | Voided
//   Partial -> Paid | Voided
//   Paid    -> Voided
//   Voided  -> (terminal)
//
// Frontend mirrors the matrix in EDIT mode — the status <select> in the
// modal only shows the current status + the legal next-states. CREATE
// mode allows any starting status (Draft is the sensible default).

import { useEffect, useRef, useState, useContext } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Receipt, Plus, Pencil, Trash2, FileDown, Ban, CreditCard, HandCoins, Link2, History, Upload, ArrowUpDown, ChevronUp, ChevronDown } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { formatMoney } from "../../utils/money";
import PatientPager from "../wellness/patients/PatientPager";
import {
  SUB_BRAND_BG,
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";
import { useActiveSubBrand } from "../../utils/subBrand";
// Branding Wave 4 G102: per-sub-brand brand-kit lookup for primary CTA tint.
import { useBrandKit, brandPrimaryColor } from "../../hooks/useBrandKit";
import { AuthContext } from "../../App";
import CountBadge from "../../components/CountBadge";

const SUB_BRANDS = [
  { value: "all", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const INVOICE_STATUSES = [
  { value: "", label: "All statuses" },
  { value: "Draft", label: "Draft" },
  { value: "Issued", label: "Issued" },
  { value: "Partial", label: "Partial" },
  { value: "Paid", label: "Paid" },
  { value: "Voided", label: "Voided" },
];
const INVOICE_SORT_KEYS = ["invoiceNum", "contact", "status", "totalAmount", "currency", "dueDate", "subBrand", "paidAt"];
const LAST_LIST_URL_KEY = "travel.invoices.lastListUrl";

// SUB_BRAND_BG now imported from ../../utils/travelSubBrand (rule-of-3
// promotion 2026-05-24 tick #99 — this file was the third caller that
// triggered the extraction; the inline copy here was an explicit hold to
// give the extraction clean call sites to work from).

// Status pill background — matches the lightweight badge palette used
// by QuotesAdmin's STATUS_BG. Voided is rendered with a strike-through
// in the row cell to make the terminal state obvious at a glance.
const STATUS_BG = {
  Draft: "rgba(148, 163, 184, 0.18)",     // slate (gray)
  Issued: "rgba(59, 130, 246, 0.18)",     // blue
  Partial: "rgba(245, 158, 11, 0.18)",    // amber
  Paid: "rgba(34, 197, 94, 0.18)",        // green
  Voided: "rgba(244, 63, 94, 0.18)",      // rose (red)
};
const STATUS_COLOR = {
  Draft: "var(--text-secondary)",
  Issued: "#3b82f6",
  Partial: "var(--warning-color, #f59e0b)",
  Paid: "var(--success-color, #22c55e)",
  Voided: "var(--danger-color, #f43f5e)",
};

// Forward-only transition map — mirror of backend ALLOWED_TRANSITIONS.
// Used by the EDIT modal to narrow the <select> options. The backend is
// the source of truth — even if this map drifts, server-side enforcement
// still kicks the bad transition out with 422 INVALID_INVOICE_TRANSITION.
const ALLOWED_TRANSITIONS = {
  Draft: ["Issued", "Voided"],
  Issued: ["Partial", "Paid", "Voided"],
  Partial: ["Paid", "Voided"],
  Paid: ["Voided"],
  Voided: [],
};

const EMPTY_FORM = {
  contactId: "",
  tripId: "",
  totalAmount: "",
  currency: "INR",
  status: "Draft",
  dueDate: "",
  quoteId: "",
  subBrand: "tmc",
};

const PAGE_SIZE = 20;

// Tomorrow as default for the dueDate date picker. Backend accepts any
// parseable date (back-dated invoices are legitimate ops) so this is a
// UX default, not a hard validation floor. Pattern mirrors QuotesAdmin's
// tomorrowISO + the CLAUDE.md date-boundary standing rule on
// unambiguous-future defaults.
function tomorrowISO() {
  const d = new Date(Date.now() + 86_400_000);
  return d.toISOString().slice(0, 10);
}

function openDatePicker(e) {
  try {
    e.currentTarget.showPicker?.();
  } catch {
    // Browsers without showPicker still open the native picker from its icon.
  }
}

function preventDateTyping(e) {
  if (e.key === "Tab") return;
  e.preventDefault();
  if (e.key === "Enter" || e.key === " ") openDatePicker(e);
}

const pickerOnlyProps = {
  onClick: openDatePicker,
  onKeyDown: preventDateTyping,
  onPaste: (e) => e.preventDefault(),
  onDrop: (e) => e.preventDefault(),
};

// Statuses on which TDS withholding is meaningful to surface — TDS lines
// are operator-relevant only AFTER an invoice has been issued (Draft +
// Voided invoices' TDS lines are noise). Matches the slice 21 contract on
// /:id/issue: the envelope adds { totalTds, payableAfterTds } at issue
// time. Partial is excluded — once partial payment has landed the
// payable-after-TDS figure is stale (deduct what's been received).
const TDS_VISIBLE_STATUSES = new Set(["Issued", "Paid"]);

// Slice 22 frontend mirror of backend/lib/tdsCalculation.js's
// computeTdsFromLines — sums amounts on lines whose lineType==='tds',
// half-up rounded to 2dp. The /:id/issue response envelope ships this
// number too (slice 21) but the list-GET doesn't, so we re-compute
// client-side from the lines returned by GET /:id?include=lines. Kept in
// lockstep with the backend lib (any drift surfaces as a frontend test
// fail because we pin the same canonical test vectors). The line shape
// from prisma is `{ lineType, amount, id }` — amount may arrive as a
// numeric string when Decimal columns serialize, so Number()-coerce
// defensively (matches backend lib's coercion contract).
function computeTotalTdsFromLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return 0;
  let sum = 0;
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (line.lineType !== "tds") continue;
    const n = Number(line.amount);
    if (!Number.isFinite(n)) continue;
    sum += Math.round((n + Number.EPSILON) * 100) / 100;
  }
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

export default function InvoicesAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  // G102: BrandKit lookup for primary-CTA tint. Module-level cache keeps
  // this cheap on re-mount.
  const { brandKit } = useBrandKit(activeSubBrand);
  const primaryBtnBranded = { ...primaryBtn, background: brandPrimaryColor(brandKit) };
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  // Sub-brand access gating for the create/edit form. ADMIN / no-restriction
  // users get a dropdown of all 4; restricted users get only their brands; a
  // single-brand user gets the field locked read-only. See defaultSubBrandFor.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const [invoices, setInvoices] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState("");
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(false);
  const [reloadTick, setReloadTick] = useState(0);
  // #1051 — resolve contactId -> { name, email } so the CONTACT column renders
  // a human-readable name instead of "#<id>". Backend list-GET doesn't include
  // the contact relation, so we batch-fetch unique IDs after the invoices land.
  // Resolved-but-unknown IDs are cached with name=null so we don't re-request.
  const [contactsById, setContactsById] = useState({});
  // Customer dropdown for the create/edit form — replaces the raw Contact-ID
  // input so operators pick a contact by name instead of memorising IDs.
  // Slim summary shape (id/name/email) + 500-row cap covers the tenant book;
  // the form is ADMIN/MANAGER-only (canWrite), who see the full tenant.
  const [customers, setCustomers] = useState([]);
  // TMC trips available for associating an invoice with its travel.
  const [trips, setTrips] = useState([]);
  // #829 — distinguish 403 from genuine empty so the empty-state copy
  // honestly says "Access restricted" instead of "No invoices match."
  const [permissionDenied, setPermissionDenied] = useState(false);
  const tripsById = Object.fromEntries(trips.map((trip) => [trip.id, trip]));

  const [subBrand, setSubBrand] = useState(searchParams.get("subBrand") || activeSubBrand || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");
  const [customerNameFilter, setCustomerNameFilter] = useState(searchParams.get("customer") || "");
  const [sortKey, setSortKey] = useState(INVOICE_SORT_KEYS.includes(searchParams.get("sortKey")) ? searchParams.get("sortKey") : null);
  const [sortDirection, setSortDirection] = useState(searchParams.get("sortDirection") === "desc" ? "desc" : "asc");
  const handleSort = (key) => {
    const next = new URLSearchParams(searchParams);
    const direction = sortKey !== key ? "asc" : sortDirection === "asc" ? "desc" : null;
    setSortKey(direction ? key : null); setSortDirection(direction || "asc");
    if (direction) { next.set("sortKey", key); next.set("sortDirection", direction); } else { next.delete("sortKey"); next.delete("sortDirection"); }
    setSearchParams(next, { replace: true });
  };
  const sortHeader = (label, key) => {
    const active = sortKey === key;
    const Icon = active ? (sortDirection === "asc" ? ChevronUp : ChevronDown) : ArrowUpDown;
    return <button type="button" onClick={() => handleSort(key)} aria-label={`Sort ${label}`} style={{ ...sortButtonStyle, ...(active ? sortButtonActiveStyle : null) }}><span>{label}</span><Icon size={14} aria-hidden /></button>;
  };
  const updateListParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingStatus, setEditingStatus] = useState(null); // server-side starting status, drives transition narrowing
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // #996 — synchronous re-entry guard. `saving` is React state, so a fast
  // double-click can fire handleSubmit twice before setSaving(true) has
  // rendered the disabled button — and the dedup pre-check on the second
  // POST runs BEFORE the first POST's row lands in the DB, so BOTH pass and
  // a byte-identical duplicate gets created. The ref is updated
  // synchronously on the first call so the second call short-circuits.
  const inFlightSubmit = useRef(false);
  // Per-row PDF download in-flight tracker. Holds the invoice.id while its
  // GET /:id/pdf is hitting the server so the action button can flip to
  // "Downloading…" and be disabled (defence against double-click producing
  // two browser-side downloads of the same blob).
  const [downloadingId, setDownloadingId] = useState(null);
  const [linkingId, setLinkingId] = useState(null); // invoice id while a pay-link generates
  // Transaction-history modal: the invoice being viewed + its fetched data.
  const [historyInv, setHistoryInv] = useState(null);
  const [historyData, setHistoryData] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [manualPaymentInv, setManualPaymentInv] = useState(null);
  const [manualPaymentData, setManualPaymentData] = useState(null);
  const [manualPaymentLoading, setManualPaymentLoading] = useState(false);
  const [manualPaymentSaving, setManualPaymentSaving] = useState(false);
  const [manualPaymentForm, setManualPaymentForm] = useState({
    milestoneId: "",
    amount: "",
    method: "cash",
    reference: "",
    paidAt: new Date().toISOString().slice(0, 10),
  });

  // Slice 22 — TDS withholding tiles in the edit modal. When opening edit
  // on an Issued / Paid invoice we lazy-fetch GET /:id?include=lines and
  // client-side-sum the lineType==='tds' lines (mirror of slice 21 server
  // math). totalTds=0 OR status not in {Issued,Paid} → tiles hidden so
  // operators never see a "TDS: 0" row on routine invoices. PRD §3.
  const [editingTds, setEditingTds] = useState(null); // { totalTds, totalAmount, currency } | null

  // S56 (#920) — Void-confirmation modal state.
  //
  // Surfaces the cancel-preview payload from S58's
  // GET /api/travel/invoices/:id/cancel-preview BEFORE the operator
  // commits POST /:id/void. Per the S33 follow-up #4 backlog item:
  // operators need to see "Refund: ₹X per TMC Default tier — 14d before
  // service" up-front so they understand what auto-issuance the void
  // will trigger.
  //
  // Discriminator key is `preview.reason` ('OK' | 'NO_POLICY_RESOLVED'),
  // NOT `refundAmount === null` — `refundAmount: 0` is a valid
  // no-refund-but-policy-matched state (the 0% tier surfaces the matched
  // policy without auto-issuing a credit note).
  //
  // The reason text input is REQUIRED by the backend (5..500 chars,
  // INVALID_VOID_REASON). The preview panel is purely informational.
  //
  // On preview-fetch failure (network / 404 / 409) we render a soft
  // error line and STILL allow the operator to proceed with the void —
  // the preview is a courtesy surface, not a hard gate.
  const [voidingInv, setVoidingInv] = useState(null); // { id, invoiceNum, currency } | null
  const [voidPreview, setVoidPreview] = useState(null);
  const [voidPreviewLoading, setVoidPreviewLoading] = useState(false);
  const [voidPreviewError, setVoidPreviewError] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voiding, setVoiding] = useState(false);

  const load = (currentPage = page, currentPageSize = pageSize) => {
    setLoading(true);
    loadingRef.current = true;
    const needle = customerNameFilter.trim().toLowerCase();
    const matchingCustomers = needle
      ? customers.filter((c) => String(c.name || "").toLowerCase().includes(needle))
      : [];

    const fetchPage = (extraQs = {}, usePagination = true) => {
      const qs = new URLSearchParams();
      if (subBrand && subBrand !== "all") qs.set("subBrand", subBrand);
      if (status) qs.set("status", status);
      Object.entries(extraQs).forEach(([key, value]) => {
        if (value != null && value !== "") qs.set(key, String(value));
      });
      if (usePagination) {
        qs.set("limit", String(currentPageSize));
        qs.set("offset", String(Math.max(currentPage - 1, 0) * currentPageSize));
      }
      const url = `/api/travel/invoices${qs.toString() ? `?${qs.toString()}` : ""}`;
      return fetchApi(url);
    };

    const applyPageSlice = (rows, totalRows) => {
      setInvoices(rows);
      setTotal(totalRows);
      setPermissionDenied(false);
    };

    if (needle) {
      if (matchingCustomers.length === 0) {
        setInvoices([]);
        setTotal(0);
        setPermissionDenied(false);
        setLoading(false);
        loadingRef.current = false;
        return;
      }

        Promise.allSettled(
          matchingCustomers.map((customer) =>
            fetchPage({ contactId: customer.id }, false),
          ),
        )
        .then((results) => {
          const merged = [];
          results.forEach((result) => {
            if (result.status === "fulfilled" && result.value) {
              const rows = Array.isArray(result.value?.invoices) ? result.value.invoices : [];
              merged.push(...rows);
            }
          });
          merged.sort((a, b) => {
            const ad = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bd = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
            if (bd !== ad) return bd - ad;
            return Number(b?.id || 0) - Number(a?.id || 0);
          });
          const totalRows = merged.length;
          const start = Math.max(currentPage - 1, 0) * currentPageSize;
          applyPageSlice(merged.slice(start, start + currentPageSize), totalRows);
        })
        .catch((err) => {
          setInvoices([]);
          setTotal(0);
          setPermissionDenied(err?.status === 403);
        })
        .finally(() => {
          setLoading(false);
          loadingRef.current = false;
        });
      return;
    }

    fetchPage()
      .then((d) => {
        const rows = Array.isArray(d?.invoices) ? d.invoices : [];
        const totalRows = Number.isFinite(d?.total) ? d.total : rows.length;
        applyPageSlice(rows, totalRows);
      })
      .catch((err) => {
        setInvoices([]);
        setTotal(0);
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => {
        setLoading(false);
        loadingRef.current = false;
      });
  };

  // Sync the global sub-brand selector into the local filter state so the
  // list automatically re-scopes when the user switches brand in the sidebar.
  useEffect(() => {
    if (!searchParams.get("subBrand")) setSubBrand(activeSubBrand || "");
  }, [activeSubBrand]);

  useEffect(() => {
    load(page, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subBrand, status, page, pageSize, reloadTick, customerNameFilter, customers]);

  useEffect(() => {
    if (location.pathname !== "/travel/invoices-admin") return;
    try { window.sessionStorage.setItem(LAST_LIST_URL_KEY, `${location.pathname}${location.search}`); } catch { /* URL remains authoritative. */ }
  }, [location.pathname, location.search]);

  // Load the tenant's contacts once for the customer dropdown.
  useEffect(() => {
    fetchApi("/api/contacts?fields=summary&limit=500")
      .then((data) => {
        const list = Array.isArray(data) ? data : data?.contacts || data?.rows || [];
        list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
        setCustomers(list);
      })
      .catch(() => setCustomers([]));
  }, []);

  // Load the lightweight trip list once for the invoice form and table labels.
  // The backend scopes this to the current tenant and excludes quote-only trips.
  useEffect(() => {
    fetchApi("/api/travel/trips?fields=summary&limit=200", { silent: true })
      .then((data) => setTrips(Array.isArray(data) ? data : data?.trips || []))
      .catch(() => setTrips([]));
  }, []);

  // #1051 — fetch contact display names for the IDs we haven't seen yet so the
  // CONTACT column can render names instead of raw IDs. /api/contacts has no
  // batch-by-ids surface, so we parallel-fetch /api/contacts/:id and cache.
  useEffect(() => {
    const ids = Array.from(
      new Set(
        invoices
          .map((i) => i.contactId)
          .filter((id) => Number.isFinite(id) && !(id in contactsById)),
      ),
    );
    if (ids.length === 0) return;
    let cancelled = false;
    // silent:true — a 404 here means the invoice references a deleted /
    // cross-tenant / inaccessible contact. The render falls back to
    // `#${inv.contactId}` (line ~977), so a global "Contact not found"
    // toast on every list-load would be noise. Cache the miss below to
    // avoid refetching the same dead id.
    Promise.allSettled(ids.map((id) => fetchApi(`/api/contacts/${id}`, { silent: true }))).then((results) => {
      if (cancelled) return;
      setContactsById((prev) => {
        const next = { ...prev };
        results.forEach((r, idx) => {
          const id = ids[idx];
          if (r.status === "fulfilled" && r.value) {
            next[id] = { name: r.value.name || null, email: r.value.email || null };
          } else {
            // Cache the miss so we don't refetch a deleted/inaccessible contact
            // on every list-load.
            next[id] = { name: null, email: null };
          }
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // contactsById intentionally omitted — we only care to fetch when the
    // invoices set changes; the filter above already skips IDs we've cached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setEditingStatus(null);
    setEditingTds(null);
  };

  const openCreate = () => {
    resetForm();
    // Default the sub-brand to the user's active/accessible brand instead of
    // the static EMPTY_FORM "tmc" so restricted users start on a valid brand.
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
    setShowForm(true);
  };

  const openEdit = (inv) => {
    setForm({
      contactId: inv.contactId == null ? "" : String(inv.contactId),
      tripId: inv.tripId == null ? "" : String(inv.tripId),
      totalAmount: inv.totalAmount == null ? "" : String(inv.totalAmount),
      currency: inv.currency || "INR",
      status: inv.status || "Draft",
      dueDate: inv.dueDate ? inv.dueDate.slice(0, 10) : "",
      quoteId: inv.quoteId == null ? "" : String(inv.quoteId),
      subBrand: inv.subBrand || "tmc",
    });
    setEditingId(inv.id);
    setEditingStatus(inv.status || "Draft");
    setEditingTds(null);
    setShowForm(true);
    // Slice 22 — only Issued / Paid invoices warrant fetching TDS detail.
    // Hidden for Draft (no withholding yet computed) and Voided (terminal,
    // the operator's audit need is past-tense and the issued envelope is
    // the source of truth). For Partial we intentionally skip too — the
    // payableAfterTds figure goes stale the moment the first payment is
    // recorded so showing it would mislead.
    if (inv?.id && TDS_VISIBLE_STATUSES.has(inv.status)) {
      fetchApi(`/api/travel/invoices/${inv.id}?include=lines`)
        .then((detail) => {
          const lines = Array.isArray(detail?.lines) ? detail.lines : [];
          const totalTds = computeTotalTdsFromLines(lines);
          if (totalTds > 0) {
            setEditingTds({
              totalTds,
              totalAmount: Number(detail?.totalAmount ?? inv.totalAmount),
              currency: detail?.currency || inv.currency || "INR",
            });
          }
        })
        .catch(() => {
          // Tiles silently absent if the detail GET fails — TDS context is
          // a nice-to-have surface, not load-bearing. The list row's
          // totalAmount still renders correctly via the canonical pathway.
        });
    }
  };

  // Allowed status options inside the modal. CREATE mode is unconstrained
  // (operator picks the starting status). EDIT mode = current status +
  // its allowed next-states. Backend enforces the same matrix; this just
  // gives a cleaner UI than letting the operator pick a backward
  // transition that will 422.
  const statusOptionsForModal = () => {
    if (!editingId) {
      return INVOICE_STATUSES.filter((s) => s.value);
    }
    const current = editingStatus || "Draft";
    const next = ALLOWED_TRANSITIONS[current] || [];
    const labels = new Set([current, ...next]);
    return INVOICE_STATUSES.filter((s) => s.value && labels.has(s.value));
  };

  const visibleInvoices = [...invoices].sort((a, b) => {
    if (!sortKey) return 0;
    const value = (row) => sortKey === "contact" ? contactsById[row.contactId]?.name || `#${row.contactId}` : sortKey === "totalAmount" ? Number(row.totalAmount || 0) : row[sortKey] || "";
    const left = value(a); const right = value(b);
    const result = typeof left === "number" ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
    return sortDirection === "desc" ? -result : result;
  });

  const resetFilters = () => {
    setSubBrand(activeSubBrand || ""); setStatus(""); setCustomerNameFilter(""); setPage(1); setSortKey(null); setSortDirection("asc");
    const next = new URLSearchParams(searchParams);
    ["subBrand", "status", "customer", "sortKey", "sortDirection"].forEach((key) => next.delete(key));
    setSearchParams(next, { replace: true });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // #996 — synchronous re-entry guard. `saving` state takes a render
    // cycle; a fast double-submit can both pass through before the disabled
    // button takes effect. The ref blocks the second call immediately.
    if (inFlightSubmit.current) return;
    inFlightSubmit.current = true;
    const contactIdInt = parseInt(form.contactId, 10);
    if (!Number.isFinite(contactIdInt)) {
      notify.error("Please select a customer");
      inFlightSubmit.current = false;
      return;
    }
    const totalAmountNum = parseFloat(form.totalAmount);
    if (!Number.isFinite(totalAmountNum)) {
      notify.error("Total amount is required (must be a number)");
      inFlightSubmit.current = false;
      return;
    }
    if (!form.currency) {
      notify.error("Currency is required");
      inFlightSubmit.current = false;
      return;
    }
    if (!form.dueDate) {
      notify.error("Due date is required");
      inFlightSubmit.current = false;
      return;
    }
    setSaving(true);
    try {
      // quoteId is optional FK — omit entirely if blank (backend would
      // accept null too but staying consistent with QuotesAdmin's omit-
      // when-blank convention keeps the request body minimal).
      const payload = {
        contactId: contactIdInt,
        totalAmount: totalAmountNum,
        currency: form.currency,
        status: form.status || "Draft",
        subBrand: form.subBrand || "tmc",
        dueDate: form.dueDate,
      };
      if (form.tripId && form.tripId.trim()) {
        const tid = parseInt(form.tripId.trim(), 10);
        if (Number.isFinite(tid)) payload.tripId = tid;
      } else if (editingId) {
        // Explicitly clear a previously linked trip when editing.
        payload.tripId = null;
      }
      if (form.quoteId && form.quoteId.trim()) {
        const qid = parseInt(form.quoteId.trim(), 10);
        if (Number.isFinite(qid)) payload.quoteId = qid;
      }
      if (editingId) {
        await fetchApi(`/api/travel/invoices/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Invoice #${editingId} updated`);
      } else {
        // #996 — silent first attempt so a 409 DUPLICATE_DRAFT_INVOICE
        // surfaces as our own info toast (instead of a generic auto-toast
        // error). On 409 we HARD-BLOCK — no auto-retry, no force-true
        // bypass. Operator either uses the existing draft or changes a
        // field. This eliminates the "click → confirm-prompt → duplicate
        // anyway" loop and keeps the dedup guard meaningful.
        try {
          await fetchApi("/api/travel/invoices", {
            method: "POST",
            body: JSON.stringify(payload),
            silent: true,
          });
        } catch (err) {
          if (err?.status === 409 && err?.code === "DUPLICATE_DRAFT_INVOICE") {
            const existing = err?.data?.existing;
            notify.info(
              `An identical Draft invoice (${existing?.invoiceNum || "TINV-???"}) already exists for this contact. Use that one, or change a field (amount / due date / sub-brand) to create a distinct invoice.`,
              { ttl: 8000 },
            );
            // Leave the form open with current values so the operator can
            // tweak a field and try again. Do NOT close + reset.
            return;
          }
          // Any other status: surface as an error toast.
          notify.error(err?.data?.error || err?.message || "Save failed");
          return;
        }
        notify.success(`Invoice for contact ${contactIdInt} created`);
      }
      setShowForm(false);
      resetForm();
      setReloadTick((t) => t + 1);
    } catch (err) {
      notify.error(err?.data?.error || err?.message || "Save failed");
    } finally {
      setSaving(false);
      inFlightSubmit.current = false;
    }
  };

  const handleDelete = async (inv) => {
    if (inv.status !== "Draft") {
      // Belt-and-braces: the button itself is disabled, but a
      // keyboard-focused click could still reach here.
      notify.error(`Only Draft invoices may be deleted (current: ${inv.status})`);
      return;
    }
    const ok = await notify.confirm({
      title: `Delete invoice ${inv.invoiceNum}?`,
      message: `Hard delete — no undo. Contact #${inv.contactId}.`,
      confirmText: "Delete",
      cancelText: "Keep",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/invoices/${inv.id}`, { method: "DELETE" });
      notify.success(`Invoice ${inv.invoiceNum} deleted`);
      setReloadTick((t) => t + 1);
    } catch (err) {
      notify.error(err?.data?.error || err?.message || "Delete failed");
    }
  };

  // S56 — open the void-confirmation modal. Fires the cancel-preview
  // fetch immediately so the operator sees the refund tier before
  // confirming. Preview fetch failures degrade gracefully (panel
  // surfaces "Could not load refund preview…" but Confirm stays
  // available).
  const openVoid = (inv) => {
    if (!inv?.id) return;
    setVoidingInv({
      id: inv.id,
      invoiceNum: inv.invoiceNum || `#${inv.id}`,
      currency: inv.currency || "INR",
    });
    setVoidPreview(null);
    setVoidPreviewError(false);
    setVoidReason("");
    setVoidPreviewLoading(true);
    fetchApi(`/api/travel/invoices/${inv.id}/cancel-preview`)
      .then((preview) => {
        setVoidPreview(preview || null);
        setVoidPreviewError(false);
      })
      .catch(() => {
        // Network failure / 404 / 409 — soft error in the modal,
        // operator can still proceed.
        setVoidPreview(null);
        setVoidPreviewError(true);
      })
      .finally(() => setVoidPreviewLoading(false));
  };

  const closeVoid = () => {
    setVoidingInv(null);
    setVoidPreview(null);
    setVoidPreviewError(false);
    setVoidPreviewLoading(false);
    setVoidReason("");
    setVoiding(false);
  };

  // S56 — confirm the void. POSTs the reason to /:id/void (the dedicated
  // audit-logged void endpoint — separate from the PUT /:id status
  // transition which doesn't capture a reason). On success the response
  // envelope (additive) may carry `creditNote` + `policyApplied` from
  // S33's auto-CR-NOTE issuance — we surface a contextual success toast.
  const confirmVoid = async () => {
    if (!voidingInv?.id) return;
    const reason = (voidReason || "").trim();
    if (reason.length < 5 || reason.length > 500) {
      notify.error("Void reason must be 5..500 characters");
      return;
    }
    setVoiding(true);
    try {
      const resp = await fetchApi(
        `/api/travel/invoices/${voidingInv.id}/void`,
        {
          method: "POST",
          body: JSON.stringify({ reason }),
        },
      );
      // S33-aware success copy: surface auto-issued credit note if any.
      if (resp?.creditNote && resp?.policyApplied) {
        notify.success(
          `Invoice ${voidingInv.invoiceNum} voided + credit note auto-issued (${resp.policyApplied.policyName})`,
        );
      } else {
        notify.success(`Invoice ${voidingInv.invoiceNum} voided`);
      }
      closeVoid();
      setReloadTick((t) => t + 1);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to void invoice");
      setVoiding(false);
    }
  };

  // GET /api/travel/invoices/:id/pdf returns a PDF Buffer with
  // Content-Type=application/pdf + Content-Disposition=attachment;
  // filename="invoice-<id>.pdf" (shipped commit e1f994b0). We can't go
  // through fetchApi() here because that helper JSON-parses every 2xx
  // body — for a binary PDF we need raw fetch + Authorization header +
  // .blob(). Mirrors the Estimates.jsx / Invoices.jsx per-row pattern
  // (commit `#603` family) which has shipped tests pinning the same
  // shape. Errors flow into notify.error('Failed to download PDF').
  const downloadPdf = async (inv) => {
    if (!inv?.id) {
      notify.error("Save the invoice first before downloading PDF");
      return;
    }
    setDownloadingId(inv.id);
    try {
      const token = getAuthToken();
      // Relative path → same-origin via Vite's /api proxy. A VITE_API_URL
      // prefix would make this cross-origin (CORS preflight 401 + mixed-content
      // over HTTPS). See Invoices.jsx downloadPdf for the canonical note.
      const resp = await fetch(`/api/travel/invoices/${inv.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) {
        notify.error("Failed to download PDF");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${inv.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify.error(err?.message || "Failed to download PDF");
    } finally {
      setDownloadingId(null);
    }
  };

  // Generate a hosted "click & pay" link for the invoice's outstanding balance
  // (BYOK Razorpay/Stripe). The link reconciles back to THIS travel invoice +
  // its milestones on payment. On success we copy the URL to the clipboard so
  // the operator can paste it to the customer.
  const generatePayLink = async (inv) => {
    if (!inv?.id) return;
    setLinkingId(inv.id);
    try {
      const res = await fetchApi(`/api/travel/invoices/${inv.id}/payment-link`, { method: "POST" });
      if (res?.url) {
        try {
          await navigator.clipboard.writeText(res.url);
          notify.success("Payment link generated and copied to clipboard.");
        } catch {
          notify.success(`Payment link generated: ${res.url}`);
        }
      } else {
        notify.error(res?.error || "Could not generate a payment link.");
      }
    } catch (err) {
      if (err?.status === 400 && /already.*paid/i.test(err?.message || "")) {
        notify.info("This invoice is already fully paid.");
      } else if (err?.data?.code === "NO_GATEWAY" || /gateway/i.test(err?.message || "")) {
        notify.error("No payment gateway configured — add your Razorpay keys in Settings → Payment.");
      } else {
        notify.error(err?.message || "Could not generate a payment link.");
      }
    } finally {
      setLinkingId(null);
    }
  };

  // Transaction history — open a modal showing the invoice's milestones
  // (expected vs received, status, paid date) + the underlying payments, so the
  // operator can see when/how much was paid (esp. for Partial invoices).
  const openHistory = async (inv) => {
    if (!inv?.id) return;
    setHistoryInv(inv);
    setHistoryData(null);
    setHistoryLoading(true);
    try {
      const data = await fetchApi(`/api/travel/invoices/${inv.id}/transactions`);
      setHistoryData(data || null);
    } catch (err) {
      notify.error(err?.message || "Failed to load transaction history.");
    } finally {
      setHistoryLoading(false);
    }
  };
  const closeHistory = () => {
    setHistoryInv(null);
    setHistoryData(null);
    setHistoryLoading(false);
  };

  const openManualPayment = async (inv) => {
    if (!inv?.id) return;
    setManualPaymentInv(inv);
    setManualPaymentData(null);
    setManualPaymentLoading(true);
    setManualPaymentForm({
      milestoneId: "",
      amount: "",
      method: "cash",
      reference: "",
      paidAt: new Date().toISOString().slice(0, 10),
    });
    try {
      const data = await fetchApi(`/api/travel/invoices/${inv.id}/transactions`);
      const milestones = Array.isArray(data?.milestones) ? data.milestones : [];
      const openMilestone = milestones.find(
        (milestone) => !["paid", "waived"].includes(String(milestone.status).toLowerCase()),
      );
      setManualPaymentData(data || null);
      if (openMilestone) {
        setManualPaymentForm((current) => ({
          ...current,
          milestoneId: String(openMilestone.id),
          amount: String(openMilestone.expectedAmount || ""),
        }));
      }
    } catch (err) {
      notify.error(err?.message || "Failed to load payment milestones.");
      setManualPaymentInv(null);
    } finally {
      setManualPaymentLoading(false);
    }
  };

  const closeManualPayment = () => {
    setManualPaymentInv(null);
    setManualPaymentData(null);
  };

  const submitManualPayment = async (event) => {
    event.preventDefault();
    if (!manualPaymentInv) return;
    const milestoneId = Number(manualPaymentForm.milestoneId);
    const amount = Number(manualPaymentForm.amount);
    const hasMilestone = Number.isInteger(milestoneId) && milestoneId > 0;
    const outstandingAmount = Number(manualPaymentData?.summary?.outstanding);
    if (manualPaymentData?.milestones?.length > 0 && !hasMilestone) {
      notify.error("Select an unpaid payment milestone.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      notify.error("Enter a payment amount greater than zero.");
      return;
    }
    if (Number.isFinite(outstandingAmount) && amount > outstandingAmount) {
      notify.error(`Payment cannot exceed the outstanding amount of ${outstandingAmount.toFixed(2)}.`);
      return;
    }
    if (!manualPaymentForm.method.trim()) {
      notify.error("Select a payment method.");
      return;
    }
    setManualPaymentSaving(true);
    try {
      const paymentPath = hasMilestone
        ? `/api/travel/invoices/${manualPaymentInv.id}/schedule/${milestoneId}/mark-paid`
        : `/api/travel/invoices/${manualPaymentInv.id}/manual-payment`;
      await fetchApi(paymentPath, {
        method: "POST",
        body: JSON.stringify({
          amount,
          method: manualPaymentForm.method.trim(),
          reference: manualPaymentForm.reference.trim() || undefined,
          paidAt: manualPaymentForm.paidAt || undefined,
        }),
      });
      notify.success("Manual payment recorded successfully.");
      closeManualPayment();
      setReloadTick((tick) => tick + 1);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to record payment.");
    } finally {
      setManualPaymentSaving(false);
    }
  };

  // Accounting exports (ADMIN/MANAGER) — Tally XML / CA CSV / plain XLSX.
  // The XLSX is the "hand to your CA / import into Excel Software for Travel"
  // file (PRD §4.4 Excel Software bridge — built internally, no vendor API).
  // Same raw-fetch + Bearer + blob pattern as downloadPdf (fetchApi would
  // JSON-parse the binary body). Respects the current sub-brand filter; the
  // server defaults the date window to the current fiscal year.
  const EXPORT_FORMATS = {
    xlsx: { path: "accounting.xlsx", ext: "xlsx", label: "accounting workbook" },
    csv: { path: "ca.csv", ext: "csv", label: "CA CSV" },
    tally: { path: "tally.xml", ext: "xml", label: "Tally XML" },
  };
  const [exporting, setExporting] = useState(null); // format key while in-flight
  const [reconFile, setReconFile] = useState(null);
  const [reconResult, setReconResult] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const reconInputRef = useRef(null);

  const downloadExport = async (formatKey) => {
    const fmt = EXPORT_FORMATS[formatKey];
    if (!fmt) return;
    setExporting(formatKey);
    try {
      const token = getAuthToken();
      const qs = subBrand && subBrand !== "all" ? `?subBrand=${encodeURIComponent(subBrand)}` : "";
      const resp = await fetch(`/api/travel/invoices/export/${fmt.path}${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) {
        notify.error(`Failed to export ${fmt.label}`);
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `travel-accounting-${subBrand || "all"}.${fmt.ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify.error(err?.message || `Failed to export ${fmt.label}`);
    } finally {
      setExporting(null);
    }
  };

  const runReconciliation = async () => {
    if (!reconFile) {
      notify.error("Choose a CSV or XLSX file first");
      return;
    }
    setReconciling(true);
    try {
      const token = getAuthToken();
      const fd = new FormData();
      fd.append("file", reconFile);
      const qs = subBrand && subBrand !== "all" ? `?subBrand=${encodeURIComponent(subBrand)}` : "";
      const resp = await fetch(`/api/travel/invoices/reconcile/excel-software${qs}`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        throw Object.assign(new Error(data?.error || "Failed to reconcile workbook"), { body: data, status: resp.status });
      }
      setReconResult(data || null);
      setReconFile(null);
      if (reconInputRef.current) reconInputRef.current.value = "";
      notify.success(`Matched ${data?.matchedRows || 0} invoices`);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to reconcile workbook");
    } finally {
      setReconciling(false);
    }
  };

  return (
    <div style={{ padding: 24, width: "100%", maxWidth: 1440, margin: "0 auto", boxSizing: "border-box", animation: "fadeIn 0.4s ease-out" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: "1.75rem", fontWeight: 600 }}>
            <Receipt size={26} aria-hidden /> Travel Invoices
            <CountBadge count={total} title={`${total.toLocaleString()} invoices`} />
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
            Customer invoices — Draft / Issued / Partial / Paid / Voided.
          </p>
        </div>
        {canWrite && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => downloadExport("xlsx")}
              disabled={exporting !== null}
              style={{ ...secondaryBtn, opacity: exporting ? 0.6 : 1, cursor: exporting ? "wait" : "pointer" }}
              title="Download an Excel workbook of invoices (for your CA / Excel Software for Travel)"
            >
              <Upload size={14} /> {exporting === "xlsx" ? "Exporting…" : "Excel"}
            </button>
            <button
              type="button"
              onClick={() => downloadExport("csv")}
              disabled={exporting !== null}
              style={{ ...secondaryBtn, opacity: exporting ? 0.6 : 1, cursor: exporting ? "wait" : "pointer" }}
              title="Download CA CSV (per-line, GST-split)"
            >
              <Upload size={14} /> {exporting === "csv" ? "Exporting…" : "CSV"}
            </button>
            <button
              type="button"
              onClick={() => downloadExport("tally")}
              disabled={exporting !== null}
              style={{ ...secondaryBtn, opacity: exporting ? 0.6 : 1, cursor: exporting ? "wait" : "pointer" }}
              title="Download Tally-importable XML vouchers"
            >
              <Upload size={14} /> {exporting === "tally" ? "Exporting…" : "Tally"}
            </button>
            <button type="button" onClick={openCreate} style={primaryBtnBranded}>
              <Plus size={14} /> New Invoice
            </button>
          </div>
        )}
      </header>

      {canWrite && (
        <div className="glass" data-testid="excel-reconciliation-panel" style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Excel Software reconciliation</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Upload a CSV or XLSX workbook and compare status, sub-brand, customer, and totals against CRM.
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <input
                ref={reconInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => setReconFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
                style={{ maxWidth: 260 }}
                aria-label="Excel Software reconciliation file"
              />
              <button
                type="button"
                onClick={runReconciliation}
                disabled={reconciling}
                style={{ ...secondaryBtn, opacity: reconciling ? 0.7 : 1, cursor: reconciling ? "wait" : "pointer" }}
              >
                <History size={14} /> {reconciling ? "Reconciling..." : "Run reconciliation"}
              </button>
            </div>
          </div>
          {reconResult && (
            <div style={{ marginTop: 10, display: "grid", gap: 6 }} data-testid="excel-reconciliation-result">
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Checked {reconResult.totalRows || 0} rows against {reconResult.scannedInvoices || 0} invoices. Matched {reconResult.matchedRows || 0}, mismatched {reconResult.mismatchedRows || 0}, missing {reconResult.missingRows || 0}.
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Workbook total {reconResult.workbookAmount ?? 0} vs CRM total {reconResult.matchedAmount ?? 0}.
              </div>
              {Array.isArray(reconResult.discrepancies) && reconResult.discrepancies.length > 0 && (
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>First discrepancy</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {reconResult.discrepancies[0].invoiceNum || "Unknown invoice"} - {reconResult.discrepancies[0].issue || "Mismatch"}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <select value={subBrand} onChange={(e) => { const value = e.target.value; setSubBrand(value); setPage(1); const next = new URLSearchParams(searchParams); if (value) next.set("subBrand", value); else next.delete("subBrand"); setSearchParams(next, { replace: true }); }} style={selectStyle} aria-label="Filter by sub-brand">
          {SUB_BRANDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); updateListParam("status", e.target.value); }} style={selectStyle} aria-label="Filter by status">
          {INVOICE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <input
          type="text"
          placeholder="Filter by customer name…"
          value={customerNameFilter}
          onChange={(e) => { setCustomerNameFilter(e.target.value); setPage(1); updateListParam("customer", e.target.value); }}
          style={{ ...selectStyle, minWidth: 220 }}
          aria-label="Filter by customer name"
        />
        <button type="button" onClick={() => setReloadTick((tick) => tick + 1)} style={secondaryBtn}>Refresh</button>
        <button type="button" onClick={resetFilters} style={secondaryBtn}>Reset filters</button>
      </div>

      {showForm && editingTds && editingTds.totalTds > 0 && (
        // Slice 22 — TDS withholding tiles. Rendered ONLY when the edit
        // modal is open against an Issued/Paid invoice that actually has
        // TDS lines (totalTds > 0). Hidden for Draft / Voided / Partial
        // and for invoices with zero TDS so operators don't see "TDS: 0"
        // noise on routine non-withholding invoices. PRD §3.
        <div
          className="glass"
          data-testid="tds-tiles"
          style={{
            padding: 12,
            marginBottom: 12,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
            gap: 10,
          }}
        >
          <div style={tdsTile}>
            <div style={tdsTileLabel}>Total TDS Withheld</div>
            <div style={tdsTileValue}>
              {formatMoney(editingTds.totalTds, { currency: editingTds.currency })}
            </div>
          </div>
          <div style={tdsTile}>
            <div style={tdsTileLabel}>Net Payable (After TDS)</div>
            <div style={tdsTileValue}>
              {formatMoney(
                Number.isFinite(editingTds.totalAmount)
                  ? editingTds.totalAmount - editingTds.totalTds
                  : 0,
                { currency: editingTds.currency },
              )}
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="glass"
          style={{
            padding: 16,
            marginBottom: 16,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            gap: 10,
            alignItems: "end",
          }}
        >
          <select
            required
            value={form.contactId}
            onChange={(e) => setForm({ ...form, contactId: e.target.value })}
            style={inputStyle}
            aria-label="Customer"
          >
            <option value="">Select customer *</option>
            {/* Editing an invoice whose contact isn't in the loaded page (or
                a >500-row tenant) keeps the existing selection visible. */}
            {form.contactId &&
              !customers.some((c) => String(c.id) === String(form.contactId)) && (
                <option value={form.contactId}>
                  {contactsById[form.contactId]?.name || `Contact #${form.contactId}`}
                </option>
              )}
            {customers.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {(c.name || `Contact #${c.id}`) + (c.email ? ` — ${c.email}` : "")}
              </option>
            ))}
          </select>
          <select
            value={form.tripId}
            onChange={(e) => setForm({ ...form, tripId: e.target.value })}
            style={inputStyle}
            aria-label="Trip"
          >
            <option value="">No trip linked</option>
            {form.tripId && !tripsById[Number(form.tripId)] && (
              <option value={form.tripId}>Trip #{form.tripId}</option>
            )}
            {trips.map((trip) => (
              <option key={trip.id} value={String(trip.id)}>
                {trip.tripCode || `Trip #${trip.id}`} · {trip.destination || "Destination not set"}
              </option>
            ))}
          </select>
          <input
            placeholder="Total amount *"
            required
            type="number"
            step="0.01"
            value={form.totalAmount}
            onChange={(e) => setForm({ ...form, totalAmount: e.target.value })}
            style={inputStyle}
            aria-label="Total amount"
          />
          <input
            placeholder="Currency *"
            required
            type="text"
            maxLength={3}
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
            style={inputStyle}
            aria-label="Currency"
          />
          <input
            type="date"
            required
            min={editingId ? undefined : tomorrowISO()}
            value={form.dueDate}
            onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            {...pickerOnlyProps}
            style={{ ...inputStyle, cursor: "pointer" }}
            aria-label="Due date"
            title="Due date"
          />
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            style={inputStyle}
            aria-label="Status"
          >
            {statusOptionsForModal().map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <input
            placeholder="Quote ID (optional)"
            type="number"
            value={form.quoteId}
            onChange={(e) => setForm({ ...form, quoteId: e.target.value })}
            style={inputStyle}
            aria-label="Quote ID"
          />
          {lockedBrand ? (
            // Single-brand user: auto-selected, not editable. The value is
            // already pinned in form.subBrand via defaultSubBrandFor (create)
            // or the record's own subBrand (edit).
            <input
              type="text"
              value={subBrandShortLabel(lockedBrand)}
              readOnly
              disabled
              aria-label="Sub-brand (locked to your assigned brand)"
              style={{ ...inputStyle, opacity: 0.7, cursor: "not-allowed" }}
            />
          ) : (
            <select
              value={form.subBrand}
              onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
              style={inputStyle}
              aria-label="Sub-brand"
            >
              {myBrands.map((b) => (
                <option key={b} value={b}>{subBrandShortLabel(b)}</option>
              ))}
            </select>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={saving} style={{ ...primaryBtn, background: "var(--success-color, var(--primary-color))" }}>
              {saving ? "Saving…" : editingId ? "Save Changes" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); resetForm(); }}
              style={secondaryBtn}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div
        className="glass"
        style={tableFrame}
      >
        {loading && invoices.length === 0 ? (
          <div style={empty}>Loading&hellip;</div>
        ) : (
          <table style={{ width: "100%", minWidth: 1500, borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "12%" }} />
              <col style={{ width: "21%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "15%" }} />
              {canWrite && <col style={{ width: "20%" }} />}
            </colgroup>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <th style={th}>{sortHeader("Invoice #", "invoiceNum")}</th>
                <th style={th}>{sortHeader("Contact", "contact")}</th>
                <th style={th}>Trip</th>
                <th style={th}>{sortHeader("Status", "status")}</th>
                <th style={th}>{sortHeader("Total", "totalAmount")}</th>
                <th style={th}>{sortHeader("Currency", "currency")}</th>
                <th style={th}>{sortHeader("Due Date", "dueDate")}</th>
                <th style={th}>{sortHeader("Sub-brand", "subBrand")}</th>
                <th style={th}>{sortHeader("Paid At", "paidAt")}</th>
                {canWrite && <th style={th}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visibleInvoices.map((inv) => {
                const isVoided = inv.status === "Voided";
                const canDelete = inv.status === "Draft";
                return (
                  <tr
                    key={inv.id}
                    style={{
                      borderTop: "1px solid rgba(255,255,255,0.04)",
                      // Strike-through the entire row for voided invoices to
                      // make the terminal state unmistakable at a glance.
                      textDecoration: isVoided ? "line-through" : "none",
                      opacity: isVoided ? 0.7 : 1,
                    }}
                  >
                    <td style={{ ...td, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, whiteSpace: "nowrap" }}>
                      {inv.invoiceNum || "—"}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {(() => {
                        const c = contactsById[inv.contactId];
                        const name = c?.name;
                        const tooltip = `Contact #${inv.contactId}${c?.email ? ` · ${c.email}` : ""}`;
                        return (
                          <Link
                            to={`/contacts/${inv.contactId}`}
                            title={tooltip}
                            style={{ color: "var(--text-primary)", textDecoration: "none", fontWeight: 500 }}
                          >
                            {name || `#${inv.contactId}`}
                          </Link>
                        );
                      })()}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {inv.tripId ? (
                        <Link
                          to={`/travel/trips/${inv.tripId}`}
                          title={tripsById[inv.tripId]?.destination || `Trip #${inv.tripId}`}
                          style={{ color: "var(--text-primary)", textDecoration: "none", fontWeight: 500 }}
                        >
                          {tripsById[inv.tripId]?.tripCode || `Trip #${inv.tripId}`}
                        </Link>
                      ) : "—"}
                    </td>
                    <td style={td}>
                      <span
                        style={{
                          ...statusBadge,
                          background: STATUS_BG[inv.status] || "rgba(255,255,255,0.08)",
                          color: STATUS_COLOR[inv.status] || "var(--text-primary)",
                        }}
                      >
                        {inv.status || "—"}
                      </span>
                    </td>
                    <td style={td}>{formatMoney(inv.totalAmount, { currency: inv.currency || "INR" })}</td>
                    <td style={td}>{inv.currency || "—"}</td>
                    <td style={td}>{formatDate(inv.dueDate)}</td>
                    <td style={td}>
                      <span style={{ ...brandBadge, background: SUB_BRAND_BG[inv.subBrand] || "rgba(255,255,255,0.08)" }}>
                        {inv.subBrand || "—"}
                      </span>
                    </td>
                    <td style={td}>{formatDate(inv.paidAt)}</td>
                    {canWrite && (
                      <td style={td}>
                        <button
                          type="button"
                          onClick={() => openEdit(inv)}
                          title={`Edit invoice ${inv.invoiceNum}`}
                          aria-label={`Edit invoice ${inv.invoiceNum}`}
                          style={iconBtn}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadPdf(inv)}
                          // Defensive: NEW rows in-flight wouldn't have an id
                          // yet (won't appear in this list, but guarded anyway)
                          // + disable while the in-flight download is active so
                          // a double-click doesn't trigger two browser saves.
                          disabled={!inv?.id || downloadingId === inv.id}
                          title={
                            downloadingId === inv.id
                              ? "Downloading…"
                              : `Download PDF for invoice ${inv.invoiceNum}`
                          }
                          aria-label={`Download PDF for invoice ${inv.invoiceNum}`}
                          style={{
                            ...iconBtn,
                            opacity: downloadingId === inv.id ? 0.5 : 1,
                            cursor: downloadingId === inv.id ? "wait" : "pointer",
                          }}
                        >
                          {downloadingId === inv.id ? (
                            <span style={{ fontSize: 11, fontWeight: 600 }}>Downloading…</span>
                          ) : (
                            <FileDown size={16} />
                          )}
                        </button>
                        {/* Transaction history — when/how much has been paid.
                            Useful for any issued/partial/paid invoice. */}
                        {inv.status !== "Draft" && (
                          <button
                            type="button"
                            onClick={() => openHistory(inv)}
                            title={`Payment history for invoice ${inv.invoiceNum}`}
                            aria-label={`Payment history for invoice ${inv.invoiceNum}`}
                            style={iconBtn}
                          >
                            <History size={16} />
                          </button>
                        )}
                        {/* Manual collections are recorded against an open
                            payment milestone so the invoice and audit trail
                            reconcile with the resulting Payment row. */}
                        {!inv.tripId && (inv.status === "Issued" || inv.status === "Partial") && (
                          <button
                            type="button"
                            onClick={() => openManualPayment(inv)}
                            title={`Record manual payment for invoice ${inv.invoiceNum}`}
                            aria-label={`Record manual payment for invoice ${inv.invoiceNum}`}
                            style={{ ...iconBtn, color: "var(--success-color, #22c55e)" }}
                          >
                            <HandCoins size={16} />
                          </button>
                        )}
                        {/* Generate a hosted pay-link for the outstanding
                            balance — only meaningful once issued + not yet
                            fully paid / voided. Reconciles back to this invoice. */}
                        {!inv.tripId && (inv.status === "Issued" || inv.status === "Partial") && (
                          <button
                            type="button"
                            onClick={() => generatePayLink(inv)}
                            disabled={linkingId === inv.id}
                            title={`Generate payment link for invoice ${inv.invoiceNum}`}
                            aria-label={`Generate payment link for invoice ${inv.invoiceNum}`}
                            style={{
                              ...iconBtn,
                              color: "var(--info-color, #2563eb)",
                              opacity: linkingId === inv.id ? 0.5 : 1,
                              cursor: linkingId === inv.id ? "wait" : "pointer",
                            }}
                          >
                            {linkingId === inv.id ? (
                              <span style={{ fontSize: 11, fontWeight: 600 }}>Linking…</span>
                            ) : (
                              <Link2 size={16} />
                            )}
                          </button>
                        )}
                        {/* S56 — dedicated Void button (POST /:id/void with
                            audit-logged reason + cancel-preview surface).
                            Hidden once an invoice is Voided (terminal state).
                            Draft invoices skip the policy resolver (nothing
                            was billed), but the operator may still want a
                            reasoned void rather than the silent PUT-status
                            transition, so we surface the button for Draft too. */}
                        {inv.status !== "Voided" && (
                          <button
                            type="button"
                            onClick={() => openVoid(inv)}
                            title={`Void invoice ${inv.invoiceNum}`}
                            aria-label={`Void invoice ${inv.invoiceNum}`}
                            style={{ ...iconBtn, color: "var(--warning-color, #f59e0b)" }}
                          >
                            <Ban size={16} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(inv)}
                          disabled={!canDelete}
                          // Tooltip explains the audit-trail reason — Voided
                          // rows MUST stay so the historical chain is intact.
                          title={
                            canDelete
                              ? `Delete invoice ${inv.invoiceNum}`
                              : "Only Draft invoices may be deleted (Voided required for issued/paid — audit trail)"
                          }
                          aria-label={
                            canDelete
                              ? `Delete invoice ${inv.invoiceNum}`
                              : `Delete disabled for ${inv.status} invoice`
                          }
                          style={{
                            ...iconBtn,
                            color: canDelete ? "var(--danger-color, #f43f5e)" : "var(--text-secondary)",
                            opacity: canDelete ? 1 : 0.4,
                            cursor: canDelete ? "pointer" : "not-allowed",
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {visibleInvoices.length === 0 && (
                <tr>
                    <td
                    colSpan={canWrite ? 10 : 9}
                    style={{
                      ...td,
                      textAlign: "center",
                      color: permissionDenied ? "var(--warning-color, #f59e0b)" : "var(--text-secondary)",
                      padding: permissionDenied ? "1rem 1rem" : "0.75rem 1rem",
                    }}
                  >
                    {/* #829 — honest empty-state when API returned 403. */}
                    {permissionDenied ? (
                      <>
                        <strong>Access restricted.</strong>
                        <div style={{ fontSize: "0.85rem", marginTop: "0.5rem", color: "var(--text-secondary)" }}>
                          Your role does not have permission to view travel invoices. Ask an Admin to grant access if you need it.
                        </div>
                      </>
                    ) : (
                      <>
                        <Receipt size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
                        <div style={{ whiteSpace: "nowrap" }}>No invoices match.</div>
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <PatientPager
          total={total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(nextSize) => {
            setPageSize(nextSize);
            setPage(1);
          }}
          isCustomPageSize={isCustomPageSize}
          setIsCustomPageSize={setIsCustomPageSize}
          customPageSize={customPageSize}
          setCustomPageSize={setCustomPageSize}
          label="invoices"
        />
      </div>

      {/* S56 — Void-confirmation modal.
          Renders the cancel-preview panel BEFORE the operator commits
          POST /:id/void so they see the refund tier the policy resolver
          will apply (and the credit-note that S33's auto-issuance will
          create). Preview-fetch failures degrade to a soft error line;
          Confirm stays available so a missed preview doesn't block
          operator action. */}
      {voidingInv && (
        <div
          data-testid="void-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Void invoice ${voidingInv.invoiceNum}`}
          style={modalOverlay}
          onClick={(e) => {
            if (e.target === e.currentTarget && !voiding) closeVoid();
          }}
        >
          <div className="glass" style={modalCard} data-testid="void-modal">
            <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 600 }}>
              Void invoice {voidingInv.invoiceNum}?
            </h2>
            <p
              style={{
                margin: "8px 0 12px",
                color: "var(--text-secondary)",
                fontSize: "0.9rem",
              }}
            >
              This marks the invoice as Voided. The cancellation policy below
              determines whether a credit note is auto-issued.
            </p>

            {/* Cancel-preview panel — shows ONE of:
                  - Loading (preview fetch in flight)
                  - reason='OK' refund line
                  - reason='NO_POLICY_RESOLVED' warning line
                  - fetch-failure soft error line. */}
            <div data-testid="void-preview-panel" style={previewPanel}>
              {voidPreviewLoading ? (
                <div style={previewLoading}>Loading refund preview&hellip;</div>
              ) : voidPreviewError ? (
                <div style={previewError}>
                  Could not load refund preview &mdash; review the policy before confirming.
                </div>
              ) : voidPreview && voidPreview.reason === "OK" && voidPreview.policyApplied ? (
                <div style={previewOk}>
                  Refund: ₹{Number(voidPreview.refundAmount || 0).toLocaleString("en-IN")} per{" "}
                  {voidPreview.policyApplied.policyName} (
                  {voidPreview.refundPercent}% &mdash;{" "}
                  {voidPreview.daysBeforeServiceStart}d before service)
                </div>
              ) : voidPreview && voidPreview.reason === "NO_POLICY_RESOLVED" ? (
                <div style={previewWarn}>
                  No matching cancellation policy. Voiding will NOT auto-issue a credit note.
                </div>
              ) : (
                // Defensive fallback — preview shape unrecognised (e.g.
                // missing reason field). Treat as no-policy.
                <div style={previewWarn}>
                  No matching cancellation policy. Voiding will NOT auto-issue a credit note.
                </div>
              )}
            </div>

            <label
              htmlFor="void-reason-input"
              style={{
                display: "block",
                marginTop: 12,
                marginBottom: 4,
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              Void reason (required, 5..500 chars)
            </label>
            <textarea
              id="void-reason-input"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              aria-label="Void reason"
              placeholder="e.g. Customer cancelled trip — full refund issued via card."
              rows={3}
              style={textareaStyle}
              disabled={voiding}
            />

            <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={closeVoid}
                disabled={voiding}
                style={secondaryBtn}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmVoid}
                disabled={voiding}
                style={{
                  ...primaryBtn,
                  background: "var(--danger-color, #f43f5e)",
                }}
                aria-label={`Confirm void of invoice ${voidingInv.invoiceNum}`}
              >
                {voiding ? "Voiding…" : "Confirm Void"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual customer payment modal. */}
      {manualPaymentInv && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Record manual payment for invoice ${manualPaymentInv.invoiceNum}`}
          style={modalOverlay}
          onClick={(e) => { if (e.target === e.currentTarget) closeManualPayment(); }}
        >
          <form onSubmit={submitManualPayment} className="glass" style={{ ...modalCard, maxWidth: 520, width: "92%" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <CreditCard size={18} /> Record manual payment
              </h2>
              <button type="button" onClick={closeManualPayment} aria-label="Close" style={{ ...iconBtn }}>✕</button>
            </div>
            <p style={{ margin: "10px 0 16px", color: "var(--text-secondary)", fontSize: 13 }}>
              Invoice {manualPaymentInv.invoiceNum} - record cash, UPI, bank transfer, or another offline collection.
            </p>

            {manualPaymentLoading ? (
              <div style={empty}>Loading payment milestones...</div>
            ) : (
              <>
                {(() => {
                  const allMilestones = Array.isArray(manualPaymentData?.milestones)
                    ? manualPaymentData.milestones
                    : [];
                  const openMilestones = allMilestones.filter(
                    (milestone) => !["paid", "waived"].includes(String(milestone.status).toLowerCase()),
                  );
                  return allMilestones.length > 0 && openMilestones.length === 0 ? (
                    <div style={{ ...empty, color: "var(--warning-color, #f59e0b)" }}>
                      No unpaid milestones are available for this invoice.
                    </div>
                  ) : (
                    <>
                      {allMilestones.length > 0 && (
                        <label style={fieldLabel}>
                          Payment milestone
                          <select
                            value={manualPaymentForm.milestoneId}
                            onChange={(e) => {
                              const milestone = openMilestones.find((item) => String(item.id) === e.target.value);
                              setManualPaymentForm((current) => ({
                                ...current,
                                milestoneId: e.target.value,
                                amount: String(milestone?.expectedAmount || ""),
                              }));
                            }}
                            style={inputStyle}
                          >
                            <option value="">Select milestone</option>
                            {openMilestones.map((milestone) => (
                              <option key={milestone.id} value={milestone.id}>
                                Milestone {milestone.milestoneOrder ?? milestone.id} - {manualPaymentInv.currency || "INR"} {milestone.expectedAmount}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label style={fieldLabel}>
                        Amount received
                        {Number.isFinite(Number(manualPaymentData?.summary?.outstanding)) && (
                          <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
                            {` (Outstanding: ${manualPaymentInv.currency || "INR"} ${Number(manualPaymentData.summary.outstanding).toFixed(2)})`}
                          </span>
                        )}
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          max={Number.isFinite(Number(manualPaymentData?.summary?.outstanding))
                            ? Number(manualPaymentData.summary.outstanding)
                            : undefined}
                          value={manualPaymentForm.amount}
                          onChange={(e) => setManualPaymentForm((current) => ({ ...current, amount: e.target.value }))}
                          style={inputStyle}
                          placeholder="e.g. 25000"
                        />
                      </label>
                      <label style={fieldLabel}>
                        Payment method
                        <select
                          value={manualPaymentForm.method}
                          onChange={(e) => setManualPaymentForm((current) => ({ ...current, method: e.target.value }))}
                          style={inputStyle}
                        >
                          <option value="cash">Cash</option>
                          <option value="upi">UPI</option>
                          <option value="neft">NEFT / bank transfer</option>
                          <option value="manual">Other manual</option>
                        </select>
                      </label>
                      <label style={fieldLabel}>
                        Reference <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>(optional)</span>
                        <input
                          type="text"
                          maxLength={128}
                          value={manualPaymentForm.reference}
                          onChange={(e) => setManualPaymentForm((current) => ({ ...current, reference: e.target.value }))}
                          style={inputStyle}
                          placeholder="UPI ID, bank reference, or receipt number"
                        />
                      </label>
                      <label style={fieldLabel}>
                        Payment date
                        <input
                          type="date"
                          value={manualPaymentForm.paidAt}
                          onChange={(e) => setManualPaymentForm((current) => ({ ...current, paidAt: e.target.value }))}
                          style={inputStyle}
                        />
                      </label>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
                        <button type="button" onClick={closeManualPayment} style={secondaryBtn}>Cancel</button>
                        <button type="submit" disabled={manualPaymentSaving || (allMilestones.length > 0 && !manualPaymentForm.milestoneId)} style={primaryBtnBranded}>
                          {manualPaymentSaving ? "Recording..." : "Record payment"}
                        </button>
                      </div>
                    </>
                  );
                })()}
              </>
            )}
          </form>
        </div>
      )}

      {/* Transaction-history modal — milestones + payments for one invoice. */}
      {historyInv && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Payment history for invoice ${historyInv.invoiceNum}`}
          style={modalOverlay}
          onClick={(e) => { if (e.target === e.currentTarget) closeHistory(); }}
        >
          <div className="glass" style={{ ...modalCard, maxWidth: 720, width: "92%" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <History size={18} /> Payment history — {historyInv.invoiceNum}
              </h2>
              <button type="button" onClick={closeHistory} aria-label="Close" style={{ ...iconBtn }}>✕</button>
            </div>

            {historyLoading ? (
              <div style={empty}>Loading&hellip;</div>
            ) : !historyData ? (
              <div style={empty}>Could not load history.</div>
            ) : (
              <>
                {/* Summary line */}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "12px 0 4px", fontSize: 14 }}>
                  <span>Total: <strong>₹{Number(historyData.summary?.total || 0).toLocaleString("en-IN")}</strong></span>
                  <span style={{ color: "var(--success-color, #22c55e)" }}>
                    Paid: <strong>₹{Number(historyData.summary?.totalReceived || 0).toLocaleString("en-IN")}</strong>
                  </span>
                  <span style={{ color: "var(--warning-color, #f59e0b)" }}>
                    Outstanding: <strong>₹{Number(historyData.summary?.outstanding || 0).toLocaleString("en-IN")}</strong>
                  </span>
                </div>

                {/* Milestones */}
                <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)", margin: "14px 0 6px" }}>Milestones</h3>
                {(!historyData.milestones || historyData.milestones.length === 0) ? (
                  <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>No milestones on this invoice.</div>
                ) : (
                  <div style={miniTableFrame}>
                  <table style={{ width: "100%", minWidth: 680, borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th style={miniTh}>#</th>
                        <th style={miniTh}>Due</th>
                        <th style={miniThRight}>Expected</th>
                        <th style={miniThRight}>Received</th>
                        <th style={miniTh}>Status</th>
                        <th style={miniTh}>Paid on</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyData.milestones.map((m) => (
                        <tr key={m.id} style={{ borderTop: "1px solid var(--border-color)" }}>
                          <td style={miniTd}>{m.milestoneOrder ?? "—"}</td>
                          <td style={miniTd}>{formatDate(m.dueDate)}</td>
                          <td style={miniTdRight}>₹{Number(m.expectedAmount || 0).toLocaleString("en-IN")}</td>
                          <td style={miniTdRight}>{m.receivedAmount != null ? `₹${Number(m.receivedAmount).toLocaleString("en-IN")}` : "—"}</td>
                          <td style={miniTd}><span style={{ textTransform: "capitalize" }}>{m.status}</span></td>
                          <td style={miniTd}>{m.paidAt ? formatDate(m.paidAt) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}

                {/* Payments / transactions */}
                <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-secondary)", margin: "16px 0 6px" }}>Transactions</h3>
                {(!historyData.payments || historyData.payments.length === 0) ? (
                  <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>No payments recorded yet.</div>
                ) : (
                  <div style={miniTableFrame}>
                  <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        <th style={miniTh}>Date</th>
                        <th style={miniThRight}>Amount</th>
                        <th style={miniTh}>Method</th>
                        <th style={miniTh}>Reference</th>
                        <th style={miniTh}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyData.payments.map((p) => (
                        <tr key={p.id} style={{ borderTop: "1px solid var(--border-color)" }}>
                          <td style={miniTd}>{formatDate(p.paidAt)}</td>
                          <td style={miniTdRight}>₹{Number(p.amount || 0).toLocaleString("en-IN")}</td>
                          <td style={miniTd}><span style={{ textTransform: "capitalize" }}>{p.method || "—"}</span></td>
                          <td style={{ ...miniTd, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{p.reference || "—"}</td>
                          <td style={miniTd}>{p.status || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" onClick={closeHistory} style={secondaryBtn}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const miniTh = {
  textAlign: "left",
  padding: "6px 8px",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-secondary)",
  fontWeight: 600,
  background: "var(--modal-bg, var(--bg-color))",
  boxShadow: "inset 0 -1px 0 var(--border-color)",
  position: "sticky",
  top: 0,
  zIndex: 3,
};
const miniThRight = { ...miniTh, textAlign: "right" };
const miniTd = { padding: "6px 8px", color: "var(--text-primary)" };
const miniTdRight = { ...miniTd, textAlign: "right" };
const miniTableFrame = {
  overflow: "auto",
  maxHeight: 260,
  border: "1px solid var(--border-color)",
  borderRadius: 8,
};

const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--modal-bg, var(--bg-color))",
  boxShadow: "inset 0 -1px 0 var(--border-color)",
  position: "sticky",
  top: 0,
  zIndex: 3,
  fontWeight: 600,
};
const sortButtonStyle = {
  display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 6,
  width: "100%", padding: "4px 8px", border: "none", borderRadius: 999,
  background: "transparent", color: "inherit", font: "inherit", cursor: "pointer", textAlign: "left",
};
const sortButtonActiveStyle = { color: "var(--primary-color)", background: "transparent" };
const td = {
  padding: "10px 12px",
  fontSize: 14,
  color: "var(--text-primary)",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};
const tableFrame = {
  padding: 0,
  overflowX: "auto",
  WebkitOverflowScrolling: "touch",
  overflowY: "visible",
  height: "auto",
  minHeight: 0,
  maxHeight: "none",
};
const empty = { padding: 20, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const fieldLabel = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginBottom: 12,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 600,
};
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
};
const selectStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  minWidth: 160,
  fontSize: 13,
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  cursor: "pointer",
};
const iconBtn = {
  padding: 6,
  borderRadius: 4,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "none",
  cursor: "pointer",
  marginRight: 4,
};
const brandBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-primary)",
};
const statusBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
};
// Slice 22 — TDS tile styling. Primary-color border via the wellness
// brand fallback (matches the rule for primary CTAs in CLAUDE.md so the
// wellness vertical doesn't render salmon accents). Tiles use a tonal
// background that reads OK in both light + dark themes via the
// --surface-color CSS var.
const tdsTile = {
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid var(--primary-color, var(--accent-color))",
  background: "var(--surface-color, rgba(255,255,255,0.04))",
};
const tdsTileLabel = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  marginBottom: 4,
  fontWeight: 600,
};
const tdsTileValue = {
  fontSize: 18,
  fontWeight: 700,
  color: "var(--text-primary)",
};
// S56 — void-confirmation modal styling. Overlay dims the page, modal
// card sits centered. Preview panel + textarea borrow the existing
// inputStyle / tdsTile shape so the visual continuity reads as part of
// the page's design language.
const modalOverlay = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};
const modalCard = {
  width: "min(540px, 100%)",
  padding: 20,
  borderRadius: 10,
  background: "var(--surface-color, #1f2937)",
  border: "1px solid var(--border-color)",
};
const previewPanel = {
  padding: "10px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.04))",
  fontSize: 13,
};
const previewLoading = {
  color: "var(--text-secondary)",
  fontStyle: "italic",
};
const previewOk = {
  color: "var(--success-color, #22c55e)",
  fontWeight: 600,
};
const previewWarn = {
  color: "var(--warning-color, #f59e0b)",
  fontWeight: 600,
};
const previewError = {
  color: "var(--danger-color, #f43f5e)",
  fontWeight: 600,
};
const textareaStyle = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
  resize: "vertical",
  fontFamily: "inherit",
  boxSizing: "border-box",
};
