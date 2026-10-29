import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  clearAllAuth,
  createSession,
  createUser,
  insertCredential,
  SESSION_COOKIE,
  setPassword,
} from "./core/auth.ts";
import { authConfig } from "./core/auth-config.ts";
import {
  closeLibrary,
  deleteDocument,
  insertDocument,
  type Library,
  openLibrary,
  updateEnrichment,
} from "./core/db.ts";
import { writeTranscription } from "./core/transcription.ts";
import { startServer } from "./serve.ts";
import type {
  ApiBrowse,
  ApiDocument,
  ApiEntityPage,
  ApiMergeOutcome,
  ApiProvider,
  ApiSearchHit,
  ApiUnmergeOutcome,
  Party,
} from "./shared.ts";

const TMP = `/tmp/dm-serve-test-${process.pid}`; // the library under test

// The Library the server under test serves, open for the whole test.
let library: Library;

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
  library = openLibrary(TMP);
});
afterEach(async () => {
  closeLibrary(library);
  await rm(TMP, { recursive: true, force: true });
});

/**
 * Create a user + session in the test library and return the Cookie header
 * value. Named, so a test can have two users of one Library and keep them
 * apart.
 */
function authCookie(username = "tester"): string {
  const user = createUser(library, username, username);
  return `${SESSION_COOKIE}=${createSession(library, user.id)}`;
}

/** A minimal PNG (valid magic bytes) so content-based mime sniffing detects image/png. */
const pngBlob = () =>
  new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    "shot.png",
    {
      type: "image/png",
    },
  );

const base = (server: ReturnType<typeof startServer>) =>
  server.url.toString().replace(/\/$/, "");

type ApiItem = {
  hash: string;
  filename: string;
  mime: string;
  status: string;
  deduped: boolean;
};
const asItems = (v: unknown) => v as ApiItem[];

