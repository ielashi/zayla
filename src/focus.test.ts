import { expect, test } from "bun:test";
import { tabFor, wrapFocus } from "./focus.ts";

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

test("ArrowRight and ArrowLeft move to the neighbouring tab, wrapping round", () => {
  expect(tabFor("ArrowRight", 3, 0)).toBe(1);
  expect(tabFor("ArrowRight", 3, 2)).toBe(0);
  expect(tabFor("ArrowLeft", 3, 0)).toBe(2);
  expect(tabFor("ArrowLeft", 3, 1)).toBe(0);
});

test("Home and End go to the first and last tab", () => {
  expect(tabFor("Home", 3, 1)).toBe(0);
  expect(tabFor("End", 3, 1)).toBe(2);
});

test("any other key is left to the browser", () => {
  expect(tabFor("ArrowDown", 3, 1)).toBeNull();
  expect(tabFor("Enter", 3, 1)).toBeNull();
});
