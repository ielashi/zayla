import { describe, expect, test } from "bun:test";
import { join as joinPath } from "node:path";
import { escapeHtml, html, join, raw, setHtml } from "./html.ts";

describe("html", () => {
  test("escapes every value put into it", () => {
    const title = `<img src=x onerror="alert('hi')"> & more`;
    expect(html`<h2>${title}</h2>`.markup).toBe(
      "<h2>&lt;img src=x onerror=&quot;alert(&#39;hi&#39;)&quot;&gt; &amp; more</h2>",
    );
  });

  test("keeps an attribute's value inside its quotes", () => {
    expect(html`<a title="${`" onclick="x`}">`.markup).toBe(
      '<a title="&quot; onclick=&quot;x">',
    );
    expect(html`<a title='${"' onclick='x"}'>`.markup).toBe(
      "<a title='&#39; onclick=&#39;x'>",
    );
  });

  test("puts markup from another template in as it is", () => {
    const name = html`<strong>${"<b>"}</strong>`;
    expect(html`<p>${name}</p>`.markup).toBe(
      "<p><strong>&lt;b&gt;</strong></p>",
    );
  });

  test("puts a list in item by item, each escaped or kept as it is", () => {
    expect(html`<ul>${["<a>", html`<li>b</li>`]}</ul>`.markup).toBe(
      "<ul>&lt;a&gt;<li>b</li></ul>",
    );
  });

  test("puts nothing in for null, undefined and false", () => {
    expect(html`[${null}${undefined}${false}]`.markup).toBe("[]");
  });

  test("writes numbers as text", () => {
    expect(html`${0} of ${12}`.markup).toBe("0 of 12");
  });
});

test("join separates items with markup, escaping text items", () => {
  expect(join(["a<", html`<i>b</i>`], html`<br>`).markup).toBe(
    "a&lt;<br><i>b</i>",
  );
});

test("raw trusts the markup it is given", () => {
  expect(html`<svg>${raw('<path d="M1 1"/>')}</svg>`.markup).toBe(
    '<svg><path d="M1 1"/></svg>',
  );
});

test("escapeHtml leaves plain text alone", () => {
  expect(escapeHtml("Stadtwerke München")).toBe("Stadtwerke München");
});

test("setHtml writes the markup into the element", () => {
  const node = { innerHTML: "" };
  setHtml(node, html`<p>${"<x>"}</p>`);
  expect(node.innerHTML).toBe("<p>&lt;x&gt;</p>");
});

// What the module is for only holds while nothing goes around it, so the
// frontend is read for the ways markup could reach the page without it.
test("the frontend writes markup only through setHtml", async () => {
  const source = await Bun.file(
    joinPath(import.meta.dir, "..", "frontend.ts"),
  ).text();
  const sinks = source.match(
    /\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML|document\.write|\bon[a-z]+="/g,
  );
  expect(sinks).toBeNull();
});
