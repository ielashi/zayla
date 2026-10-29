/**
 * Where Tab moves focus inside a modal, given how many controls it has and
 * which of them has focus: the index to focus, or null to leave the step to
 * the browser.
 */
export function wrapFocus(
  count: number,
  at: number,
  back: boolean,
): number | null {
  if (count === 0) return null;
  if (at === -1) return back ? count - 1 : 0;
  if (!back && at === count - 1) return 0;
  if (back && at === 0) return count - 1;
  return null;
}
