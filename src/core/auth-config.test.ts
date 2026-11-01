import { expect, test } from "bun:test";
import { authConfig } from "./auth-config.ts";

test("without ZAYLA_URL there is no passkey configuration", () => {
  expect(authConfig({})).toBeNull();
  expect(authConfig({ ZAYLA_URL: "" })).toBeNull();
});

test("ZAYLA_URL gives the Relying Party its domain and origin", () => {
  expect(authConfig({ ZAYLA_URL: "https://zayla.example.com" })).toEqual({
    rpID: "zayla.example.com",
    rpOrigin: "https://zayla.example.com",
    rpName: "Zayla",
  });
});

test("a trailing slash is the same address", () => {
  expect(
    authConfig({ ZAYLA_URL: "https://zayla.example.com/" })?.rpOrigin,
  ).toBe("https://zayla.example.com");
});

test("a port stays in the origin but not in the Relying Party ID", () => {
  expect(authConfig({ ZAYLA_URL: "https://zayla.example.com:8443" })).toEqual({
    rpID: "zayla.example.com",
    rpOrigin: "https://zayla.example.com:8443",
    rpName: "Zayla",
  });
  expect(authConfig({ ZAYLA_URL: "http://localhost:3000" })?.rpID).toBe(
    "localhost",
  );
});

test("RP_NAME names Zayla in the passkey prompt", () => {
  expect(
    authConfig({ ZAYLA_URL: "https://zayla.example.com", RP_NAME: "Our docs" })
      ?.rpName,
  ).toBe("Our docs");
});

test("an address Zayla can't be served at is refused, naming the variable", () => {
  for (const bad of [
    "zayla.example.com",
    "ftp://zayla.example.com",
    "https://zayla.example.com/zayla",
    "https://zayla.example.com/?x=1",
    "https://zayla.example.com/#top",
    "https://me:secret@zayla.example.com",
  ])
    expect(() => authConfig({ ZAYLA_URL: bad })).toThrow(/ZAYLA_URL/);
});
