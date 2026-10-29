import { expect, test } from "bun:test";
import { authConfig } from "./auth-config.ts";

test("without ZAYLA_URL there is no passkey configuration", () => {
  expect(authConfig({})).toBeNull();
  expect(authConfig({ ZAYLA_URL: "" })).toBeNull();
});

test("ZAYLA_URL gives the Relying Party its domain and origin", () => {
  expect(authConfig({ ZAYLA_URL: "https://docs.example.com" })).toEqual({
    rpID: "docs.example.com",
    rpOrigin: "https://docs.example.com",
    rpName: "Zayla",
  });
});

test("a trailing slash is the same address", () => {
  expect(authConfig({ ZAYLA_URL: "https://docs.example.com/" })?.rpOrigin).toBe(
    "https://docs.example.com",
  );
});

test("a port stays in the origin but not in the Relying Party ID", () => {
  expect(authConfig({ ZAYLA_URL: "https://docs.example.com:8443" })).toEqual({
    rpID: "docs.example.com",
    rpOrigin: "https://docs.example.com:8443",
    rpName: "Zayla",
  });
  expect(authConfig({ ZAYLA_URL: "http://localhost:3000" })?.rpID).toBe(
    "localhost",
  );
});

test("RP_NAME names Zayla in the passkey prompt", () => {
  expect(
    authConfig({ ZAYLA_URL: "https://docs.example.com", RP_NAME: "Our docs" })
      ?.rpName,
  ).toBe("Our docs");
});

test("an address Zayla can't be served at is refused, naming the variable", () => {
  for (const bad of [
    "docs.example.com",
    "ftp://docs.example.com",
    "https://docs.example.com/zayla",
    "https://docs.example.com/?x=1",
    "https://docs.example.com/#top",
    "https://me:secret@docs.example.com",
  ])
    expect(() => authConfig({ ZAYLA_URL: bad })).toThrow(/ZAYLA_URL/);
});
