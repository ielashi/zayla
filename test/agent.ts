/**
 * An agent connected to Zayla the way a real one connects: it registers,
 * its user signs in and allows it, and it trades the code for an access token,
 * all over HTTP. For tests about what a connected agent can do; the steps
 * themselves are tested in connect-agent.test.ts.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type RunningZayla, signIn } from "./library.ts";

const REDIRECT_URI = "https://agent.example.org/oauth/callback";

/** An SDK MCP client, connected to `zayla` as the user who signs in with `password`. */
export async function connectedAgent(
  zayla: RunningZayla,
  password: string,
): Promise<Client> {
  const registered = await fetch(`${zayla.url}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Agent",
      redirect_uris: [REDIRECT_URI],
    }),
  });
  const { client_id } = (await registered.json()) as { client_id: string };

  const verifier = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  const challenge = new Bun.CryptoHasher("sha256")
    .update(verifier)
    .digest("base64url");
  const session = await signIn(zayla, password);
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const page = await (
    await fetch(`${zayla.url}/oauth/authorize?${authorize}`, {
      headers: { Cookie: session },
    })
  ).text();
  const request = page.match(/name="request" value="([^"]+)"/)?.[1];
  if (!request) throw new Error(`no approval form on the page:\n${page}`);
  const allowed = await fetch(`${zayla.url}/oauth/authorize`, {
    method: "POST",
    headers: { Cookie: session },
    body: new URLSearchParams({ request, decision: "allow" }),
    redirect: "manual",
  });
  const code = new URL(allowed.headers.get("Location") ?? "").searchParams.get(
    "code",
  );
  if (!code) throw new Error(`allowing gave no code: ${allowed.status}`);

  const token = await fetch(`${zayla.url}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id,
      code_verifier: verifier,
    }),
  });
  const { access_token } = (await token.json()) as { access_token: string };

  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${zayla.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${access_token}` } },
    }),
  );
  return client;
}
