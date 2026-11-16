/**
 * Zayla as its own OAuth 2.1 authorization server, for agents that connect
 * over MCP (ADR 0004): the metadata that says where everything is, dynamic
 * client registration, the authorize step that ends in a Connection, and the
 * token endpoint for the authorization-code grant with PKCE (S256). Spread
 * into the server's route table by serve.ts; `/mcp` itself is in mcp.ts.
 *
 * Everything is named from ZAYLA_URL, never from the request's Host header:
 * behind a reverse proxy that is the local hop, and an issuer a request can
 * choose is one an attacker can choose. Without ZAYLA_URL there is no issuer,
 * and every endpoint here says connected apps are unavailable.
 */
import { requireAuth } from "../core/auth.ts";
import { zaylaOrigin } from "../core/auth-config.ts";
import { connectionUser, createConnection } from "../core/connections.ts";
import type { Library } from "../core/db.ts";
import { signInAddress } from "../routes.ts";
import { approvalPage, cannotConnectPage } from "./approval-page.ts";

/** A client as it registered itself: what it calls itself, and where it may be sent back to. */
type Client = { id: string; name: string; redirectUris: string[] };

/**
 * What the authorization server holds between requests, in memory only. A
 * restart forgets it: a client registers again, and an agent part way through
 * connecting starts over. Nothing here is a Connection, which is in its user's
 * file.
 */
export type Grants = {
  clients: Map<string, Client>;
  /** Approval pages shown and not yet answered, by the id their form carries. */
  approvals: Map<string, PendingApproval>;
  /** Authorization codes not yet exchanged, by code. */
  codes: Map<string, IssuedCode>;
  /** Access tokens, by token. */
  tokens: Map<string, AccessToken>;
};

export const newGrants = (): Grants => ({
  clients: new Map(),
  approvals: new Map(),
  codes: new Map(),
  tokens: new Map(),
});

/** What an agent asked for, held while its user decides. */
type PendingApproval = {
  userId: string;
  client: Client;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  createdAt: number;
};

/** A code the agent was sent back with, which it exchanges once for an access token. */
type IssuedCode = {
  userId: string;
  connectionId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  createdAt: number;
};

/** What an access token lets its bearer do: read as one user, through one Connection. */
type AccessToken = {
  userId: string;
  connectionId: string;
  createdAt: number;
};

/** How long an access token lasts. */
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

/** How long an approval page, once shown, can still be answered. */
const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** How long a code can be exchanged for: only as long as the agent takes to do it. */
const CODE_TTL_MS = 60 * 1000;

/** Forget whatever in `held` was made before `ttl` ago. */
function sweep<T extends { createdAt: number }>(
  held: Map<string, T>,
  ttl: number,
) {
  const cutoff = Date.now() - ttl;
  for (const [id, value] of held) if (value.createdAt < cutoff) held.delete(id);
}

/** A URL-safe random token of `bytes` bytes of entropy. */
function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

/** The longest name a client is shown under; past it, the name is cut. */
const MAX_CLIENT_NAME = 100;

/** Schemes nothing is ever sent back to: they run or read something here instead. */
const NEVER_REDIRECTED_TO = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
]);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a client may be sent back to `uri`. HTTPS anywhere, plain HTTP only
 * on this machine (an agent like Claude Code listening on a local port), and
 * an app's own scheme (RFC 8252), but never one that would run something.
 */
function isRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string") return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || NEVER_REDIRECTED_TO.has(url.protocol)) return false;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return url.protocol === "https:" ? url.hostname !== "" : true;
}

/** An OAuth error, as RFC 6749 shapes one. */
const oauthError = (error: string, description: string, status = 400) =>
  Response.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store" } },
  );

/**
 * Register a client (RFC 7591). Anyone may: a client is only a name and the
 * addresses it may be sent back to, and nothing comes of it until a user
 * approves it. Every client is public, proving itself with PKCE alone.
 */
