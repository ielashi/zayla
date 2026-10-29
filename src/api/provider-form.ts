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

/** A request body as these routes read it: what it says, unchecked. */
type ProviderBody =
  | {
      kind?: unknown;
      baseUrl?: unknown;
      model?: unknown;
      zeroRetention?: unknown;
    }
  | null
  | undefined;

/**
 * Where a body sends Documents, both to choose a Provider and to list its
 * models: always with the address they go to, and whether with Zero retention.
 */
export type Destination =
  | { kind: "openrouter"; baseUrl: string; zeroRetention: boolean }
  // A Custom Provider has no Zero retention to offer.
  | { kind: "custom"; baseUrl: string; zeroRetention: false };

/**
 * Where a body sends Documents, or why it names nowhere. A body naming no
 * kind is Custom, as every body was before OpenRouter was its own. OpenRouter
 * takes no address, and has Zero retention unless the body turns it off;
 * Custom takes any address but OpenRouter's, which is reached only by
 * choosing it.
 */
export function destinationFrom(
  body: ProviderBody,
): Destination | { error: string } {
  if (body?.kind === "openrouter")
    return {
      kind: "openrouter",
      baseUrl: openRouterAddress(),
      zeroRetention: body.zeroRetention !== false,
    };
  if (body?.kind !== undefined && body.kind !== "custom")
    return { error: "a Provider is either OpenRouter or Custom" };
  const baseUrl = httpAddress(body?.baseUrl);
  if (!baseUrl) return { error: "a Custom Provider needs an http(s) address" };
  if (isOpenRouterAddress(baseUrl))
    return { error: "that is OpenRouter's address: choose OpenRouter instead" };
  return { kind: "custom", baseUrl, zeroRetention: false };
}

/** The Provider a body names, before its key, or why it names none. */
export function namedProvider(
  body: ProviderBody,
): (Destination & { model: string }) | { error: string } {
  const destination = destinationFrom(body);
  if ("error" in destination) return destination;
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  return model
    ? { ...destination, model }
    : { error: "a Provider needs a model" };
}

/** The answer to a body that names nowhere to list models. */
export const noModelsListed = (error: string) =>
  Response.json({ error }, { status: 400 });

/**
 * The models a listing offers, as a response. An address that does not
 * answer is a 502: it was asked, and could not say, which is not the same as
 * offering nothing.
 */
export async function modelsAt(
  { baseUrl, zeroRetention }: Destination,
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
