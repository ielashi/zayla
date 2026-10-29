/**
 * Setup HTTP routes, spread into the server's route table by serve.ts. Every
 * one refuses once the Library has a user, and then refuses anything that
 * doesn't carry the Setup code this process printed at boot, before it looks at
 * anything else in the request. Setup itself lives in ../core/setup.ts.
 */

import {
  countUsers,
  createSession,
  isAcceptablePassword,
  PASSWORD_RULE,
  sessionCookie,
} from "../core/auth.ts";
import type { Library } from "../core/db.ts";
import type { ProviderChoice } from "../core/enrich.ts";
import { completeSetup, isSetupCode, SetupClosed } from "../core/setup.ts";
import { readingLanguagesFrom } from "../languages.ts";
import {
  addressAndModel,
  httpAddress,
  modelsAt,
  noAddressToList,
} from "./provider-form.ts";

/** The answer every Setup route gives once the Library has a user. */
const setupClosed = () =>
  Response.json({ error: new SetupClosed().message }, { status: 403 });

/** A request body as Setup reads it: JSON, or nothing. */
const bodyOf = async (req: Request) =>
  ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

/**
 * Why this request may not go on with Setup, or null when it may: Setup is
 * over once anyone exists, and closed without the code. `code` is null when
 * the process booted with a user, and so printed none.
 */
function refuseSetup(
  lib: Library,
  code: string | null,
  typed: unknown,
): Response | null {
  if (countUsers(lib) > 0) return setupClosed();
  // Everyone was removed (`auth-reset`) after this process booted with a user,
  // so it printed no code: only a restart prints one.
  if (code === null)
    return Response.json(
      { error: "restart the server, and it will print a Setup code" },
      { status: 403 },
    );
  if (!isSetupCode(typed, code))
    return Response.json(
      { error: "that isn't the Setup code in the server's logs" },
      { status: 403 },
    );
  return null;
}

/** The Provider a Setup body chose, an error for one it chose badly, or null for none. */
function providerFrom(
  value: unknown,
): { provider: ProviderChoice | null } | { error: string } {
  if (value === undefined || value === null) return { provider: null };
  const v = value as { baseUrl?: unknown; model?: unknown; apiKey?: unknown };
  const named = addressAndModel(v);
  if ("error" in named) return named;
  const apiKey = typeof v.apiKey === "string" ? v.apiKey.trim() : null;
  return { provider: { ...named, apiKey } };
}

/** The routes for a server that printed `code` at boot (null: it printed none). */
export function setupRoutes(lib: Library, code: string | null) {
  return {
    // Check the code alone, so a wrong one is refused before anything else is
    // asked.
    "/api/setup/code": {
      POST: async (req: Bun.BunRequest) => {
        const body = await bodyOf(req);
        const refused = refuseSetup(lib, code, body.code);
        if (refused) return refused;
        return Response.json({ ok: true });
      },
    },

    // "List models" for Setup's Provider step, which has no session yet: the
    // code stands in for one. The key is the one typed, or none.
    "/api/setup/models": {
      POST: async (req: Bun.BunRequest) => {
        const body = await bodyOf(req);
        const refused = refuseSetup(lib, code, body.code);
        if (refused) return refused;
        const baseUrl = httpAddress(body.baseUrl);
        if (!baseUrl) return noAddressToList();
        const apiKey =
          typeof body.apiKey === "string" ? body.apiKey.trim() || null : null;
        return modelsAt(baseUrl, apiKey);
      },
    },

    // Finish: create the owner with a password, Reading languages and maybe a
    // Provider, all at once, and sign them in.
    "/api/setup": {
      POST: async (req: Bun.BunRequest) => {
        const body = await bodyOf(req);
        const refused = refuseSetup(lib, code, body.code);
        if (refused) return refused;
        if (!isAcceptablePassword(body.password))
          return Response.json({ error: PASSWORD_RULE }, { status: 400 });
        const languages = readingLanguagesFrom(body.languages);
        if ("error" in languages)
          return Response.json({ error: languages.error }, { status: 400 });
        const chosen = providerFrom(body.provider);
        if ("error" in chosen)
          return Response.json({ error: chosen.error }, { status: 400 });
        let owner: Awaited<ReturnType<typeof completeSetup>>;
        try {
          owner = await completeSetup(lib, {
            password: body.password,
            readingLanguages: languages.languages,
            provider: chosen.provider,
          });
        } catch (err) {
          if (err instanceof SetupClosed) return setupClosed();
          throw err;
        }
        const token = createSession(lib, owner.id);
        return Response.json(
          {
            authenticated: true,
            user: { id: owner.id, username: owner.username },
          },
          { headers: { "Set-Cookie": sessionCookie(req, token) } },
        );
      },
    },
  };
}
