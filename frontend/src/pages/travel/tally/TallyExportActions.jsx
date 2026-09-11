import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Download, KeyRound, UploadCloud } from "lucide-react";
import PermissionGate from "../../../components/PermissionGate";
import { fetchApi } from "../../../utils/api";
import { useNotify } from "../../../utils/notify";
import {
  buildBaseFileName,
  buildCsv,
  buildTallyMastersXml,
  buildTallyXml,
  buildVoucherRows,
  validateExport,
} from "./tallyExportBuilder";

const button = {
  border: 0,
  borderRadius: 9,
  padding: "10px 16px",
  color: "white",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontWeight: 700,
};
const validationPanel = {
  border: "1px solid var(--border-color, rgba(148,163,184,.2))",
  borderRadius: 10,
  padding: 12,
  marginTop: 18,
  background: "var(--card-bg, rgba(255,255,255,.04))",
};
const validationRow = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
};
const th = {
  padding: "8px 9px",
  textAlign: "left",
  color: "var(--text-secondary)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".02em",
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.16))",
  whiteSpace: "nowrap",
};
const td = {
  padding: "9px",
  borderBottom: "1px solid var(--border-color, rgba(148,163,184,.1))",
  fontSize: 12,
  verticalAlign: "top",
};
const rowHasIssue = (row) => {
  const debit = Number(row[6] || 0);
  const credit = Number(row[7] || 0);
  const hasDebit = row[6] !== "" && row[6] != null;
  const hasCredit = row[7] !== "" && row[7] != null;

  return (
    !String(row[0] || "").trim() ||
    !String(row[1] || "").trim() ||
    !String(row[2] || "").trim() ||
    !String(row[3] || "").trim() ||
    ((!hasDebit && !hasCredit) || (hasDebit && hasCredit)) ||
    (hasDebit && debit <= 0) ||
    (hasCredit && credit <= 0)
  );
};
const summarizeVoucherTypes = (rows) =>
  rows.slice(1).reduce((summary, row) => {
    const voucherType = row[1] || "Unknown";
    summary[voucherType] = (summary[voucherType] || 0) + 1;
    return summary;
  }, {});
const summarizeVoucherAmounts = (rows) =>
  rows.slice(1).reduce((summary, row) => {
    const voucherType = row[1] || "Unknown";
    const current = summary[voucherType] || { count: 0, debit: 0, credit: 0 };
    current.count += 1;
    current.debit += Number(row[6] || 0);
    current.credit += Number(row[7] || 0);
    summary[voucherType] = current;
    return summary;
  }, {});

const downloadFile = (fileName, contents, type) => {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};

