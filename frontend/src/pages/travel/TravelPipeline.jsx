// Travel CRM — Sales Pipeline page.
//
// Lives at /travel/pipeline. Shows all Itineraries across sub-brands as a
// flat table with live KPI tiles (total pipeline value, won/accepted, in
// negotiation, lost). Operators can filter by sub-brand, status, and free-
// text search (destination or contact name). Inline status dropdown lets an
// advisor move a quote from "sent" → "accepted" without leaving the page.
//
// Data source: GET /api/travel/itineraries (full shape — includes contact
// name). Pagination-safe: load up to 200 rows per fetch; shows a "Load
// more" button when total > loaded count.
//
// Create flow: "+ New Deal" opens a minimal drawer that posts to
// POST /api/travel/itineraries (contactId + subBrand + destination +
// optional totalAmount + optional dates). On success navigates to the new
// itinerary's detail page (/travel/itineraries/:id).

import { useContext, useEffect, useMemo, useState } from "react";
import { useNavigate, Link, useLocation, useSearchParams } from "react-router-dom";
import {
  Plane, Plus, Upload, Download, RefreshCw, Pencil, Trash2, X, ArrowUpDown, ChevronUp, ChevronDown,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { useActiveSubBrand } from "../../utils/subBrand";
import { AuthContext } from "../../App";
import TopScrollSync from "../../components/TopScrollSync";
import CountBadge from "../../components/CountBadge";
import {
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";

// ─── Constants ────────────────────────────────────────────────────────────

const SUB_BRAND_OPTIONS = [
  { value: "all", label: "All companies" },
  { value: "tmc", label: "TMC" },
  { value: "rfu", label: "RFU" },
  { value: "travelstall", label: "TravelStall" },
  { value: "visasure", label: "Visa Sure" },
];
const LAST_LIST_URL_KEY = "travel.pipeline.lastListUrl";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "revised", label: "Revised" },
  { value: "accepted", label: "Accepted" },
  { value: "advance_paid", label: "Advance paid" },
  { value: "fully_paid", label: "Fully paid" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
];
const STATUS_SORT_RANK = new Map(
  STATUS_OPTIONS
    .filter((option) => option.value)
    .map((option, index) => [option.value, index]),
);

// Editable statuses — the inline dropdown only shows these so advisors
// can advance/withdraw a quote without accidentally setting edge-case
// terminal statuses via a mis-click.
const EDITABLE_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "revised", label: "Revised" },
  { value: "accepted", label: "Accepted" },
  { value: "advance_paid", label: "Advance paid" },
  { value: "fully_paid", label: "Fully paid" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
];

// "Won" = itineraries where money is committed (accepted or paid). Used
// for the KPI tile labelled "Won / Accepted".
const WON_STATUSES = new Set(["accepted", "advance_paid", "fully_paid"]);
// "In negotiation" = active drafts being worked on.
const NEGOTIATION_STATUSES = new Set(["sent", "revised"]);
// "Lost" = closed-negative.
const LOST_STATUSES = new Set(["rejected", "expired"]);
const API_STATUSES = new Set(EDITABLE_STATUSES.map((option) => option.value));

const LIGHT_THEME = "light";
const DARK_THEME = "dark";

const STATUS_STYLE = {
  light: {
    neutral: { bg: "rgba(18, 38, 71, 0.06)", color: "#4F5569", border: "rgba(18, 38, 71, 0.12)" },
    info: { bg: "rgba(91, 110, 248, 0.12)", color: "#3F54D0", border: "rgba(91, 110, 248, 0.18)" },
    success: { bg: "rgba(47, 122, 77, 0.12)", color: "#2F7A4D", border: "rgba(47, 122, 77, 0.18)" },
    warning: { bg: "rgba(200, 154, 78, 0.14)", color: "#8B5E20", border: "rgba(200, 154, 78, 0.22)" },
    danger: { bg: "rgba(168, 50, 63, 0.12)", color: "#A8323F", border: "rgba(168, 50, 63, 0.18)" },
  },
  dark: {
    neutral: { bg: "rgba(244, 239, 223, 0.08)", color: "#D7D1C3", border: "rgba(244, 239, 223, 0.14)" },
    info: { bg: "rgba(91, 110, 248, 0.20)", color: "#C6CCFF", border: "rgba(91, 110, 248, 0.26)" },
    success: { bg: "rgba(47, 122, 77, 0.22)", color: "#A8D8B9", border: "rgba(47, 122, 77, 0.30)" },
    warning: { bg: "rgba(200, 154, 78, 0.20)", color: "#F0D7A4", border: "rgba(200, 154, 78, 0.28)" },
    danger: { bg: "rgba(168, 50, 63, 0.20)", color: "#F7B0B7", border: "rgba(168, 50, 63, 0.28)" },
  },
};

