import { expect, test } from "bun:test";
import { wrapFocus } from "./focus.ts";

test("Tab from the last control comes round to the first", () => {
  expect(wrapFocus(4, 3, false)).toBe(0);
});

test("Shift+Tab from the first control goes round to the last", () => {
  expect(wrapFocus(4, 0, true)).toBe(3);
});

test("Tab with focus outside the modal brings it back in, at the end it moves toward", () => {
  expect(wrapFocus(4, -1, false)).toBe(0);
  expect(wrapFocus(4, -1, true)).toBe(3);
});

test("Tab between controls in the middle is left to the browser", () => {
  expect(wrapFocus(4, 1, false)).toBeNull();
  expect(wrapFocus(4, 2, true)).toBeNull();
});

test("a modal with nothing to focus leaves focus where it is", () => {
  expect(wrapFocus(0, -1, false)).toBeNull();
  expect(wrapFocus(0, -1, true)).toBeNull();
});
