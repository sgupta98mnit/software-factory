// Who is acting, and what they may do. SF_AUTH=local (the default) is this
// machine's user with every role (SF_LOCAL_ROLES narrows them): what the
// factory did before sign-in, and labelled as such. SF_AUTH=oidc signs people
// in with the agency's identity provider (Authorization Code + PKCE, the ID
// token checked here with node:crypto: its signature against the issuer's
// keys, issuer, audience, expiry and nonce). A session is a random cookie
// whose sha256 is kept in the ledger; the audit actor is the issuer and
// subject, never a display name. Roles come from a claim. Each change checks
// the role it needs, so an agent without a person's session changes nothing.
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { audit } from "./audit.js";

export type Role = "engineer" | "approver" | "isso" | "release_manager" | "admin";
export const ROLES: Role[] = ["engineer", "approver", "isso", "release_manager", "admin"];

export interface Principal {
  actor: string; // the audit actor: "user:<name>" locally, "oidc:<subject>@<issuer host>" when signed in
  name: string; // a label for people
  roles: Role[];
  mode: "local" | "oidc";
}

/** No session where one is needed (401). */
export class Unauthenticated extends Error {}
/** Signed in, but without the role this needs (403). */
export class Forbidden extends Error {}

export interface AuthConfig {
  mode: "local" | "oidc";
  localUser: string;
  localRoles: Role[];
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  scopes: string;
  rolesClaim: string;
  roleMap: Record<string, Role> | null; // claim value -> role; null: claim values that are role names
  sessionHours: number;
}

export interface SessionStore {
  createSession(x: { idHash: string; subject: string; issuer: string; name: string; roles: string[]; expiresAt: string }): void;
  getSession(idHash: string): { subject: string; issuer: string; name: string; roles: string[]; expiresAt: string } | undefined;
  deleteSession(idHash: string): void;
}

const COOKIE = "sf_session";
const LOGIN_TTL_MS = 10 * 60_000;
const SKEW_S = 60;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");
const asRoles = (values: string[]) => values.filter((v): v is Role => (ROLES as string[]).includes(v));

/** The configuration from the environment; a broken one throws, naming the variable. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv, localUser: string): AuthConfig {
  const mode = env.SF_AUTH === "oidc" ? "oidc" : "local";
  const localRoles = env.SF_LOCAL_ROLES ? asRoles(env.SF_LOCAL_ROLES.split(",").map((r) => r.trim())) : [...ROLES];
  let roleMap: Record<string, Role> | null = null;
  if (env.SF_OIDC_ROLE_MAP) {
    try {
      roleMap = Object.fromEntries(Object.entries(JSON.parse(env.SF_OIDC_ROLE_MAP) as Record<string, string>).filter(([, r]) => (ROLES as string[]).includes(r))) as Record<string, Role>;
    } catch {
      throw new Error('SF_OIDC_ROLE_MAP must be JSON like {"Factory-Approvers":"approver"}');
    }
  }
  const config: AuthConfig = {
    mode,
    localUser,
    localRoles,
    issuer: (env.SF_OIDC_ISSUER ?? "").replace(/\/+$/, ""),
    clientId: env.SF_OIDC_CLIENT_ID ?? "",
    clientSecret: env.SF_OIDC_CLIENT_SECRET || null,
    redirectUri: env.SF_OIDC_REDIRECT_URI ?? "http://localhost:8000/sf-api/auth/callback",
    scopes: env.SF_OIDC_SCOPES ?? "openid profile email",
    rolesClaim: env.SF_OIDC_ROLES_CLAIM ?? "roles",
    roleMap,
    sessionHours: Number(env.SF_SESSION_HOURS ?? 8) || 8,
  };
  if (mode === "oidc" && (!config.issuer || !config.clientId)) throw new Error("SF_AUTH=oidc needs SF_OIDC_ISSUER and SF_OIDC_CLIENT_ID.");
  return config;
}

/** The principal on a request (set by the middleware). */
export const principalOf = (c: Context): Principal | undefined => c.get("principal" as never) as Principal | undefined;

