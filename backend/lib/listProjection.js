// #920 slice S3 — PII list-endpoint summary projections
// (FR-3.5 PII payload reduction — per docs/PRD_TRAVEL_SECURITY_ARCHITECTURE.md
// §3 FR-3.5 + tracker row S3 in docs/TRAVEL_BIG_SCOPE_BACKLOG.md).
//
// Slice S42 — wellness PHI list-endpoint slim projections (Patient + Visit +
// Prescription). Same opt-in shape (`?fields=summary`) extended to the HIPAA-
// regulated wellness clinical surface. The new registry entries live alongside
// the travel-vertical entries; the audit-coordination semantics ride on the
// route adoption (see backend/routes/wellness.js GET /patients|/visits|
// /prescriptions for the per-route wiring).
//
// Why this helper exists
// ----------------------
// List endpoints today return the FULL Prisma row shape, including PII columns
// (`phone`, `email`, `passportNumber`, `aadhaarLast4`, `medicalNotes`,
// `rawPayload`, etc.). An insider with operator credentials can call
// `GET /api/contacts?limit=10000` once and walk away with 10,000 rows of full
// PII. The audit trail records "one GET call." Issue: #920 — list endpoints
// should ship a slim summary (id + display name + a small handful of non-PII
// keys) by default; the full row follows a click-through to the detail
// endpoint (`GET /:id`), which is per-row-auditable and rate-limit-able.
//
// PRD direction (FR-3.5.a) is to make summary the DEFAULT. The cron has
// already shipped 51 hand-rolled `?fields=summary` opt-in slices going the
// other direction (summary on opt-in, full as default) — see commits
// f7790241 (contacts slice 1) through 4c1743ae (deal-insights slice 51).
// This helper consolidates the pattern those slices share into ONE
// reusable lookup so future routes adopt the same shape with a single
// require() instead of cargo-culting the literal `select` object across
// every new route. The opt-in direction is preserved (`?fields=summary`
// triggers slim) to keep the 51 prior slices + their 50+ vitest cases
// shape-compatible; this slice does NOT flip the default (that's a true
// cross-cutting break that needs its own coordinated wave). The
// `?fields=full` opt-out lands here as a no-op (full is already the
// default) so callers that want to be explicit can be — and the helper
// is forward-compatible for the day the default flips.
//
// Contract
// --------
// listProjection(modelName, fullShape)
//   modelName — Prisma model name (case-sensitive — must match a key in
//               PROJECTIONS). Unknown names return `undefined`.
//   fullShape — boolean (or any truthy value). When truthy, returns
//               `undefined` so the caller's `findMany` call defaults to
//               full row shape. When falsy, returns the slim
//               `{ id: true, ...summaryFields }` object suitable for
//               drop-in use as `findManyArgs.select`.
//
// Returns: a Prisma `select` object, OR `undefined`.
//
// Usage in a route
// ----------------
//   const listProjection = require('../lib/listProjection');
//
//   const isSummary = req.query.fields === 'summary';
//   const select = listProjection('TmcTrip', !isSummary);
//   const findManyArgs = { where, orderBy: { departDate: 'asc' }, take, skip };
//   if (select) findManyArgs.select = select;
//   const rows = await prisma.tmcTrip.findMany(findManyArgs);
//
// Why caller-builds-args rather than helper-builds-args
// -----------------------------------------------------
// Each route's findMany call carries its own `where` / `orderBy` / `take` /
// `skip` / `include` shape — couplings the helper doesn't (and shouldn't)
// know about. The helper's job is JUST the projection lookup; the call-site
// composes it into the rest of the args. This keeps the helper a pure
// function (testable without mocking Prisma) and lets each route opt
// individual fields into the slim shape without forking the helper.
//
// Pure-function contract
// ----------------------
// - Identity-stable: same input always returns the same output object
//   (helps callers that cache the projection across requests).
// - Side-effect-free: no I/O, no env-var reads, no clock.
// - Defensive: unknown model names return `undefined` rather than throwing,
//   so a misspelled model name in a route degrades to "full shape" (the
//   pre-helper baseline) rather than 500-ing the request.
// - PRD anchor: every model's summary field set tracks the PRD's FR-3.5.a
//   shape (id + displayName + sub-brand-ish key + createdAt) plus the
//   minimum extra columns the route's existing filter/sort UI needs to
//   keep working without the full row. New models added here MUST justify
//   each included field with a one-line comment.
//
// What this helper DOES NOT do
// ----------------------------
// - It does NOT enforce that callers pass `select`. A route that ignores
//   the helper's output silently ships full PII; the per-route adoption
//   is the load-bearing step.
// - It does NOT filter response bodies post-Prisma. Slim shape is enforced
//   at the Prisma layer (the SQL `SELECT` clause); if a route inserts
//   PII into the response after the findMany call (e.g. via a decoration
//   `.map((row) => ({ ...row, contact }))`), the helper has no visibility
//   into that. Adopting routes must skip the decoration on the slim path.
// - It does NOT replace `middleware/fieldFilter.js` (the role-based
//   field-level permission filter — issue #464). That layer is still
//   applied per-route post-helper; the helper drops fields at the SQL
//   layer regardless of role, the fieldFilter layer drops fields per role.
//   Both layers compose cleanly: an absent field is a no-op for fieldFilter.

