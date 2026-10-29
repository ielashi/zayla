/**
 * WebAuthn configuration, read from the environment.
 *
 * Zayla usually runs behind a reverse proxy: the Bun server terminates plain
 * HTTP locally while the browser talks to `https://<domain>`. WebAuthn binds
 * every ceremony to the Relying Party ID and origin, so those MUST come from
 * configuration — never derived from the incoming request, whose scheme/host
 * reflect the local hop, not what the browser saw. One variable, ZAYLA_URL,
 * names the address the browser opens; without it there are no passkeys, and
 * passwords are the way in. See README.
 */
export type AuthConfig = {
  /** Relying Party ID — the bare domain (no scheme, no port), e.g. "docs.example.com". */
  rpID: string;
  /** Exact origin the browser sees, e.g. "https://docs.example.com". */
  rpOrigin: string;
  /** Human-facing name shown in the passkey prompt. */
  rpName: string;
};

type Env = Record<string, string | undefined>;

/**
 * The passkey configuration ZAYLA_URL describes, or null when it is unset.
 * Throws, naming the variable, for an address Zayla can't be served at: not
 * http(s), or more than an origin (a path, query, fragment or credentials).
 */
export function authConfig(env: Env = process.env): AuthConfig | null {
  const raw = env.ZAYLA_URL?.trim();
  if (!raw) return null;
  const refuse = (why: string) =>
    new Error(
      `ZAYLA_URL=${raw} ${why}; give an origin like https://docs.example.com`,
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse("isn't an address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw refuse("isn't http or https");
  if (url.username || url.password) throw refuse("carries credentials");
  if (url.pathname !== "/" || url.search || url.hash)
    throw refuse(
      "has more than an origin; Zayla is served at the root of its address",
    );
  return {
    rpID: url.hostname,
    rpOrigin: url.origin,
    rpName: env.RP_NAME?.trim() || "Zayla",
  };
}
