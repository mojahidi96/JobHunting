import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, api, setCsrf, setUnauthenticatedHandler } from "./api";
import type { SignInResponse, User } from "./types";

interface AuthState {
  user: User | null; loading: boolean; hasPassword: boolean;
  /** Set when a previously signed-in session ended on the server (shown on the sign-in screen). */
  notice: string | null; clearNotice: () => void;
  login: (email: string, password: string) => Promise<SignInResponse>;
  register: (name: string, email: string, password: string) => Promise<SignInResponse>;
  otpVerify: (email: string, code: string) => Promise<SignInResponse>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (u: User) => void;
  setCsrfToken: (t: string) => void;
}
const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => { const c = useContext(Ctx); if (!c) throw new Error("AuthProvider missing"); return c; };

export const SESSION_EXPIRED_MESSAGE = "Your session expired, so we signed you out. Please sign in again.";
export const SUSPENDED_MESSAGE = "This account has been suspended. Contact the administrator if you think this is a mistake.";

/** Auth state lives only in memory. The session itself is an HttpOnly cookie the page cannot read. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const clear = useCallback(() => { setUserState(null); setCsrf(""); }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.me();
      setCsrf(r.csrfToken); setUserState(r.user); setHasPassword(r.hasPassword);
    } catch (e) {
      clear();
      if (e instanceof ApiError && e.code === "SESSION_EXPIRED") setNotice(SESSION_EXPIRED_MESSAGE);
      if (e instanceof ApiError && e.code === "ACCOUNT_SUSPENDED") setNotice(SUSPENDED_MESSAGE);
    }
  }, [clear]);

  useEffect(() => {
    setUnauthenticatedHandler((code) => { clear(); setNotice(code === "ACCOUNT_SUSPENDED" ? SUSPENDED_MESSAGE : SESSION_EXPIRED_MESSAGE); });
    refresh().finally(() => setLoading(false));
  }, [refresh, clear]);

  const accept = useCallback((r: SignInResponse) => { setCsrf(r.csrfToken); setUserState(r.user); setNotice(null); void api.me().then((m) => setHasPassword(m.hasPassword)).catch(() => undefined); return r; }, []);

  const value = useMemo<AuthState>(() => ({
    user, loading, hasPassword, notice, refresh,
    clearNotice: () => setNotice(null),
    login: async (email, password) => accept(await api.login({ email, password })),
    register: async (name, email, password) => accept(await api.register({ name, email, password })),
    otpVerify: async (email, code) => accept(await api.otpVerify(email, code)),
    logout: async () => { try { await api.logout(); } finally { clear(); setNotice(null); } },
    setUser: setUserState,
    setCsrfToken: setCsrf,
  }), [user, loading, hasPassword, notice, refresh, accept, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