test("POST /api/documents imports an uploaded file and it appears in the list", async () => {
  const server = startServer(0, library); // ephemeral port
  try {
    const url = base(server);
    const cookie = authCookie();
    const form = new FormData();
    form.append("files", pngBlob());

    const res = await fetch(`${url}/api/documents`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(200);
    const items = asItems(await res.json());
    expect(items.length).toBe(1);
    expect(items[0]?.filename).toBe("shot.png");
    expect(items[0]?.mime).toBe("image/png");
    expect(items[0]?.status).toBe("imported");
    expect(items[0]?.deduped).toBe(false);
    expect(items[0]?.hash).toMatch(/^[0-9a-f]{64}$/);

    const list = asItems(
      await (
        await fetch(`${url}/api/documents`, { headers: { cookie } })
      ).json(),
    );
    expect(list.length).toBe(1);
    expect(list[0]?.hash).toBe(items[0]?.hash);
  } finally {
    server.stop(true);
  }
});

test("re-uploading the same content dedupes", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    const post = async () => {
      const form = new FormData();
      form.append("files", pngBlob());
      const r = await fetch(`${url}/api/documents`, {
        method: "POST",
        headers: { cookie },
        body: form,
      });
      return asItems(await r.json());
    };

    await post();
    const second = await post();
    expect(second[0]?.deduped).toBe(true);

    const list = asItems(
      await (
        await fetch(`${url}/api/documents`, { headers: { cookie } })
      ).json(),
    );
    expect(list.length).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("POST /api/documents with no files returns 400", async () => {
  const server = startServer(0, library);
  try {
    const res = await fetch(`${base(server)}/api/documents`, {
      method: "POST",
      headers: { cookie: authCookie() },
      body: new FormData(),
    });
    expect(res.status).toBe(400);
  } finally {
    server.stop(true);
  }
});

test("document endpoints require authentication", async () => {
  const server = startServer(0, library);
  try {
    const res = await fetch(`${base(server)}/api/documents`);
    expect(res.status).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("a passkey is added by someone signed in, never by a stranger", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const options = (cookie?: string) =>
      fetch(`${url}/api/auth/register/options`, {
        method: "POST",
        headers: cookie ? { cookie } : {},
      });
    // Not even while the Library has nobody: its first user comes from Setup.
    expect((await options()).status).toBe(401);
    const cookie = authCookie("owner");
    expect((await options()).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/auth/register/verify`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect((await options(cookie)).status).toBe(200);
  } finally {
    server.stop(true);
  }
});

// ---- password sign-in ----

/** Give the Library its one user, signing in with `password` (and no passkey). */
async function ownerWithPassword(password: string): Promise<void> {
  await setPassword(
    library,
    createUser(library, "owner", "owner").id,
    password,
  );
}

const signIn = (
  server: ReturnType<typeof startServer>,
  password: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${base(server)}/api/auth/password/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });

/** The session cookie a response set, with its attributes, or "". */
const setSessionCookie = (res: Response): string =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ??
  "";

/** The session cookie a response set, as `name=value`, ready to send back. */
const sessionFrom = (res: Response): string =>
  setSessionCookie(res).split(";")[0] ?? "";

test("the right password signs the owner in, with no username asked", async () => {
  await ownerWithPassword("correct horse battery");
  const server = startServer(0, library);
  try {
    const res = await signIn(server, "correct horse battery");
    expect(res.status).toBe(200);
    const cookie = sessionFrom(res);
    expect(cookie).not.toBe("");

    const docs = await fetch(`${base(server)}/api/documents`, {
      headers: { cookie },
    });
    expect(docs.status).toBe(200);
  } finally {
    server.stop(true);
  }
});

test("a wrong password is refused, saying no more than when there is no account", async () => {
  const server = startServer(0, library);
  try {
    // Nobody has a password yet…
    const noAccount = await signIn(server, "correct horse battery");
    await ownerWithPassword("correct horse battery");
    // …and now the owner does, but this isn't it.
    const wrong = await signIn(server, "correct horse batteries");

    for (const res of [noAccount, wrong]) {
      expect(res.status).toBe(401);
      expect(sessionFrom(res)).toBe("");
    }
    expect(await wrong.json()).toEqual(await noAccount.json());
    expect((await signIn(server, 12345678)).status).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("the session cookie is Secure only when the browser came over HTTPS", async () => {
  await ownerWithPassword("correct horse battery");
  const server = startServer(0, library);
  try {
    const setCookie = async (headers: Record<string, string>) =>
      setSessionCookie(await signIn(server, "correct horse battery", headers));

    // A LAN address over plain HTTP: a Secure cookie would never come back.
    const plain = await setCookie({ origin: "http://192.168.1.20:3000" });
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("Max-Age=2592000"); // the usual 30 days
    expect(plain).not.toContain("Secure");

    // Behind a TLS-terminating proxy, the browser's own scheme is what counts.
    expect(await setCookie({ origin: "https://docs.example.com" })).toContain(
      "Secure",
    );
    expect(await setCookie({ "x-forwarded-proto": "https" })).toContain(
      "Secure",
    );
  } finally {
    server.stop(true);
  }
});

const choosePassword = (
  server: ReturnType<typeof startServer>,
  cookie: string,
  body: { password?: unknown; currentPassword?: unknown },
) =>
  fetch(`${base(server)}/api/auth/password`, {
    method: "PUT",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const me = async (server: ReturnType<typeof startServer>, cookie: string) =>
  (await (
    await fetch(`${base(server)}/api/auth/me`, { headers: { cookie } })
  ).json()) as { authenticated: boolean; user: { hasPassword: boolean } };

test("a passkey-only user can add a password, and then sign in with it", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie("owner");
    expect((await me(server, cookie)).user.hasPassword).toBe(false);

    const res = await choosePassword(server, cookie, {
      password: "correct horse battery",
    });
    expect(res.status).toBe(200);
    expect((await me(server, cookie)).user.hasPassword).toBe(true);

    const signedIn = await signIn(server, "correct horse battery");
    expect(signedIn.status).toBe(200);
  } finally {
    server.stop(true);
  }
});

test("changing a password takes the current one, and only then replaces it", async () => {
  await ownerWithPassword("correct horse battery");
  const server = startServer(0, library);
  try {
    const cookie = sessionFrom(await signIn(server, "correct horse battery"));
    const next = "tr0ub4dor & three";

    for (const currentPassword of [undefined, "not the password"]) {
      const refused = await choosePassword(server, cookie, {
        password: next,
        currentPassword,
      });
      expect(refused.status).toBe(403);
    }
    expect((await signIn(server, next)).status).toBe(401);

    const changed = await choosePassword(server, cookie, {
      password: next,
      currentPassword: "correct horse battery",
    });
    expect(changed.status).toBe(200);
    expect((await signIn(server, next)).status).toBe(200);
    expect((await signIn(server, "correct horse battery")).status).toBe(401);
    // The session it was changed from carries on.
    expect((await me(server, cookie)).authenticated).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("a password under 8 characters is refused, saying why, and nothing else is", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie("owner");
    for (const password of ["seven77", "", undefined]) {
      const res = await choosePassword(server, cookie, { password });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("8");
    }
    expect((await me(server, cookie)).user.hasPassword).toBe(false);

    // No rules beyond the length: eight of anything will do.
    const eight = await choosePassword(server, cookie, {
      password: "aaaaaaaa",
    });
    expect(eight.status).toBe(200);
  } finally {
    server.stop(true);
  }
});

/**
 * A software authenticator holding one P-256 passkey for a new user `owner`
 * (and no password), able to answer a sign-in challenge the way a browser
 * would.
 */
function ownerWithPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const coord = (v?: string) => Buffer.from(v ?? "", "base64url");
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    coord(jwk.x),
    Buffer.from([0x22, 0x58, 0x20]),
    coord(jwk.y),
  ]);
  const credentialId = Buffer.from("test-passkey").toString("base64url");
  insertCredential(library, {
    id: credentialId,
    userId: createUser(library, "owner", "owner").id,
    publicKey: new Uint8Array(cose),
    counter: 0,
    transports: undefined,
    deviceType: "singleDevice",
    backedUp: false,
  });

  return (challenge: string) => {
    const { rpID, rpOrigin } = authConfig();
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin: rpOrigin }),
    );
    const authenticatorData = Buffer.concat([
      new Bun.CryptoHasher("sha256").update(rpID).digest(),
      Buffer.from([0x05]), // user present + user verified
      Buffer.from([0, 0, 0, 1]), // signature counter
    ]);
    const signature = sign(
      "sha256",
      Buffer.concat([
        authenticatorData,
        new Bun.CryptoHasher("sha256").update(clientDataJSON).digest(),
      ]),
      privateKey,
    );
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
    };
  };
}

test("a passkey-only user still signs in with their passkey, and no password is asked", async () => {
  const answer = ownerWithPasskey();
  const server = startServer(0, library);
  try {
    const url = base(server);
    const options = await fetch(`${url}/api/auth/login/options`, {
      method: "POST",
    });
    const { challenge } = (await options.json()) as { challenge: string };
    const challengeCookie =
      options.headers.getSetCookie()[0]?.split(";")[0] ?? "";

    const verified = await fetch(`${url}/api/auth/login/verify`, {
      method: "POST",
      headers: { cookie: challengeCookie, "Content-Type": "application/json" },
      body: JSON.stringify(answer(challenge)),
    });
    expect(verified.status).toBe(200);
    const cookie = sessionFrom(verified);
    expect(await me(server, cookie)).toMatchObject({
      authenticated: true,
      user: { hasPassword: false },
    });
    // With no password set, none signs anyone in.
    expect((await signIn(server, "correct horse battery")).status).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("choosing a password requires a session", async () => {
  await ownerWithPassword("correct horse battery");
  const server = startServer(0, library);
  try {
    const res = await choosePassword(server, "", { password: "mine now!" });
    expect(res.status).toBe(401);
    expect((await signIn(server, "mine now!")).status).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("GET /api/documents/:hash/transcription serves the text, and 404s when there is none", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    const form = new FormData();
    form.append("files", pngBlob());
    const items = asItems(
      await (
        await fetch(`${url}/api/documents`, {
          method: "POST",
          headers: { cookie },
          body: form,
        })
      ).json(),
    );
    const hash = items[0]?.hash ?? "";

    const before = await fetch(`${url}/api/documents/${hash}/transcription`, {
      headers: { cookie },
    });
    expect(before.status).toBe(404);

    writeTranscription(TMP, hash, "Rechnung Nr. 4711");

    const after = await fetch(`${url}/api/documents/${hash}/transcription`, {
      headers: { cookie },
    });
    expect(after.status).toBe(200);
    expect(after.headers.get("content-type")).toContain("text/plain");
    expect(await after.text()).toBe("Rechnung Nr. 4711");
  } finally {
    server.stop(true);
  }
});

test("every destination is a real path serving the same application shell", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const shell = await (await fetch(`${url}/`)).text();
    expect(shell).toContain("Zayla");

    for (const path of ["/organizations", "/people"]) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(shell);
    }
  } finally {
    server.stop(true);
  }
});

test("an unrecognized path answers as not found rather than the shell", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const shell = await (await fetch(`${url}/`)).text();

    // A trailing slash is a different address, and only the addresses the
    // sidebar links are served.
    for (const path of [
      "/nope",
      "/documents",
      "/organizations/acme",
      "/organizations/",
    ]) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toBe(shell);
      expect(body).toContain("nothing at this address");
      // No palette of its own, so the browser's follows the system's scheme.
      expect(body).toContain('<meta name="color-scheme" content="light dark">');
    }
  } finally {
    server.stop(true);
  }
});

test("a mistyped data path answers as not found", async () => {
  const server = startServer(0, library);
  try {
    const res = await fetch(`${base(server)}/api/documnets`, {
      headers: { cookie: authCookie() },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  } finally {
    server.stop(true);
  }
});

// ---- a Document's pages ----------------------------------------------------

/**
 * A valid PDF of `pages` blank US-letter pages, built in memory: a catalog, a
 * page tree, the pages, and a cross-reference table giving each object's byte
 * offset, which is all poppler asks of one.
 */
function pdfBlob(pages: number, filename = "letter.pdf"): File {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`,
    ...kids.map(
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ),
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${String(o).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([body], filename, { type: "application/pdf" });
}

/** Import one file through the web interface, returning its gallery record. */
async function importOne(
  server: ReturnType<typeof startServer>,
  cookie: string,
  file: File,
): Promise<ApiDocument> {
  const form = new FormData();
  form.append("files", file);
  const res = await fetch(`${base(server)}/api/documents`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  return ((await res.json()) as ApiDocument[])[0] as ApiDocument;
}

test("a Document reports how many pages it has, and an image has one", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    const pdf = await importOne(server, cookie, pdfBlob(2));
    const png = await importOne(server, cookie, pngBlob());
    expect(pdf.pages).toBe(2);
    expect(png.pages).toBe(1);

    const list = (await (
      await fetch(`${base(server)}/api/documents`, { headers: { cookie } })
    ).json()) as ApiDocument[];
    const pagesOf = (hash: string) => list.find((d) => d.hash === hash)?.pages;
    expect(pagesOf(pdf.hash)).toBe(2);
    expect(pagesOf(png.hash)).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("GET /api/documents/:hash/pages/:n serves each page as a JPEG, and nothing past them", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    const { hash } = await importOne(server, cookie, pdfBlob(2));
    const page = (path: string, headers: Record<string, string> = { cookie }) =>
      fetch(`${url}/api/documents/${path}`, { headers });

    for (const n of [1, 2]) {
      const res = await page(`${hash}/pages/${n}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]); // JPEG magic
    }
    for (const path of [
      `${hash}/pages/0`,
      `${hash}/pages/3`,
      `${hash}/pages/one`,
      `${"0".repeat(64)}/pages/1`,
    ])
      expect((await page(path)).status).toBe(404);
    expect((await page(`${hash}/pages/1`, {})).status).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("an image's one page is its Original", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    const { hash } = await importOne(server, cookie, pngBlob());

    const res = await fetch(`${url}/api/documents/${hash}/pages/1`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array(await pngBlob().arrayBuffer()),
    );
    const past = await fetch(`${url}/api/documents/${hash}/pages/2`, {
      headers: { cookie },
    });
    expect(past.status).toBe(404);
  } finally {
    server.stop(true);
  }
});

test("a page is rendered once: asked for again, it is served without the Original", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    const { hash } = await importOne(server, cookie, pdfBlob(2));
    const page = async () => {
      const res = await fetch(`${url}/api/documents/${hash}/pages/2`, {
        headers: { cookie },
      });
      return { status: res.status, bytes: await res.arrayBuffer() };
    };
    const first = await page();
    expect(first.status).toBe(200);

    // With the Original unreadable, rendering again could only fail.
    await rm(`${TMP}/objects/${hash}.pdf`);
    const second = await page();
    expect(second.status).toBe(200);
    expect(new Uint8Array(second.bytes)).toEqual(new Uint8Array(first.bytes));
  } finally {
    server.stop(true);
  }
});

// ---- installing to a home screen ------------------------------------------

/**
 * Where the application shell says to find a `<link rel>`: the href a browser
 * follows, whatever the bundler named the file.
 */
async function linked(url: string, rel: string): Promise<string> {
  const shell = await (await fetch(`${url}/`)).text();
  const tag = shell.match(new RegExp(`<link rel="${rel}"[^>]*>`))?.[0];
  const href = tag?.match(/href="([^"]+)"/)?.[1];
  if (!href) throw new Error(`the shell links no ${rel}`);
  return new URL(href, `${url}/`).href;
}

test("the application shell carries a theme colour for each scheme, and links a manifest and icons", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const shell = await (await fetch(`${url}/`)).text();
    expect(shell).toContain('<meta name="color-scheme" content="light dark">');
    // Which colours they are is the palette's to check (src/palette.test.ts).
    for (const scheme of ["light", "dark"])
      expect(shell).toContain(
        `<meta name="theme-color" media="(prefers-color-scheme: ${scheme})"`,
      );
    for (const rel of ["manifest", "icon", "apple-touch-icon"])
      expect(await linked(url, rel)).toStartWith(url);
  } finally {
    server.stop(true);
  }
});

test("the manifest is served without a session, naming how Zayla opens", async () => {
  const server = startServer(0, library);
  try {
    const res = await fetch(await linked(base(server), "manifest"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    expect(await res.json()).toMatchObject({
      name: "Zayla",
      short_name: "Zayla",
      start_url: "/",
      display: "standalone",
      theme_color: "#F4F6F9",
      background_color: "#F4F6F9",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        {
          src: "/icon-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    });
  } finally {
    server.stop(true);
  }
});

test("the icons are served without a session, each as its own type", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const manifestUrl = await linked(url, "manifest");
    const manifest = (await (await fetch(manifestUrl)).json()) as {
      icons: { src: string; type: string }[];
    };
    const icons: [href: string, type: string][] = [
      ...manifest.icons.map((i): [string, string] => [
        new URL(i.src, manifestUrl).href,
        i.type,
      ]),
      [await linked(url, "icon"), "image/svg+xml"],
      [await linked(url, "apple-touch-icon"), "image/png"],
    ];
    for (const [href, type] of icons) {
      const res = await fetch(href);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  } finally {
    server.stop(true);
  }
});

// ---- browsing by Person and Organization ----------------------------------

/**
 * Catalog a Document in the test library and record what a reading of it says
 * about who it involves, as Enrichment would. Appearances are what the browse
 * lists are built from, and no model call is needed to have some.
 */
function read(
  hash: string,
  reading: { sender?: Party; receiver?: Party; people?: string[] },
): void {
  insertDocument(library, {
    hash,
    ext: "pdf",
    mime: "application/pdf",
    filename: `${hash}.pdf`,
    bytes: 1,
    status: "imported",
    addedAt: new Date().toISOString(),
  });
  const nobody = { organization: "", person: "" };
  updateEnrichment(
    library,
    hash,
    {
      texts: {},
      people: reading.people ?? [],
      sender: reading.sender ?? nobody,
      receiver: reading.receiver ?? nobody,
      deadlines: [],
      date: null,
      languages: [],
      keywords: [],
      ref: [],
    },
    { textSource: "vision", baseUrl: "http://mock.test/v1", model: "mock" },
  );
}

const browse = async (server: ReturnType<typeof startServer>, cookie: string) =>
  (await (
    await fetch(`${base(server)}/api/entities`, { headers: { cookie } })
  ).json()) as ApiBrowse;

test("GET /api/entities requires authentication, as every other data endpoint does", async () => {
  const server = startServer(0, library);
  try {
    const res = await fetch(`${base(server)}/api/entities`);
    expect(res.status).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("GET /api/entities counts each Document once however many parts a name played", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    // Sender and receiver of one Document, and named inside it as well.
    read("aaa", {
      sender: { organization: "Stadt Porto", person: "Jordan Okafor" },
      receiver: { organization: "Stadt Porto", person: "Jordan Okafor" },
      people: ["Jordan Okafor"],
    });
    read("bbb", { sender: { organization: "Stadt Porto", person: "" } });

    const view = await browse(server, cookie);
    expect(view.organizations.map((o) => [o.displayName, o.documents])).toEqual(
      [["Stadt Porto", 2]],
    );
    expect(
      view.organizations[0]?.people.map((p) => [p.displayName, p.documents]),
    ).toEqual([["Jordan Okafor", 1]]);
  } finally {
    server.stop(true);
  }
});

test("GET /api/entities nests a Person under each Organization they appeared for", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", {
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    read("bbb", {
      sender: { organization: "Region Osaka", person: "M. Schmidt" },
    });
    read("ccc", { people: ["Jana Okafor"] });

    const view = await browse(server, cookie);
    expect(
      view.organizations.map((o) => [
        o.displayName,
        o.people.map((p) => p.displayName),
      ]),
    ).toEqual([
      ["Region Osaka", ["M. Schmidt"]],
      ["Stadt Porto", ["M. Schmidt"]],
    ]);
    // One entity with one count under each, not one entry per Organization.
    const schmidt = view.organizations.flatMap((o) =>
      o.people.filter((p) => p.displayName === "M. Schmidt"),
    );
    expect(schmidt.map((p) => [p.id, p.documents])).toEqual([
      [schmidt[0]?.id ?? 0, 2],
      [schmidt[0]?.id ?? 0, 2],
    ]);
    // Only the People belonging to no Organization are listed on their own.
    expect(view.people.map((p) => p.displayName)).toEqual(["Jana Okafor"]);
  } finally {
    server.stop(true);
  }
});

test("GET /api/entities offers a shortcut from the first Document on, most Documents first", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { sender: { organization: "Stadt Porto", person: "" } });

    // One Document is enough: the sidebar fills in with the Library.
    const first = await browse(server, cookie);
    expect(first.shortcuts.map((s) => [s.displayName, s.documents])).toEqual([
      ["Stadt Porto", 1],
    ]);
    // And it addresses that Organization's own page.
    expect(first.shortcuts[0]?.path).toBe(
      `/organizations/${first.organizations[0]?.id}`,
    );

    read("bbb", { sender: { organization: "Region Osaka", person: "" } });
    read("ccc", { sender: { organization: "Stadt Porto", person: "" } });

    const after = await browse(server, cookie);
    expect(after.shortcuts.map((s) => [s.displayName, s.documents])).toEqual([
      ["Stadt Porto", 2],
      ["Region Osaka", 1],
    ]);
  } finally {
    server.stop(true);
  }
});

// ---- one entity's own page ------------------------------------------------

const entityPage = async (
  server: ReturnType<typeof startServer>,
  cookie: string,
  id: number,
) =>
  (await (
    await fetch(`${base(server)}/api/entities/${id}`, { headers: { cookie } })
  ).json()) as ApiEntityPage;

test("an entity's page is a real address serving the application shell", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    read("aaa", {
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    const view = await browse(server, cookie);
    const org = view.organizations[0];
    const person = org?.people[0];

    const shell = await (await fetch(`${url}/`)).text();
    for (const path of [`/organizations/${org?.id}`, `/people/${person?.id}`]) {
      const res = await fetch(`${url}${path}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(shell);
    }
  } finally {
    server.stop(true);
  }
});

test("an address for an entity that does not exist answers as not found", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    read("aaa", {
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    const view = await browse(server, cookie);
    const org = view.organizations[0];
    const person = org?.people[0];

    for (const path of [
      "/organizations/9999", // nobody's id
      `/people/${org?.id}`, // an Organization is not at a Person's address
      `/organizations/${person?.id}`,
      "/organizations/acme", // and an address that names no id at all
    ]) {
      const res = await fetch(`${url}${path}`, { headers: { cookie } });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("nothing at this address");
    }
  } finally {
    server.stop(true);
  }
});

test("which entities the Library holds is not told to a request without a session", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    read("aaa", { sender: { organization: "Stadt Porto", person: "" } });
    const held = (await browse(server, cookie)).organizations[0]?.id;

    // Held or not, the answer is the same shell, so the ids the Library holds
    // cannot be read off the status one address at a time. The gate behind it
    // asks who is there, and the owner gets the real answer — above.
    const shell = await (await fetch(`${url}/`)).text();
    for (const path of [`/organizations/${held}`, "/organizations/9999"]) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(shell);
    }
    // An address that names no entity at all is still nothing: saying so gives
    // away nothing about the Library.
    expect((await fetch(`${url}/organizations/acme`)).status).toBe(404);
  } finally {
    server.stop(true);
  }
});

test("GET /api/entities/:id requires authentication, as every other data endpoint does", async () => {
  const server = startServer(0, library);
  try {
    const res = await fetch(`${base(server)}/api/entities/1`);
    expect(res.status).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("GET /api/entities/:id answers not found for an id that is nobody's", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    for (const id of ["9999", "0", "acme"]) {
      const res = await fetch(`${base(server)}/api/entities/${id}`, {
        headers: { cookie },
      });
      expect(res.status).toBe(404);
    }
  } finally {
    server.stop(true);
  }
});

test("GET /api/entities/:id carries the count, the spellings and what a Person appeared for", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", {
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    read("bbb", { sender: { organization: "Stadt Porto", person: "" } });
    const view = await browse(server, cookie);
    const org = view.organizations[0];

    const stadt = await entityPage(server, cookie, org?.id ?? 0);
    expect(stadt.kind).toBe("organization");
    expect(stadt.displayName).toBe("Stadt Porto");
    expect(stadt.documents).toBe(2);
    expect(stadt.variants).toEqual(["Stadt Porto"]);
    expect(stadt.affiliations).toEqual([]);

    const schmidt = await entityPage(server, cookie, org?.people[0]?.id ?? 0);
    expect(schmidt.kind).toBe("person");
    expect(schmidt.documents).toBe(1);
    expect(schmidt.affiliations).toEqual([
      { id: org?.id ?? 0, displayName: "Stadt Porto" },
    ]);
  } finally {
    server.stop(true);
  }
});

test("GET /api/entities/:id groups the entity's Documents by the part it played", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { sender: { organization: "Stadt Porto", person: "" } });
    read("bbb", { sender: { organization: "Stadt Porto", person: "" } });
    read("ccc", { receiver: { organization: "Stadt Porto", person: "" } });
    read("ddd", { people: ["Jordan Okafor"] });
    read("eee", {
      sender: { organization: "Region Osaka", person: "" },
      people: ["Jordan Okafor"],
      receiver: { organization: "Stadt Porto", person: "" },
    });
    const view = await browse(server, cookie);
    const stadt = view.organizations.find((o) => o.displayName === "Stadt Porto");
    const okafor = view.people.find((p) => p.displayName === "Jordan Okafor");

    expect((await entityPage(server, cookie, stadt?.id ?? 0)).roles).toEqual([
      { role: "sender", hashes: ["aaa", "bbb"] },
      { role: "receiver", hashes: ["ccc", "eee"] },
    ]);
    // A part the entity never played is absent rather than empty.
    expect((await entityPage(server, cookie, okafor?.id ?? 0)).roles).toEqual([
      { role: "mentioned", hashes: ["ddd", "eee"] },
    ]);
  } finally {
    server.stop(true);
  }
});

test("GET /api/entities drops an entity once its last Document is Deleted", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", {
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    expect((await browse(server, cookie)).organizations.length).toBe(1);

    deleteDocument(library, "aaa");

    const after = await browse(server, cookie);
    expect(after.organizations).toEqual([]);
    expect(after.people).toEqual([]);
  } finally {
    server.stop(true);
  }
});

