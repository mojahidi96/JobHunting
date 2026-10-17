import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth";
import { PreviewFrame, StatusBadge } from "../components/common";
import { ConfirmProvider } from "../components/confirm";
import { ToastProvider } from "../components/ui";
import { TemplatesPage } from "../pages/TemplatesPage";
import { RecruitersPage } from "../pages/RecruitersPage";
import { ThemeProvider } from "../theme";
import { media } from "./setup";

type Handler = (url: URL, init: RequestInit) => { status?: number; body: unknown } | undefined;
let calls: { method: string; path: string; body?: string; headers: Record<string, string> }[] = [];

function mockApi(h: Handler) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://localhost");
    calls.push({ method: init.method ?? "GET", path: url.pathname + url.search, body: typeof init.body === "string" ? init.body : undefined, headers: (init.headers ?? {}) as Record<string, string> });
    const r = h(url, init) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "nope" } } };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body, blob: async () => new Blob() } as Response;
  }));
}
const user = (o: Record<string, unknown> = {}) => ({
  id: "u1", name: "Pat", email: "pat@example.com", profilePhotoUrl: null, templateOnboardingCompletedAt: null, onboardingCompleted: true,
  emailVerified: true, googleLinked: false, theme: "system", createdAt: "2026-01-01T00:00:00Z", ...o,
});
const me = (u = user()) => ({ body: { user: u, csrfToken: "csrf-123", hasPassword: true, session: { expiresAt: "", idleExpiresAt: "" } } });
const contact = (o: Record<string, unknown> = {}) => ({
  id: "c1", Name: "Ann Lee", Company: "Acme", Email: "ann@acme.test", Role: "Dev", Link: "https://acme.test/j", isSend: "yes",
  source: { type: "manual", importId: null }, deliveryStatus: "pending", lastDelivery: null, createdAt: "", updatedAt: "", ...o,
});
const err = (status: number, code: string, message = code, meta?: object) => ({ status, body: { error: { code, message, details: [], ...(meta ? { meta } : {}) } } });
const PROVIDERS = { body: { password: true, google: true, otp: true } };

/** Minimal well-formed responses for every endpoint the signed-in pages call on load. */
const appData: Handler = (url) => {
  switch (url.pathname) {
    case "/api/recruiters": return { body: { items: [], total: 0, page: 1, pageSize: 25 } };
    case "/api/imports": return { body: { items: [] } };
    case "/api/email-templates": return { body: { items: [], onboardingCompleted: false } };
    case "/api/emails/history": return { body: { items: [], total: 0, page: 1, pageSize: 1, counts: { attempted: 0, sent: 0, failed: 0, skipped: 0 } } };
    case "/api/emails/jobs": return { body: { items: [] } };
    case "/api/settings/email": return { body: { settings: { provider: "gmail_smtp", loginEmail: "pat@example.com", senderName: "", senderEmail: "", status: "not_configured", verifiedAt: null, lastError: null, hasCredential: false } } };
    case "/api/profile": return { body: { profile: { name: "Pat", loginEmail: "pat@example.com", phone: "", headline: "", resumeUrl: "", experienceYears: null } } };
  }
};

function renderApp(path = "/") {
  return render(<ThemeProvider><ToastProvider><ConfirmProvider><MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter></ConfirmProvider></ToastProvider></ThemeProvider>);
}

let nativeConfirm: ReturnType<typeof vi.spyOn>;
beforeEach(() => { nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true); vi.spyOn(window, "prompt").mockReturnValue("x"); });

