import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TallyExportPreviewPage from "./TallyExportPreviewPage";
import { fetchApi } from "../../../utils/api";

const { navigate, routeParams, success } = vi.hoisted(() => ({
  navigate: vi.fn(),
  routeParams: { current: { tripId: "1" } },
  success: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
  useParams: () => routeParams.current,
}));
vi.mock("../../../components/PermissionGate", () => ({ default: ({ children }) => children }));
vi.mock("../../../utils/notify", () => ({ useNotify: () => ({ success, error: vi.fn() }) }));
vi.mock("../../../utils/api", () => ({ fetchApi: vi.fn() }));
vi.mock("./useTravelTallyMaster", () => ({
  useTravelTallyMaster: () => ({
    master: { companyName: "Travel Test Co", subBrand: "all", from: "2026-09-01", to: "2026-09-30" },
  }),
}));
vi.mock("./tallyMath", () => ({
  getTripLedgerRows: ({ trips }) => trips.map((trip) => ({
    id: trip.id,
    label: trip.destination || `Trip #${trip.id}`,
    status: trip.status || "Open",
    sales: 1000,
    unpaidSales: 0,
    purchase: 600,
    gst: 0,
    tcs: 0,
    profit: 400,
    accrualProfit: 400,
  })),
}));
vi.mock("./tallyExportBuilder", () => ({
  buildVoucherRows: () => [
    ["Date", "Voucher Type", "Ledger", "Counter Ledger", "Trip", "Voucher Number", "Debit", "Credit", "Narration", "Source", "Bill Reference"],
    ["2026-09-01", "Sales", "Sales", "Customer", "Goa", "INV-1", 1000, "", "Trip sale", "customer", "INV-1"],
  ],
  buildTallyMastersXml: () => "<ENVELOPE><MASTERS /></ENVELOPE>",
  buildTallyXml: ({ educationalMode }) => `<ENVELOPE><VOUCHERS educational="${Boolean(educationalMode)}" /></ENVELOPE>`,
}));

function apiResponse(url) {
  if (url.includes("/itineraries")) return { itineraries: [{ id: 1, destination: "Goa", status: "Open", startDate: "2026-09-01" }] };
  if (url.includes("/trips")) return { trips: [] };
  if (url.includes("/ledger")) return { customerDetails: [], payableDetails: [] };
  return {};
}

describe("TallyExportPreviewPage connector and fallback exports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeParams.current = { tripId: "1" };
    window.localStorage.clear();
    URL.createObjectURL = vi.fn(() => "blob:tally-export");
    URL.revokeObjectURL = vi.fn();
  });

  it("does not show manual XML import controls while the connector is offline", async () => {
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: false };
      return apiResponse(url);
    });

    render(<TallyExportPreviewPage />);

    await screen.findByRole("button", { name: /Push directly to Tally/i });
    expect(screen.queryByRole("button", { name: /Download Masters XML/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download Voucher XML/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Push directly to Tally/i })).toBeDisabled();
  });

  it("refreshes connector status without navigating away", async () => {
    routeParams.current = {};
    let statusRequests = 0;
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) {
        statusRequests += 1;
        return statusRequests === 1
          ? { configured: true, online: false }
          : { configured: true, online: true, machineId: "office-pc-1" };
      }
      return apiResponse(url);
    });

    render(<TallyExportPreviewPage />);
    await screen.findByText("Configured, but currently offline");
    fireEvent.click(screen.getByRole("button", { name: /Refresh status/i }));

    await screen.findByText("Online on office-pc-1");
    expect(statusRequests).toBe(2);
    expect(navigate).not.toHaveBeenCalledWith("/travel/tally/export");
  });

  it("does not let a stale browser flag block a changed trip from being pushed", async () => {
    window.localStorage.setItem("travel-tally-pushed:1:normal", "true");
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: true };
      if (url.endsWith("/connector/push")) return { success: true, results: [{ stage: "vouchers", tally: { created: 1, altered: 0 } }] };
      return apiResponse(url);
    });

    render(<TallyExportPreviewPage />);
    const push = await screen.findByRole("button", { name: /Push directly to Tally/i });
    await waitFor(() => expect(push).toBeEnabled());
    fireEvent.click(push);

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      "/api/travel/tally/connector/push",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(success).toHaveBeenCalledWith(expect.stringContaining("Trip pushed to Tally"));
  });
});