// ---- merging and unmerging from the web interface --------------------------

/**
 * Say over HTTP that two names are one, as the entity page's "Same as…" does.
 * The ids are the Library's, and the chosen name is the owner's when given —
 * which is the one thing about a Merge the Library does not decide.
 */
const merge = async (
  server: ReturnType<typeof startServer>,
  cookie: string,
  body: { a?: unknown; b?: unknown; displayName?: unknown },
) =>
  fetch(`${base(server)}/api/merges`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Take one Merge back, named — as `unmerge` names it — by the name it took in. */
const unmerge = async (
  server: ReturnType<typeof startServer>,
  cookie: string,
  absorbed: number | string,
) =>
  fetch(`${base(server)}/api/merges/${absorbed}`, {
    method: "DELETE",
    headers: { cookie },
  });

/** The id the browse lists have for one Organization, by the name it shows. */
const orgNamed = (view: ApiBrowse, displayName: string) =>
  view.organizations.find((o) => o.displayName === displayName)?.id ?? 0;

test("POST /api/merges puts two names behind one, with the Documents of both", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { sender: { organization: "Acme Foundation", person: "" } });
    read("bbb", { sender: { organization: "Acme Foundation", person: "" } });
    read("ccc", { sender: { organization: "Acme Stiftung", person: "" } });

    const before = await browse(server, cookie);
    const foundation = orgNamed(before, "Acme Foundation");
    const stiftung = orgNamed(before, "Acme Stiftung");

    const res = await merge(server, cookie, { a: stiftung, b: foundation });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as ApiMergeOutcome;
    // The spelling with the most Documents behind it survives, whichever way
    // round the owner named the two.
    expect(outcome.survivor).toEqual({
      id: foundation,
      displayName: "Acme Foundation",
      documents: 3,
    });
    expect(outcome.absorbed).toEqual({
      id: stiftung,
      displayName: "Acme Stiftung",
    });

    // One Organization in the lists now, with the Documents of both names.
    const after = await browse(server, cookie);
    expect(
      after.organizations.map((o) => [o.displayName, o.documents]),
    ).toEqual([["Acme Foundation", 3]]);

    // And its page names the name it took in, so the Merge can be taken back.
    const page = await entityPage(server, cookie, foundation);
    expect(page.mergedNames).toEqual([
      { id: stiftung, displayName: "Acme Stiftung" },
    ]);
    expect(page.variants).toEqual(["Acme Foundation", "Acme Stiftung"]);
  } finally {
    server.stop(true);
  }
});

