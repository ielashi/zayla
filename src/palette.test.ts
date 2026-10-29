import { expect, test } from "bun:test";

/**
 * The palette is index.html's design tokens: one set on `:root`, and a second
 * under `prefers-color-scheme: dark`. These tests read both straight from the
 * stylesheet, so a token changed there is checked here without a copy to drift.
 */
const html = await Bun.file(`${import.meta.dir}/../index.html`).text();

/** The `--name: value` declarations in a block of CSS. */
function tokensIn(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/--([\w-]+):\s*([^;]+);/g))
    if (name && value) tokens.set(name, value.trim());
  return tokens;
}

const lightBlock = html.match(/<style>\s*:root\s*\{([^}]*)\}/)?.[1] ?? "";
const darkBlock =
  html.match(
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/,
  )?.[1] ?? "";
const light = tokensIn(lightBlock);
// The dark set restates only colours; everything else is the light set's.
const dark = new Map([...light, ...tokensIn(darkBlock)]);
const schemes = { light, dark };

/** WCAG 2's relative luminance of a `#RRGGBB` colour. */
function luminance(hex: string): number {
  const channels = (
    hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i) ?? []
  )
    .slice(1)
    .map((c) => {
      const s = Number.parseInt(c, 16) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
  if (channels.length !== 3) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

// Text, and what it is set on, wherever the stylesheet sets the pair.
const TEXT: [fg: string, bgs: string[]][] = [
  ["ink", ["paper", "ground", "line-soft", "accent-soft", "placeholder"]],
  ["ink-soft", ["paper", "ground", "line-soft", "placeholder"]],
  ["ink-faint", ["paper", "ground"]],
  ["accent", ["paper", "ground", "accent-soft"]],
  ["danger", ["paper", "ground"]],
  ["notice", ["paper", "ground"]],
  ["on-accent", ["accent", "accent-hover", "danger"]],
  ["on-ink", ["ink", "danger"]],
];
// Focus rings, and the grounds they are drawn against.
const RINGS: [ring: string, bgs: string[]][] = [
  ["accent", ["paper", "ground", "canvas", "accent-soft"]],
  ["danger", ["paper"]],
];

for (const [scheme, tokens] of Object.entries(schemes)) {
  const colour = (name: string) => {
    const value = tokens.get(name);
    if (!value) throw new Error(`no --${name} in the ${scheme} scheme`);
    return value;
  };

  for (const [fg, bgs] of TEXT)
    for (const bg of bgs)
      test(`${scheme}: --${fg} text on --${bg} meets WCAG AA (4.5:1)`, () => {
        expect(contrast(colour(fg), colour(bg))).toBeGreaterThanOrEqual(4.5);
      });

  for (const [ring, bgs] of RINGS)
    for (const bg of bgs)
      test(`${scheme}: a --${ring} focus ring on --${bg} meets WCAG AA (3:1)`, () => {
        expect(contrast(colour(ring), colour(bg))).toBeGreaterThanOrEqual(3);
      });

  // The placeholder's letters are large and bold, which AA holds to 3:1.
  test(`${scheme}: a placeholder's letters stand out from its stripes (3:1)`, () => {
    for (const bg of ["placeholder", "placeholder-stripe"])
      expect(contrast(colour("ink-faint"), colour(bg))).toBeGreaterThanOrEqual(
        3,
      );
  });
}

test("the dark scheme restates every colour the light scheme sets", () => {
  const colours = [...light].filter(([, v]) => /#|rgba?\(|url\(/.test(v));
  for (const [name] of colours)
    expect(tokensIn(darkBlock).has(name)).toBe(true);
});

test("the browser's own colours and the theme colour follow each scheme's ground", () => {
  expect(lightBlock).toContain("color-scheme: light dark;");
  for (const [scheme, tokens] of Object.entries(schemes))
    expect(html).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: ${scheme})" content="${tokens.get("ground")}">`,
    );
});
