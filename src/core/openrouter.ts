/**
 * OpenRouter's address: where an OpenRouter Provider's Documents go, and the
 * address a Custom Provider may not name, so OpenRouter is reached only by
 * choosing it.
 */

/**
 * OpenRouter's one address. OPENROUTER_BASE_URL stands another in its place,
 * as the tests do, so an OpenRouter Provider can be read with offline.
 */
export const openRouterAddress = () =>
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

/** Whether an address is OpenRouter's, whatever its path or letter case. */
export function isOpenRouterAddress(address: string): boolean {
  try {
    const host = new URL(address).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}
