import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parse } from "yaml";
import {
  newLibrary,
  type RunningZayla,
  type ServerOptions,
  signIn,
  startZayla,
  writeDocument,
  writeUser,
} from "./library.ts";

/** The address the server is told it is opened at, which is not where the tests reach it. */
const ZAYLA_URL = "https://zayla.example.com";

let zayla: RunningZayla | null = null;
let library = "";

afterEach(async () => {
  await zayla?.stop();
  zayla = null;
  await rm(library, { recursive: true, force: true });
});

async function start(options: ServerOptions = { zaylaUrl: ZAYLA_URL }) {
  library = await newLibrary();
  zayla = await startZayla(library, options);
  return zayla;
}

test("the metadata names ZAYLA_URL as the issuer and its /mcp as the resource", async () => {
  const { url } = await start();

  const server = await fetch(`${url}/.well-known/oauth-authorization-server`);
  expect(server.status).toBe(200);
  expect(await server.json()).toMatchObject({
    issuer: ZAYLA_URL,
    authorization_endpoint: `${ZAYLA_URL}/oauth/authorize`,
    token_endpoint: `${ZAYLA_URL}/oauth/token`,
    registration_endpoint: `${ZAYLA_URL}/oauth/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  });

  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    const resource = await fetch(`${url}${path}`);
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      resource: `${ZAYLA_URL}/mcp`,
      authorization_servers: [ZAYLA_URL],
    });
  }
});

/** Where the agent in these tests is sent back to. */
const REDIRECT_URI = "https://agent.example.org/oauth/callback";

async function register(
  url: string,
  client: Record<string, unknown> = {
    client_name: "Example Agent",
    redirect_uris: [REDIRECT_URI],
  },
) {
  return fetch(`${url}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(client),
  });
}

test("a client registers itself and is given a client id", async () => {
  const { url } = await start();

  const registered = await register(url);
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as Record<string, unknown>;
  expect(client).toMatchObject({
    client_name: "Example Agent",
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "none",
  });
  expect(client.client_id).toEqual(expect.any(String));
});

test("a client with no address to be sent back to, or a plain-HTTP one off this machine, is refused", async () => {
  const { url } = await start();

  for (const redirect_uris of [
    [],
    ["not an address"],
    ["http://agent.example.org/callback"],
    ["javascript:alert(1)"],
  ]) {
    const refused = await register(url, {
      client_name: "Agent",
      redirect_uris,
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: "invalid_redirect_uri",
    });
  }
  const local = await register(url, {
    client_name: "Local Agent",
    redirect_uris: ["http://localhost:33418/callback"],
  });
  expect(local.status).toBe(201);
});

const PASSWORD = "correct horse";

/** The words the approval page says, agreed for the page as they stand. */
const WHAT_IT_CAN_DO =
  "It will be able to search your documents and open them, including their full text and original files. Documents it opens are sent to its AI model; Zayla doesn't control what happens to them there. It can't add, change or delete anything.";

/** A PKCE pair (RFC 7636): the verifier the agent keeps, and the S256 challenge it sends. */
function pkce() {
  const verifier = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  const challenge = new Bun.CryptoHasher("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

/** The address an agent sends its user to, to be approved. */
function authorizePath(
  clientId: string,
  challenge: string,
  { namesRedirect = true } = {},
) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    ...(namesRedirect ? { redirect_uri: REDIRECT_URI } : {}),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${ZAYLA_URL}/mcp`,
  });
  return `/oauth/authorize?${params}`;
}

/**
 * A server with a user who signs in with PASSWORD, over a Library `seed`
 * writes whatever else into, and an agent registered with it.
 */
async function startWithAgent(seed?: (library: string) => Promise<void>) {
  library = await newLibrary();
  const userId = await writeUser(library, {
    username: "owner",
    password: PASSWORD,
  });
  await seed?.(library);
  zayla = await startZayla(library, { zaylaUrl: ZAYLA_URL });
  const client = (await (await register(zayla.url)).json()) as {
    client_id: string;
  };
  return { zayla, userId, clientId: client.client_id };
}

/**
 * Sign in, open the approval page for `clientId` and answer it. Returns where
 * the agent is sent back to.
 */
async function answerApproval(
  zayla: RunningZayla,
  clientId: string,
  challenge: string,
  decision: "allow" | "cancel",
  options: { namesRedirect?: boolean } = {},
): Promise<URL> {
  const session = await signIn(zayla, PASSWORD);
  const page = await (
    await fetch(`${zayla.url}${authorizePath(clientId, challenge, options)}`, {
      headers: { Cookie: session },
    })
  ).text();
  const request = page.match(/name="request" value="([^"]+)"/)?.[1];
  if (!request) throw new Error(`no approval form on the page:\n${page}`);
  const answered = await fetch(`${zayla.url}/oauth/authorize`, {
    method: "POST",
    headers: { Cookie: session },
    body: new URLSearchParams({ request, decision }),
    redirect: "manual",
  });
  expect(answered.status).toBe(303);
  const back = new URL(answered.headers.get("Location") ?? "");
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get("state")).toBe("xyz");
  expect(back.searchParams.get("iss")).toBe(ZAYLA_URL);
  return back;
}

/** The Connections in a user's file, as it says them. */
async function connectionsInFile(userId: string): Promise<unknown[]> {
  const file = parse(
    await Bun.file(join(library, "users", `${userId}.yaml`)).text(),
  ) as { connections?: unknown[] };
  return file.connections ?? [];
}

test("authorizing while signed out goes through sign-in and back to the approval page", async () => {
  const { zayla, clientId } = await startWithAgent();
  const authorize = authorizePath(clientId, pkce().challenge);

  const signedOut = await fetch(`${zayla.url}${authorize}`, {
    redirect: "manual",
  });
  expect(signedOut.status).toBe(302);
  const signInAt = new URL(signedOut.headers.get("Location") ?? "", zayla.url);
  expect(signInAt.pathname).toBe("/");
  expect(signInAt.searchParams.get("next")).toBe(authorize);
  const signInPage = await fetch(signInAt);
  expect(signInPage.status).toBe(200);
  expect(await signInPage.text()).toContain('id="gate"');

  const session = await signIn(zayla, PASSWORD);
  const approval = await fetch(
    `${zayla.url}${signInAt.searchParams.get("next")}`,
    { headers: { Cookie: session } },
  );
  expect(approval.status).toBe(200);
  const page = await approval.text();
  expect(page).toContain("Example Agent");
  expect(page).toContain("agent.example.org");
  expect(page).toContain(WHAT_IT_CAN_DO);
  expect(page).toContain(">Allow<");
  expect(page).toContain(">Cancel<");
});

test("cancelling grants nothing and creates no Connection", async () => {
  const { zayla, userId, clientId } = await startWithAgent();

  const back = await answerApproval(
    zayla,
    clientId,
    pkce().challenge,
    "cancel",
  );
  expect(back.searchParams.get("error")).toBe("access_denied");
  expect(back.searchParams.get("code")).toBeNull();
  expect(await connectionsInFile(userId)).toEqual([]);
});

test("allowing creates a Connection in the user's file and sends the agent back with a code", async () => {
  const { zayla, userId, clientId } = await startWithAgent();

  const back = await answerApproval(zayla, clientId, pkce().challenge, "allow");
  expect(back.searchParams.get("code")).toEqual(expect.any(String));
  expect(back.searchParams.get("error")).toBeNull();
  expect(await connectionsInFile(userId)).toEqual([
    {
      id: expect.any(String),
      name: "Example Agent",
      redirect_domain: "agent.example.org",
      client_id: clientId,
      granted_at: expect.any(String),
    },
  ]);
});

/** Exchange a code for a token, as an agent does. */
function exchange(
  zayla: RunningZayla,
  clientId: string,
  code: string,
  verifier: string,
  { namesRedirect = true } = {},
) {
  return fetch(`${zayla.url}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      ...(namesRedirect ? { redirect_uri: REDIRECT_URI } : {}),
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
}

/** Take an agent through approval and the exchange, to its access token. */
async function connectAgent(zayla: RunningZayla, clientId: string) {
  const { verifier, challenge } = pkce();
  const back = await answerApproval(zayla, clientId, challenge, "allow");
  const token = await exchange(
    zayla,
    clientId,
    back.searchParams.get("code") ?? "",
    verifier,
  );
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

test("the code, with the right verifier, buys an access token, once", async () => {
  const { zayla, clientId } = await startWithAgent();
  const { verifier, challenge } = pkce();
  const code =
    (
      await answerApproval(zayla, clientId, challenge, "allow")
    ).searchParams.get("code") ?? "";

  const token = await exchange(zayla, clientId, code, verifier);
  expect(token.status).toBe(200);
  expect(token.headers.get("Cache-Control")).toBe("no-store");
  expect(await token.json()).toMatchObject({
    access_token: expect.any(String),
    token_type: "Bearer",
    expires_in: expect.any(Number),
  });

  const reused = await exchange(zayla, clientId, code, verifier);
  expect(reused.status).toBe(400);
  expect(await reused.json()).toMatchObject({ error: "invalid_grant" });
});

test("a client with one address needn't name it, at either step", async () => {
  const { zayla, clientId } = await startWithAgent();
  const { verifier, challenge } = pkce();
  const unnamed = { namesRedirect: false };
  const code =
    (
      await answerApproval(zayla, clientId, challenge, "allow", unnamed)
    ).searchParams.get("code") ?? "";

  const token = await exchange(zayla, clientId, code, verifier, unnamed);
  expect(token.status).toBe(200);
});

test("the code with the wrong verifier buys nothing", async () => {
  const { zayla, clientId } = await startWithAgent();
  const code =
    (
      await answerApproval(zayla, clientId, pkce().challenge, "allow")
    ).searchParams.get("code") ?? "";

  const wrong = await exchange(zayla, clientId, code, pkce().verifier);
  expect(wrong.status).toBe(400);
  expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
});

test("/mcp without a token, or with one it never issued, is told where to get one", async () => {
  const { url } = await start();
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "probe", version: "0" },
    },
  };

  for (const authorization of [null, "Bearer not-a-token-it-issued"]) {
    const refused = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(initialize),
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ZAYLA_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  }
});

