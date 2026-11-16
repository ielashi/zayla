/**
 * The signed-in user's Connections, as Settings shows them under "connected
 * apps": the address to give an agent, and each agent they let in.
 */
import { requireAuth } from "../core/auth.ts";
import { zaylaOrigin } from "../core/auth-config.ts";
import { listConnections, removeConnection } from "../core/connections.ts";
import type { Library } from "../core/db.ts";
import { mcpResource } from "./oauth.ts";

const unauthorized = () =>
  Response.json({ error: "unauthorized" }, { status: 401 });

/** The connected-apps routes over this Library. */
export function connectionRoutes(lib: Library) {
  return {
    // The address is null while ZAYLA_URL is unset: there is then nothing an
    // agent could connect to, and Settings says why.
    "/api/connections": {
      GET: (req: Bun.BunRequest) => {
        const user = requireAuth(lib, req);
        if (!user) return unauthorized();
        const issuer = zaylaOrigin();
        return Response.json({
          address: issuer ? mcpResource(issuer) : null,
          connections: listConnections(lib, user.id),
        });
      },
    },

    "/api/connections/:id": {
      DELETE: (req: Bun.BunRequest<"/api/connections/:id">) => {
        const user = requireAuth(lib, req);
        if (!user) return unauthorized();
        return removeConnection(lib, user.id, req.params.id)
          ? new Response(null, { status: 204 })
          : new Response("not found", { status: 404 });
      },
    },
  };
}
