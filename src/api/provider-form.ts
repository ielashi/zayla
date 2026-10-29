/**
 * Reading a Provider out of a request body, and listing the models an address
 * offers: shared by Settings' Provider routes and Setup's, which ask the same
 * questions with and without a session.
 */
import { listModels } from "../core/enrich.ts";

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

/** The address and model a body names, or why it names no Provider. */
export function addressAndModel(
  body: { baseUrl?: unknown; model?: unknown } | null | undefined,
): { baseUrl: string; model: string } | { error: string } {
  const baseUrl = httpAddress(body?.baseUrl);
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  return baseUrl && model
    ? { baseUrl, model }
    : { error: "a Provider needs an http(s) address and a model" };
}

/** The answer to a body that names no address to list models at. */
export const noAddressToList = () =>
  Response.json(
    { error: "listing models needs an http(s) address" },
    { status: 400 },
  );

/**
 * The models an address offers, as a response. An address that does not
 * answer is a 502: it was asked, and could not say, which is not the same as
 * offering nothing.
 */
export async function modelsAt(
  baseUrl: string,
  apiKey: string | null,
): Promise<Response> {
  try {
    return Response.json({ models: await listModels(baseUrl, apiKey) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