/** An MCP client from the SDK, connected to `zayla` with `token`. */
async function mcpClient(zayla: RunningZayla, token: string) {
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${zayla.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** What a tool call answered, read from the JSON its text carries. */
function resultOf(called: Awaited<ReturnType<Client["callTool"]>>) {
  const [first] = called.content as { type: string; text: string }[];
  if (first?.type !== "text") throw new Error("the tool answered no text");
  return JSON.parse(first.text);
}

test("a connected agent has one tool, search, which finds Documents as their user reads them", async () => {
  let lease = "";
  const { zayla, clientId } = await startWithAgent(async (library) => {
    lease = await writeDocument(library, {
      filename: "mietvertrag.pdf",
      content: "a German lease",
      texts: {
        DE: { title: "Mietvertrag für die Wohnung" },
        EN: { title: "Apartment rental contract" },
      },
      languages: ["DE"],
      date: "2024-03-01",
      sender: { organization: "Hausverwaltung Müller", person: "Hans Müller" },
      receiver: { person: "Jane Doe" },
      transcription: "Die Kaution beträgt drei Monatsmieten.",
    });
    await writeDocument(library, {
      filename: "bill.pdf",
      content: "an electricity bill",
      title: "Electricity bill",
    });
  });
  const agent = await mcpClient(zayla, await connectAgent(zayla, clientId));

  const { tools } = await agent.listTools();
  expect(tools.map((t) => t.name)).toEqual(["search"]);
  expect(tools[0]?.description).toContain("synonyms");
  expect(tools[0]?.description).toContain("translations");

  const found = resultOf(
    await agent.callTool({
      name: "search",
      arguments: { query: "rental contract" },
    }),
  );
  expect(found).toEqual({
    results: [
      {
        hash: lease,
        title: "Apartment rental contract",
        date: "2024-03-01",
        sender: {
          organization: "Hausverwaltung Müller",
          person: "Hans Müller",
        },
        receiver: { organization: null, person: "Jane Doe" },
        snippet: null,
      },
    ],
  });

  const deposit = resultOf(
    await agent.callTool({ name: "search", arguments: { query: "Kaution" } }),
  );
  expect(deposit.results).toHaveLength(1);
  expect(deposit.results[0].snippet).toContain("Kaution");

  expect(
    resultOf(
      await agent.callTool({
        name: "search",
        arguments: { query: "tax return" },
      }),
    ),
  ).toEqual({ results: [] });
  await agent.close();
});

test("without ZAYLA_URL, /mcp and the OAuth endpoints say connected apps are unavailable", async () => {
  const { url } = await start({});

  for (const [method, path] of [
    ["GET", "/.well-known/oauth-authorization-server"],
    ["GET", "/.well-known/oauth-protected-resource/mcp"],
    ["GET", "/.well-known/oauth-protected-resource"],
    ["POST", "/oauth/register"],
    ["GET", "/oauth/authorize?client_id=x"],
    ["POST", "/oauth/authorize"],
    ["POST", "/oauth/token"],
    ["POST", "/mcp"],
  ] as const) {
    const unavailable = await fetch(`${url}${path}`, { method });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: "connected apps need ZAYLA_URL, the address Zayla is opened at",
    });
  }
});

