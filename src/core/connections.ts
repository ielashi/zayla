/**
 * Connections: each one a user's permission for one agent to read the Library
 * on their behalf (ADR 0004). A Connection is kept in its user's file, like
 * everything else about them, so removing the user — `auth-reset` included —
 * removes their Connections with them.
 */
import { updateUser } from "./auth.ts";
import type { Library } from "./db.ts";
import type { ConnectionRecord } from "./user-file.ts";

/** Record that `userId` let the agent `name`, sent back to `redirectDomain`, read as them. */
export function createConnection(
  lib: Library,
  userId: string,
  agent: { name: string; redirectDomain: string },
): ConnectionRecord {
  const user = lib.users.get(userId);
  if (!user) throw new Error(`no user with id: ${userId}`);
  const connection: ConnectionRecord = {
    id: crypto.randomUUID(),
    name: agent.name,
    redirectDomain: agent.redirectDomain,
    grantedAt: new Date().toISOString(),
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