/**
 * Per-model slim projection.
 *
 * Each entry maps a Prisma model name to the keys that are SAFE to ship in
 * the slim list-endpoint shape. Keys NOT listed here will be dropped by the
 * Prisma `select` clause. The conventions:
 *
 *   - `id` is always included (every model has it; the picker / count-badge
 *     callers need it to wire row-click → detail navigation).
 *   - A single "display name" column — what the operator sees as the row
 *     headline (name, fullName, invoiceNum, tripCode, etc.).
 *   - sub-brand-ish key where the model has one (`subBrand`, `provider`,
 *     `productTier`, etc.). The PRD calls this out as a SAFE classifier
 *     that doesn't leak PII but lets pickers/dropdowns segment correctly.
 *   - `createdAt` (or the model's analogous timestamp) — for default-sort
 *     stability on the picker UI.
 *   - Plus the minimum extra columns the route's existing filter/sort UI
 *     needs to keep working without a full row (e.g. `status` for status
 *     filters, `departDate` for trip-list sort, `tripId` for participant
 *     pickers).
 *
 * NEVER include in a slim projection: phone, email, address, dob,
 * passportNumber (raw), aadhaar fields, medical notes, raw payload blobs,
 * GST numbers, parent contact PII, payment references. These are the
 * "follow click-through to detail endpoint" set.
 */
