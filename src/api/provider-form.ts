/**
 * Reading a Provider out of a request body, and listing the models an address
 * offers: shared by Settings' Provider routes and Setup's, which ask the same
 * questions with and without a session.
 */
import { listModels, listZeroRetentionModels } from "../core/enrich.ts";
import { isOpenRouterAddress, openRouterAddress } from "../core/openrouter.ts";

/** An http(s) address from a request body, trimmed; null when it is not one. */
export function httpAddress(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  try {
    const { protocol } = new URL(s);
    return protocol === "http:" || protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/** A Provider as a body names it, before its key: always with the address its Documents go to. */
export type NamedProvider =
  | {
      kind: "openrouter";
      baseUrl: string;
      model: string;
      zeroRetention: boolean;
    }
  | { kind: "custom"; baseUrl: string; model: string };

/**
 * The Provider a body names, or why it names none. A body naming no kind is
 * Custom, as every body was before OpenRouter was its own. OpenRouter takes
 * no address, and has Zero retention unless the body turns it off; Custom
 * takes any address but OpenRouter's, which is reached only by choosing it.
 */
export function namedProvider(
  body:
    | {
        kind?: unknown;
        baseUrl?: unknown;
        model?: unknown;
        zeroRetention?: unknown;
      }
    | null
    | undefined,
): NamedProvider | { error: string } {
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (body?.kind === "openrouter")
    return model
      ? {
          kind: "openrouter",
          baseUrl: openRouterAddress(),
          model,
          zeroRetention: body.zeroRetention !== false,
        }
      : { error: "an OpenRouter Provider needs a model" };
  if (body?.kind !== undefined && body.kind !== "custom")
    return { error: "a Provider is either OpenRouter or Custom" };
  const baseUrl = httpAddress(body?.baseUrl);
  if (!baseUrl || !model)
    return { error: "a Provider needs an http(s) address and a model" };
  if (isOpenRouterAddress(baseUrl))
    return { error: "that is OpenRouter's address: choose OpenRouter instead" };
  return { kind: "custom", baseUrl, model };
}

/** Where a body asks for models to be listed, and whether only those with Zero retention. */
export type Listing = { baseUrl: string; zeroRetention: boolean };

/**
 * Where a body asks for models to be listed: OpenRouter, keeping to Zero
 * retention unless the body turns it off, or the http(s) address it names.
 * Null when it names neither.
 */
export function listingFrom(
  body: { kind?: unknown; baseUrl?: unknown; zeroRetention?: unknown } | null,
): Listing | null {
  if (body?.kind === "openrouter")
    return {
      baseUrl: openRouterAddress(),
      zeroRetention: body.zeroRetention !== false,
    };
  const baseUrl = httpAddress(body?.baseUrl);
  return baseUrl ? { baseUrl, zeroRetention: false } : null;
}

/** The answer to a body that names no address to list models at. */
export const noAddressToList = () =>
  Response.json(
    { error: "listing models needs OpenRouter or an http(s) address" },
    { status: 400 },
  );

/**
 * The models a listing offers, as a response. An address that does not
 * answer is a 502: it was asked, and could not say, which is not the same as
 * offering nothing.
 */
export async function modelsAt(
  { baseUrl, zeroRetention }: Listing,
  apiKey: string | null,
): Promise<Response> {
  try {
    const models = zeroRetention
      ? await listZeroRetentionModels(baseUrl, apiKey)
      : await listModels(baseUrl, apiKey);
    return Response.json({ models });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