describe("signed-out experience", () => {
  const anon: Handler = (url) => {
    if (url.pathname === "/api/auth/me") return err(401, "UNAUTHENTICATED");
    if (url.pathname === "/api/auth/providers") return PROVIDERS;
  };

  it("redirects to sign-in, offers Google / password / OTP, and shows generic API errors", async () => {
    mockApi((url, init) => anon(url, init) ?? (url.pathname === "/api/auth/login" ? err(401, "INVALID_CREDENTIALS", "Incorrect email or password.") : undefined));
    renderApp("/recruiters");
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /continue with google/i })).toHaveAttribute("href", "/api/auth/google");
    expect(screen.getByRole("link", { name: /continue with email otp/i })).toHaveAttribute("href", "/login/otp");
    await userEvent.type(screen.getByLabelText("Email address"), "pat@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
  });

  it("disables Google when the server has not configured it", async () => {
    mockApi((url, init) => url.pathname === "/api/auth/providers" ? { body: { password: true, google: false, otp: false } } : anon(url, init));
    renderApp("/login");
    const btn = await screen.findByRole("button", { name: /continue with google/i });
    expect(btn).toBeDisabled();
  });

  it("shows a friendly message for Google callback errors", async () => {
    mockApi(anon);
    renderApp("/login?error=google_denied");
    expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled/i);
  });

  it("registration asks only for name, email and password", async () => {
    mockApi(anon);
    renderApp("/register");
    await screen.findByRole("heading", { name: /create your account/i });
    const form = screen.getByRole("form", { name: /create account/i });
    expect(within(form).getAllByRole("textbox").length + form.querySelectorAll("input[type=password]").length).toBe(3);
    expect(within(form).getByLabelText("Full name")).toBeInTheDocument();
  });
});