test("POST /api/merges shows the name the owner chose rather than the frequent one", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { sender: { organization: "Acme Foundation", person: "" } });
    read("bbb", { sender: { organization: "Acme Foundation", person: "" } });
    read("ccc", { sender: { organization: "Acme Stiftung", person: "" } });

    const before = await browse(server, cookie);
    const foundation = orgNamed(before, "Acme Foundation");
    const stiftung = orgNamed(before, "Acme Stiftung");

    const res = await merge(server, cookie, {
      a: foundation,
      b: stiftung,
      // Neither spelling, which is the owner's to say: the chosen name is the
      // one thing about a Merge that is not read off the Library.
      displayName: "Acme",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ApiMergeOutcome).survivor.displayName).toBe(
      "Acme",
    );

    const after = await browse(server, cookie);
    expect(after.organizations.map((o) => o.displayName)).toEqual(["Acme"]);
    // The chosen spelling is one the Organization now answers to as well.
    expect((await entityPage(server, cookie, foundation)).variants).toContain(
      "Acme",
    );
  } finally {
    server.stop(true);
  }
});

test("POST /api/merges refuses a Person and an Organization, and says why", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", {
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    const view = await browse(server, cookie);
    const org = view.organizations[0];
    const person = org?.people[0];

    const res = await merge(server, cookie, { a: org?.id, b: person?.id });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("cannot merge");
    expect(error).toContain("an organization");
    expect(error).toContain("a person");

    // Refused means nothing happened: both are listed as they were.
    const after = await browse(server, cookie);
    expect(after.organizations[0]?.people.map((p) => p.displayName)).toEqual([
      "M. Schmidt",
    ]);
  } finally {
    server.stop(true);
  }
});

test("POST /api/merges refuses an id that is nobody's, and a body that names no pair", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { sender: { organization: "Stadt Porto", person: "" } });
    const held = orgNamed(await browse(server, cookie), "Stadt Porto");

    for (const body of [
      { a: held, b: 9999 }, // nobody's id
      { a: held }, // only one name
      { a: held, b: held }, // one name twice
      { a: held, b: "Acme" }, // a name where an id belongs
      { a: held, b: 0 },
    ]) {
      const res = await merge(server, cookie, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }
  } finally {
    server.stop(true);
  }
});

test("DELETE /api/merges/:id takes one Merge back, leaving both names as they stood", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { sender: { organization: "Acme Foundation", person: "" } });
    read("bbb", { sender: { organization: "Acme Foundation", person: "" } });
    read("ccc", { sender: { organization: "Acme Stiftung", person: "" } });

    const before = await browse(server, cookie);
    const foundation = orgNamed(before, "Acme Foundation");
    const stiftung = orgNamed(before, "Acme Stiftung");
    await merge(server, cookie, {
      a: foundation,
      b: stiftung,
      displayName: "Acme",
    });

    const res = await unmerge(server, cookie, stiftung);
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as ApiUnmergeOutcome;
    // The chosen name goes with the Merge that chose it.
    expect(outcome.survivor).toEqual({
      id: foundation,
      displayName: "Acme Foundation",
      documents: 2,
    });
    expect(outcome.restored).toEqual({
      id: stiftung,
      displayName: "Acme Stiftung",
      documents: 1,
    });

    const after = await browse(server, cookie);
    expect(
      after.organizations.map((o) => [o.displayName, o.documents]),
    ).toEqual([
      ["Acme Foundation", 2],
      ["Acme Stiftung", 1],
    ]);
    expect((await entityPage(server, cookie, foundation)).mergedNames).toEqual(
      [],
    );
  } finally {
    server.stop(true);
  }
});

test("DELETE /api/merges/:id refuses a name no Merge took in, and says why", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { sender: { organization: "Stadt Porto", person: "" } });
    const held = orgNamed(await browse(server, cookie), "Stadt Porto");

    const res = await unmerge(server, cookie, held);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "not merged",
    );

    // An id that is nobody's, and an address that names no id at all.
    expect((await unmerge(server, cookie, 9999)).status).toBe(400);
    expect((await unmerge(server, cookie, "acme")).status).toBe(404);
  } finally {
    server.stop(true);
  }
});

test("merging requires authentication, as every other write does", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    expect(
      (
        await fetch(`${url}/api/merges`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ a: 1, b: 2 }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(`${url}/api/merges/1`, { method: "DELETE" })).status,
    ).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("the lists and an entity's page flag the names that look like one name", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { people: ["Jordan Okafor"] });
    read("bbb", { people: ["Jordan Okafor"] });
    read("ccc", { people: ["J. Okafor"] });
    read("ddd", { sender: { organization: "Stadt Porto", person: "" } });

    const view = await browse(server, cookie);
    expect(
      view.duplicates.map(({ kind, entities }) => [
        kind,
        entities.map((e) => [e.displayName, e.documents]),
      ]),
    ).toEqual([
      [
        "person",
        [
          ["Jordan Okafor", 2],
          ["J. Okafor", 1],
        ],
      ],
    ]);

    // The same question on the page where it can be answered, from both sides.
    const jordan = view.people.find((p) => p.displayName === "Jordan Okafor");
    const initial = view.people.find((p) => p.displayName === "J. Okafor");
    expect(
      (await entityPage(server, cookie, jordan?.id ?? 0)).suspected,
    ).toEqual([
      { id: initial?.id ?? 0, displayName: "J. Okafor", documents: 1 },
    ]);
    expect(
      (await entityPage(server, cookie, initial?.id ?? 0)).suspected,
    ).toEqual([
      { id: jordan?.id ?? 0, displayName: "Jordan Okafor", documents: 2 },
    ]);
    // A name nothing looks like is flagged nowhere.
    const stadt = orgNamed(view, "Stadt Porto");
    expect((await entityPage(server, cookie, stadt)).suspected).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("a Merge answers the question it settles: the pair is no longer flagged", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { people: ["Jordan Okafor"] });
    read("bbb", { people: ["J. Okafor"] });

    const before = await browse(server, cookie);
    const jordan = before.people.find((p) => p.displayName === "Jordan Okafor");
    const initial = before.people.find((p) => p.displayName === "J. Okafor");
    expect(before.duplicates.length).toBe(1);

    await merge(server, cookie, { a: jordan?.id, b: initial?.id });

    const after = await browse(server, cookie);
    expect(after.duplicates).toEqual([]);
    const page = await entityPage(server, cookie, after.people[0]?.id ?? 0);
    expect(page.suspected).toEqual([]);
    expect(page.mergedNames.length).toBe(1);
  } finally {
    server.stop(true);
  }
});

// ---- the Person the reader is ---------------------------------------------

const markMe = (
  server: ReturnType<typeof startServer>,
  cookie: string,
  id: number,
) =>
  fetch(`${base(server)}/api/entities/${id}/me`, {
    method: "POST",
    headers: { cookie },
  });

/** The People a browse list holds, in the order it holds them. */
const peopleIn = (view: ApiBrowse) => view.people.map((p) => p.displayName);

/** The id of the Person a browse list carries under this name. */
const idOf = (view: ApiBrowse, displayName: string) =>
  view.people.find((p) => p.displayName === displayName)?.id ?? 0;

test("marking a Person as Me requires authentication, as every other data endpoint does", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { people: ["Jordan Okafor"] });
    const okafor = idOf(await browse(server, cookie), "Jordan Okafor");

    const res = await fetch(`${base(server)}/api/entities/${okafor}/me`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
    // And a request without a session marked nobody.
    expect((await browse(server, cookie)).me).toBe(null);
  } finally {
    server.stop(true);
  }
});

test("marking a Person as Me heads the People with her", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { receiver: { organization: "", person: "Jordan Okafor" } });
    read("bbb", { people: ["Jana Okafor"] });
    read("ccc", { people: ["Jana Okafor"] });

    const before = await browse(server, cookie);
    expect(before.me).toBe(null);
    expect(peopleIn(before)).toEqual(["Jana Okafor", "Jordan Okafor"]);

    const okafor = idOf(before, "Jordan Okafor");
    const marked = await markMe(server, cookie, okafor);
    expect(marked.status).toBe(200);
    expect(await marked.json()).toEqual({ me: okafor });

    // Ahead of the Person with more Documents now, and named as the reader's
    // own so that every list can label her row.
    const after = await browse(server, cookie);
    expect(after.me).toBe(okafor);
    expect(peopleIn(after)).toEqual(["Jordan Okafor", "Jana Okafor"]);
  } finally {
    server.stop(true);
  }
});

test("marking a different Person replaces the mark rather than adding to it", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { people: ["Jordan Okafor"] });
    read("bbb", { people: ["Jana Okafor"] });
    const view = await browse(server, cookie);

    await markMe(server, cookie, idOf(view, "Jordan Okafor"));
    await markMe(server, cookie, idOf(view, "Jana Okafor"));

    const after = await browse(server, cookie);
    expect(after.me).toBe(idOf(view, "Jana Okafor"));
    // One reader, one row at the head of the People — not two.
    expect(peopleIn(after)).toEqual(["Jana Okafor", "Jordan Okafor"]);
  } finally {
    server.stop(true);
  }
});

