import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./auth";
import { Loading } from "./components/common";
import { CheckIcon, ChevronDownIcon, ClockIcon, CloseIcon, FileIcon, HomeIcon, LogoutIcon, MailIcon, MenuIcon, UserIcon, UsersIcon } from "./components/icons";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { cn } from "./components/ui";
import { AuthPage } from "./pages/AuthPage";
import { DashboardPage } from "./pages/DashboardPage";
import { HistoryPage } from "./pages/HistoryPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { ProfilePage } from "./pages/ProfilePage";
import { RecruitersPage } from "./pages/RecruitersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { hasStoredTheme, useTheme } from "./theme";

const NAV: [string, string, ComponentType<SVGProps<SVGSVGElement>>][] = [
  ["/", "Dashboard", HomeIcon], ["/recruiters", "Recruiters", UsersIcon], ["/templates", "Email Templates", FileIcon],
  ["/history", "Email History", ClockIcon], ["/profile", "Profile", UserIcon], ["/settings/email", "Email Sending Settings", MailIcon],
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <ul className="space-y-1">
      {NAV.map(([to, label, Icon]) => (
        <li key={to}>
          <NavLink to={to} end={to === "/"} onClick={onNavigate}
            className={({ isActive }) => cn("flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors", isActive ? "bg-primary-soft text-primary" : "text-muted hover:bg-surface-muted hover:text-foreground")}>
            <Icon className="size-5" />{label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function Brand() {
  return (
    <span className="flex items-center gap-2.5 font-semibold tracking-tight">
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground"><CheckIcon className="size-4" /></span>JobHunting
    </span>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  if (!user) return null;
  const avatar = user.profilePhotoUrl ? <img className="size-8 rounded-full object-cover" src={user.profilePhotoUrl} alt="" /> : <span className="grid size-8 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground" aria-hidden>{user.name[0]?.toUpperCase()}</span>;
  return (
    <div className="relative" ref={ref}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-10 items-center gap-2 rounded-lg px-2 hover:bg-surface-muted">
        {avatar}<span className="hidden max-w-32 truncate text-sm font-medium sm:block">{user.name}</span><ChevronDownIcon className="size-4 text-muted" />
      </button>
      {open && (
        <div role="menu" aria-label="Account" className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-border bg-surface p-2 shadow-xl">
          <div className="px-3 py-2"><p className="truncate text-sm font-medium">{user.name}</p><p className="truncate text-xs text-muted">{user.email}</p></div>
          <div className="my-1 h-px bg-border" />
          <button role="menuitem" type="button" onClick={() => { setOpen(false); nav("/profile"); }} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-sm hover:bg-surface-muted"><UserIcon className="size-4" />Profile</button>
          <div className="px-3 py-2"><p className="mb-1.5 text-xs font-medium text-muted">Theme</p><ThemeSwitcher /></div>
          <div className="my-1 h-px bg-border" />
          <button role="menuitem" type="button" onClick={async () => { setOpen(false); await logout(); nav("/login"); }} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-sm text-danger hover:bg-danger-soft"><LogoutIcon className="size-4" />Sign out</button>
        </div>
      )}
    </div>
  );
}

function Shell() {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname]);
  useEffect(() => {
    if (!drawer) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(false); };
    document.addEventListener("keydown", key); document.body.classList.add("modal-open");
    return () => { document.removeEventListener("keydown", key); document.body.classList.remove("modal-open"); };
  }, [drawer]);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded-lg focus:bg-surface focus:p-3 focus:shadow-lg">Skip to content</a>
      <aside className="hidden border-r border-border bg-surface lg:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-6 p-4"><div className="px-2 pt-1"><Brand /></div><nav aria-label="Main"><NavLinks /></nav></div>
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/60" onClick={() => setDrawer(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-6 bg-surface p-4 shadow-2xl" role="dialog" aria-modal="true" aria-label="Navigation">
            <div className="flex items-center justify-between px-2"><Brand /><button type="button" aria-label="Close menu" onClick={() => setDrawer(false)} className="rounded-lg p-2 hover:bg-surface-muted"><CloseIcon /></button></div>
            <nav aria-label="Main"><NavLinks onNavigate={() => setDrawer(false)} /></nav>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface/90 px-4 py-2 backdrop-blur sm:px-6">
          <button type="button" aria-label="Open menu" aria-expanded={drawer} onClick={() => setDrawer(true)} className="rounded-lg p-2 hover:bg-surface-muted lg:hidden"><MenuIcon /></button>
          <span className="lg:hidden"><Brand /></span>
          <div className="ml-auto flex items-center gap-2 sm:gap-3"><div className="hidden sm:block"><ThemeSwitcher compact /></div><UserMenu /></div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 p-4 outline-none sm:p-6 lg:p-8"><Outlet /></main>
      </div>
    </div>
  );
}

/** Routes by auth state: signed out -> sign-in screens; signed in but not onboarded -> onboarding; else the app. */
export function App() {
  const { user, loading } = useAuth();
  const { setTheme, theme } = useTheme();
  // Adopt the account's saved theme on a device that has no local preference yet.
  useEffect(() => { if (user && !hasStoredTheme() && user.theme !== theme) setTheme(user.theme); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="mx-auto max-w-md p-8"><Loading label="Restoring your session…" /></div>;
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/login/otp" element={<AuthPage mode="otp" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (!user.onboardingCompleted) {
    return (
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<DashboardPage />} />
        <Route path="recruiters" element={<RecruitersPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="settings/email" element={<SettingsPage />} />
      </Route>
      <Route path="/login/*" element={<Navigate to="/" replace />} />
      <Route path="/register" element={<Navigate to="/" replace />} />
      <Route path="/onboarding" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