const PROJECTIONS = Object.freeze({
  // ── Travel vertical ──────────────────────────────────────────────────
  TmcTrip: Object.freeze({
    id: true,
    tripCode: true,      // display name (tenant-unique slug)
    destination: true,   // location label (non-PII)
    status: true,        // filter on the trip-list UI
    departDate: true,    // sort key
    returnDate: true,    // duration display (date math, non-PII)
    // (TmcTrip has no `subBrand` column on the schema — TMC is its own
    // sub-brand by virtue of model identity; the absence of a subBrand
    // entry here is intentional, not an oversight.)
    createdAt: true,
  }),

  // Trip participants — high-value PII target. fullName is required as the
  // operator headline; everything else (passportNumber, aadhaar*, parent*,
  // medicalNotes) is intentionally DROPPED. The detail endpoint
  // GET /trips/:id/participants/:pid would surface the full row.
  TripParticipant: Object.freeze({
    id: true,
    tripId: true,        // pickers need this to navigate back to the trip
    fullName: true,      // operator headline
    // consentCapturedAt indicates "has parent consented?" — a workflow
    // boolean, not PII. createdAt is the sort key.
    consentCapturedAt: true,
    createdAt: true,
  }),

  Itinerary: Object.freeze({
    id: true,
    subBrand: true,      // sub-brand chip on the list UI
    contactId: true,     // FK only — the contact's PII follows a separate fetch
    destination: true,   // non-PII location label
    status: true,        // filter UI
    startDate: true,
    endDate: true,
    totalAmount: true,   // currency display on the picker
    currency: true,
    catalogueDriveFileId: true, // TMC catalogue sync state, not customer PII
    catalogueDriveViewLink: true, // operator link to the generated PDF
    catalogueSyncedAt: true, // last generated-PDF upload timestamp
    createdAt: true,
    // Intentionally DROPPED: pricingJson (heavy @db.Text breakdown),
    // shareToken (auth-bearing), pdfUrl (heavy + may leak), micrositeUrl.
  }),

  TravelQuote: Object.freeze({
    id: true,
    subBrand: true,
    contactId: true,
    status: true,
    totalAmount: true,
    currency: true,
    validUntil: true,    // expiry-sort UI needs this
    createdAt: true,
    // Contact name is the operator-visible headline for a quote row. The bare
    // contactId is kept for backwards-compat/detail navigation; name is joined
    // here so list callers don't need a second fetch to render the customer.
    contact: { select: { id: true, name: true } },
    // Intentionally DROPPED: assignedToUserId / assignedToUser. Assignment is
    // visible on the detail endpoint and full-shape list; the slim summary
    // projection used by picker/dashboard tiles should not carry it.
  }),

  TravelInvoice: Object.freeze({
    id: true,
    subBrand: true,
    contactId: true,
    tripId: true,       // associated TMC trip, when present
    invoiceNum: true,    // operator headline
    status: true,
    docType: true,       // TaxInvoice vs CreditNote etc. — filter UI
    totalAmount: true,
    currency: true,
    dueDate: true,       // aging-tile sort
    paidAt: true,        // paid-vs-unpaid filter
    createdAt: true,
    // Intentionally DROPPED: tcsAmount / tcsRate / tcsExceedingAmount /
    // tcsAppliedAt (audit-trail data, not picker-relevant); parentInvoiceId
    // (FK only — detail endpoint surfaces it).
  }),

  TravelSupplier: Object.freeze({
    id: true,
    subBrand: true,
    name: true,          // operator headline
    supplierCategory: true,
    isActive: true,
    createdAt: true,
    // Intentionally DROPPED: contactPerson, phone, email (supplier PII —
    // the supplier-master detail endpoint serves these); gstin (regulated
    // identifier); addressLine, notes, paymentTermsDays, creditLimit.
  }),

  RfuLeadProfile: Object.freeze({
    id: true,
    contactId: true,     // FK only — detail endpoint surfaces the PII
    productTier: true,   // entry | primary | premium — sub-brand-ish
    createdAt: true,
    // Intentionally DROPPED: passportNumber, emergencyContact*, medicalNotes,
    // visaHistoryJson, frequentFlyerJson, pastComplaintsJson — all PII /
    // sensitive personal data.
  }),

  // ── Visa Sure applications (Phase 3 — PII surface) ──────────────────
  //
  // Slice S43 — VisaApplication slim list shape. The visa-applications
  // list endpoint (GET /api/travel/visa/applications) carries identity-
  // bearing data: contactId (FK back to a Contact whose PII the route
  // decorates onto the row via `.map(a => ({...a, contact}))`),
  // applicationType / destinationCountry (travel-intent metadata),
  // status / readinessLevel / advisorRiskFlag (workflow keys), plus the
  // load-bearing PII drop targets — rejectionHistoryJson (@db.Text, can
  // embed prior visa-refusal reasons), outcomeReason (@db.Text, decision
  // narrative), familySize (dependent count — PC-8 risk-flag input), and
  // priorApplicationId (the recovery-FK linking to a prior rejected app).
  //
  // The list endpoint's MOST sensitive payload component is the contact
  // decoration (the route adds `{...a, contact: {id, name, email, phone}}`
  // after the Prisma findMany). The slim path's load-bearing semantic is
  // that the route MUST skip the decoration when this projection is
  // applied — otherwise the SQL-level column drop is bypassed by the
  // post-query enrichment. The adoption rule:
  //
  //   if (slim) { findManyArgs.select = listProjection('VisaApplication', false);
  //               rows = await prisma.visaApplication.findMany(findManyArgs);
  //               return rows;  // ← no contact decoration
  //   } else    { rows = await prisma.visaApplication.findMany(findManyArgs);
  //               return rows.map((a) => ({ ...a, contact: contactById.get(a.contactId) || null }));
  //   }
  //
  // Same shape as MarketplaceLead's `contact` include-skip pattern (the
  // contact PII is fetch-via-separate-endpoint on the slim path).
  VisaApplication: Object.freeze({
    id: true,
    contactId: true,        // FK only — contact PII follows the GET /:id
                            // detail endpoint (which the picker row-click
                            // navigates to) rather than riding the list.
    applicationType: true,  // tourist | business | student | work | umrah |
                            // hajj — picker chip; non-PII catalogue value.
    destinationCountry: true, // ISO-3166-1 alpha-2 code (US, AE, ...) —
                            // catalogue value; non-PII.
    status: true,           // intake | docs-pending | filed | approved |
                            // rejected | appeal — filter UI's pivot column.
    readinessLevel: true,   // 1-4 numeric tier from the diagnostic —
                            // non-PII workflow signal.
    advisorRiskFlag: true,  // null | low | medium | high | priority —
                            // workflow chip; non-PII.
    complexCase: true,      // boolean — workflow chip; non-PII.
    filedAt: true,          // timestamp — sort key for the filed-queue UI.
    decidedAt: true,        // timestamp — sort key for the outcomes UI.
    outcome: true,          // null | approved | rejected — workflow chip;
                            // non-PII (the WHY is in outcomeReason which
                            // is dropped).
    createdAt: true,        // default-sort stability for the picker.
    // Intentionally DROPPED:
    //   rejectionHistoryJson (@db.Text) — embeds prior rejection reasons /
    //     destinations / dates → identifiable travel history.
    //   outcomeReason (@db.Text) — decision narrative; may quote the
    //     embassy's case-by-case reasoning + applicant personal context.
    //   familySize — dependent count; demographic metadata (PC-8 risk
    //     engine input but not picker-relevant).
    //   priorApplicationId — recovery-FK; surfaces the existence of a
    //     prior rejected application by this same applicant. Useful in
    //     detail UI; not safe for list payload because it reveals
    //     rejection history via the FK chain alone.
    //   recoveryProgramId — FK to a future RejectionRecoveryProgram model;
    //     same rejection-history-revealing risk class.
    //   tenantId — strip per repo-wide stripDangerous convention; the
    //     payload is already tenant-scoped by the route's where clause.
    //   updatedAt — admin/audit metadata; detail endpoint surfaces it.
    //
    // NOTE: the route MUST also skip the post-query
    // `.map(a => ({...a, contact: contactById.get(a.contactId)}))`
    // decoration on the slim path — that decoration is what would
    // otherwise re-introduce contact.name / contact.email / contact.phone
    // into the payload AFTER the SQL drop.
  }),

  // ── Multi-channel inbound lead ingestion ─────────────────────────────
  MarketplaceLead: Object.freeze({
    id: true,
    provider: true,      // indiamart | justdial | tradeindia — sub-brand-ish
    name: true,          // operator headline (non-PII when present as just
                         // a first name; sometimes it's "John D.", sometimes
                         // full — same risk-class as Contact.name which the
                         // shipped contacts slice 1 already classified as
                         // safe-in-summary)
    status: true,        // filter UI (New | Imported | Duplicate | Dismissed)
    contactId: true,     // FK only (resolved Contact's PII follows separately)
    createdAt: true,
    // Intentionally DROPPED: email, phone, company, message (@db.Text),
    // product, city, rawPayload (@db.Text — could embed full webhook payload).
    // These are the highest-PII fields on the model.
  }),

  // ── Wellness vertical (HIPAA / DPDP Act) ─────────────────────────────
  // Slice S42 — wellness PHI list-endpoint slim projections.
  //
  // The wellness clinical surface (`GET /api/wellness/{patients,visits,
  // prescriptions}`) is HIPAA-regulated: any default-shape PHI ship-out
  // is medico-legally significant. The PRD §11 contract already requires
  // an audit row per PHI read; this slice extends that contract by giving
  // the list pickers an opt-in slim shape (`?fields=summary`) that ships
  // ONLY non-PHI identifiers + workflow keys. That lets the picker /
  // dropdown / count-badge use cases hit the list endpoint WITHOUT
  // triggering a PII_DISCLOSED audit row (because no PII is in the
  // response payload — the operator never SAW it).
  //
  // Audit-coordination contract: when the route returns slim shape, the
  // PATIENT_LIST_READ / VISIT_LIST_READ / PRESCRIPTION_LIST_READ audit
  // row is STILL written (regulatory "an operator hit the list endpoint"
  // visibility), but the PII_DISCLOSED audit row is SKIPPED on slim path
  // because no PHI columns are in the response. This is the load-bearing
  // semantic of the slim path: it converts a PII-disclosing call into a
  // non-PII-disclosing call by SQL-dropping the columns at the Prisma
  // layer (the operator gets back rows with only IDs + workflow keys, so
  // no disclosure event has happened).
  //
  // Default shape stays full PHI (back-compat with the 28 frontend
  // wellness pages that destructure `patient.phone` / `patient.email` /
  // `patient.dob` directly — flipping the default would silently break
  // every page picker that depends on the full row).
  Patient: Object.freeze({
    id: true,
    name: true,          // operator headline. Per the existing piiMask /
                         // shouldMaskForViewer contract (#680), Patient.name
                         // is classified as PII when an UNMASKED disclosure
                         // is logged — but the slim shape's purpose is
                         // explicitly to ship a row-identifier surface for
                         // pickers / autocomplete / tag-link UIs where the
                         // operator MUST see the patient name to disambiguate.
                         // Without name, the slim row is a useless number.
                         // Trade-off: name stays IN the slim shape; the route
                         // still applies the existing maskRows() viewer-policy
                         // filter so low-trust viewers (telecaller / helper)
                         // see masked names on slim path too.
    // S96 — surface S62's slim-shape PRD additions (per S42 carry-over).
    // firstName / lastName / displayName / lastVisitDate are the structured
    // name parts + last-visit anchor that the slim row UI can render WITHOUT
    // loading the full PHI payload. Same PHI risk class as `name` (operator-
    // visible identifier) and gated by the same maskRows() viewer-policy
    // filter route-side, so low-trust viewers (telecaller / helper) see them
    // masked too. lastVisitDate is a denormalized cache (currently null on
    // every row — S62 added the column without backfill; population logic is
    // a follow-up gap row). The slim consumer treats null as "unknown / not
    // yet computed", not "no visits".
    firstName: true,     // structured given name (additive to `name`).
    lastName: true,      // structured family name (additive to `name`).
    displayName: true,   // operator-set / computed UI-rendered name (falls
                         // back to `name` when null).
    lastVisitDate: true, // denormalized MAX(visits.visitDate) anchor for
                         // last-visit chip on picker rows.
    locationId: true,    // location chip on the picker (non-PHI — just a
                         // clinic-branch FK).
    source: true,        // "ad" | "walk-in" | "referral" | "whatsapp" — non-
                         // PHI classifier; useful for the picker UI's
                         // source-segmentation chip.
    createdAt: true,     // sort key for default-list stability.
    // Intentionally DROPPED (PHI):
    //   phone, normalizedPhone, email — direct contact PII.
    //   dob, gender, bloodGroup — demographic / clinical PHI.
    //   allergies, notes (both @db.Text) — clinical narrative PHI.
    //   photoUrl — patient photo (PHI under HIPAA's "biometric identifier"
    //              clause when the image is the patient themselves).
    //   gst (@db.VarChar(15)) — regulated tax identifier.
    //   tagsJson — patient-segment labels (e.g. "diabetic", "vip-revenue")
    //              that conflate clinical diagnosis with VIP marketing and
    //              are too sensitive for the slim picker shape.
    //   anniversary, walletBalance, taxType, instagramHandle — non-clinical
    //              but still personal; the picker doesn't need them.
    //   contactId, userId — back-link FKs; not picker-useful.
    //   deletedAt, updatedAt — tombstone columns; admin-list UI fetches the
    //              full row when it needs to see them.
  }),

  Visit: Object.freeze({
    id: true,
    patientId: true,     // back-link FK so the picker can hop to the patient.
                         // NOT PHI on its own — it's a row identifier.
    visitDate: true,     // calendar / sort key. The date alone is not PHI;
                         // joining it with patientId is — the slim caller
                         // already has the patient FK so this is a no-op
                         // delta vs the bare patientId.
    status: true,        // filter UI: booked | arrived | in-treatment |
                         // completed | no-show | cancelled. Non-PHI.
    doctorId: true,      // assigned doctor — calendar column UI needs it
                         // to render the per-doctor lane. Non-PHI (just a
                         // staff User FK).
    serviceId: true,     // service catalog FK — picker shows "Botox" /
                         // "Hair Transplant" badge. Non-PHI; the service
                         // name is in the catalog, not on the visit.
    locationId: true,    // clinic branch — multi-location UI lane.
    bookingType: true,   // CLINIC_VISIT | IN_HOME | VIDEO | PHONE.
                         // Channel chip on the picker UI. Non-PHI.
    createdAt: true,     // sort key for visit-history.
    // Intentionally DROPPED (PHI):
    //   reason (@db.Text) — patient-supplied chief complaint. Clinical PHI.
    //   notes (@db.Text) — clinical narrative.
    //   vitals (@db.Text JSON) — BP / pulse / weight — clinical PHI.
    //   photosBefore, photosAfter (@db.Text JSON arrays of URLs) — clinical
    //                  photography PHI.
    //   amountCharged — financial PHI (joins with patient identity to
    //                   reveal what the patient paid for what treatment).
    //   videoRoom, videoCallUrl — telehealth session identifiers. The URL
    //                   is auth-bearing (anyone with the link enters the
    //                   session); MUST not leak through pickers.
    //   atHomeAddress, atHomeCity, atHomePincode — patient home address PHI.
    //   travelTimeMinutes — dispatch-private (combined with address = PHI).
    //   utm* + referrer — attribution data; not PHI in isolation but useless
    //                     to a picker.
  }),

  Prescription: Object.freeze({
    id: true,
    patientId: true,     // back-link FK.
    visitId: true,     // back-link FK (when the Rx anchors a visit).
    doctorId: true,    // prescriber FK — medico-legal "who wrote it"
                       // metadata; not PHI on its own.
    // S96 — surface S62's slim-shape PRD additions. Both columns are
    // lifecycle workflow keys (not PHI on their own — they don't reveal
    // what was prescribed, only whether/when the Rx was issued/dispensed).
    // status is the conventional 'draft' | 'issued' | 'dispensed' |
    // 'cancelled' string (null = legacy row, route layer treats as
    // 'issued' for back-compat per the S62 schema comment).
    // dispensedAt is the POS pharmacy-dispense timestamp (null until the
    // dispense action fires). Both are picker-relevant for the Rx-history
    // / dispense-queue UIs that the slim path serves.
    status: true,        // 'draft' | 'issued' | 'dispensed' | 'cancelled'
                         // — non-PHI lifecycle marker.
    dispensedAt: true,   // pharmacy-dispense timestamp — non-PHI workflow
                         // signal (null until dispense action fires).
    createdAt: true,     // sort key for Rx history.
    // Intentionally DROPPED (the entire reason this slim shape exists):
    //   drugs (@db.Text JSON) — the actual prescription contents. THIS IS
    //          THE LOAD-BEARING DROP for HIPAA: shipping the drug list in
    //          a list-endpoint response is what makes the call a PHI read.
    //   instructions (@db.Text) — patient-specific dosage narrative.
    //   pdfUrl — signed PDF link; potentially auth-bearing on signed-URL
    //            providers + contains the same drug list once opened.
    //
    // (Earlier comment noted status + dispensedAt did NOT exist on
    // Prescription; S62 added them as nullable columns. S96 surfaced them
    // on the slim shape per the original S42 carry-over spec.)
  }),
});