test("a second user of one Library marks themselves without disturbing the first", async () => {
  const server = startServer(0, library);
  try {
    const mine = authCookie("owner");
    const theirs = authCookie("housemate");
    read("aaa", { people: ["Jordan Okafor"] });
    read("bbb", { people: ["Jana Okafor"] });
    const view = await browse(server, mine);
    const jordan = idOf(view, "Jordan Okafor");
    const jana = idOf(view, "Jana Okafor");

    await markMe(server, mine, jordan);
    await markMe(server, theirs, jana);

    expect((await browse(server, mine)).me).toBe(jordan);
    expect((await browse(server, theirs)).me).toBe(jana);

    // And the Documents are one shared Library for both, as they were before.
    const hashes = async (cookie: string) =>
      asItems(
        await (
          await fetch(`${base(server)}/api/documents`, { headers: { cookie } })
        ).json(),
      ).map((d) => d.hash);
    expect(await hashes(mine)).toEqual(await hashes(theirs));
  } finally {
    server.stop(true);
  }
});

test("an Organization is refused as Me, and an id that is nobody's is nothing", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { sender: { organization: "Stadt Porto", person: "" } });
    const stadt = (await browse(server, cookie)).organizations[0]?.id ?? 0;

    // A real address asked for what it cannot be: refused, in the Library's own
    // words, by the one rule every refused statement about a name comes through.
    const refused = await markMe(server, cookie, stadt);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain(
      "only a person can be me",
    );

    // An address that is nobody's is nothing, here exactly as it is on the way
    // in — whether it names an id the Library has never had or no id at all.
    expect((await markMe(server, cookie, 9999)).status).toBe(404);
    const nowhere = await fetch(`${base(server)}/api/entities/acme/me`, {
      method: "POST",
      headers: { cookie },
    });
    expect(nowhere.status).toBe(404);

    expect((await browse(server, cookie)).me).toBe(null);
  } finally {
    server.stop(true);
  }
});

test("Me follows a Merge to the surviving name, and taking it back leaves her marked", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    read("aaa", { people: ["Jordan Okafor"] });
    read("bbb", { people: ["J. Okafor"] });
    read("ccc", { people: ["J. Okafor"] });
    const view = await browse(server, cookie);
    const jordan = idOf(view, "Jordan Okafor");
    const shortened = idOf(view, "J. Okafor");
    await markMe(server, cookie, jordan);

    // The shortened spelling has the Documents, so it is the name that
    // survives — and the reader is the one Person either way.
    expect(
      (await merge(server, cookie, { a: jordan, b: shortened })).status,
    ).toBe(200);
    const merged = await browse(server, cookie);
    expect(peopleIn(merged)).toEqual(["J. Okafor"]);
    expect(merged.me).toBe(shortened);

    // The mark was made on the name she was marked under, so taking the Merge
    // back leaves it there rather than on the name that briefly answered.
    expect((await unmerge(server, cookie, jordan)).status).toBe(200);
    expect((await browse(server, cookie)).me).toBe(jordan);
  } finally {
    server.stop(true);
  }
});

// ---- the Provider -----------------------------------------------------------

/** Ask the Library for its Provider, as Settings does. */
async function providerOf(
  server: ReturnType<typeof startServer>,
  cookie: string,
): Promise<ApiProvider | null> {
  const res = await fetch(`${base(server)}/api/provider`, {
    headers: { cookie },
  });
  return ((await res.json()) as { provider: ApiProvider | null }).provider;
}

