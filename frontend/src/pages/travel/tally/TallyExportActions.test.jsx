import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TallyExportActions from "./TallyExportActions";
import { fetchApi } from "../../../utils/api";

const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("../../../components/PermissionGate", () => ({ default: ({ children }) => children }));
vi.mock("../../../utils/notify", () => ({ useNotify: () => ({ success, error }) }));
vi.mock("../../../utils/api", () => ({ fetchApi: vi.fn() }));

const props = {
  accounts: [],
  commonRows: [],
  customers: [{
    reference: "INV-1",
    paymentReference: "REC-1",
    name: "Customer One",
    invoiceTotal: 1000,
    amount: 1000,
    transactionDate: "2026-09-07",
    itineraryId: 1,
  }],
  payables: [],
  trips: [{ id: 1, destination: "Test Trip" }],
  tripTaxes: {},
  master: { companyName: "Test Travel Company", from: "2026-09-07", to: "2026-09-07" },
  selectedSubBrandLabel: "Travel",
  ledgerRows: [],
  ledgerMappings: [],
  voucherTypes: [],
  onDownloadPdf: vi.fn(),
};

describe("TallyExportActions direct connector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    URL.createObjectURL = vi.fn(() => "blob:tally-export");
    URL.revokeObjectURL = vi.fn();
  });

  it("keeps direct push disabled while the local connector is offline", async () => {
    fetchApi.mockResolvedValue({ configured: true, online: false });
    render(<TallyExportActions {...props} />);
    await screen.findByText("Configured, but currently offline");
    expect(screen.getByRole("button", { name: /Push directly to Tally/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Download CSV/i })).toBeEnabled();
  });

  it("sends masters and vouchers together when the connector is online", async () => {
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/status")) return { configured: true, online: true, machineId: "office-pc-1" };
      if (url.endsWith("/push")) return { success: true, results: [{ stage: "vouchers", tally: { created: 2, altered: 0 } }] };
      return {};
    });
    render(<TallyExportActions {...props} />);
    const push = await screen.findByRole("button", { name: /Push directly to Tally/i });
    await waitFor(() => expect(push).toBeEnabled());
    fireEvent.click(push);
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      "/api/travel/tally/connector/push",
      expect.objectContaining({ method: "POST" }),
    ));
    const pushCall = fetchApi.mock.calls.find(([url]) => url.endsWith("/push"));
    const payload = JSON.parse(pushCall[1].body);
    expect(payload.mastersXml).toContain("<ENVELOPE>");
    expect(payload.vouchersXml).toContain("<ENVELOPE>");
    expect(success).toHaveBeenCalledWith(expect.stringContaining("Created 2"));
  });

  it("downloads Masters and Voucher XML automatically when the direct push fails", async () => {
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/status")) return { configured: true, online: true, machineId: "office-pc-1" };
      if (url.endsWith("/push")) throw new Error("Tally is not responding");
      return {};
    });
    render(<TallyExportActions {...props} />);
    const push = await screen.findByRole("button", { name: /Push directly to Tally/i });
    await waitFor(() => expect(push).toBeEnabled());

    fireEvent.click(push);

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("XML files were downloaded automatically"));
  });
});
