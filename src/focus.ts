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

/**
 * Which tab a key moves to in a row of `count` tabs with `at` selected: the
 * index to select, or null for a key the row leaves to the browser.
 */
export function tabFor(key: string, count: number, at: number): number | null {
  switch (key) {
    case "ArrowRight":
      return (at + 1) % count;
    case "ArrowLeft":
      return (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