/** Choose the Library's Provider, as Settings does. */
const chooseProvider = (
  server: ReturnType<typeof startServer>,
  cookie: string,
  body: unknown,
) =>
  fetch(`${base(server)}/api/provider`, {
    method: "PUT",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * A stand-in OpenAI-compatible server: it lists these models, reads every
 * Document as an invoice, and records the requests it was sent.
 */
function fakeModelServer(
  models: string[] = [],
  whileReading: () => Promise<void> = async () => {},
) {
  const seen: { path: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, authorization: req.headers.get("authorization") });
      if (path === "/v1/models")
        return Response.json({ data: models.map((id) => ({ id })) });
      await whileReading();
      return Response.json({
        choices: [
          {
            message: { content: '{"title":"Invoice"}' },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, seen, server };
}

/** Import one small image, returning its hash. */
async function importDocument(
  server: ReturnType<typeof startServer>,
  cookie: string,
): Promise<string> {
  const form = new FormData();
  form.append("files", pngBlob());
  const res = await fetch(`${base(server)}/api/documents`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  return asItems(await res.json())[0]?.hash ?? "";
}

test("the Provider requires authentication, to read it as much as to choose it", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    await chooseProvider(server, cookie, {
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "gemma",
    });

    expect((await fetch(`${url}/api/provider`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/provider`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseUrl: "http://evil.test/v1", model: "x" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(`${url}/api/provider`, { method: "DELETE" })).status,
    ).toBe(401);
    expect(
      (await fetch(`${url}/api/provider/models`, { method: "POST" })).status,
    ).toBe(401);
    expect(await providerOf(server, cookie)).toMatchObject({
      baseUrl: "http://127.0.0.1:8001/v1",
    });
  } finally {
    server.stop(true);
  }
});

test("a Library starts with no Provider, and one chosen is read back without its key", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    expect(await providerOf(server, cookie)).toBe(null);

    const res = await chooseProvider(server, cookie, {
      baseUrl: "https://example.test/api/v1",
      model: "qwen/x",
      apiKey: "sk-secret",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("sk-secret");

    const got = await fetch(`${base(server)}/api/provider`, {
      headers: { cookie },
    });
    const text = await got.text();
    expect(text).not.toContain("sk-secret");
    expect(JSON.parse(text).provider).toMatchObject({
      baseUrl: "https://example.test/api/v1",
      model: "qwen/x",
      hasKey: true,
    });
  } finally {
    server.stop(true);
  }
});

test("choosing again keeps the key for the same address, and drops it for another", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    await chooseProvider(server, cookie, {
      baseUrl: "https://example.test/api/v1",
      model: "qwen/x",
      apiKey: "sk-secret",
    });

    await chooseProvider(server, cookie, {
      baseUrl: "https://example.test/api/v1",
      model: "qwen/y",
    });
    expect(await providerOf(server, cookie)).toMatchObject({
      model: "qwen/y",
      hasKey: true,
    });

    await chooseProvider(server, cookie, {
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "gemma",
    });
    expect(await providerOf(server, cookie)).toMatchObject({
      baseUrl: "http://127.0.0.1:8001/v1",
      hasKey: false,
    });
  } finally {
    server.stop(true);
  }
});

test("a key can be removed without choosing a different Provider", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    const chosen = {
      baseUrl: "https://example.test/api/v1",
      model: "qwen/x",
    };
    await chooseProvider(server, cookie, { ...chosen, apiKey: "sk-secret" });

    await chooseProvider(server, cookie, { ...chosen, apiKey: null });

    expect(await providerOf(server, cookie)).toMatchObject({ hasKey: false });
  } finally {
    server.stop(true);
  }
});

test("a Provider needs an address and a model", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    for (const body of [
      { model: "gemma" },
      { baseUrl: "http://127.0.0.1:8001/v1" },
      { baseUrl: "  ", model: "gemma" },
      { baseUrl: "not a url", model: "gemma" },
    ]) {
      const res = await chooseProvider(server, cookie, body);
      expect(res.status).toBe(400);
    }
    expect(await providerOf(server, cookie)).toBe(null);
  } finally {
    server.stop(true);
  }
});

test("clearing the Provider leaves the Library with none", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    await chooseProvider(server, cookie, {
      baseUrl: "https://example.test/api/v1",
      model: "qwen/x",
      apiKey: "sk-secret",
    });

    const res = await fetch(`${base(server)}/api/provider`, {
      method: "DELETE",
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    expect(await providerOf(server, cookie)).toBe(null);
  } finally {
    server.stop(true);
  }
});

test("the models an address offers are listed for choosing, in order", async () => {
  const models = fakeModelServer(["qwen/y", "gemma", "qwen/x"]);
  const server = startServer(0, library);
  try {
    const cookie = authCookie();

    const res = await fetch(`${base(server)}/api/provider/models`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: models.baseUrl, apiKey: "sk-secret" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["gemma", "qwen/x", "qwen/y"] });
    expect(models.seen[0]).toEqual({
      path: "/v1/models",
      authorization: "Bearer sk-secret",
    });
  } finally {
    server.stop(true);
    models.server.stop(true);
  }
});

test("listing models at the Provider's own address uses the key it already holds", async () => {
  const models = fakeModelServer(["gemma"]);
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    await chooseProvider(server, cookie, {
      baseUrl: models.baseUrl,
      model: "gemma",
      apiKey: "sk-secret",
    });

    await fetch(`${base(server)}/api/provider/models`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: models.baseUrl }),
    });

    expect(models.seen[0]?.authorization).toBe("Bearer sk-secret");
  } finally {
    server.stop(true);
    models.server.stop(true);
  }
});

test("an address that cannot list its models says so, rather than offering none", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();

    const res = await fetch(`${base(server)}/api/provider/models`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:1/v1" }),
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  } finally {
    server.stop(true);
  }
});

test("a Document filed with no Provider waits to be read, rather than failing", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    const hash = await importDocument(server, cookie);

    const res = await fetch(`${base(server)}/api/documents/${hash}/enrich`, {
      method: "POST",
      headers: { cookie },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ noProvider: true });
    const list = asItems(
      await (
        await fetch(`${base(server)}/api/documents`, { headers: { cookie } })
      ).json(),
    );
    expect(list[0]?.status).toBe("imported");
  } finally {
    server.stop(true);
  }
});

test("a Document is read by the Provider the Library chose", async () => {
  const models = fakeModelServer();
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    await chooseProvider(server, cookie, {
      baseUrl: models.baseUrl,
      model: "gemma",
      apiKey: "sk-secret",
    });
    const hash = await importDocument(server, cookie);

    const res = await fetch(`${base(server)}/api/documents/${hash}/enrich`, {
      method: "POST",
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "enriched",
      title: "Invoice",
    });
    expect(models.seen[0]).toEqual({
      path: "/v1/chat/completions",
      authorization: "Bearer sk-secret",
    });
  } finally {
    server.stop(true);
    models.server.stop(true);
  }
});

test("each user chooses their own Provider, and never sees another's", async () => {
  const server = startServer(0, library);
  try {
    const ada = authCookie("ada");
    const ben = authCookie("ben");
    await chooseProvider(server, ada, {
      baseUrl: "https://example.test/api/v1",
      model: "qwen/x",
      apiKey: "sk-ada",
    });

    expect(await providerOf(server, ben)).toBe(null);

    await chooseProvider(server, ben, {
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "gemma",
    });
    await fetch(`${base(server)}/api/provider`, {
      method: "DELETE",
      headers: { cookie: ben },
    });

    expect(await providerOf(server, ada)).toMatchObject({
      baseUrl: "https://example.test/api/v1",
      model: "qwen/x",
      hasKey: true,
    });
    expect(await providerOf(server, ben)).toBe(null);
  } finally {
    server.stop(true);
  }
});

test("listing models never uses another user's key, even at the same address", async () => {
  const models = fakeModelServer(["gemma"]);
  const server = startServer(0, library);
  try {
    const ada = authCookie("ada");
    const ben = authCookie("ben");
    await chooseProvider(server, ada, {
      baseUrl: models.baseUrl,
      model: "gemma",
      apiKey: "sk-ada",
    });

    await fetch(`${base(server)}/api/provider/models`, {
      method: "POST",
      headers: { cookie: ben, "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: models.baseUrl }),
    });

    expect(models.seen[0]?.authorization).toBeNull();
  } finally {
    server.stop(true);
    models.server.stop(true);
  }
});

test("a Document is read by the Provider of the user who asked, with that user's key", async () => {
  const adaModels = fakeModelServer();
  const benModels = fakeModelServer();
  const server = startServer(0, library);
  try {
    const ada = authCookie("ada");
    const ben = authCookie("ben");
    const carol = authCookie("carol");
    await chooseProvider(server, ada, {
      baseUrl: adaModels.baseUrl,
      model: "gemma",
      apiKey: "sk-ada",
    });
    await chooseProvider(server, ben, {
      baseUrl: benModels.baseUrl,
      model: "qwen/x",
      apiKey: "sk-ben",
    });
    const hash = await importDocument(server, ada);
    const enrichAs = (cookie: string) =>
      fetch(`${base(server)}/api/documents/${hash}/enrich`, {
        method: "POST",
        headers: { cookie },
      });

    const res = await enrichAs(ben);

    expect(res.status).toBe(200);
    expect(adaModels.seen).toEqual([]);
    expect(benModels.seen[0]).toEqual({
      path: "/v1/chat/completions",
      authorization: "Bearer sk-ben",
    });
    // A user with no Provider is not lent anyone else's.
    const waiting = await enrichAs(carol);
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toMatchObject({ noProvider: true });
  } finally {
    server.stop(true);
    adaModels.server.stop(true);
    benModels.server.stop(true);
  }
});

// ---- Delete --------------------------------------------------------------

test("DELETE /api/documents/:hash removes the Document, leaving nothing to list or open", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    const hash = await importDocument(server, cookie);

    const res = await fetch(`${url}/api/documents/${hash}`, {
      method: "DELETE",
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hash, filename: "shot.png" });
    const list = asItems(
      await (
        await fetch(`${url}/api/documents`, { headers: { cookie } })
      ).json(),
    );
    expect(list).toEqual([]);
    const original = await fetch(`${url}/api/documents/${hash}/original`, {
      headers: { cookie },
    });
    expect(original.status).toBe(404);
  } finally {
    server.stop(true);
  }
});

test("DELETE /api/documents/:hash refuses a prefix, which the read-only routes accept", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    const hash = await importDocument(server, cookie);

    const res = await fetch(`${url}/api/documents/${hash.slice(0, 12)}`, {
      method: "DELETE",
      headers: { cookie },
    });

    expect(res.status).toBe(404);
    const list = asItems(
      await (
        await fetch(`${url}/api/documents`, { headers: { cookie } })
      ).json(),
    );
    expect(list.map((d) => d.hash)).toEqual([hash]);
  } finally {
    server.stop(true);
  }
});

test("deleting requires authentication, as every other write does", async () => {
  const server = startServer(0, library);
  try {
    const url = base(server);
    const cookie = authCookie();
    const hash = await importDocument(server, cookie);

    const res = await fetch(`${url}/api/documents/${hash}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
    const list = asItems(
      await (
        await fetch(`${url}/api/documents`, { headers: { cookie } })
      ).json(),
    );
    expect(list.map((d) => d.hash)).toEqual([hash]);
  } finally {
    server.stop(true);
  }
});

test("a Document Deleted while it was being read answers not found, and stays Deleted", async () => {
  const server = startServer(0, library);
  const url = base(server);
  const cookie = authCookie();
  let hash = "";
  const models = fakeModelServer([], async () => {
    await fetch(`${url}/api/documents/${hash}`, {
      method: "DELETE",
      headers: { cookie },
    });
  });
  try {
    await chooseProvider(server, cookie, {
      baseUrl: models.baseUrl,
      model: "gemma",
    });
    hash = await importDocument(server, cookie);

    const res = await fetch(`${url}/api/documents/${hash}/enrich`, {
      method: "POST",
      headers: { cookie },
    });

    expect(res.status).toBe(404);
    const list = asItems(
      await (
        await fetch(`${url}/api/documents`, { headers: { cookie } })
      ).json(),
    );
    expect(list).toEqual([]);
  } finally {
    server.stop(true);
    models.server.stop(true);
  }
});

// ---- searching --------------------------------------------------------------

/** What a stand-in model reads one Document as: its metadata, and its Transcription if any. */
type Reading = { meta: Record<string, unknown>; transcription?: string };

/** A small image of its own, so each Document in one Library is a different one. */
const distinctPng = (n: number, name: string) =>
  new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n])],
    name,
    { type: "image/png" },
  );

/**
 * A Library holding one Document per reading, each read by a stand-in model as
 * given, in order. A null reading leaves its Document filed but unread, under the
 * filename `unread-<n>.png`.
 */
async function libraryOf(readings: (Reading | null)[]) {
  const server = startServer(0, library);
  const cookie = authCookie();
  const queue: Reading[] = [];
  const models = Bun.serve({
    port: 0,
    fetch() {
      const r = queue.shift() ?? { meta: {} };
      const content =
        JSON.stringify(r.meta) +
        (r.transcription ? `\n---TRANSCRIPTION---\n${r.transcription}` : "");
      return Response.json({
        choices: [{ message: { content }, finish_reason: "stop" }],
      });
    },
  });
  await chooseProvider(server, cookie, {
    baseUrl: `http://127.0.0.1:${models.port}/v1`,
    model: "gemma",
  });

  /** Have the stand-in model read one Document (again), as this. */
  const read = async (hash: string, reading: Reading) => {
    queue.push(reading);
    const res = await fetch(`${base(server)}/api/documents/${hash}/enrich`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  };

  const hashes: string[] = [];
  for (const [n, reading] of readings.entries()) {
    const form = new FormData();
    form.append(
      "files",
      distinctPng(n, reading ? "shot.png" : `unread-${n}.png`),
    );
    const res = await fetch(`${base(server)}/api/documents`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    const hash = asItems(await res.json())[0]?.hash ?? "";
    hashes.push(hash);
    if (reading) await read(hash, reading);
  }
  return {
    server,
    cookie,
    hashes,
    read,
    stop() {
      server.stop(true);
      models.stop(true);
    },
  };
}

type SearchLibrary = Awaited<ReturnType<typeof libraryOf>>;

/** Search the Library as the search box does, returning the hits in order. */
async function search(
  lib: SearchLibrary,
  query: string,
): Promise<ApiSearchHit[]> {
  const res = await fetch(
    `${base(lib.server)}/api/search?q=${encodeURIComponent(query)}`,
    { headers: { cookie: lib.cookie } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ApiSearchHit[];
}

// Typed to take `lib.hashes[n]` on the expected side as it comes.
const found = async (
  lib: SearchLibrary,
  query: string,
): Promise<(string | undefined)[]> =>
  (await search(lib, query)).map((h) => h.hash);

/** The hits as [hash, tier] pairs, typed as `found` is. */
const ranked = (hits: ApiSearchHit[]): [string | undefined, number][] =>
  hits.map((h) => [h.hash, h.tier]);

test("a word only the Transcription holds finds the Document", async () => {
  const lib = await libraryOf([
    {
      meta: { title: "Invoice" },
      transcription: "Rechnung der Hausverwaltung Nordhaus AG",
    },
    { meta: { title: "Lease" } },
  ]);
  try {
    expect(await found(lib, "nordhaus")).toEqual([lib.hashes[0]]);
  } finally {
    lib.stop();
  }
});

test("a query's terms may each match somewhere different, but all must match", async () => {
  const lib = await libraryOf([
    {
      meta: { title: "Mietvertrag", keywords: ["birkental"] },
      transcription: "Vermieterin: Nordhaus AG",
    },
    { meta: { title: "Mietvertrag" } },
  ]);
  try {
    // "mietvertrag" in the title, "birkental" in the keywords, "nordhaus" in the body.
    expect(await found(lib, "mietvertrag birkental nordhaus")).toEqual([
      lib.hashes[0],
    ]);
    expect(await found(lib, "mietvertrag bergstädt")).toEqual([]);
  } finally {
    lib.stop();
  }
});

test("a term shorter than three letters still matches", async () => {
  const lib = await libraryOf([
    { meta: { title: "Invoice" }, transcription: "Nordhaus AG, Birkental" },
    { meta: { title: "Invoice" }, transcription: "Nordhaus GmbH" },
  ]);
  try {
    expect(await found(lib, "ag")).toEqual([lib.hashes[0]]);
    expect(await found(lib, "nordhaus ag")).toEqual([lib.hashes[0]]);
  } finally {
    lib.stop();
  }
});

test("terms match by substring, ignoring case and accents on both sides", async () => {
  const lib = await libraryOf([
    {
      meta: { title: "NORDVITA Premium Invoice" },
      transcription: "Veranlagungsverfügung Kanton Bergstädt",
    },
  ]);
  const [d] = lib.hashes;
  try {
    for (const q of [
      "nordvita",
      "NORDVITA",
      "verfugung", // the body holds "verfügung"
      "VERANLAGUNG", // part of a compound
      "bergstadt",
      "Bergstädt",
      "  nordvita   bergstädt ",
    ])
      expect(await found(lib, q)).toEqual([d]);
    expect(await found(lib, "   ")).toEqual([]);
  } finally {
    lib.stop();
  }
});

/** The passages a snippet marks, as text. */
const marked = (hit: ApiSearchHit | undefined) =>
  hit?.snippet?.marks.map(([from, to]) => hit.snippet?.text.slice(from, to));

test("a Document found only through its Transcription shows the passage that matched", async () => {
  const filler = "Sehr geehrte Damen und Herren, ".repeat(20);
  const lib = await libraryOf([
    {
      meta: { title: "Rent increase" },
      transcription: `${filler}Ihre Vermieterin, die Nordhaus AG in Bergstädt,\n\nteilt mit: ${filler}`,
    },
    { meta: { title: "Rent increase", summary: "From Nordhaus, Bergstädt" } },
  ]);
  const [bodyOnly, inReading] = lib.hashes;
  try {
    const hits = await search(lib, "rent bergstadt nordhaus");
    const body = hits.find((h) => h.hash === bodyOnly);
    expect(body?.snippet?.text).toContain(
      "die Nordhaus AG in Bergstädt, teilt mit",
    );
    expect(body?.snippet?.text.length).toBeLessThan(200);
    // Every term the snippet holds is marked, as the Transcription spells it.
    expect(marked(body)).toEqual(["Nordhaus", "Bergstädt"]);

    expect(hits.find((h) => h.hash === inReading)?.snippet).toBe(null);
  } finally {
    lib.stop();
  }
});

test("a snippet keeps its match even inside a word longer than the snippet", async () => {
  const compound = `Grundstücks${"verwaltungs".repeat(12)}gesellschaft`;
  const lib = await libraryOf([
    {
      meta: { title: "Letter" },
      transcription: `Sehr geehrte Damen und Herren, die ${compound} teilt mit`,
    },
  ]);
  try {
    const [hit] = await search(lib, "gesellschaft");
    expect(marked(hit)).toEqual(["gesellschaft"]);
  } finally {
    lib.stop();
  }
});

test("reading a Document again replaces what it can be found by", async () => {
  const lib = await libraryOf([
    { meta: { title: "Invoice" }, transcription: "Nordhaus AG" },
  ]);
  const [d = ""] = lib.hashes;
  try {
    await lib.read(d, {
      meta: { title: "Invoice" },
      transcription: "Lindenhof AG",
    });
    expect(await found(lib, "lindenhof")).toEqual([d]);
    expect(await found(lib, "nordhaus")).toEqual([]);

    // A reading that comes back with no Transcription leaves none to match.
    await lib.read(d, { meta: { title: "Invoice" } });
    expect(await found(lib, "lindenhof")).toEqual([]);
  } finally {
    lib.stop();
  }
});

test("a Deleted Document is found by nothing", async () => {
  const lib = await libraryOf([
    { meta: { title: "Invoice" }, transcription: "Nordhaus AG" },
  ]);
  try {
    await fetch(`${base(lib.server)}/api/documents/${lib.hashes[0]}`, {
      method: "DELETE",
      headers: { cookie: lib.cookie },
    });
    expect(await found(lib, "invoice")).toEqual([]);
    expect(await found(lib, "nordhaus")).toEqual([]);
    expect(await found(lib, "ag")).toEqual([]);
  } finally {
    lib.stop();
  }
});

test("searching requires authentication, as every other data endpoint does", async () => {
  const lib = await libraryOf([{ meta: { title: "Invoice" } }]);
  try {
    const res = await fetch(`${base(lib.server)}/api/search?q=invoice`);
    expect(res.status).toBe(401);
  } finally {
    lib.stop();
  }
});

test("a Document not yet read is found by its filename", async () => {
  const lib = await libraryOf([null, { meta: { title: "Invoice" } }]);
  try {
    expect(await found(lib, "unread")).toEqual([lib.hashes[0]]);
  } finally {
    lib.stop();
  }
});

test("Best match ranks by where the terms were found, then newest first", async () => {
  const lib = await libraryOf([
    // body only, and the newest of all
    {
      meta: { title: "Insurance", date: "2026-05-01" },
      transcription: "deductible against tax",
    },
    // on the card, oldest
    { meta: { title: "Tax Assessment 2020", date: "2021-03-01" } },
    // elsewhere in the reading
    { meta: { title: "Payslip", date: "2025-01-31", summary: "Tax withheld" } },
    // on the card, undated
    { meta: { title: "Tax return draft" } },
    // on the card, as the sender
    {
      meta: {
        title: "Assessment",
        date: "2023-03-01",
        sender: { organization: "Tax Office", person: "" },
      },
    },
  ]);
  const [body, oldCard, rest, undatedCard, senderCard] = lib.hashes;
  try {
    const hits = await search(lib, "tax");
    expect(ranked(hits)).toEqual([
      [senderCard, 1],
      [oldCard, 1],
      [undatedCard, 1],
      [rest, 2],
      [body, 3],
    ]);
  } finally {
    lib.stop();
  }
});

test("a Document ranks by its weakest term, so one term found only in the body pulls it down", async () => {
  const lib = await libraryOf([
    {
      meta: { title: "Tax Assessment", keywords: ["birkental"] },
      transcription: "Steuerverwaltung",
    },
    {
      meta: {
        title: "Tax Assessment",
        keywords: ["birkental"],
        summary: "steuerverwaltung",
      },
    },
  ]);
  try {
    const hits = await search(lib, "tax steuerverwaltung");
    expect(ranked(hits)).toEqual([
      [lib.hashes[1], 2],
      [lib.hashes[0], 3],
    ]);
  } finally {
    lib.stop();
  }
});

// ---- Reading languages ----------------------------------------------------

/** Ask for the session user's Reading languages, as Settings does. */
async function languagesOf(
  server: ReturnType<typeof startServer>,
  cookie: string,
): Promise<string[]> {
  const res = await fetch(`${base(server)}/api/reading-languages`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { languages: string[] }).languages;
}

/** Replace the session user's Reading languages, as Settings does. */
const chooseLanguages = (
  server: ReturnType<typeof startServer>,
  cookie: string,
  languages: unknown,
) =>
  fetch(`${base(server)}/api/reading-languages`, {
    method: "PUT",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ languages }),
  });

/** The Documents as this user is served them. */
async function documentsAs(
  server: ReturnType<typeof startServer>,
  cookie: string,
): Promise<ApiDocument[]> {
  const res = await fetch(`${base(server)}/api/documents`, {
    headers: { cookie },
  });
  return (await res.json()) as ApiDocument[];
}

/** The title and summary this user is shown for the Library's only Document. */
const shownTo = async (lib: SearchLibrary, cookie: string = lib.cookie) => {
  const [d] = await documentsAs(lib.server, cookie);
  return { title: d?.title, summary: d?.summary };
};

test("Reading languages require authentication, to read them as much as to choose them", async () => {
  const server = startServer(0, library);
  try {
    const get = await fetch(`${base(server)}/api/reading-languages`);
    const put = await fetch(`${base(server)}/api/reading-languages`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ languages: ["DE"] }),
    });

    expect(get.status).toBe(401);
    expect(put.status).toBe(401);
  } finally {
    server.stop(true);
  }
});

test("a user reads in English until they choose, and their choice is read back in order", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    expect(await languagesOf(server, cookie)).toEqual(["EN"]);

    const res = await chooseLanguages(server, cookie, ["de", "AR", "fr"]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ languages: ["DE", "AR", "FR"] });
    expect(await languagesOf(server, cookie)).toEqual(["DE", "AR", "FR"]);
  } finally {
    server.stop(true);
  }
});

