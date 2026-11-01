/**
 * OpenRouter's address: where an OpenRouter Provider's Documents go, and the
 * address a Custom Provider may not name, so OpenRouter is reached only by
 * choosing it. The Recommended model too, which the browser reads, so nothing
 * here runs on import.
 */

/**
 * OpenRouter's one address. OPENROUTER_BASE_URL stands another in its place,
 * as the tests do, so an OpenRouter Provider can be read with offline.
 */
export const openRouterAddress = () =>
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

/** The model suggested for an OpenRouter Provider. Changed by release. */
export const RECOMMENDED_MODEL = "google/gemini-3.6-flash";

/** Whether an address is OpenRouter's, whatever its path or letter case. */
export function isOpenRouterAddress(address: string): boolean {
  try {
    const host = new URL(address).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}