async function registerClient(req: Request, grants: Grants): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    client_name?: unknown;
    redirect_uris?: unknown;
  } | null;
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isRedirectUri))
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris must be HTTPS addresses, HTTP ones on this machine, or an app's own scheme",
    );
  const name =
    typeof body?.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, MAX_CLIENT_NAME)
      : "An unnamed app";
  const client: Client = { id: randomToken(16), name, redirectUris: uris };
  grants.clients.set(client.id, client);
  return Response.json(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Where a client is shown as being sent back to: the host of a web address,
 * or the scheme and host of an app's own.
 */
function redirectDomain(uri: string): string {
  const url = new URL(uri);
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.hostname
    : `${url.protocol}//${url.host}`;
}

/**
 * Send the agent back to `redirectUri` with `params`, and the issuer, so a
 * client talking to several servers knows which one answered (RFC 9207).
 */
function sendBack(
  redirectUri: string,
  issuer: string,
  params: Record<string, string | null>,
  status = 302,
): Response {
  const back = new URL(redirectUri);
  for (const [key, value] of Object.entries(params))
    if (value !== null) back.searchParams.set(key, value);
  back.searchParams.set("iss", issuer);
  return new Response(null, {
    status,
    headers: { Location: back.href, "Cache-Control": "no-store" },
  });
}

/**
 * The authorize step. A request that names no client this server knows, or an
 * address that client didn't register, is answered here and never sent on:
 * sending it anywhere would make this server a way to bounce people to any
 * address. Anything else wrong with it goes back to the agent. A user who
 * isn't signed in signs in first and comes back; one who is is asked.
 */
function authorize(
  lib: Library,
  grants: Grants,
  req: Request,
  issuer: string,
): Response {
  const url = new URL(req.url);
  const params = url.searchParams;
  const client = grants.clients.get(params.get("client_id") ?? "");
  if (!client)
    return cannotConnectPage(
      "It isn't registered with Zayla. Try connecting from the app again.",
    );
  const asked = params.get("redirect_uri");
  const redirectUri =
    asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
  if (!redirectUri || !client.redirectUris.includes(redirectUri))
    return cannotConnectPage(
      "The address it asked to be sent back to isn't one it registered.",
    );
  const state = params.get("state");
  const refuse = (error: string, description: string) =>
    sendBack(redirectUri, issuer, {
      error,
      error_description: description,
      state,
    });
  if (params.get("response_type") !== "code")
    return refuse("unsupported_response_type", "only code is supported");
  const codeChallenge = params.get("code_challenge");
  if (!codeChallenge || params.get("code_challenge_method") !== "S256")
    return refuse("invalid_request", "PKCE with S256 is required");
  const resource = params.get("resource");
  if (resource !== null && resource !== mcpResource(issuer))
    return refuse(
      "invalid_target",
      `the only resource is ${mcpResource(issuer)}`,
    );

  const user = requireAuth(lib, req);
  if (!user)
    return new Response(null, {
      status: 302,
      headers: { Location: signInAddress(`${url.pathname}${url.search}`) },
    });

  sweep(grants.approvals, APPROVAL_TTL_MS);
  const id = randomToken();
  grants.approvals.set(id, {
    userId: user.id,
    client,
    redirectUri,
    codeChallenge,
    state,
    createdAt: Date.now(),
  });
  return approvalPage(client.name, redirectDomain(redirectUri), id);
}

/**
 * The user's answer on the approval page. The request it answers is good for
 * this one answer, by the user it was shown to, so a form posted from
 * anywhere else, or twice, grants nothing. Allowing makes the Connection, then
 * sends the agent back with a code for it; cancelling sends it back with
 * nothing.
 */
async function answerApproval(
  lib: Library,
  grants: Grants,
  req: Request,
  issuer: string,
): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const id = form?.get("request");
  const pending = typeof id === "string" ? grants.approvals.get(id) : undefined;
  if (typeof id === "string") grants.approvals.delete(id);
  const user = requireAuth(lib, req);
  if (
    !pending ||
    !user ||
    pending.userId !== user.id ||
    pending.createdAt < Date.now() - APPROVAL_TTL_MS
  )
    return cannotConnectPage(
      "This approval has expired. Try connecting from the app again.",
    );
  const decision = form?.get("decision");
  if (decision !== "allow")
    return sendBack(
      pending.redirectUri,
      issuer,
      {
        error: "access_denied",
        error_description: "the user cancelled",
        state: pending.state,
      },
      303,
    );

  const connection = createConnection(lib, user.id, {
    name: pending.client.name,
    redirectDomain: redirectDomain(pending.redirectUri),
  });
  sweep(grants.codes, CODE_TTL_MS);
  const code = randomToken();
  grants.codes.set(code, {
    userId: user.id,
    connectionId: connection.id,
    clientId: pending.client.id,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    createdAt: Date.now(),
  });
  return sendBack(
    pending.redirectUri,
    issuer,
    { code, state: pending.state },
    303,
  );
}