/**
 * Look up the Prisma `select` projection for a model's slim list-endpoint shape.
 *
 * @param {string} modelName     - Prisma model name (case-sensitive).
 * @param {boolean} fullShape    - When truthy, returns `undefined` so Prisma
 *                                 ships the full row. When falsy, returns
 *                                 the slim `select` object.
 * @returns {object|undefined}   - Slim select object, or `undefined` for
 *                                 full-shape / unknown-model paths.
 */
function listProjection(modelName, fullShape) {
  if (fullShape) return undefined;
  if (typeof modelName !== 'string' || modelName.length === 0) return undefined;
  const projection = PROJECTIONS[modelName];
  if (!projection) return undefined;
  return projection;
}

/**
 * Expose the projection map for testing + introspection. Read-only at module
 * load (Object.freeze on construction); callers that mutate this in tests
 * are caught by the freeze and crash loudly rather than corrupting state.
 *
 * @returns {Readonly<Record<string, object>>}
 */
function getProjections() {
  return PROJECTIONS;
}

/**
 * Resolve the `req.query.fields` value to a boolean "ship full shape?" flag.
 * Centralizes the strict-equality opt-in convention shared across slices 1-51
 * (`?fields=summary` is the slim opt-in; everything else — absent param,
 * `?fields=full`, `?fields=summary,extra`, casing variants — falls through
 * to full shape).
 *
 * Slim path requires EXACTLY the literal string "summary". Anything else
 * (including `?fields=full`, `?fields=Summary`, `?fields=summary ` with
 * trailing whitespace, `?fields=summary,extra`) returns true (full shape).
 *
 * @param {object} query - req.query
 * @returns {boolean}    - true when the caller wants the full row shape.
 */
function isFullShape(query) {
  if (!query || typeof query !== 'object') return true;
  return query.fields !== 'summary';
}

module.exports = listProjection;
module.exports.listProjection = listProjection;
module.exports.getProjections = getProjections;
module.exports.isFullShape = isFullShape;