test("Reading languages are 1 to 4 ISO 639-1 codes, none twice, and anything else is refused", async () => {
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    await chooseLanguages(server, cookie, ["DE"]);

    for (const refused of [
      [],
      ["EN", "DE", "FR", "AR", "IT"],
      ["XX"],
      ["English"],
      ["DE", "de"],
      [7],
      "DE",
      null,
    ]) {
      const res = await chooseLanguages(server, cookie, refused);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    }
    // Nothing refused replaced the list.
    expect(await languagesOf(server, cookie)).toEqual(["DE"]);
  } finally {
    server.stop(true);
  }
});

test("each user's Reading languages are their own", async () => {
  const server = startServer(0, library);
  try {
    const ada = authCookie("ada");
    const ben = authCookie("ben");

    await chooseLanguages(server, ada, ["AR"]);

    expect(await languagesOf(server, ada)).toEqual(["AR"]);
    expect(await languagesOf(server, ben)).toEqual(["EN"]);
  } finally {
    server.stop(true);
  }
});

test("a Document is read in the Reading languages of the user who asked, named in the prompt", async () => {
  const prompts: string[] = [];
  const models = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        messages: { content: unknown }[];
      };
      prompts.push(String(body.messages[0]?.content));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: { DE: "Rechnung", AR: "فاتورة" },
                summary: { DE: "Eine Rechnung.", AR: "فاتورة كهرباء." },
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
  const server = startServer(0, library);
  try {
    const cookie = authCookie();
    await chooseProvider(server, cookie, {
      baseUrl: `http://127.0.0.1:${models.port}/v1`,
      model: "gemma",
    });
    await chooseLanguages(server, cookie, ["DE", "AR"]);
    const hash = await importDocument(server, cookie);

    const res = await fetch(`${base(server)}/api/documents/${hash}/enrich`, {
      method: "POST",
      headers: { cookie },
    });

    expect(res.status).toBe(200);
    expect(prompts[0]).toContain("German");
    expect(prompts[0]).toContain("Arabic");
    expect(await res.json()).toMatchObject({
      title: "Rechnung",
      summary: "Eine Rechnung.",
    });
  } finally {
    server.stop(true);
    models.stop(true);
  }
});