/** A PKCE verifier as RFC 7636 allows one: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * The token endpoint, for the authorization-code grant. A code is taken the
 * moment it is presented, so it buys at most one token whatever else is wrong
 * with the request; it buys one only from the client it was issued to, for the
 * address it was sent back to, with the verifier of its challenge, while its
 * Connection still stands.
 */
async function issueToken(
  lib: Library,
  grants: Grants,
  req: Request,
): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === "string" ? value : null;
  };
  if (field("grant_type") !== "authorization_code")
    return oauthError(
      "unsupported_grant_type",
      "only authorization_code is supported",
    );
  const code = field("code") ?? "";
  const issued = grants.codes.get(code);
  grants.codes.delete(code);
  const verifier = field("code_verifier") ?? "";
  if (
    !issued ||
    issued.createdAt < Date.now() - CODE_TTL_MS ||
    issued.clientId !== field("client_id") ||
    issued.redirectUri !== field("redirect_uri") ||
    !VERIFIER.test(verifier) ||
    new Bun.CryptoHasher("sha256").update(verifier).digest("base64url") !==
      issued.codeChallenge ||
    !connectionUser(lib, issued.userId, issued.connectionId)
  )
    return oauthError(
      "invalid_grant",
      "the code is unknown, used, expired, or not this client's",
    );

  sweep(grants.tokens, ACCESS_TOKEN_TTL_MS);
  const token = randomToken();
  grants.tokens.set(token, {
    userId: issued.userId,
    connectionId: issued.connectionId,
    createdAt: Date.now(),
  });
  return Response.json(
    {
      access_token: token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The user an access token reads as, or null for a token that is unknown,
 * lapsed, or whose Connection is gone.
 */
export function tokenUser(
  lib: Library,
  grants: Grants,
  token: string,
): string | null {
  const held = grants.tokens.get(token);
  if (!held) return null;
  if (held.createdAt < Date.now() - ACCESS_TOKEN_TTL_MS) {
    grants.tokens.delete(token);
    return null;
  }
  return connectionUser(lib, held.userId, held.connectionId);
}

/** The answer every endpoint for agents gives while ZAYLA_URL is unset. */
export const noConnectedApps = () =>
  Response.json(
    {
      error: "connected apps need ZAYLA_URL, the address Zayla is opened at",
    },
    { status: 503 },
  );

/** The address of the MCP endpoint an issuer serves: the resource tokens are for. */
export const mcpResource = (issuer: string) => `${issuer}/mcp`;

/** The protected-resource metadata for `/mcp`, at the address RFC 9728 gives it. */
export const PROTECTED_RESOURCE_PATH =
  "/.well-known/oauth-protected-resource/mcp";

/**
 * Answer with `handle`, given the issuer, or say connected apps are
 * unavailable when there is none.
 */
export function withIssuer<R extends Request>(
  handle: (req: R, issuer: string) => Response | Promise<Response>,
) {
  return (req: R) => {
    const issuer = zaylaOrigin();
    return issuer ? handle(req, issuer) : noConnectedApps();
  };
}

function protectedResource(issuer: string): Response {
  return Response.json({
    resource: mcpResource(issuer),
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
  });
}

/** The OAuth routes over this Library, holding what is in flight in `grants`. */
export function oauthRoutes(lib: Library, grants: Grants) {
  return {
    "/.well-known/oauth-authorization-server": {
      GET: withIssuer((_req, issuer) =>
        Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          registration_endpoint: `${issuer}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        }),
      ),
    },

    // A client that knows only `/mcp` finds the issuer here. Served at the
    // resource's own well-known address and at the bare one, which clients
    // written before RFC 9728's path form still ask for.
    [PROTECTED_RESOURCE_PATH]: {
      GET: withIssuer((_req, issuer) => protectedResource(issuer)),
    },
    "/.well-known/oauth-protected-resource": {
      GET: withIssuer((_req, issuer) => protectedResource(issuer)),
    },

    "/oauth/register": {
      POST: withIssuer((req) => registerClient(req, grants)),
    },

    "/oauth/authorize": {
      GET: withIssuer((req, issuer) => authorize(lib, grants, req, issuer)),
      POST: withIssuer((req, issuer) =>
        answerApproval(lib, grants, req, issuer),
      ),
    },

    "/oauth/token": {
      POST: withIssuer((req) => issueToken(lib, grants, req)),
    },
  };
}
