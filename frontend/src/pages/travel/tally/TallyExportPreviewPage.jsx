import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, KeyRound, UploadCloud } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import PermissionGate from "../../../components/PermissionGate";
import { fetchApi } from "../../../utils/api";
import { formatMoney } from "../../../utils/money";
import { useNotify } from "../../../utils/notify";
import { getTripLedgerRows } from "./tallyMath";
import { buildTallyMastersXml, buildTallyXml, buildVoucherRows } from "./tallyExportBuilder";
import { useTravelTallyMaster } from "./useTravelTallyMaster";
import tallyIcon from "../../../assets/tally-icon.png";

const field = (value) => value == null || value === "" ? "—" : String(value);
const requestConnectorStatus = (silent = true) =>
  fetchApi("/api/travel/tally/connector/status", { silent });

export default function TallyExportPreviewPage() {
  const { tripId } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const { master } = useTravelTallyMaster();
  const [trip, setTrip] = useState(null);
  const [allTrips, setAllTrips] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [allCustomers, setAllCustomers] = useState([]);
  const [payables, setPayables] = useState([]);
  const [allPayables, setAllPayables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tallyPreviewSelection, setTallyPreviewSelection] = useState("voucher:0");
  const [connectorStatus, setConnectorStatus] = useState(null);
  const [connectorCredentials, setConnectorCredentials] = useState(null);
  const [generatingCredentials, setGeneratingCredentials] = useState(false);
  const [educationalMode, setEducationalMode] = useState(() => {
    try { return window.localStorage.getItem("travel-tally-educational-mode") === "true"; } catch (_) { return false; }
  });
  const [pushNotice, setPushNotice] = useState(null);
  const [pushing, setPushing] = useState(false);
  useEffect(() => setTallyPreviewSelection("voucher:0"), [tripId]);

  useEffect(() => {
    let cancelled = false;
    const loadStatus = () => requestConnectorStatus(true)
      .then((status) => { if (!cancelled) setConnectorStatus(status); })
      .catch(() => { if (!cancelled) setConnectorStatus(null); });
    loadStatus();
    const timer = setInterval(loadStatus, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const refreshConnectorStatus = async () => {
    try {
      setConnectorStatus(await requestConnectorStatus(false));
    } catch (_) {
      setConnectorStatus(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchApi(`/api/travel/itineraries?fields=summary&limit=200`),
      fetchApi(`/api/travel/trips?fields=summary&limit=200`).catch(() => ({ trips: [] })),
      fetchApi(`/api/travel/tally/ledger?subBrand=${encodeURIComponent(master.subBrand || "all")}`),
    ]).then(([tripData, tmcTripData, ledgerData]) => {
      if (cancelled) return;
      const itineraryTrips = (tripData?.itineraries || []).map((row) => ({ ...row, ledgerType: "itinerary" }));
      const tmcTrips = (tmcTripData?.trips || []).map((row) => ({
        ...row,
        id: `tmc-${row.id}`,
        tmcTripId: row.id,
        ledgerType: "tmc",
        destination: row.tripCode ? `${row.tripCode} — ${row.destination || ""}`.trim() : row.destination,
      }));
      const combinedTrips = [...itineraryTrips, ...tmcTrips];
      const quoteRows = [...(ledgerData?.customerDetails || []), ...(ledgerData?.payableDetails || [])];
      const quoteTrips = [...new Map(quoteRows
        .filter((row) => row.quoteId != null && !row.itineraryId && !row.tripId)
        .map((row) => [String(row.quoteId), {
          id: `quote-${row.quoteId}`,
          quoteId: Number(row.quoteId),
          destination: row.tripName || `Quote #${row.quoteId}`,
          status: "Quoted",
          ledgerType: "quote",
        }])).values()];
      const allCombinedTrips = [...combinedTrips, ...quoteTrips];
      const foundTrip = allCombinedTrips.find((row) => String(row.id) === String(tripId));
      setAllTrips(allCombinedTrips);
      setTrip(foundTrip || null);
      const isTmcTrip = String(tripId || "").startsWith("tmc-");
      const isQuoteTrip = String(tripId || "").startsWith("quote-");
      const sourceTripId = isTmcTrip ? String(tripId).replace(/^tmc-/, "") : String(tripId);
      setCustomers((ledgerData?.customerDetails || []).filter((row) =>
        isQuoteTrip ? String(row.quoteId) === String(tripId).replace(/^quote-/, "")
          : isTmcTrip ? String(row.tripId) === sourceTripId : String(row.itineraryId) === sourceTripId,
      ));
      setAllCustomers(ledgerData?.customerDetails || []);
      setPayables((ledgerData?.payableDetails || []).filter((row) =>
        isQuoteTrip ? String(row.quoteId) === String(tripId).replace(/^quote-/, "")
          : isTmcTrip ? String(row.tripId) === sourceTripId : String(row.itineraryId) === sourceTripId,
      ));
      setAllPayables(ledgerData?.payableDetails || []);
    }).catch(() => { if (!cancelled) setTrip(null); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [master.subBrand, tripId]);

  const summary = useMemo(() => trip ? getTripLedgerRows({ trips: [trip], customers, suppliers: [], payables, tripTaxes: {} })[0] : null, [trip, customers, payables]);
  const allRows = useMemo(() => getTripLedgerRows({ trips: allTrips, customers: allCustomers, suppliers: [], payables: allPayables, tripTaxes: {} }), [allTrips, allCustomers, allPayables]);
  const buildTripExport = () => {
    if (!summary) return;
    const exportDate = master.to || master.from || trip.startDate || trip.fromDate || trip.createdAt || new Date().toISOString();
    const journalDate = customers.find((row) => row.transactionDate || row.createdAt || row.date)?.transactionDate || customers.find((row) => row.transactionDate || row.createdAt || row.date)?.createdAt || master.from || exportDate;
    const exportMaster = { ...master, from: master.from || exportDate, to: journalDate };
    const voucherRows = buildVoucherRows({ accounts: [], commonRows: [], customers, payables, trips: [trip], tripTaxes: {}, master: exportMaster, selectedSubBrandLabel: master.subBrand === "all" ? "Travel" : master.subBrand, ledgerRows: [], ledgerMappings: [] });
    return { voucherRows, fileName: summary.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "trip" };
  };
  const downloadXmlFile = (fileName, xml) => {
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const pushTripDirectly = async () => {
    const exportData = buildTripExport();
    if (!exportData || !connectorStatus?.online || summary?.unpaidSales > 0) return;
    const mastersXml = buildTallyMastersXml({ companyName: master.companyName, voucherRows: exportData.voucherRows });
    const vouchersXml = buildTallyXml({ companyName: master.companyName, voucherRows: exportData.voucherRows, educationalMode });
    const pushToTally = (allowDuplicate = false) => fetchApi("/api/travel/tally/connector/push", { method: "POST", body: JSON.stringify({ mastersXml, vouchersXml, allowDuplicate }) });
    const downloadFallback = () => {
      downloadXmlFile(`${exportData.fileName}-masters.xml`, mastersXml);
      downloadXmlFile(`${exportData.fileName}${educationalMode ? "-educational" : ""}-vouchers.xml`, vouchersXml);
      setPushNotice({ title: "Push failed", message: "The push failed, so Masters and Voucher XML files were downloaded automatically." });
    };
    const showSuccess = (result) => {
      const tally = result.results?.find((entry) => entry.stage === "vouchers")?.tally;
      notify.success(`Trip pushed to Tally. Created ${tally?.created || 0}, altered ${tally?.altered || 0}.`);
    };
    setPushing(true);
    try {
      showSuccess(await pushToTally());
    } catch (error) {
      if (error.code === "TALLY_DUPLICATE_PUSH") {
        const confirmed = await notify.confirm({ title: "Possible duplicate", message: "This trip was already pushed to Tally. Continuing may create duplicate records. Do you want to continue?", confirmText: "Continue push", cancelText: "Cancel", destructive: true });
        if (!confirmed) {
          notify.info("Push cancelled. No duplicate was created.");
          return;
        }
        try {
          showSuccess(await pushToTally(true));
        } catch (_) {
          downloadFallback();
        }
      } else {
        downloadFallback();
      }
    } finally {
      setPushing(false);
    }
  };
  const generateConnectorCredentials = async () => {
    setGeneratingCredentials(true);
    try {
      const credentials = await fetchApi("/api/travel/tally/connector/credentials", { method: "POST" });
      setConnectorCredentials(credentials);
      notify.success("Credentials generated. Download config.json now; the token is shown only once.");
    } finally {
      setGeneratingCredentials(false);
    }
  };
  const downloadConnectorConfig = () => {
    if (!connectorCredentials) return;
    const config = {
      serverUrl: connectorCredentials.connectorUrl,
      customerId: connectorCredentials.customerId,
      connectorId: connectorCredentials.connectorId,
      token: connectorCredentials.token,
      machineId: "office-pc-1",
      localTallyUrl: "http://127.0.0.1:9000",
      requestTimeoutMs: 45000,
      rejectUnauthorized: true,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "config.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const previewData = buildTripExport();
  const previewRows = previewData?.voucherRows.slice(1) || [];
  const previewOptions = getTallyPreviewOptions(previewRows);
  const selectedPreview = previewOptions.find((option) => option.value === tallyPreviewSelection) || previewOptions[0];

  if (loading) return <main style={page}><p>Loading Tally export preview…</p></main>;
  if (!tripId) return <main style={page}><button type="button" onClick={() => navigate("/travel/tally")} style={button}><ArrowLeft size={15} /> Back to Tally Export</button><section style={card}><span style={eyebrow}>Tally Export</span><h1>All Trips</h1><p style={muted}>Paid Sales and Cash Profit use customer payments received. Unpaid invoice value remains outstanding.</p><div style={{ ...connectorPanel, borderColor: connectorStatus?.online ? "#10b981" : undefined }}><div style={connectorHeader}><div><strong>Direct Tally connector</strong><small style={{ display: "block", color: connectorStatus?.online ? "#10b981" : "var(--text-secondary)" }}>{connectorStatus?.online ? `Online${connectorStatus.machineId ? ` on ${connectorStatus.machineId}` : ""}` : connectorStatus?.configured ? "Configured, but currently offline" : "Not configured"}</small></div><div style={connectorButtons}><button type="button" onClick={refreshConnectorStatus} style={smallButton}>Refresh status</button><PermissionGate module="tally" action="update"><button type="button" onClick={generateConnectorCredentials} disabled={generatingCredentials} style={smallButton}><KeyRound size={14} /> {generatingCredentials ? "Generating…" : connectorStatus?.configured ? "Rotate credentials" : "Generate credentials"}</button></PermissionGate></div></div>{connectorCredentials && <div style={credentialNotice}><strong>Save this configuration now</strong><small>The token is shown only once. Download it before leaving this page.</small><button type="button" onClick={downloadConnectorConfig} style={smallButton}><Download size={14} /> Download config.json</button></div>}<small style={muted}>Run the connector on the Windows computer where Tally is open on localhost port 9000.</small></div><div style={{ overflowX: "auto" }}><table style={table}><thead><tr>{["Trip", "Status", "Paid Sales", "Purchase", "GST / TCS", "Cash Profit / Loss", "Actions"].map((label) => <th key={label} style={th}>{label}</th>)}</tr></thead><tbody>{allRows.map((row) => <tr key={row.id}><td style={td}><strong>{row.label}</strong><small style={{ display: "block", color: "var(--text-secondary)" }}>Trip #{row.id}</small></td><td style={td}>{row.status}</td><td style={td}>{formatMoney(row.sales)}{row.unpaidSales > 0 && <><small style={{ display: "block", color: "#f59e0b" }}>Unpaid: {formatMoney(row.unpaidSales)}</small><small style={tallyWarning}>⚠ Do not push to Tally — the remaining amount may create duplicate records.</small></>}</td><td style={td}>{formatMoney(row.purchase)}</td><td style={td}>{formatMoney(row.gst + row.tcs)}</td><td style={td}>{formatMoney(row.profit)}</td><td style={td}><button type="button" aria-label={`Preview ${row.label}`} title={row.unpaidSales > 0 ? "Do not push to Tally while this trip has an outstanding amount" : `Preview ${row.label}`} onClick={() => navigate(`/travel/tally/export/${row.id}`)} style={iconButton}><img src={tallyIcon} alt="" style={tallyIconStyle} /></button></td></tr>)}</tbody></table></div></section></main>;
  if (!trip || !summary) return <main style={page}><button type="button" onClick={() => navigate("/travel/tally")} style={button}><ArrowLeft size={15} /> Back to Tally Export</button><section style={card}><h1>Trip not found</h1><p style={muted}>This trip is no longer available for export.</p></section></main>;

  return <main style={page}>
    {pushNotice && <TallyPushNotice notice={pushNotice} onClose={() => setPushNotice(null)} />}
    <button type="button" onClick={() => navigate("/travel/tally")} style={button}><ArrowLeft size={15} /> Back to Tally Export</button>
    <section style={card}>
      <div style={header}><div><span style={eyebrow}>Tally Export Preview</span><h1 style={{ margin: "5px 0 0" }}>{summary.label}</h1><p style={muted}>Complete trip accounting details prepared for direct Tally push.</p></div></div>
      <div style={detailsGrid}><Detail label="Trip ID" value={`#${trip.id}`} /><Detail label="Status" value={summary.status} /><Detail label="Trip Code" value={trip.tripCode} /><Detail label="Destination" value={trip.destination} /><Detail label="Start Date" value={trip.startDate || trip.fromDate} /><Detail label="End Date" value={trip.endDate || trip.toDate} /><Detail label="Company" value={master.companyName} /><Detail label="Sub-brand" value={master.subBrand === "all" ? "All" : master.subBrand} /></div>
      <div style={voucher}><div style={voucherHeader}>Tally voucher summary <span>Globussoft</span></div><div style={summaryGrid}><Metric label="Paid sales" value={summary.sales} /><Metric label="Unpaid sales" value={summary.unpaidSales} /><Metric label="Purchase" value={summary.purchase} /><Metric label="Cash profit / loss" value={summary.profit} positive={summary.profit >= 0} /><Metric label="Accrual profit / loss" value={summary.accrualProfit} positive={summary.accrualProfit >= 0} /></div></div>
      <TallyPreviewSelector options={previewOptions} value={selectedPreview?.value || ""} onChange={setTallyPreviewSelection} />
      {selectedPreview?.kind === "voucher" ? <TallyVoucherPreview row={selectedPreview.row} companyName={master.companyName} /> : selectedPreview ? <TallyLedgerPreview ledger={selectedPreview.ledger} rows={previewRows} /> : <p style={muted}>No voucher or ledger data available for preview.</p>}
    </section>
    <section style={card}><h2 style={sectionTitle}>All trip records</h2><RecordTable title="Customer invoices & receipts" rows={customers} columns={["name", "reference", "invoiceTotal", "amount"]} labels={["Party", "Reference", "Invoice", "Received"]} /><RecordTable title="Expenses" rows={payables} columns={["name", "reference", "amount", "status"]} labels={["Supplier", "Reference", "Amount", "Status"]} /></section>
    <div style={bottomPush}><div style={connectorButtons}><PermissionGate module="tally" action="export"><button type="button" onClick={pushTripDirectly} disabled={!connectorStatus?.online || pushing || summary.unpaidSales > 0} title={summary.unpaidSales > 0 ? "Direct push is blocked while the trip has an outstanding amount" : connectorStatus?.online ? "Send masters and vouchers directly to local Tally" : "Start the local Tally connector first"} style={{ ...downloadButton, background: connectorStatus?.online && !pushing && summary.unpaidSales <= 0 ? "#ea580c" : "#64748b", borderColor: connectorStatus?.online && !pushing && summary.unpaidSales <= 0 ? "#ea580c" : "#64748b", cursor: connectorStatus?.online && !pushing && summary.unpaidSales <= 0 ? "pointer" : "not-allowed" }}><UploadCloud size={16} /> {pushing ? "Pushing…" : "Push directly to Tally"}</button></PermissionGate></div><label style={educationalToggle}><input type="checkbox" checked={educationalMode} onChange={(event) => { const enabled = event.target.checked; setEducationalMode(enabled); try { window.localStorage.setItem("travel-tally-educational-mode", String(enabled)); } catch (_) { /* optional preference */ } }} /> Tally is running in Educational Mode <small>(uses the first day of each month)</small></label></div>
  </main>;
}

function Detail({ label, value }) { return <div style={detail}><span style={muted}>{label}</span><strong>{field(value)}</strong></div>; }
function Metric({ label, value, positive }) { return <div style={metric}><span style={muted}>{label}</span><strong style={positive == null ? undefined : { color: positive ? "#059669" : "#dc2626" }}>{formatMoney(value)}</strong></div>; }
function RecordTable({ title, rows, columns, labels }) { return <div style={{ marginTop: 18 }}><h3 style={{ margin: "0 0 8px", fontSize: 14 }}>{title} <span style={count}>{rows.length}</span></h3>{rows.length ? <div style={{ overflowX: "auto" }}><table style={table}><thead><tr>{labels.map((label) => <th key={label} style={th}>{label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id || index}>{columns.map((column) => <td key={column} style={td}>{column === "amount" || column === "invoiceAmount" || column === "invoiceTotal" ? formatMoney(row[column]) : field(row[column])}</td>)}</tr>)}</tbody></table></div> : <p style={muted}>No records found.</p>}</div>; }

function getTallyPreviewOptions(rows) {
  const options = rows.map((row, index) => ({ value: `voucher:${index}`, kind: "voucher", label: `${row[1]} — ${row[5] || "Unnumbered"}`, row }));
  const ledgers = [...new Set(rows.flatMap((row) => [row[2], row[3]].filter(Boolean)))].sort();
  return [...options, ...ledgers.map((ledger) => ({ value: `ledger:${ledger}`, kind: "ledger", label: `Ledger — ${ledger}`, ledger }))];
}

function TallyPreviewSelector({ options, value, onChange }) {
  return <div style={previewControls}><div><strong style={{ display: "block", fontSize: 14 }}>Tally preview</strong><span style={muted}>Select a voucher or ledger to see how it will appear in Tally.</span></div><select aria-label="Select voucher or ledger preview" value={value} onChange={(event) => onChange(event.target.value)} style={previewSelect}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>;
}

function TallyVoucherPreview({ row, rows, companyName }) {
  const amount = Number(row[6] || row[7] || 0);
  const isCredit = row[7] !== "" && row[7] != null;
  const entries = isCredit
    ? [{ side: "Dr", ledger: row[3], reference: row[10] || row[5] }, { side: "Cr", ledger: row[2] }]
    : [{ side: "Dr", ledger: row[2] }, { side: "Cr", ledger: row[3], reference: row[10] || row[5] }];
  return <div style={tallyPreview}><div style={tallyPreviewHeader}><strong>Tally Prime</strong><span>{field(companyName)}</span></div><div style={previewCaption}>Accounting Voucher Alteration (Preview)</div><div style={previewMeta}><span style={voucherBadge}>{field(row[1])}</span><span><strong>No.</strong> {field(row[5])}</span><span style={{ marginLeft: "auto" }}><strong>Date:</strong> {field(row[0])}</span></div><div style={particulars}>Particulars <span>Amount</span></div><div style={voucherBody}>{entries.map((entry, index) => <div style={entryRow} key={`${entry.ledger}-${index}`}><div style={entryDetails}><strong>{entry.side}</strong><span>{field(entry.ledger)}</span>{entry.reference && <small>{index === 0 ? "New Ref" : "Against reference"} &nbsp; {field(entry.reference)}</small>}</div><strong>{formatMoney(amount)} {entry.side}</strong></div>)}<div style={previewNarration}>{field(row[8])}</div></div><div style={previewTotals}><span>Total Dr: {formatMoney(amount)}</span><span>Total Cr: {formatMoney(amount)}</span></div><div style={previewStatus}>Sales remains at the full invoice value; cash profit uses paid sales only.</div></div>;
}

function TallyLedgerPreview({ ledger, rows }) {
  const entries = rows.filter((row) => row[2] === ledger || row[3] === ledger);
  return <div style={tallyPreview}><div style={tallyPreviewHeader}><strong>Tally Prime</strong><span>{field(ledger)} Ledger</span></div><div style={previewCaption}>Ledger Preview — {field(ledger)}</div><div style={particulars}><span>Date / Voucher / Particulars</span><span>Amount</span></div>{entries.map((row, index) => { const isPrimary = row[2] === ledger; const amount = Number(row[6] || row[7] || 0); const side = isPrimary ? (row[7] !== "" && row[7] != null ? "Cr" : "Dr") : (row[7] !== "" && row[7] != null ? "Dr" : "Cr"); const other = isPrimary ? row[3] : row[2]; return <div style={entryRow} key={`${row[5]}-${index}`}><div><small>{field(row[0])} · {field(row[1])} · {field(row[5])}</small><span>{field(other)}</span></div><strong>{formatMoney(amount)} {side}</strong></div>; })}{!entries.length && <p style={muted}>No entries found for this ledger.</p>}</div>;
}

function TallyPushNotice({ notice, onClose }) {
  return <div style={noticeOverlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div style={noticeModal} role="alertdialog" aria-modal="true" aria-labelledby="tally-push-notice-title">
      <div style={noticeHeader}><h2 id="tally-push-notice-title">{notice.title}</h2><button type="button" onClick={onClose} aria-label="Close notification" style={noticeClose}>×</button></div>
      <p style={noticeMessage}>{notice.message}</p>
      <div style={noticeActions}><button type="button" onClick={onClose} style={noticeOk}>OK</button></div>
    </div>
  </div>;
}

const page = { padding: 24, maxWidth: 1100, margin: "0 auto" };
const card = { marginTop: 16, padding: 20, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 14, background: "var(--card-bg, rgba(255,255,255,.03))" };
const header = { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" };
const bottomPush = { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, margin: "18px 0 24px" };
const eyebrow = { color: "#64748b", fontSize: 10, fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase" };
const muted = { color: "var(--text-secondary)", fontSize: 13 };
const button = { display: "inline-flex", alignItems: "center", gap: 6, minHeight: 38, padding: "8px 12px", border: "1px solid var(--border-color, rgba(148,163,184,.25))", borderRadius: 9, background: "transparent", color: "var(--text-primary)", fontWeight: 700, cursor: "pointer" };
const downloadButton = { ...button, background: "#f97316", borderColor: "#f97316", color: "#fff" };
const connectorPanel = { marginTop: 18, padding: 14, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 10, background: "var(--card-bg, rgba(255,255,255,.04))" };
const connectorHeader = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" };
const connectorButtons = { display: "flex", gap: 8, flexWrap: "wrap" };
const smallButton = { ...button, minHeight: 34, padding: "6px 10px", fontSize: 12 };
const credentialNotice = { display: "grid", gap: 7, marginTop: 12, padding: 12, borderRadius: 8, background: "rgba(245,158,11,.12)" };
const educationalToggle = { display: "flex", alignItems: "center", gap: 7, marginTop: 16, color: "var(--text-primary)", fontSize: 13 };
const noticeOverlay = { position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 20, background: "rgba(15, 23, 42, .48)" };
const noticeModal = { width: "min(100%, 520px)", borderRadius: 16, padding: 22, background: "var(--modal-bg, #fff)", color: "var(--text-primary)", boxShadow: "0 22px 60px rgba(15,23,42,.28)" };
const noticeHeader = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 };
const noticeClose = { width: 32, height: 32, border: "1px solid var(--border-color, #d1d5db)", borderRadius: 8, background: "transparent", color: "var(--text-primary)", fontSize: 22, lineHeight: 1, cursor: "pointer" };
const noticeMessage = { margin: "18px 0 24px", color: "var(--text-secondary)", lineHeight: 1.55, fontSize: 14 };
const noticeActions = { display: "flex", justifyContent: "flex-end", gap: 10 };
const noticeOk = { minWidth: 100, border: 0, borderRadius: 9, padding: "11px 20px", background: "#4f46e5", color: "#fff", fontWeight: 700, cursor: "pointer" };
const detailsGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 1, marginTop: 20, border: "1px solid var(--border-color, rgba(148,163,184,.2))", borderRadius: 10, overflow: "hidden" };
const detail = { display: "grid", gap: 5, padding: 13, background: "rgba(148,163,184,.06)" };
const voucher = { marginTop: 18, border: "1px solid #cbd5e1", borderRadius: 10, overflow: "hidden", background: "#fff", color: "#334155" };
const voucherHeader = { padding: "12px 14px", background: "#294b92", color: "#fff", fontWeight: 800, display: "flex", justifyContent: "space-between" };
const summaryGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" };
const metric = { display: "grid", gap: 6, padding: 14, borderRight: "1px solid #e2e8f0" };
const sectionTitle = { margin: 0, fontSize: 18 };
const count = { padding: "2px 7px", borderRadius: 999, background: "rgba(91,124,250,.12)", color: "#5b7cfa", fontSize: 11 };
const table = { width: "100%", borderCollapse: "collapse", minWidth: 560 };
const th = { padding: "9px 8px", textAlign: "left", color: "var(--text-secondary)", fontSize: 10, textTransform: "uppercase", borderBottom: "1px solid var(--border-color, rgba(148,163,184,.2))" };
const td = { padding: "10px 8px", fontSize: 12, borderBottom: "1px solid var(--border-color, rgba(148,163,184,.12))" };
const tallyWarning = { display: "block", marginTop: 4, color: "#b45309", fontSize: 11, fontWeight: 700, lineHeight: 1.35 };
const iconButton = { display: "inline-grid", placeItems: "center", width: 38, height: 38, padding: 7, border: "1px solid var(--border-color, rgba(148,163,184,.25))", borderRadius: 9, background: "transparent", cursor: "pointer" };
const tallyIconStyle = { width: 22, height: 22, objectFit: "contain" };
const previewControls = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", marginTop: 18, padding: 14, border: "1px solid #cbd5e1", borderRadius: 10, background: "#f8fafc" };
const previewSelect = { minWidth: 260, maxWidth: "100%", padding: "9px 10px", border: "1px solid #94a3b8", borderRadius: 7, background: "#fff", color: "#1e293b" };
const tallyPreview = { marginTop: 12, border: "1px solid #cbd5e1", borderRadius: 10, overflow: "hidden", background: "#fff", color: "#1e293b" };
const tallyPreviewHeader = { display: "flex", justifyContent: "space-between", padding: "12px 16px", background: "#294b92", color: "#fff" };
const previewCaption = { padding: "8px 12px", background: "#e0ecfa", fontSize: 12, fontWeight: 700 };
const previewMeta = { display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", padding: "10px 16px", borderBottom: "1px solid #cbd5e1", fontSize: 13, background: "#fbf1f7" };
const voucherBadge = { padding: "5px 12px", background: "#385bb0", color: "#fff", fontWeight: 800 };
const particulars = { display: "flex", justifyContent: "space-between", padding: "9px 16px", background: "#fbf1f7", fontSize: 12, fontWeight: 800, borderBottom: "1px solid #cbd5e1" };
const voucherBody = { minHeight: 220, background: "#fbf1f7" };
const entryRow = { display: "flex", justifyContent: "space-between", gap: 16, padding: "13px 16px", borderBottom: "1px solid #e2e8f0", fontSize: 13 };
const entryDetails = { display: "grid", gridTemplateColumns: "28px minmax(0, 1fr)", gap: "4px 4px", alignItems: "start" };
const previewNarration = { padding: "14px 16px", color: "#64748b", fontStyle: "italic", fontSize: 12 };
const previewTotals = { display: "flex", justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid #cbd5e1", background: "#fbf1f7", fontSize: 12, fontWeight: 700 };
const previewStatus = { padding: "9px 16px", color: "#64748b", background: "#fbf1f7", fontSize: 12 };