/** The principal, who must hold `role`. */
export function requireRole(c: Context, role: Role): Principal {
  const p = principalOf(c);
  if (!p) throw new Unauthenticated("Sign in first.");
  if (!p.roles.includes(role)) throw new Forbidden(`This needs the ${role} role; ${p.name} has ${p.roles.length ? p.roles.join(", ") : "none"}.`);
  return p;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export function createAuth(config: AuthConfig, store: SessionStore, opts: { fetch?: typeof fetch; now?: () => number } = {}) {
  const fetcher = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const pending = new Map<string, { verifier: string; nonce: string; returnTo: string; expires: number }>();
  let discovery: Discovery | null = null;
  let keys: { at: number; list: (JsonWebKey & { kid?: string })[] } | null = null;
  const local: Principal = { actor: config.localUser, name: config.localUser.replace(/^user:/, ""), roles: config.localRoles, mode: "local" };
  const secure = config.redirectUri.startsWith("https://");

  async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${new URL(url).pathname} answered ${res.status}`);
    return JSON.parse(text) as T;
  }

  async function discover(): Promise<Discovery> {
    if (discovery) return discovery;
    const d = await getJson<Discovery>(`${config.issuer}/.well-known/openid-configuration`);
    if (d.issuer.replace(/\/+$/, "") !== config.issuer) throw new Error("The identity provider's discovery names another issuer.");
    return (discovery = d);
  }

  /** The issuer's signing key `kid`, refreshing the key set once when it's unknown (a rotation). */
  async function keyFor(kid: string | undefined): Promise<KeyObject> {
    for (let pass = 0; pass < 2; pass++) {
      if (!keys || pass === 1 || now() - keys.at > 10 * 60_000) keys = { at: now(), list: (await getJson<{ keys: (JsonWebKey & { kid?: string })[] }>((await discover()).jwks_uri)).keys };
      const jwk = keys.list.find((k) => (kid ? k.kid === kid : true));
      if (jwk) return createPublicKey({ key: jwk, format: "jwk" });
    }
    throw new Error("The ID token was signed with a key the issuer doesn't publish.");
  }

  /** The ID token's claims, once its signature (RS256 or ES256 only), issuer, audience, times and nonce check out. */
  async function verifyIdToken(token: string, nonce: string): Promise<Record<string, unknown>> {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) throw new Error("The ID token isn't a JWT.");
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    const data = Buffer.from(`${h}.${p}`);
    const signature = Buffer.from(s, "base64url");
    const key = await keyFor(header.kid);
    const valid =
      header.alg === "RS256" ? verifySignature("RSA-SHA256", data, key, signature)
      : header.alg === "ES256" ? verifySignature("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature)
      : false;
    if (!valid) throw new Error(`The ID token's signature doesn't verify (${header.alg ?? "no alg"}).`);
    const d = await discover();
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const t = Math.floor(now() / 1000);
    if (claims.iss !== d.issuer) throw new Error("The ID token is from another issuer.");
    if (!audience.includes(config.clientId) || (audience.length > 1 && claims.azp !== config.clientId)) throw new Error("The ID token is for another client.");
    if (typeof claims.exp !== "number" || claims.exp < t - SKEW_S) throw new Error("The ID token has expired.");
    if (typeof claims.iat === "number" && claims.iat > t + SKEW_S) throw new Error("The ID token is from the future.");
    if (claims.nonce !== nonce) throw new Error("The ID token's nonce doesn't match this sign-in.");
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("The ID token has no subject.");
    return claims;
  }

  function rolesFrom(claims: Record<string, unknown>): Role[] {
    const raw = claims[config.rolesClaim];
    const values = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter((v): v is string => typeof v === "string");
    return [...new Set(config.roleMap ? values.map((v) => config.roleMap?.[v]).filter((r): r is Role => !!r) : asRoles(values))];
  }

  const hostOf = (issuer: string) => {
    try {
      return new URL(issuer).host;
    } catch {
      return issuer;
    }
  };

  function principal(c: Context): Principal | null {
    if (config.mode === "local") return local;
    const raw = getCookie(c, COOKIE);
    const s = raw ? store.getSession(sha256(raw)) : undefined;
    if (!s || Date.parse(s.expiresAt) <= now()) return null;
    return { actor: `oidc:${s.subject}@${hostOf(s.issuer)}`, name: s.name, roles: asRoles(s.roles), mode: "oidc" };
  }

  /** In oidc mode, everything but signing in needs a session. */
  const middleware: MiddlewareHandler = async (c, next) => {
    const p = principal(c);
    if (!p && !/\/auth\/(login|callback|me)$/.test(c.req.path)) {
      return c.json({ error: "Sign in first.", signIn: `/sf-api/auth/login` }, 401);
    }
    if (p) c.set("principal" as never, p as never);
    await next();
  };

  /** Only a path on this site: an open redirect would hand the session to anyone's page. */
  const safeReturn = (value: string | undefined) => (value && /^\/(?!\/)[^\s]*$/.test(value) ? value : "/autopilot");

  const routes = new Hono();

  routes.get("/me", (c) => {
    const p = principal(c);
    return c.json({ mode: config.mode, user: p ? { actor: p.actor, name: p.name, roles: p.roles } : null });
  });

  routes.get("/login", async (c) => {
    if (config.mode !== "oidc") return c.redirect(safeReturn(c.req.query("return")));
    const d = await discover();
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const nonce = b64url(randomBytes(16));
    for (const [k, v] of pending) if (v.expires < now()) pending.delete(k);
    pending.set(state, { verifier, nonce, returnTo: safeReturn(c.req.query("return")), expires: now() + LOGIN_TTL_MS });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes,
      state,
      nonce,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    });
    return c.redirect(`${d.authorization_endpoint}?${q}`);
  });

  routes.get("/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const login = pending.get(state);
    pending.delete(state); // one use
    if (!login || login.expires < now()) return c.json({ error: "This sign-in expired or wasn't started here. Sign in again." }, 400);
    const code = c.req.query("code");
    if (!code) return c.json({ error: `The identity provider didn't sign you in: ${c.req.query("error_description") ?? c.req.query("error") ?? "no code"}` }, 400);
    try {
      const d = await discover();
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: login.verifier });
      if (config.clientSecret) body.set("client_secret", config.clientSecret);
      const tokens = await getJson<{ id_token?: string }>(d.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      if (!tokens.id_token) throw new Error("The identity provider returned no ID token.");
      const claims = await verifyIdToken(tokens.id_token, login.nonce);
      const roles = rolesFrom(claims);
      const name = String(claims.name ?? claims.preferred_username ?? claims.email ?? claims.sub);
      const session = b64url(randomBytes(32));
      store.createSession({ idHash: sha256(session), subject: String(claims.sub), issuer: d.issuer, name, roles, expiresAt: new Date(now() + config.sessionHours * 3_600_000).toISOString() });
      setCookie(c, COOKIE, session, { httpOnly: true, sameSite: "Strict", path: "/sf-api", secure, maxAge: config.sessionHours * 3600 });
      void audit(`oidc:${String(claims.sub)}@${hostOf(d.issuer)}`, "auth.signed_in", "auth", { name, roles }).catch(() => undefined);
      return c.redirect(login.returnTo);
    } catch (err) {
      void audit("system", "auth.sign_in_refused", "auth", { reason: (err as Error).message.slice(0, 120) }).catch(() => undefined);
      return c.json({ error: `Sign-in refused: ${(err as Error).message}` }, 401);
    }
  });

  routes.post("/logout", (c) => {
    const raw = getCookie(c, COOKIE);
    const p = principal(c);
    if (raw) store.deleteSession(sha256(raw));
    deleteCookie(c, COOKIE, { path: "/sf-api" });
    if (p && p.mode === "oidc") void audit(p.actor, "auth.signed_out", "auth", {}).catch(() => undefined);
    return c.json({ ok: true });
  });

  return { mode: config.mode, middleware, routes, principal };
}

export type Auth = ReturnType<typeof createAuth>;
