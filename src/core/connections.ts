/**
 * Connections: each one a user's permission for one agent to read the Library
 * on their behalf (ADR 0004). A Connection is kept in its user's file, like
 * everything else about them, so removing the user — `auth-reset` included —
 * removes their Connections with them.
 */
import { randomToken, requireUser, updateUser } from "./auth.ts";
import type { Library } from "./db.ts";
import type { ConnectionRecord } from "./user-file.ts";

/**
 * Record that `userId` let the agent `name`, registered as `clientId` and sent
 * back to `redirectDomain`, read as them.
 */
export function createConnection(
  lib: Library,
  userId: string,
  agent: { name: string; redirectDomain: string; clientId: string },
): ConnectionRecord {
  const user = requireUser(lib, userId);
  const connection: ConnectionRecord = {
    id: crypto.randomUUID(),
    name: agent.name,
    redirectDomain: agent.redirectDomain,
    clientId: agent.clientId,
    grantedAt: new Date().toISOString(),
    refreshTokenHash: null,
    lastUsedAt: null,
  };
  updateUser(lib, { ...user, connections: [...user.connections, connection] });
  return connection;
}

/** The user a Connection reads as, while both it and they exist. */
export function connectionUser(
  lib: Library,
  userId: string,
  connectionId: string,
): string | null {
  const user = lib.users.get(userId);
  return user?.connections.some((c) => c.id === connectionId) ? user.id : null;
}

const hashOf = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

/**
 * Give a Connection a new refresh token, which from now on is the only one
 * that works for it, and record that its agent used it now. Only the token's
 * hash is written, so the user's file never holds one that works. Returns the
 * token, or null when the Connection or its user is gone.
 */
export function issueRefreshToken(
  lib: Library,
  userId: string,
  connectionId: string,
): string | null {
  if (!connectionUser(lib, userId, connectionId)) return null;
  const user = requireUser(lib, userId);
  const token = randomToken();
  const now = new Date().toISOString();
  updateUser(lib, {
    ...user,
    connections: user.connections.map((c) =>
      c.id === connectionId
        ? { ...c, refreshTokenHash: hashOf(token), lastUsedAt: now }
        : c,
    ),
  });
  return token;
}

/**
 * The Connection a refresh token is the current one for, with its user, or
 * null for a token that was replaced, never issued, issued to a client other
 * than `clientId`, or whose Connection is gone.
 */
export function refreshTokenConnection(
  lib: Library,
  token: string,
  clientId: string,
): { userId: string; connectionId: string } | null {
  const hash = hashOf(token);
  for (const user of lib.users.values())
    for (const c of user.connections)
      if (c.refreshTokenHash === hash && c.clientId === clientId)
        return { userId: user.id, connectionId: c.id };
  return null;
}