export default function TallyExportActions({
  accounts,
  commonRows = [],
  customers,
  payables,
  trips,
  tripTaxes,
  master,
  selectedSubBrandLabel,
  ledgerRows = [],
  ledgerMappings = [],
  voucherTypes = [],
  onDownloadPdf,
}) {
  const notify = useNotify();
  const voucherRows = buildVoucherRows({
    accounts,
    commonRows,
    customers,
    payables,
    trips,
    tripTaxes,
    master,
    selectedSubBrandLabel,
    ledgerRows,
    ledgerMappings,
    voucherTypes,
  });
  const exportWarnings = validateExport({ master, voucherRows });
  const hasVoucherRows = voucherRows.length > 1;
  const voucherSummary = summarizeVoucherTypes(voucherRows);
  const voucherAmountSummary = summarizeVoucherAmounts(voucherRows);
  const [selectedVoucherType, setSelectedVoucherType] = useState("all");
  const [connectorStatus, setConnectorStatus] = useState(null);
  const [connectorCredentials, setConnectorCredentials] = useState(null);
  const [generatingCredentials, setGeneratingCredentials] = useState(false);
  const [pushing, setPushing] = useState(false);
  const filteredRows = voucherRows
    .slice(1)
    .filter((row) => (selectedVoucherType === "all" ? true : row[1] === selectedVoucherType));
  const previewRows = filteredRows.slice(0, 18);
  const typeOptions = ["all", ...Object.keys(voucherSummary)];

  const loadConnectorStatus = async (silent = true) => {
    try {
      const status = await fetchApi("/api/travel/tally/connector/status", { silent });
      setConnectorStatus(status);
    } catch (_) {
      if (!silent) setConnectorStatus(null);
    }
  };

  useEffect(() => {
    loadConnectorStatus();
    const timer = setInterval(() => loadConnectorStatus(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const generateConnectorCredentials = async () => {
    setGeneratingCredentials(true);
    try {
      const credentials = await fetchApi("/api/travel/tally/connector/credentials", { method: "POST" });
      setConnectorCredentials(credentials);
      await loadConnectorStatus();
      notify.success("Connector credentials generated. Download the config now; the token is shown only once.");
    } finally {
      setGeneratingCredentials(false);
    }
  };

  const downloadConnectorConfig = () => {
    if (!connectorCredentials) return;
    downloadFile("config.json", JSON.stringify({
      serverUrl: connectorCredentials.connectorUrl,
      customerId: connectorCredentials.customerId,
      connectorId: connectorCredentials.connectorId,
      token: connectorCredentials.token,
      machineId: "office-pc-1",
      localTallyUrl: "http://127.0.0.1:9000",
      requestTimeoutMs: 45000,
      rejectUnauthorized: true,
    }, null, 2), "application/json;charset=utf-8");
  };

  const pushDirectlyToTally = async () => {
    if (!hasVoucherRows || exportWarnings.length || !connectorStatus?.online) return;
    const mastersXml = buildTallyMastersXml({ companyName: master.companyName, voucherRows });
    const vouchersXml = buildTallyXml({ companyName: master.companyName, voucherRows });
    const pushToTally = (allowDuplicate = false) => fetchApi("/api/travel/tally/connector/push", { method: "POST", body: JSON.stringify({ mastersXml, vouchersXml, allowDuplicate }) });
    const downloadFallback = () => {
      downloadFile(`${buildBaseFileName(master)}-masters.xml`, mastersXml, "application/xml;charset=utf-8");
      downloadFile(`${buildBaseFileName(master)}-vouchers.xml`, vouchersXml, "application/xml;charset=utf-8");
    };
    setPushing(true);
    try {
      const result = await pushToTally();
      const voucherResult = result.results?.find((entry) => entry.stage === "vouchers")?.tally;
      notify.success(`Pushed to Tally successfully. Created ${voucherResult?.created || 0}, altered ${voucherResult?.altered || 0}.`);
      await loadConnectorStatus();
    } catch (error) {
      if (error.code === "TALLY_DUPLICATE_PUSH") {
        const confirmed = await notify.confirm({ title: "Possible duplicate", message: "This export was already pushed to Tally. Continuing may create duplicate records. Do you want to continue?", confirmText: "Continue push", cancelText: "Cancel", destructive: true });
        if (!confirmed) {
          notify.info("Push cancelled. No duplicate was created.");
          return;
        }
        try {
          const result = await pushToTally(true);
          const voucherResult = result.results?.find((entry) => entry.stage === "vouchers")?.tally;
          notify.success(`Pushed to Tally successfully. Created ${voucherResult?.created || 0}, altered ${voucherResult?.altered || 0}.`);
          return;
        } catch (_) {
          downloadFallback();
          notify.error("The confirmed push failed. XML files were downloaded automatically.");
          return;
        }
      }
      // Keep the export usable even when the local connector/Tally returns an
      // error or the request throws before a response is available.
      downloadFallback();
      notify.error(`Tally push failed. XML files were downloaded automatically${error?.message ? `: ${error.message}` : "."}`);
    } finally {
      setPushing(false);
    }
  };

  const exportCsv = () => {
    if (!hasVoucherRows) return;

    downloadFile(
      `${buildBaseFileName(master)}.csv`,
      buildCsv(voucherRows),
      "text/csv;charset=utf-8",
    );
  };

  return (
    <>
      <div style={validationPanel}>
        <div
          style={{
            ...validationRow,
            color: exportWarnings.length ? "#f59e0b" : "#10b981",
            fontWeight: 700,
          }}
        >
          {exportWarnings.length ? (
            <AlertCircle size={16} />
          ) : (
            <CheckCircle2 size={16} />
          )}
          {exportWarnings.length
            ? "Review before export"
            : "Ready for export"}
        </div>
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          {(exportWarnings.length
            ? exportWarnings
            : [`${voucherRows.length - 1} voucher rows prepared.`]
          ).map((message) => (
            <div
              key={message}
              style={{ color: "var(--text-secondary)", fontSize: 13 }}
            >
              {message}
            </div>
          ))}
        </div>
      </div>
      <div style={{ ...validationPanel, borderColor: connectorStatus?.online ? "#10b981" : undefined }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <strong style={{ display: "block" }}>Direct Tally connector</strong>
            <span style={{ color: connectorStatus?.online ? "#10b981" : "var(--text-secondary)", fontSize: 13 }}>
              {connectorStatus?.online
                ? `Online${connectorStatus.machineId ? ` on ${connectorStatus.machineId}` : ""}`
                : connectorStatus?.configured ? "Configured, but currently offline" : "Not configured"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn-secondary" onClick={() => loadConnectorStatus(false)}>Refresh status</button>
            <PermissionGate module="tally" action="update">
              <button type="button" className="btn-secondary" onClick={generateConnectorCredentials} disabled={generatingCredentials}>
                <KeyRound size={15} /> {generatingCredentials ? "Generating…" : connectorStatus?.configured ? "Rotate credentials" : "Generate credentials"}
              </button>
            </PermissionGate>
          </div>
        </div>
        {connectorCredentials && <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: "rgba(245,158,11,.12)" }}>
          <strong style={{ display: "block", color: "#f59e0b" }}>Save this configuration now</strong>
          <small style={{ display: "block", margin: "5px 0 9px", color: "var(--text-secondary)" }}>The connector token cannot be displayed again. Rotating credentials disconnects the previous configuration.</small>
          <button type="button" className="btn-secondary" onClick={downloadConnectorConfig}><Download size={15} /> Download config.json</button>
        </div>}
        <small style={{ display: "block", marginTop: 10, color: "var(--text-secondary)" }}>Run the Globussoft connector on the Windows computer where Tally is open on localhost port 9000.</small>
      </div>
      <div style={{ ...validationPanel, marginTop: 12 }}>
        <div
          style={{
            ...validationRow,
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <strong>Export voucher preview</strong>
          <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
            Showing {previewRows.length} of {filteredRows.length}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginTop: 10,
          }}
        >
          {typeOptions.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setSelectedVoucherType(type)}
              style={{
                border: "1px solid var(--border-color, rgba(148,163,184,.2))",
                borderRadius: 999,
                padding: "4px 9px",
                fontSize: 12,
                color:
                  selectedVoucherType === type
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                background:
                  selectedVoucherType === type
                    ? "rgba(59,130,246,.12)"
                    : "transparent",
                cursor: "pointer",
              }}
            >
              {type === "all" ? "All vouchers" : `${type}: ${voucherSummary[type]}`}
            </button>
          ))}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 10,
            marginTop: 12,
          }}
        >
          {Object.entries(voucherAmountSummary).map(([type, summary]) => (
            <div
              key={type}
              style={{
                border: "1px solid var(--border-color, rgba(148,163,184,.16))",
                borderRadius: 10,
                padding: 10,
                background: "rgba(255,255,255,.02)",
              }}
            >
              <strong style={{ display: "block", marginBottom: 6 }}>{type}</strong>
              <small
                style={{ display: "block", color: "var(--text-secondary)" }}
              >
                Entries: {summary.count}
              </small>
              <small
                style={{ display: "block", color: "var(--text-secondary)" }}
              >
                Debit: {summary.debit.toFixed(2)}
              </small>
              <small
                style={{ display: "block", color: "var(--text-secondary)" }}
              >
                Credit: {summary.credit.toFixed(2)}
              </small>
            </div>
          ))}
        </div>
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Type</th>
                <th style={th}>Ledger</th>
                <th style={th}>Party</th>
                <th style={th}>Trip</th>
                <th style={th}>Reference</th>
                <th style={{ ...th, textAlign: "right" }}>Debit</th>
                <th style={{ ...th, textAlign: "right" }}>Credit</th>
                <th style={th}>Narration</th>
                <th style={th}>Source</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.length ? (
                previewRows.map((row, index) => (
                  <tr
                    key={`${row[5] || row[2]}-${index}`}
                    style={
                      rowHasIssue(row)
                        ? { background: "rgba(245, 158, 11, 0.08)" }
                        : undefined
                    }
                  >
                    <td style={td}>{row[0] || "-"}</td>
                    <td style={td}>{row[1] || "-"}</td>
                    <td style={td}>{row[2] || "-"}</td>
                    <td style={td}>{row[3] || "-"}</td>
                    <td style={td}>{row[4] || "-"}</td>
                    <td style={td}>{row[5] || "-"}</td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      {row[6] || "-"}
                    </td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      {row[7] || "-"}
                    </td>
                    <td style={td}>{row[8] || "-"}</td>
                    <td style={td}>{row[9] || "-"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td style={td} colSpan={10}>
                    <span style={{ color: "var(--text-secondary)" }}>
                      No voucher rows available for preview.
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          marginTop: 18,
          flexWrap: "wrap",
        }}
      >
        <PermissionGate module="tally" action="export">
          <button
            type="button"
            onClick={pushDirectlyToTally}
            disabled={!hasVoucherRows || exportWarnings.length > 0 || !connectorStatus?.online || pushing}
            title={!connectorStatus?.online ? "Start the local Tally connector first" : exportWarnings.length ? "Resolve export warnings before pushing" : "Send masters and vouchers directly to local Tally"}
            style={{
              ...button,
              background: hasVoucherRows && !exportWarnings.length && connectorStatus?.online && !pushing ? "#ea580c" : "#64748b",
              cursor: hasVoucherRows && !exportWarnings.length && connectorStatus?.online && !pushing ? "pointer" : "not-allowed",
            }}
          >
            <UploadCloud size={15} /> {pushing ? "Pushing to Tally…" : "Push directly to Tally"}
          </button>
        </PermissionGate>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!hasVoucherRows}
          style={{
            ...button,
            background: hasVoucherRows ? "#0f766e" : "#64748b",
            cursor: hasVoucherRows ? "pointer" : "not-allowed",
          }}
        >
          <Download size={15} /> Download CSV
        </button>
        <button
          type="button"
          onClick={onDownloadPdf}
          style={{ ...button, background: "#5b7cfa" }}
        >
          <Download size={15} /> Download PDF
        </button>
      </div>
    </>
  );
}
