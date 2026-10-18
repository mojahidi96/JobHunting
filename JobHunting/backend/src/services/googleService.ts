import { OAuth2Client } from "google-auth-library";
import type { Config } from "../config/env.js";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/** Result of the "Connect Gmail" consent: a refresh token for sending only, plus the verified account identity. */
export interface GmailGrant { refreshToken: string | null; email: string; emailVerified: boolean; name: string; nonce?: string; scopes: string[] }

export interface GoogleClaims { sub: string; email: string; emailVerified: boolean; name: string; nonce?: string }

/** Thin seam over Google OAuth 2.0 / OpenID Connect so the flow can be tested without the network. */
export interface GoogleClient {
  authUrl(p: { state: string; nonce: string; codeChallenge: string }): string;
  /** Exchanges the authorization code (PKCE) and returns the *verified* ID-token claims. Throws on any failure. */
  exchange(code: string, codeVerifier: string): Promise<GoogleClaims>;
  /** Consent URL for sending mail (gmail.send only), requesting an offline refresh token for this signed-in user. */
  gmailConnectUrl(p: { state: string; nonce: string; codeChallenge: string; loginHint?: string }): string;
  exchangeGmail(code: string, codeVerifier: string): Promise<GmailGrant>;
  /** Exchanges a stored refresh token for a short-lived access token. Throws on revoked/expired grants. */
  accessToken(refreshToken: string): Promise<string>;
  /** Best-effort revocation at Google when a user disconnects. */
  revoke(token: string): Promise<void>;
}

export function createGoogleClient(cfg: NonNullable<Config["google"]>): GoogleClient {
  const client = new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri });
  const authUrlBase = (extra: Record<string, string>) => {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", code_challenge_method: "S256", ...extra }).toString();
    return u.toString();
  };
  return {
    authUrl({ state, nonce, codeChallenge }) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: "openid email profile",
        state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256", prompt: "select_account",
      }).toString();
      return u.toString();
    },
    gmailConnectUrl({ state, nonce, codeChallenge, loginHint }) {
      return authUrlBase({
        scope: `openid email profile ${GMAIL_SEND_SCOPE}`, state, nonce, code_challenge: codeChallenge,
        access_type: "offline", prompt: "consent", ...(loginHint ? { login_hint: loginHint } : {}),
      });
    },
    async exchangeGmail(code, codeVerifier) {
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: cfg.redirectUri });
      if (!tokens.id_token) throw new Error("no id_token");
      const p = (await client.verifyIdToken({ idToken: tokens.id_token, audience: cfg.clientId })).getPayload();
      if (!p?.sub || !p.email) throw new Error("incomplete claims");
      return { refreshToken: tokens.refresh_token ?? null, email: p.email.toLowerCase(), emailVerified: p.email_verified === true, name: p.name ?? "", nonce: p.nonce, scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean) };
    },
    async accessToken(refreshToken) {
      const c = new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret });
      c.setCredentials({ refresh_token: refreshToken });
      const { token } = await c.getAccessToken();
      if (!token) throw new Error("no access token");
      return token;
    },
    async revoke(token) { await client.revokeToken(token); },
    async exchange(code, codeVerifier) {
      const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: cfg.redirectUri });
      if (!tokens.id_token) throw new Error("no id_token");
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: cfg.clientId }); // signature, aud, exp, iss
      const p = ticket.getPayload();
      if (!p?.sub || !p.email) throw new Error("incomplete claims");
      return { sub: p.sub, email: p.email.toLowerCase(), emailVerified: p.email_verified === true, name: p.name ?? "", nonce: p.nonce };
    },
  };
}