describe("email OTP flow", () => {
  it("requests a code, verifies it, then continues to onboarding for new users; handles invalid + cooldown states", async () => {
    let verifyCalls = 0;
    mockApi((url) => {
      if (url.pathname === "/api/auth/me") return err(401, "UNAUTHENTICATED");
      if (url.pathname === "/api/auth/providers") return PROVIDERS;
      if (url.pathname === "/api/auth/otp/request") return { body: { ok: true, expiresInSeconds: 600, resendAfterSeconds: 60 } };
      if (url.pathname === "/api/auth/otp/verify") {
        verifyCalls++;
        return verifyCalls === 1 ? err(400, "OTP_INVALID", "That code is incorrect. Check it and try again.", { attemptsRemaining: 4 })
          : { body: { user: user({ onboardingCompleted: false }), csrfToken: "c", isNewUser: true } };
      }
    });
    renderApp("/login/otp");
    await userEvent.type(await screen.findByLabelText("Email address"), "new@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send code/i }));
    expect(await screen.findByRole("heading", { name: /check your email/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend code in \d+s/i })).toBeDisabled(); // cooldown
    const code = screen.getByLabelText("6-digit code");
    await userEvent.type(code, "123456");
    await userEvent.click(screen.getByRole("button", { name: /verify and continue/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/4 attempt\(s\) left/);
    await userEvent.type(screen.getByLabelText("6-digit code"), "654321");
    await userEvent.click(screen.getByRole("button", { name: /verify and continue/i }));
    expect(await screen.findByRole("heading", { name: /set up your profile/i })).toBeInTheDocument();
    expect(JSON.stringify(calls)).not.toMatch(/localStorage/);
  });

  it("explains rate limits and expired codes", async () => {
    mockApi((url) => {
      if (url.pathname === "/api/auth/me") return err(401, "UNAUTHENTICATED");
      if (url.pathname === "/api/auth/providers") return PROVIDERS;
      if (url.pathname === "/api/auth/otp/request") return err(429, "OTP_RATE_LIMITED", "Too many codes requested. Try again later.");
    });
    renderApp("/login/otp");
    await userEvent.type(await screen.findByLabelText("Email address"), "x@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send code/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/too many codes/i);
  });
});

describe("onboarding gate", () => {
  it("sends users who haven't onboarded to a short form where only the name is required", async () => {
    mockApi((url, init) => {
      if (url.pathname === "/api/auth/me") return me(user({ onboardingCompleted: false, name: "Gina" }));
      if (url.pathname === "/api/onboarding/complete" && init.method === "POST") return { body: { user: user({ name: "Gina" }), profile: {} } };
      return appData(url, init);
    });
    renderApp("/recruiters");
    expect(await screen.findByRole("heading", { name: /set up your profile/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toHaveAttribute("readonly");
    expect(screen.queryByLabelText(/phone/i)).toBeNull();
    expect(screen.queryByLabelText(/linkedin/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/onboarding/complete")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.path === "/api/onboarding/complete")!.body!)).toEqual({ name: "Gina" });
    expect(calls.find((c) => c.path === "/api/onboarding/complete")!.headers["X-CSRF-Token"]).toBe("csrf-123");
    expect(await screen.findByRole("heading", { name: /^dashboard$/i })).toBeInTheDocument();
  });
});

describe("session handling", () => {
  it("shows a friendly notice when the server says the session expired on reload", async () => {
    mockApi((url) => {
      if (url.pathname === "/api/auth/me") return err(401, "SESSION_EXPIRED", "Your session expired. Please sign in again.");
      if (url.pathname === "/api/auth/providers") return PROVIDERS;
    });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(/session expired/i);
  });

  it("clears in-memory auth and redirects to sign-in when any API call returns 401", async () => {
    let expired = false;
    mockApi((url) => {
      if (url.pathname === "/api/auth/me") return expired ? err(401, "SESSION_EXPIRED") : me();
      if (url.pathname === "/api/auth/providers") return PROVIDERS;
      if (url.pathname === "/api/recruiters") return expired ? err(401, "SESSION_EXPIRED") : { body: { items: [contact()], total: 1, page: 1, pageSize: 25 } };
      if (url.pathname === "/api/imports") return expired ? err(401, "SESSION_EXPIRED") : { body: { items: [] } };
    });
    renderApp("/recruiters");
    expect(await screen.findByText("Ann Lee")).toBeInTheDocument();
    expired = true;
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "a");
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
    expect(localStorage.length).toBe(0); // nothing session-related in browser storage
  });

  it("the user menu offers an explicit Sign out", async () => {
    mockApi((url) => {
      if (url.pathname === "/api/auth/me") return me();
      if (url.pathname === "/api/auth/logout") return { body: { ok: true } };
      if (url.pathname === "/api/auth/providers") return PROVIDERS;
      return appData(url, {});
    });
    renderApp("/");
    await userEvent.click(await screen.findByRole("button", { name: /pat/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /sign out/i }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/auth/logout" && c.method === "POST")).toBe(true));
    expect(await screen.findByRole("heading", { name: /welcome back/i })).toBeInTheDocument();
  });
});

describe("themes", () => {
  const signedOut: Handler = (url) => (url.pathname === "/api/auth/me" ? err(401, "UNAUTHENTICATED") : url.pathname === "/api/auth/providers" ? PROVIDERS : undefined);

  it("switches between light, dark and system, persists, and follows OS changes", async () => {
    mockApi(signedOut);
    const { unmount } = renderApp("/login");
    const group = await screen.findByRole("group", { name: /colour theme/i });
    const root = document.documentElement;
    expect(root).not.toHaveClass("dark");
    await userEvent.click(within(group).getByRole("radio", { name: /dark/i }));
    expect(root).toHaveClass("dark");
    expect(localStorage.getItem("jh_theme")).toBe("dark");
    await userEvent.click(within(group).getByRole("radio", { name: /light/i }));
    expect(root).not.toHaveClass("dark");

    await userEvent.click(within(group).getByRole("radio", { name: /system/i }));
    expect(root).not.toHaveClass("dark");
    act(() => { media.dark = true; media.listeners.forEach((l) => l({ matches: true })); });
    expect(root).toHaveClass("dark"); // follows the OS live

    await userEvent.click(within(group).getByRole("radio", { name: /dark/i }));
    unmount();
    root.classList.remove("dark");
    renderApp("/login"); // reload: the stored choice is applied again
    await screen.findByRole("group", { name: /colour theme/i });
    expect(root).toHaveClass("dark");
    expect(within(screen.getByRole("group", { name: /colour theme/i })).getByRole("radio", { name: /dark/i })).toBeChecked();
  });

  it("syncs the choice to the account when signed in and keeps it across navigation", async () => {
    mockApi((url, init) => {
      if (url.pathname === "/api/auth/me") return me();
      if (init.method === "PATCH" && url.pathname === "/api/profile") return { body: { profile: {} } };
      return appData(url, init);
    });
    renderApp("/");
    const group = (await screen.findAllByRole("group", { name: /colour theme/i }))[0];
    await userEvent.click(within(group).getByRole("radio", { name: /dark/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/profile" && c.body === JSON.stringify({ theme: "dark" }))).toBe(true));
    await userEvent.click(screen.getAllByRole("link", { name: "Recruiters" })[0]);
    expect(document.documentElement).toHaveClass("dark");
  });

  it("adopts the account's saved theme on a device with no local preference", async () => {
    mockApi((url, init) => (url.pathname === "/api/auth/me" ? me(user({ theme: "dark" })) : appData(url, init)));
    renderApp("/");
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
  });
});

describe("recruiters grid", () => {
  const setup = (items = [contact()]) => {
    mockApi((url, init) => {
      if (url.pathname === "/api/recruiters" && (init.method ?? "GET") === "GET") return { body: { items, total: items.length, page: 1, pageSize: 25 } };
      if (url.pathname === "/api/recruiters" && init.method === "POST") return { status: 201, body: { item: contact({ id: "c2" }) } };
      if (url.pathname === "/api/imports") return { body: { items: [] } };
    });
    render(<ThemeProvider><ToastProvider><ConfirmProvider><MemoryRouter><AuthProvider><RecruitersPage /></AuthProvider></MemoryRouter></ConfirmProvider></ToastProvider></ThemeProvider>);
  };

  it("shows em dashes for empty values, safe links, and delivery status separate from isSend", async () => {
    setup([contact({ Link: null, isSend: null }), contact({ id: "c3", Email: "x@y.test", Link: "javascript:alert(1)", isSend: "yes", deliveryStatus: "sent" })]);
    expect(await screen.findAllByText("Ann Lee")).toHaveLength(2);
    expect(screen.getAllByLabelText("empty").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("link", { name: /open link/i })).toBeNull();
    expect(screen.getByText(/✓ Sent/)).toBeInTheDocument();
    expect(screen.getAllByText(/Manual entry/).length).toBeGreaterThan(0);
  });

  it("adds a row inline with validation, then saves via the API", async () => {
    setup([]);
    await screen.findByText(/No recruiters yet/);
    await userEvent.click(screen.getAllByRole("button", { name: /add recruiter/i })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Name is required");
    await userEvent.type(screen.getByLabelText("Name"), "Bob");
    await userEvent.type(screen.getByLabelText("Company"), "Corp");
    await userEvent.type(screen.getByLabelText("Email"), "bob@corp.test");
    await userEvent.type(screen.getByLabelText("Role"), "PM");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/recruiters")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toMatchObject({ Name: "Bob", Email: "bob@corp.test", Link: null });
  });

  it("requires a selection before sending and never sends on load", async () => {
    setup();
    await screen.findByText("Ann Lee");
    expect(screen.getByRole("button", { name: /send emails \(0\)/i })).toBeDisabled();
    expect(calls.some((c) => c.path.startsWith("/api/emails/send"))).toBe(false);
  });
});

describe("in-app confirmation dialogs", () => {
  const setupGrid = () => {
    mockApi((url, init) => {
      if (url.pathname === "/api/recruiters" && (init.method ?? "GET") === "GET") return { body: { items: [contact()], total: 1, page: 1, pageSize: 25 } };
      if (url.pathname === "/api/recruiters/c1" && init.method === "DELETE") return { body: { ok: true } };
      if (url.pathname === "/api/imports") return { body: { items: [] } };
    });
    render(<ThemeProvider><ToastProvider><ConfirmProvider><MemoryRouter><AuthProvider><RecruitersPage /></AuthProvider></MemoryRouter></ConfirmProvider></ToastProvider></ThemeProvider>);
  };

  it("asks for delete confirmation in a modal dialog (not window.confirm); Cancel keeps the data", async () => {
    setupGrid();
    await userEvent.click(await screen.findByRole("button", { name: /delete ann lee/i }));
    const dialog = await screen.findByRole("dialog", { name: /delete recruiter\?/i });
    expect(dialog).toHaveTextContent("ann@acme.test");
    expect(nativeConfirm).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes only after the dialog's confirm button, and Escape cancels", async () => {
    setupGrid();
    await userEvent.click(await screen.findByRole("button", { name: /delete ann lee/i }));
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /delete ann lee/i }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/recruiters/c1")).toBe(true));
    expect(nativeConfirm).not.toHaveBeenCalled();
  });
});

describe("templates page", () => {
  const tpl = { id: "t1", name: "Generic introduction", subject: "Hello {{firstName}}", html: "<p>Hi</p>", placeholderConfig: {}, version: 1, isDefault: true, starterKey: "generic", reviewedVersion: null, reviewed: false, reviewedAt: null, createdAt: "", updatedAt: "" };
  const setupTemplates = () => {
    mockApi((url, init) => {
      if (url.pathname === "/api/email-templates" && (init.method ?? "GET") === "GET") return { body: { items: [tpl], onboardingCompleted: false } };
      if (url.pathname === "/api/email-templates/starters") return { body: { items: [{ key: "generic", name: "Generic introduction", subject: "Interested in the {{Role}} opportunity at {{Company}}", html: "<p>Hi {{firstName}}, sample body</p>", placeholderConfig: {} }] } };
      if (url.pathname === "/api/email-templates/t1" && init.method === "DELETE") return { body: { ok: true } };
      if (url.pathname === "/api/email-templates/t1" && init.method === "PATCH") return { body: { item: tpl } };
      if (url.pathname === "/api/recruiters") return { body: { items: [], total: 0, page: 1, pageSize: 50 } };
    });
    render(<ThemeProvider><ToastProvider><ConfirmProvider><MemoryRouter><AuthProvider><TemplatesPage /></AuthProvider></MemoryRouter></ConfirmProvider></ToastProvider></ThemeProvider>);
  };

  it("has no separate example button; New template opens pre-filled with the editable sample", async () => {
    setupTemplates();
    await screen.findByText("Generic introduction");
    expect(screen.queryByRole("button", { name: /sendEmails/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "New template" }));
    const dialog = await screen.findByRole("dialog", { name: /new email template/i });
    expect(within(dialog).getByLabelText("Subject")).toHaveValue("Interested in the {{Role}} opportunity at {{Company}}");
    expect(within(dialog).getByLabelText("HTML body")).toHaveValue("<p>Hi {{firstName}}, sample body</p>");
    expect(within(dialog).getByLabelText("Template name")).toHaveValue("My template");
    await userEvent.clear(within(dialog).getByLabelText("HTML body")); // user can clear it and write their own
    expect(within(dialog).getByLabelText("HTML body")).toHaveValue("");
  });

  it("warns about unsaved changes with an in-app dialog before discarding", async () => {
    setupTemplates();
    await userEvent.click(await screen.findByRole("button", { name: "New template" }));
    const editor = await screen.findByRole("dialog", { name: /new email template/i });
    await userEvent.type(within(editor).getByLabelText("Subject"), " edited");
    await userEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    const confirmDlg = await screen.findByRole("dialog", { name: /discard unsaved changes/i });
    await userEvent.click(within(confirmDlg).getByRole("button", { name: /keep editing/i }));
    expect(screen.getByRole("dialog", { name: /new email template/i })).toBeInTheDocument(); // editor still open
    await userEvent.click(within(screen.getByRole("dialog", { name: /new email template/i })).getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: /discard unsaved changes/i })).getByRole("button", { name: /discard changes/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("renames through an in-app dialog and deletes through a danger confirmation", async () => {
    setupTemplates();
    await userEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const rename = await screen.findByRole("dialog", { name: /rename template/i });
    const input = within(rename).getByLabelText("Template name");
    await userEvent.clear(input); await userEvent.type(input, "Renamed one");
    await userEvent.click(within(rename).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ name: "Renamed one" }))).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: /delete template\?/i })).getByRole("button", { name: /delete template/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/email-templates/t1")).toBe(true));
    expect(window.prompt).not.toHaveBeenCalled();
  });
});

describe("components", () => {
  it("renders email previews only inside a fully sandboxed iframe", () => {
    render(<PreviewFrame html={'<p>hi</p><script>alert(1)</script>'} />);
    const frame = screen.getByTitle("Email preview");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(document.querySelector("script")).toBeNull();
  });
  it("labels statuses with text, not colour alone", () => {
    render(<><StatusBadge status="sent" /><StatusBadge status="failed" /><StatusBadge status="skipped" /></>);
    expect(screen.getByText("✓ Sent")).toBeInTheDocument();
    expect(screen.getByText("✕ Failed")).toBeInTheDocument();
    expect(screen.getByText("– Skipped")).toBeInTheDocument();
  });
});
