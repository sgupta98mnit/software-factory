// A stand-in OpenID Connect issuer: discovery, a signing key set, an
// authorize endpoint that signs in whoever the test names, and a token
// endpoint that checks PKCE and returns an RS256 ID token. Tests can make it
// sign with another key, for another audience, or with another nonce.
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeUser {
  sub: string;
  name: string;
  groups: string[];
}

export async function startFakeIssuer(opts: { clientId: string }) {
  const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(signing.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", use: "sig", alg: "RS256" };
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string; user: FakeUser }>();
  const tamper = { key: null as KeyObject | null, audience: null as string | null, nonce: null as string | null };
  let user: FakeUser = { sub: "sub-1", name: "Pat", groups: [] };
  let url = "";

  const jwt = (claims: Record<string, unknown>, key: KeyObject) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc(claims)}`;
    return `${head}.${createSign("RSA-SHA256").update(head).sign(key).toString("base64url")}`;
  };

  async function route(req: IncomingMessage, u: URL): Promise<[number, unknown, Record<string, string>?]> {
    if (u.pathname === "/.well-known/openid-configuration") {
      return [200, { issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, jwks_uri: `${url}/jwks` }];
    }
    if (u.pathname === "/jwks") return [200, { keys: [jwk] }];
    if (u.pathname === "/authorize") {
      const p = u.searchParams;
      if (p.get("code_challenge_method") !== "S256" || p.get("client_id") !== opts.clientId) return [400, { error: "invalid_request" }];
      const code = `code-${codes.size + 1}`;
      codes.set(code, { nonce: p.get("nonce") ?? "", challenge: p.get("code_challenge") ?? "", redirect: p.get("redirect_uri") ?? "", user });
      return [302, {}, { location: `${p.get("redirect_uri")}?code=${code}&state=${p.get("state")}` }];
    }
    if (u.pathname === "/token" && req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const form = new URLSearchParams(text);
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!grant || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge || form.get("redirect_uri") !== grant.redirect) {
        return [400, { error: "invalid_grant" }];
      }
      const t = Math.floor(Date.now() / 1000);
      const claims = { iss: url, aud: tamper.audience ?? opts.clientId, sub: grant.user.sub, name: grant.user.name, groups: grant.user.groups, nonce: tamper.nonce ?? grant.nonce, iat: t, exp: t + 600 };
      return [200, { id_token: jwt(claims, tamper.key ?? signing.privateKey), token_type: "Bearer" }];
    }
    return [404, { error: "not_found" }];
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, new URL(req.url ?? "/", "http://fake")).then(([status, body, headers]) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    tamper,
    otherKey: other.privateKey,
    /** Who the next sign-in is. */
    as(next: FakeUser) {
      user = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