const SUB_BRAND_STYLE = {
  light: {
    tmc: { bg: "rgba(18, 38, 71, 0.06)", color: "#122647", border: "rgba(18, 38, 71, 0.12)", label: "TMC" },
    rfu: { bg: "rgba(47, 122, 77, 0.08)", color: "#2F7A4D", border: "rgba(47, 122, 77, 0.14)", label: "RFU" },
    travelstall: { bg: "rgba(200, 154, 78, 0.12)", color: "#8B5E20", border: "rgba(200, 154, 78, 0.20)", label: "TravelStall" },
    visasure: { bg: "rgba(91, 110, 248, 0.12)", color: "#5B6EF8", border: "rgba(91, 110, 248, 0.20)", label: "Visa Sure" },
  },
  dark: {
    tmc: { bg: "rgba(18, 38, 71, 0.72)", color: "#9DB7E6", border: "rgba(157, 183, 230, 0.18)", label: "TMC" },
    rfu: { bg: "rgba(26, 31, 26, 0.82)", color: "#B6D3B6", border: "rgba(182, 211, 182, 0.16)", label: "RFU" },
    travelstall: { bg: "rgba(42, 31, 16, 0.84)", color: "#F0D7A4", border: "rgba(240, 215, 164, 0.18)", label: "TravelStall" },
    visasure: { bg: "rgba(26, 18, 40, 0.84)", color: "#D1C4FF", border: "rgba(209, 196, 255, 0.18)", label: "Visa Sure" },
  },
};

function getThemeName() {
  if (typeof document === "undefined") return LIGHT_THEME;
  return document.documentElement.getAttribute("data-theme") === DARK_THEME ? DARK_THEME : LIGHT_THEME;
}

function useTravelTheme() {
  const [theme, setTheme] = useState(() => getThemeName());

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};

    const root = document.documentElement;
    const syncTheme = () => {
      setTheme(root.getAttribute("data-theme") === DARK_THEME ? DARK_THEME : LIGHT_THEME);
    };

    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function getStatusTone(theme, current) {
  const palette = STATUS_STYLE[theme] || STATUS_STYLE.light;
  if (["accepted", "advance_paid", "fully_paid", "won"].includes(current)) return palette.success;
  if (["sent", "negotiation"].includes(current)) return palette.warning;
  if (["revised", "achieved"].includes(current)) return palette.info;
  if (["rejected", "lost"].includes(current)) return palette.danger;
  return palette.neutral;
}

function getSubBrandTone(theme, value) {
  const palette = SUB_BRAND_STYLE[theme] || SUB_BRAND_STYLE.light;
  return palette[value] || { ...palette.tmc, label: value };
}