test("the code buys a refresh token along with the access token", async () => {
  const { zayla, clientId } = await startWithAgent();
  const { verifier, challenge } = pkce();
  const code =
    (
      await answerApproval(zayla, clientId, challenge, "allow")
    ).searchParams.get("code") ?? "";

  const token = await exchange(zayla, clientId, code, verifier);
  expect(await token.json()).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
  });
});

/** The tokens the token endpoint answered with. */
type Tokens = { access_token: string; refresh_token: string };

/** Take an agent through approval and the exchange, to both its tokens. */
async function connectAgentTokens(
  zayla: RunningZayla,
  clientId: string,
): Promise<Tokens> {
  const { verifier, challenge } = pkce();
  const back = await answerApproval(zayla, clientId, challenge, "allow");
  const token = await exchange(
    zayla,
    clientId,
    back.searchParams.get("code") ?? "",
    verifier,
  );
  expect(token.status).toBe(200);
  return (await token.json()) as Tokens;
}

/** Trade a refresh token for new tokens, as an agent does. */
function refresh(zayla: RunningZayla, clientId: string, refreshToken: string) {
  return fetch(`${zayla.url}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
}

test("a refresh token buys new tokens, once", async () => {
  const { zayla, clientId } = await startWithAgent();
  const first = await connectAgentTokens(zayla, clientId);

  const refreshed = await refresh(zayla, clientId, first.refresh_token);
  expect(refreshed.status).toBe(200);
  expect(refreshed.headers.get("Cache-Control")).toBe("no-store");
  const second = (await refreshed.json()) as Tokens & { token_type: string };
  expect(typeof second.access_token).toBe("string");
  expect(typeof second.refresh_token).toBe("string");
  expect(second.token_type).toBe("Bearer");
  expect(second.access_token).not.toBe(first.access_token);
  expect(second.refresh_token).not.toBe(first.refresh_token);

  const reused = await refresh(zayla, clientId, first.refresh_token);
  expect(reused.status).toBe(400);
  expect(await reused.json()).toMatchObject({ error: "invalid_grant" });

  expect((await refresh(zayla, clientId, second.refresh_token)).status).toBe(
    200,
  );
});

test("a refresh token buys nothing for another client", async () => {
  const { zayla, clientId } = await startWithAgent();
  const { refresh_token } = await connectAgentTokens(zayla, clientId);
  const other = (await (await register(zayla.url)).json()) as {
    client_id: string;
  };

  const refused = await refresh(zayla, other.client_id, refresh_token);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: "invalid_grant" });
});

test("a refresh token outlives a restart, and what it buys reaches /mcp", async () => {
  const {
    zayla: before,
    userId,
    clientId,
  } = await startWithAgent(async (library) => {
    await writeDocument(library, {
      filename: "bill.pdf",
      content: "an electricity bill",
      title: "Electricity bill",
    });
  });
  const first = await connectAgentTokens(before, clientId);
  await before.stop();
  zayla = await startZayla(library, { zaylaUrl: ZAYLA_URL });

  const refreshed = await refresh(zayla, clientId, first.refresh_token);
  expect(refreshed.status).toBe(200);
  const second = (await refreshed.json()) as Tokens;
  const agent = await mcpClient(zayla, second.access_token);
  const found = resultOf(
    await agent.callTool({ name: "search", arguments: { query: "bill" } }),
  );
  expect(found.results.map((r: { title: string }) => r.title)).toEqual([
    "Electricity bill",
  ]);
  await agent.close();

  const file = await Bun.file(join(library, "users", `${userId}.yaml`)).text();
  for (const token of [first, second].flatMap((t) => [
    t.access_token,
    t.refresh_token,
  ]))
    expect(file).not.toContain(token);
});

test("a Connection's last use is recorded when it refreshes, and not on each call", async () => {
  const { zayla, userId, clientId } = await startWithAgent();
  const first = await connectAgentTokens(zayla, clientId);
  const lastUsed = async () =>
    ((await connectionsInFile(userId))[0] as { last_used_at?: string })
      .last_used_at;
  const connected = await lastUsed();
  expect(connected).toEqual(expect.any(String));

  const agent = await mcpClient(zayla, first.access_token);
  await agent.callTool({ name: "search", arguments: { query: "bill" } });
  await agent.close();
  expect(await lastUsed()).toBe(connected);

  await Bun.sleep(5);
  expect((await refresh(zayla, clientId, first.refresh_token)).status).toBe(
    200,
  );
  const refreshed = await lastUsed();
  expect(Date.parse(refreshed ?? "")).toBeGreaterThan(
    Date.parse(connected ?? ""),
  );
});
