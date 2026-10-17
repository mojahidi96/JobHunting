import { OAuth2Client } from "google-auth-library";
import type { Config } from "../config/env.js";

export interface GoogleClaims { sub: string; email: string; emailVerified: boolean; name: string; nonce?: string }

/** Thin seam over Google OAuth 2.0 / OpenID Connect so the flow can be tested without the network. */
export interface GoogleClient {
  authUrl(p: { state: string; nonce: string; codeChallenge: string }): string;
  /** Exchanges the authorization code (PKCE) and returns the *verified* ID-token claims. Throws on any failure. */
  exchange(code: string, codeVerifier: string): Promise<GoogleClaims>;
}

export function createGoogleClient(cfg: NonNullable<Config["google"]>): GoogleClient {
  const client = new OAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri });
  return {
    authUrl({ state, nonce, codeChallenge }) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: "openid email profile",
        state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256", prompt: "select_account",
      }).toString();
      return u.toString();
    },
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