function labelForStatus(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Draft";
  const known = EDITABLE_STATUSES.find((option) => option.value === normalized);
  if (known) return known.label;
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// ??? Helpers ??????????????????????????????????????????????????????????????

function fmtMoney(amt, currency = "INR") {
  const n = Number(amt);
  if (!Number.isFinite(n) || n === 0) return currency === "INR" ? "₹0" : `${currency} 0`;
  const sym = currency === "INR" ? "₹" : `${currency} `;
  if (currency === "INR") {
    if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
    if (n >= 100000)   return `₹${(n / 100000).toFixed(2)}L`;
    return `₹${n.toLocaleString("en-IN")}`;
  }
  return `${sym}${n.toLocaleString()}`;
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return "—";
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── Export helper ────────────────────────────────────────────────────────

function exportCsv(rows) {
  const headers = ["ID", "Destination", "Contact", "Sub-brand", "Total amount", "Currency", "Status", "Travel date", "Created"];
  const lines = [
    headers.join(","),
    ...rows.map((r) => [
      r.id,
      `"${(r.destination || "").replace(/"/g, '""')}"`,
      `"${(r.contact?.name || "").replace(/"/g, '""')}"`,
      r.subBrand || "",
      r.totalAmount || "",
      r.currency || "INR",
      r.status || "",
      r.startDate ? fmtDate(r.startDate) : "",
      fmtDate(r.createdAt),
    ].join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `travel-pipeline-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Empty form ───────────────────────────────────────────────────────────

const EMPTY_FORM = {
  contactId: "", subBrand: "travelstall", destination: "",
  totalAmount: "", currency: "INR", startDate: "", endDate: "",
};

// ─── Component ────────────────────────────────────────────────────────────

export default function TravelPipeline() {
  const { user } = useContext(AuthContext);
  const { activeSubBrand } = useActiveSubBrand();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const notify = useNotify();
  const navigate = useNavigate();
  const theme = useTravelTheme();

  // Data
  const [itineraries, setItineraries] = useState([]);
  const [total, setTotal]             = useState(0);
  const [loading, setLoading]         = useState(true);
  const [offset, setOffset]           = useState(0);
  const LIMIT = 100;

  // Filters
  const [filterSubBrand,   setFilterSubBrand]   = useState(searchParams.get("subBrand") || activeSubBrand || "");
  const [filterStatus,     setFilterStatus]     = useState(searchParams.get("status") || "");
  const [search,           setSearch]           = useState(searchParams.get("search") || "");
  const [filterContact,  setFilterContact]  = useState(searchParams.get("contact") || "");
  const [sortKey, setSortKey] = useState(searchParams.get("sortKey") || null);
  const [sortDirection, setSortDirection] = useState(searchParams.get("sortDirection") || null);
  const updateSubBrandFilter = (value) => {
    setFilterSubBrand(value);
    const next = new URLSearchParams(searchParams);
    if (value) next.set("subBrand", value);
    else next.delete("subBrand");
    setSearchParams(next, { replace: true });
  };

  const updateListParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const handleSort = (key) => {
    const next = new URLSearchParams(searchParams);
    const direction = sortKey !== key ? "asc" : sortDirection === "asc" ? "desc" : null;
    setSortKey(direction ? key : null);
    setSortDirection(direction);
    if (direction) { next.set("sortKey", key); next.set("sortDirection", direction); }
    else { next.delete("sortKey"); next.delete("sortDirection"); }
    setSearchParams(next, { replace: true });
  };

  const sortHeader = (label, key) => {
    const active = sortKey === key;
    const Icon = active ? (sortDirection === "asc" ? ChevronUp : ChevronDown) : ArrowUpDown;
    return <button type="button" onClick={() => handleSort(key)} aria-label={`Sort ${label}`} style={{ ...sortButtonStyle, ...(active ? sortButtonActiveStyle : null) }}><span>{label}</span><Icon size={14} aria-hidden /></button>;
  };

  useEffect(() => {
    if (!searchParams.get("subBrand")) setFilterSubBrand(activeSubBrand || "");
  }, [activeSubBrand]);

  useEffect(() => {
    if (location.pathname !== "/travel/pipeline") return;
    try { window.sessionStorage.setItem(LAST_LIST_URL_KEY, `${location.pathname}${location.search}`); } catch { /* URL remains authoritative. */ }
  }, [location.pathname, location.search]);

  // Inline status update
  const [updatingId, setUpdatingId] = useState(null);

  // Delete
  const [deletingId, setDeletingId] = useState(null);

  // Create drawer
  const [creating, setCreating] = useState(false);
  const [form, setForm]         = useState(EMPTY_FORM);
  const [contacts, setContacts] = useState([]);
  const [saving, setSaving]     = useState(false);

  // Sub-brands the current user can access
  const allowedSubBrands = useMemo(
    () => accessibleSubBrands(user),
    [user],
  );

  // ── Load contacts for the create drawer ─────────────────────────────
  useEffect(() => {
    if (!creating) return;
    if (contacts.length > 0) return;
    fetchApi("/api/contacts?limit=200")
      .then((res) => setContacts(Array.isArray(res) ? res : (res?.contacts || [])))
      .catch(() => setContacts([]));
  }, [creating]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load itineraries ────────────────────────────────────────────────
  const load = (resetOffset = true) => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterSubBrand && filterSubBrand !== "all") qs.set("subBrand", filterSubBrand);
    if (filterStatus)   qs.set("status", filterStatus);
    const newOffset = resetOffset ? 0 : offset;
    qs.set("limit", String(LIMIT));
    qs.set("offset", String(newOffset));
    fetchApi(`/api/travel/itineraries?${qs.toString()}`)
      .then((res) => {
        const rows = Array.isArray(res?.itineraries) ? res.itineraries : [];
        setItineraries(resetOffset ? rows : (prev) => [...prev, ...rows]);
        setTotal(typeof res?.total === "number" ? res.total : rows.length);
        if (resetOffset) setOffset(0);
      })
      .catch((e) => {
        notify.error(e?.body?.error || "Failed to load pipeline");
        setItineraries([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(true); }, [filterSubBrand, filterStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = () => {
    const newOffset = offset + LIMIT;
    setOffset(newOffset);
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterSubBrand && filterSubBrand !== "all") qs.set("subBrand", filterSubBrand);
    if (filterStatus)   qs.set("status", filterStatus);
    qs.set("limit", String(LIMIT));
    qs.set("offset", String(newOffset));
    fetchApi(`/api/travel/itineraries?${qs.toString()}`)
      .then((res) => {
        const rows = Array.isArray(res?.itineraries) ? res.itineraries : [];
        setItineraries((prev) => [...prev, ...rows]);
        setTotal(typeof res?.total === "number" ? res.total : total);
      })
      .catch((e) => notify.error(e?.body?.error || "Failed to load more"))
      .finally(() => setLoading(false));
  };

  // ── Filtered rows (client-side search on top of server-side filters) ─
  const visible = useMemo(() => {
    let rows = itineraries;
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((r) =>
      (r.destination || "").toLowerCase().includes(q) ||
      (r.contact?.name || "").toLowerCase().includes(q) ||
      (r.subBrand || "").toLowerCase().includes(q),
    );
    const cq = filterContact.trim().toLowerCase();
    if (cq) rows = rows.filter((r) =>
      (r.contact?.name || "").toLowerCase().includes(cq),
    );
    if (sortKey) {
      const getValue = (row) => {
        if (sortKey === "company") return row.contact?.company || row.company || "";
        if (sortKey === "contact") return row.contact?.name || "";
        if (sortKey === "amount") return Number(row.totalAmount || 0);
        if (sortKey === "status") {
          const status = String(row.status || "draft").trim().toLowerCase();
          return STATUS_SORT_RANK.get(status) ?? STATUS_SORT_RANK.size;
        }
        return row[sortKey] || "";
      };
      rows = [...rows].sort((a, b) => {
        const left = getValue(a); const right = getValue(b);
        const result = typeof left === "number" ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
        return sortDirection === "desc" ? -result : result;
      });
    }
    return rows;
  }, [itineraries, search, filterContact, sortKey, sortDirection]);

  // ── KPI tiles ───────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    let totalVal = 0, wonVal = 0, negotiationVal = 0, lostVal = 0;
    for (const r of itineraries) {
      const amt = Number(r.totalAmount) || 0;
      totalVal += amt;
      if (WON_STATUSES.has(r.status))         wonVal         += amt;
      if (NEGOTIATION_STATUSES.has(r.status)) negotiationVal += amt;
      if (LOST_STATUSES.has(r.status))        lostVal        += amt;
    }
    return { totalVal, wonVal, negotiationVal, lostVal };
  }, [itineraries]);

  // ── Inline status update ─────────────────────────────────────────────
  const updateStatus = async (id, newStatus) => {
    if (!API_STATUSES.has(newStatus)) {
      notify.error("Status cannot be updated to that value");
      return;
    }
    setUpdatingId(id);
    try {
      await fetchApi(`/api/travel/itineraries/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      setItineraries((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r)),
      );
    } catch (e) {
      notify.error(e?.body?.error || "Failed to update status");
    } finally {
      setUpdatingId(null);
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────
  const remove = async (row) => {
    const ok = await notify.confirm({
      title: "Delete itinerary",
      message: `Delete the "${row.destination}" itinerary for ${row.contact?.name || `#${row.contactId}`}? This cannot be undone.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(row.id);
    try {
      await fetchApi(`/api/travel/itineraries/${row.id}`, { method: "DELETE" });
      notify.success("Itinerary deleted");
      setItineraries((prev) => prev.filter((r) => r.id !== row.id));
      setTotal((t) => t - 1);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to delete");
    } finally {
      setDeletingId(null);
    }
  };

  // ── Create ──────────────────────────────────────────────────────────
  const openCreate = () => {
    setForm({
      ...EMPTY_FORM,
      subBrand: defaultSubBrandFor(user, "") || "travelstall",
    });
    setCreating(true);
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!form.contactId) { notify.error("Contact is required"); return; }
    if (!form.destination.trim()) { notify.error("Destination is required"); return; }
    setSaving(true);
    try {
      const body = {
        contactId: parseInt(form.contactId, 10),
        subBrand: form.subBrand,
        destination: form.destination.trim(),
        status: "draft",
        currency: form.currency || "INR",
      };
      if (form.totalAmount) body.totalAmount = Number(form.totalAmount);
      if (form.startDate)   body.startDate   = form.startDate;
      if (form.endDate)     body.endDate     = form.endDate;
      const res = await fetchApi("/api/travel/itineraries", {
        method: "POST",
        body: JSON.stringify(body),
      });
      notify.success("Itinerary created");
      setCreating(false);
      // Navigate to the new itinerary's detail page
      const newId = res?.id || res?.itinerary?.id;
      if (newId) {
        navigate(`/travel/itineraries/${newId}`);
      } else {
        load(true);
      }
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to create");
    } finally {
      setSaving(false);
    }
  };

  // ── Sub-brand badge ─────────────────────────────────────────────────
  function SubBrandBadge({ value }) {
    const style = getSubBrandTone(theme, value);
    const displayLabel = style.label || subBrandShortLabel(value) || value || "—";
    return (
      <span style={{
        display: "inline-block", padding: "3px 9px", borderRadius: 6,
        fontSize: 11.5, fontWeight: 700,
        background: style.bg, color: style.color, border: `1px solid ${style.border}`,
        letterSpacing: "0.02em",
      }}>
        {displayLabel}
      </span>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "24px 28px", maxWidth: 1280, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "var(--subtle-bg)", border: "1px solid var(--border-color)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Plane size={16} style={{ color: "var(--primary-color)" }} />
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
            Travel Pipeline
            <CountBadge
              count={visible.length}
              title={`${visible.length.toLocaleString()} deals in view`}
              style={{ marginLeft: 8 }}
            />
          </h1>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            onClick={() => exportCsv(visible)}
            style={secondaryBtn}
            aria-label="Export pipeline as CSV"
            title="Export to CSV"
          >
            <Upload size={14} /> Export
          </button>
          <button
            type="button"
            onClick={openCreate}
            style={primaryBtn}
            aria-label="Create a new deal"
          >
            <Plus size={14} /> New Deal
          </button>
        </div>
      </div>

      {/* Sub-line */}
      <p style={{ margin: "0 0 20px 0", fontSize: 13.5, color: "var(--text-secondary)" }}>
        Sales pipeline —{" "}
        {["Draft", "Negotiation", "Won", "Lost", "Achieved"]
          .map((s, i) => (
            <span key={s}>
              {i > 0 && " / "}
              <strong style={{ color: "var(--text-primary)" }}>{s}</strong>
            </span>
          ))
        }.{" "}
        Sales pipeline data matches the filters currently applied.
      </p>

      {/* Filters */}
      <div style={{
        display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center",
        background: "var(--surface-color)",
        border: "1px solid var(--border-color)",
        borderRadius: 12, padding: "16px",
        marginBottom: 20,
      }}>
        <select
          value={filterSubBrand}
          onChange={(e) => updateSubBrandFilter(e.target.value)}
          style={selectStyle}
          aria-label="Filter by sub-brand"
        >
          {SUB_BRAND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => { setFilterStatus(e.target.value); updateListParam("status", e.target.value); }}
          style={selectStyle}
          aria-label="Filter by status"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => { setSearch(e.target.value); updateListParam("search", e.target.value); }}
          placeholder="Filter by tour title..."
          aria-label="Filter by tour title"
          style={{ ...selectStyle, minWidth: 180 }}
        />
        <input
          type="search"
          value={filterContact}
          onChange={(e) => { setFilterContact(e.target.value); updateListParam("contact", e.target.value); }}
          placeholder="Filter by contact name..."
          aria-label="Filter by contact name"
          style={{ ...selectStyle, minWidth: 170 }}
        />
        <button
          type="button"
          onClick={() => load(true)}
          style={secondaryBtn}
          title="Refresh"
          aria-label="Refresh pipeline"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* KPI tiles */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
        gap: 12, marginBottom: 20,
      }}>
        {[
          { label: "Total pipeline value", val: kpis.totalVal,         color: "var(--text-primary)" },
          { label: "Won",                   val: kpis.wonVal,           color: "#4fd48a" },
          { label: "In negotiation",        val: kpis.negotiationVal,   color: "#e8b34a" },
          { label: "Lost",                  val: kpis.lostVal,          color: "#f06a6a" },
        ].map((tile) => (
          <div key={tile.label} style={{
            background: "var(--surface-color)",
            border: "1px solid var(--border-color)",
            borderRadius: 12, padding: "14px 16px",
          }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
              {tile.label}
            </div>
            <div style={{ fontSize: 20, fontWeight: 600, color: tile.color }}>
              {fmtMoney(tile.val)}
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div style={{
        background: "var(--surface-color)",
        border: "1px solid var(--border-color)",
        borderRadius: 12, overflow: "hidden",
      }}>
        {loading && itineraries.length === 0 ? (
          <div style={emptyStyle}>Loading pipeline…</div>
        ) : visible.length === 0 ? (
          <div style={emptyStyle}>
            {itineraries.length === 0
              ? 'No deals yet. Create the first one with "+ New Deal".'
              : `No deals match "${search}".`}
          </div>
        ) : (
          <TopScrollSync scrollWidth={780}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 780 }}>
              <thead>
                <tr>
                  {[["Tour title", "destination"], ["Contact", "contact"], ["Company", "company"], ["Package cost", "amount"], ["Travel date", "startDate"], ["Status", "status"]].map(([h, key]) => (
                    <th key={h} style={thStyle}>{sortHeader(h, key)}</th>
                  ))}
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.id}
                    style={{ borderTop: "1px solid var(--border-light)" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--subtle-bg)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    {/* Tour / Destination */}
                    <td style={tdStyle}>
                      <Link
                        to={`/travel/itineraries/${row.id}`}
                        style={{ color: "var(--text-primary)", textDecoration: "none", fontWeight: 600, fontSize: 14 }}
                        title="Open itinerary detail"
                      >
                        {row.destination || "—"}
                      </Link>
                      {/* subtitle: duration + any sub-destinations from items */}
                      {(row.startDate && row.endDate) ? (() => {
                        const days = Math.round((new Date(row.endDate) - new Date(row.startDate)) / 86400000);
                        const nights = Math.max(0, days - 1);
                        const sub = nights > 0 ? `${nights}N/${days}D` : `${days}D`;
                        return (
                          <div style={{ fontSize: 11.5, color: "var(--text-muted, #6b6b76)", marginTop: 2 }}>
                            {sub}
                          </div>
                        );
                      })() : row.currency && row.currency !== "INR" ? (
                        <div style={{ fontSize: 11.5, color: "var(--text-muted, #6b6b76)", marginTop: 2 }}>
                          {row.currency}
                        </div>
                      ) : null}
                    </td>

                    {/* Contact */}
                    <td style={tdStyle}>
                      {row.contact ? (
                        <Link
                          to={`/travel/leads/${row.contactId}`}
                          style={{ color: "var(--text-primary)", textDecoration: "none" }}
                          title="Open lead view"
                        >
                          {row.contact.name}
                        </Link>
                      ) : (
                        <span style={{ color: "var(--text-tertiary)" }}>#{row.contactId}</span>
                      )}
                    </td>

                    {/* Company */}
                    <td style={tdStyle}>
                      <div>
                        {row.contact?.company || row.company || (
                          <span style={{ color: "var(--text-tertiary)" }}>—</span>
                        )}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <SubBrandBadge value={row.subBrand} />
                      </div>
                    </td>

                    {/* Package cost */}
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {fmtMoney(row.totalAmount, row.currency || "INR")}
                    </td>

                    {/* Travel date */}
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      {row.startDate ? fmtDate(row.startDate) : (
                        <span style={{ color: "var(--text-tertiary)" }}>—</span>
                      )}
                    </td>

                    {/* Status — inline editable dropdown */}
                    <td style={tdStyle}>
                      <StatusDropdown
                        key={`${row.id}-${theme}`}
                        id={row.id}
                        current={row.status}
                        disabled={updatingId === row.id}
                        onChange={(newStatus) => updateStatus(row.id, newStatus)}
                        theme={theme}
                      />
                    </td>

                    {/* Actions */}
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <Link
                          to={`/travel/itineraries/${row.id}`}
                          title="Edit itinerary"
                          style={iconBtnStyle}
                          aria-label={`Edit itinerary ${row.destination}`}
                        >
                          <Pencil size={13} />
                        </Link>
                        <button
                          type="button"
                          onClick={() => remove(row)}
                          disabled={deletingId === row.id}
                          title="Delete deal"
                          aria-label={`Delete itinerary ${row.destination}`}
                          style={{
                            ...iconBtnStyle,
                            opacity: deletingId === row.id ? 0.4 : 1,
                            cursor: deletingId === row.id ? "wait" : "pointer",
                            color: "var(--danger-color, #A8323F)",
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TopScrollSync>
        )}

        {/* Load more */}
        {!loading && itineraries.length < total && (
          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border-light)", textAlign: "center" }}>
            <button type="button" onClick={loadMore} style={secondaryBtn}>
              Load more ({total - itineraries.length} remaining)
            </button>
          </div>
        )}
        {loading && itineraries.length > 0 && (
          <div style={{ padding: "10px 16px", textAlign: "center", fontSize: 13, color: "var(--text-secondary)" }}>
            Loading…
          </div>
        )}
      </div>

      {/* Create drawer */}
      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setCreating(false); }}
          style={overlayStyle}
        >
          <form
            onSubmit={submitCreate}
            className="card"
            role="dialog"
            aria-modal="true"
            aria-label="New deal"
            style={drawerStyle}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>New Deal</h2>
              <button type="button" onClick={() => setCreating(false)} style={closeBtn} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Contact */}
              <label style={labelStyle}>
                Contact
                <select
                  required
                  value={form.contactId}
                  onChange={(e) => setForm({ ...form, contactId: e.target.value })}
                  style={inputStyle}
                >
                  <option value="">— select a contact —</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ""}</option>
                  ))}
                </select>
              </label>

              {/* Sub-brand */}
              <label style={labelStyle}>
                Sub-brand
                <select
                  value={form.subBrand}
                  onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                  style={inputStyle}
                >
                  {SUB_BRAND_OPTIONS.filter((o) => o.value && o.value !== "all").map((o) => (
                    <option key={o.value} value={o.value}
                      disabled={allowedSubBrands && allowedSubBrands.length > 0 && !allowedSubBrands.includes(o.value)}
                    >
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* Destination */}
              <label style={labelStyle}>
                Destination / Tour title
                <input
                  required
                  type="text"
                  value={form.destination}
                  onChange={(e) => setForm({ ...form, destination: e.target.value })}
                  style={inputStyle}
                  placeholder="e.g. Bali Honeymoon 7N/8D"
                />
              </label>

              {/* Package cost + currency */}
              <div style={{ display: "flex", gap: 10 }}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Package cost (optional)
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={form.totalAmount}
                    onChange={(e) => setForm({ ...form, totalAmount: e.target.value })}
                    style={inputStyle}
                    placeholder="0"
                  />
                </label>
                <label style={{ ...labelStyle, width: 90 }}>
                  Currency
                  <select
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    style={inputStyle}
                  >
                    {["INR", "USD", "EUR", "GBP", "AED"].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Travel dates */}
              <div style={{ display: "flex", gap: 10 }}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Travel date (optional)
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                    style={inputStyle}
                  />
                </label>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Return date (optional)
                  <input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    style={inputStyle}
                    min={form.startDate || undefined}
                  />
                </label>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 }}>
              <button type="button" onClick={() => setCreating(false)} style={secondaryBtn}>
                Cancel
              </button>
              <button type="submit" disabled={saving} style={primaryBtn}>
                {saving ? "Creating…" : "Create Deal"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ─── StatusDropdown ───────────────────────────────────────────────────────
//
// Renders a styled <select> that matches the current status's colour pill.
// When `disabled` is true (update in flight) it shows a spinner-like faded
// state.
function StatusDropdown({ id: _id, current, disabled, onChange, theme }) {
  const normalizedCurrent = String(current || "draft").trim() || "draft";
  const s = getStatusTone(theme, current);
  const options = EDITABLE_STATUSES.some((option) => option.value === normalizedCurrent)
    ? EDITABLE_STATUSES
    : [
        { value: normalizedCurrent, label: labelForStatus(normalizedCurrent) },
        ...EDITABLE_STATUSES,
      ];
  return (
    <select
      value={normalizedCurrent}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Change status"
      style={{
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        borderRadius: 20,
        padding: "5px 28px 5px 10px",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.6 : 1,
        minWidth: 120,
        lineHeight: 1.25,
        textAlign: "left",
        colorScheme: theme,
      }}
    >
      {options.map((o) => (
        <option
          key={o.value}
          value={o.value}
          style={{
            background: theme === DARK_THEME ? "#16161d" : "#FFFFFF",
            color: theme === DARK_THEME ? "#F4EFDF" : "#1F1B14",
          }}
        >
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const selectStyle = {
  padding: "7px 10px", borderRadius: 8,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 13, minWidth: 140,
};

const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 8,
  fontSize: 13, fontWeight: 600, cursor: "pointer",
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  border: "1px solid var(--primary-color, var(--accent-color))",
  whiteSpace: "nowrap",
};

const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: "pointer",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  whiteSpace: "nowrap",
};

const thStyle = {
  textAlign: "left", padding: "12px 14px",
  fontSize: 11.5, letterSpacing: "0.04em",
  fontWeight: 600, textTransform: "uppercase",
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
  whiteSpace: "nowrap",
};

const sortButtonStyle = {
  display: "inline-flex", alignItems: "center", justifyContent: "space-between", gap: 6,
  width: "100%", padding: "4px 8px", border: "none", borderRadius: 999,
  background: "transparent", color: "inherit", font: "inherit", cursor: "pointer", textAlign: "left",
};
const sortButtonActiveStyle = { color: "var(--primary-color)", background: "transparent" };

const tdStyle = {
  padding: "12px 14px",
  fontSize: 13.5,
  color: "var(--text-primary)",
  verticalAlign: "middle",
};

const emptyStyle = {
  padding: 40, textAlign: "center",
  fontSize: 14, color: "var(--text-secondary)",
};

const iconBtnStyle = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 30, height: 30, borderRadius: 7,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer", textDecoration: "none",
  fontSize: 14,
};

const overlayStyle = {
  position: "fixed", inset: 0,
  background: "var(--catalogue-modal-backdrop)",
  backdropFilter: "blur(4px)",
  WebkitBackdropFilter: "blur(4px)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 1000, padding: "1rem",
};

const drawerStyle = {
  background: "var(--bg-color, var(--surface-color))",
  color: "var(--text-primary)",
  width: "100%", maxWidth: 500,
  maxHeight: "90vh", overflowY: "auto",
  padding: "1.5rem",
};

const closeBtn = {
  background: "transparent", border: "none",
  color: "var(--text-secondary)", cursor: "pointer", padding: 4,
  display: "flex", alignItems: "center", justifyContent: "center",
};

const labelStyle = {
  display: "flex", flexDirection: "column", gap: 5,
  fontSize: 12, color: "var(--text-secondary)", fontWeight: 500,
};

const inputStyle = {
  padding: "8px 10px", borderRadius: 7,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg, var(--surface-color))",
  color: "var(--text-primary)", fontSize: 14,
};
