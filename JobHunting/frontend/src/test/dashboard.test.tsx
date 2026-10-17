import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../pages/DashboardPage";
import { ApiError } from "../services/api";
import { PLACEHOLDERS } from "../types/api";

vi.mock("../services/api", async (orig) => {
  const actual = await orig<typeof import("../services/api")>();
  return { ...actual, api: { health: vi.fn(), recruiters: vi.fn(), preview: vi.fn(), send: vi.fn(), job: vi.fn() } };
});
import { api } from "../services/api";
const mocked = vi.mocked(api);

const rec = (n: number, extra = {}) => ({
  id: `row-${n}`, rowNumber: n, Name: `Person ${n}`, Company: `Co ${n}`, Email: `p${n}@example.com`,
  Role: "Dev", Link: null, isSend: null, status: "pending" as const, ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocked.recruiters.mockResolvedValue({
    items: [rec(2), rec(3, { isSend: "no" })],
    source: { fileName: "r.xlsx", sheetName: "Recruiters_Email" },
    warnings: [],
  });
});

describe("dashboard", () => {
  it("lists placeholders and keeps template edits", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByText("Person 2");
    const list = screen.getByRole("list", { name: "Supported placeholders" });
    for (const [name] of PLACEHOLDERS) expect(within(list).getByText(`{{${name}}}`)).toBeInTheDocument();
    const subject = screen.getByLabelText("Subject");
    await user.clear(subject);
    await user.type(subject, "Custom");
    await user.click(screen.getByLabelText("Select Person 2"));
    expect(subject).toHaveValue("Custom");
    await user.click(screen.getByRole("button", { name: "Reset to default" }));
    expect((subject as HTMLInputElement).value).toContain("{{Role}}");
  });

  it("selects visible rows, clears, and warns with no selection", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByText("Person 2");
    expect(screen.getByText(/No recruiters selected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview email/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Select visible/ }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });

  it("does not call send until the dialog is confirmed", async () => {
    const user = userEvent.setup();
    mocked.send.mockResolvedValue({ jobId: "job-1", status: "queued", total: 1, message: "ok" });
    mocked.job.mockResolvedValue({ jobId: "job-1", status: "completed", total: 1, sent: 1, failed: 0, skipped: 0, results: [{ recruiterId: "row-2", email: "p2@example.com", status: "sent" }] });
    render(<DashboardPage />);
    await screen.findByText("Person 2");
    await user.click(screen.getByLabelText("Select Person 2"));
    await user.click(screen.getByRole("button", { name: /Send emails/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/sent externally/);
    expect(mocked.send).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocked.send).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Send emails/ }));
    await user.click(screen.getByRole("button", { name: "Send 1 email" }));
    expect(mocked.send).toHaveBeenCalledTimes(1);
    expect(mocked.send.mock.calls[0][0]).toMatchObject({ recruiterIds: ["row-2"], confirmation: true });
    expect(await screen.findByText(/1 sent/)).toBeInTheDocument();
  });

  it("shows API errors with retry", async () => {
    const user = userEvent.setup();
    mocked.recruiters.mockRejectedValueOnce(new ApiError("Cannot reach the API. Is the backend running?", "NETWORK_ERROR", 0));
    render(<DashboardPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the API");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Person 2")).toBeInTheDocument();
  });

  it("renders preview in a sandboxed iframe with warnings", async () => {
    const user = userEvent.setup();
    mocked.preview.mockResolvedValue({ items: [{ recruiterId: "row-2", to: "p2@example.com", subject: "S", html: "<script>x</script>", warnings: ["Unknown placeholder: {{Bogus}}"] }] });
    render(<DashboardPage />);
    await screen.findByText("Person 2");
    await user.click(screen.getByLabelText("Select Person 2"));
    await user.click(screen.getByRole("button", { name: "Preview email" }));
    const frame = await screen.findByTitle("Email preview");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(screen.getByText(/Unknown placeholder/)).toBeInTheDocument();
    expect(screen.getByText(/nothing has been sent/)).toBeInTheDocument();
  });
});