/** A reading in German, with its title and summary written in these languages. */
const writtenIn = (
  languages: string[],
  texts: Record<string, string>,
): Reading => ({
  meta: {
    languages,
    title: texts,
    summary: Object.fromEntries(
      Object.entries(texts).map(([code, title]) => [code, `${title}.`]),
    ),
  },
});

test("a Document is shown in its own language when that is one of the user's", async () => {
  const lib = await libraryOf([
    writtenIn(["DE"], { EN: "Lease", DE: "Mietvertrag" }),
  ]);
  try {
    await chooseLanguages(lib.server, lib.cookie, ["EN", "DE"]);

    expect(await shownTo(lib)).toEqual({
      title: "Mietvertrag",
      summary: "Mietvertrag.",
    });
  } finally {
    lib.stop();
  }
});

test("a Document in a language the user doesn't read is shown in the first of theirs it has", async () => {
  const lib = await libraryOf([
    writtenIn(["IT"], { EN: "Lease", DE: "Mietvertrag" }),
  ]);
  try {
    await chooseLanguages(lib.server, lib.cookie, ["FR", "DE", "EN"]);

    expect(await shownTo(lib)).toEqual({
      title: "Mietvertrag",
      summary: "Mietvertrag.",
    });
  } finally {
    lib.stop();
  }
});

test("a Document's own language without a title written in it falls to the user's first", async () => {
  const lib = await libraryOf([writtenIn(["DE"], { EN: "Lease" })]);
  try {
    await chooseLanguages(lib.server, lib.cookie, ["DE", "EN"]);

    expect(await shownTo(lib)).toEqual({ title: "Lease", summary: "Lease." });
  } finally {
    lib.stop();
  }
});

test("a Document written in none of the user's languages is shown with whatever title it has", async () => {
  const lib = await libraryOf([writtenIn(["DE"], { DE: "Mietvertrag" })]);
  try {
    await chooseLanguages(lib.server, lib.cookie, ["FR"]);

    expect(await shownTo(lib)).toEqual({
      title: "Mietvertrag",
      summary: "Mietvertrag.",
    });
  } finally {
    lib.stop();
  }
});

test("two users of one Library see one Document each in their own language", async () => {
  const lib = await libraryOf([
    writtenIn(["IT"], { EN: "Lease", AR: "عقد إيجار" }),
  ]);
  try {
    const ben = authCookie("ben");
    await chooseLanguages(lib.server, ben, ["AR"]);

    expect((await shownTo(lib)).title).toBe("Lease");
    expect((await shownTo(lib, ben)).title).toBe("عقد إيجار");
  } finally {
    lib.stop();
  }
});

test("removing a Reading language discards nothing: search still finds what was written in it", async () => {
  const lib = await libraryOf([
    writtenIn(["DE"], { EN: "Lease", FR: "Bail de location" }),
  ]);
  try {
    await chooseLanguages(lib.server, lib.cookie, ["EN"]);

    expect(await found(lib, "bail")).toEqual([lib.hashes[0]]);
    expect(await found(lib, "location")).toEqual([lib.hashes[0]]);
    // And taking the language back shows it again, with nothing read anew.
    await chooseLanguages(lib.server, lib.cookie, ["FR"]);
    expect((await shownTo(lib)).title).toBe("Bail de location");
  } finally {
    lib.stop();
  }
});

// ---- Setup ------------------------------------------------------------------

/**
 * Boot the server as a container would, returning the Setup code it printed
 * to its logs (null when it printed none).
 */
function boot(): {
  server: ReturnType<typeof startServer>;
  code: string | null;
} {
  const printed: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args) => {
    printed.push(args.join(" "));
  });
  try {
    const server = startServer(0, library);
    const line = printed.find((l) => /setup code/i.test(l));
    return {
      server,
      code: line?.match(/([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)/)?.[1] ?? null,
    };
  } finally {
    log.mockRestore();
  }
}

const setUp = (
  server: ReturnType<typeof startServer>,
  body: unknown,
  path = "/api/setup",
) =>
  fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("Setup refuses a missing or wrong code before anything else", async () => {
  const { server, code } = boot();
  try {
    expect(code).not.toBeNull();
    const finish = { password: "correct horse battery", languages: ["EN"] };
    for (const wrong of [undefined, "", "AAAA-AAAA-AAAA"]) {
      for (const path of ["/api/setup/code", "/api/setup"]) {
        const res = await setUp(server, { ...finish, code: wrong }, path);
        expect(res.status).toBe(403);
        expect(sessionFrom(res)).toBe("");
      }
    }
    // Nothing was created: the Library still needs Setup.
    const probe = (await (
      await fetch(`${base(server)}/api/auth/me`)
    ).json()) as { needsSetup: boolean };
    expect(probe.needsSetup).toBe(true);
    expect((await setUp(server, { code }, "/api/setup/code")).status).toBe(200);
  } finally {
    server.stop(true);
  }
});

const CHOICES = { password: "correct horse battery", languages: ["DE", "EN"] };

test("Setup requires an acceptable password, and creates nobody without one", async () => {
  const { server, code } = boot();
  try {
    for (const password of [undefined, "", "seven77"]) {
      const res = await setUp(server, { ...CHOICES, code, password });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("8");
    }
    const probe = (await (
      await fetch(`${base(server)}/api/auth/me`)
    ).json()) as { needsSetup: boolean };
    expect(probe.needsSetup).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("finishing Setup signs the owner in, with their password and Reading languages", async () => {
  const { server, code } = boot();
  try {
    const res = await setUp(server, { ...CHOICES, code });
    expect(res.status).toBe(200);
    const cookie = sessionFrom(res);
    expect((await me(server, cookie)).authenticated).toBe(true);
    expect((await me(server, cookie)).user.hasPassword).toBe(true);
    const langs = await fetch(`${base(server)}/api/reading-languages`, {
      headers: { cookie },
    });
    expect(await langs.json()).toEqual({ languages: ["DE", "EN"] });
    // The password chosen is the one that signs in from now on.
    expect((await signIn(server, "correct horse battery")).status).toBe(200);
  } finally {
    server.stop(true);
  }
});

test("the Provider can be skipped, and then Documents are filed and wait to be read", async () => {
  const { server, code } = boot();
  try {
    const cookie = sessionFrom(await setUp(server, { ...CHOICES, code }));
    expect(await providerOf(server, cookie)).toBeNull();
    const hash = await importDocument(server, cookie);
    const res = await fetch(`${base(server)}/api/documents/${hash}/enrich`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ noProvider: true });
  } finally {
    server.stop(true);
  }
});

test("a Provider chosen in Setup reads the owner's Documents, its models listed first", async () => {
  const models = fakeModelServer(["gemma", "qwen"]);
  const { server, code } = boot();
  try {
    const listed = await setUp(
      server,
      { code, baseUrl: models.baseUrl, apiKey: "sk-secret" },
      "/api/setup/models",
    );
    expect(await listed.json()).toEqual({ models: ["gemma", "qwen"] });
    expect(models.seen[0]?.authorization).toBe("Bearer sk-secret");

    const cookie = sessionFrom(
      await setUp(server, {
        ...CHOICES,
        code,
        provider: {
          baseUrl: models.baseUrl,
          model: "gemma",
          apiKey: "sk-secret",
        },
      }),
    );
    expect(await providerOf(server, cookie)).toMatchObject({
      baseUrl: models.baseUrl,
      model: "gemma",
      hasKey: true,
    });
    const hash = await importDocument(server, cookie);
    const res = await fetch(`${base(server)}/api/documents/${hash}/enrich`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  } finally {
    server.stop(true);
    models.server.stop(true);
  }
});

test("Setup closes once a user exists, and a Library booted with one prints no code", async () => {
  const first = boot();
  try {
    expect(
      (await setUp(first.server, { ...CHOICES, code: first.code })).status,
    ).toBe(200);
    // Not a second time, with the very same code.
    for (const path of ["/api/setup/code", "/api/setup/models", "/api/setup"]) {
      const res = await setUp(
        first.server,
        { ...CHOICES, code: first.code, password: "another password" },
        path,
      );
      expect(res.status).toBe(403);
    }
    expect((await signIn(first.server, "another password")).status).toBe(401);
    const probe = (await (
      await fetch(`${base(first.server)}/api/auth/me`)
    ).json()) as { needsSetup: boolean };
    expect(probe.needsSetup).toBe(false);
  } finally {
    first.server.stop(true);
  }

  const again = boot();
  try {
    expect(again.code).toBeNull();
  } finally {
    again.server.stop(true);
  }
});

test("a passkey-only owner never sees Setup", async () => {
  ownerWithPasskey();
  const { server, code } = boot();
  try {
    expect(code).toBeNull();
    const probe = (await (
      await fetch(`${base(server)}/api/auth/me`)
    ).json()) as { needsSetup: boolean };
    expect(probe.needsSetup).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("each boot with no user prints a fresh Setup code, and only the current one works", async () => {
  const before = boot();
  before.server.stop(true);
  const { server, code } = boot();
  try {
    expect(code).not.toBe(before.code);
    expect(
      (await setUp(server, { code: before.code }, "/api/setup/code")).status,
    ).toBe(403);
    // Typed loosely, the current one is still recognised.
    const loose = code?.toLowerCase().replaceAll("-", " ");
    expect(
      (await setUp(server, { code: loose }, "/api/setup/code")).status,
    ).toBe(200);
  } finally {
    server.stop(true);
  }
});

test("with everyone removed after boot, Setup says a restart prints a code", async () => {
  authCookie("owner");
  const { server, code } = boot();
  try {
    expect(code).toBeNull();
    clearAllAuth(library);
    const res = await setUp(server, { ...CHOICES, code: "AAAA-AAAA-AAAA" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain(
      "restart",
    );
  } finally {
    server.stop(true);
  }
});
