/**
 * WebAuthn / session configuration, read once from the environment.
 *
 * Zayla runs behind a reverse proxy (a Cloudflare tunnel): the Bun server
 * terminates plain HTTP locally while the browser talks to `https://<domain>`.
 * WebAuthn binds every ceremony to the Relying Party ID and origin, so those
 * MUST come from configuration — never derived from the incoming request, whose
 * scheme/host reflect the local hop, not what the browser saw. See README.
 */
export type AuthConfig = {
  /** Relying Party ID — the bare domain (no scheme, no port), e.g. "docs.example.com". */
  rpID: string;
  /** Exact origin the browser sees, e.g. "https://docs.example.com". */
  rpOrigin: string;
  /** Human-facing name shown in the passkey prompt. */
  rpName: string;
};

let cached: AuthConfig | null = null;

/** Resolve auth config from env (RP_ID / RP_ORIGIN / RP_NAME), with localhost dev defaults. */
export function authConfig(): AuthConfig {
  if (cached) return cached;
  const rpID = process.env.RP_ID ?? "localhost";
  const rpOrigin = process.env.RP_ORIGIN ?? "http://localhost:3000";
  const rpName = process.env.RP_NAME ?? "zayla";
  cached = { rpID, rpOrigin, rpName };
  return cached;
}
