/**
 * The pages a person sees while an agent connects: the approval page, where
 * they say whether it may read their Library, and the page that says the
 * request itself was wrong. Server-rendered, because the agent sends them here
 * with nothing but an address.
 *
 * What the agent calls itself is the agent's to choose, so it is escaped like
 * anything else from outside, and the page names the domain it will be sent
 * back to beside it: a name can claim to be anyone, the domain can't.
 */
import { type Html, html } from "../html.ts";

/**
 * A page of its own, laid out like the not-found page in serve.ts: no
 * palette, since the tokens live in styles/tokens.css.
 */
function page(title: string, body: Html): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · Zayla</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: system-ui, sans-serif; line-height: 1.5; padding: 0 16px; }
  main { max-width: 28rem; }
  h1 { font-weight: 600; font-size: 22px; margin: 0 0 8px; }
  p { font-size: 14px; margin: 0 0 16px; }
  form { display: flex; gap: 8px; margin-top: 24px; }
  button { font: inherit; font-size: 14px; padding: 6px 16px; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`.markup;
}

/**
 * Headers for a page that grants something: never framed, so it can't be
 * clicked through from under another site, and never kept or referred from.
 */
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

/**
 * Ask the signed-in user whether the agent `name`, which will be sent back to
 * `domain`, may read their Library. The form carries only the id of the
 * request held on the server, which is good for this one answer.
 */
export function approvalPage(
  name: string,
  domain: string,
  requestId: string,
): Response {
  return new Response(
    page(
      `Connect ${name}`,
      html`<h1>Allow ${name} to read your library?</h1>
<p>${name} will be sent back to <strong>${domain}</strong>.</p>
<p>It will be able to search your documents and open them, including their full text and original files. Documents it opens are sent to its AI model; Zayla doesn't control what happens to them there. It can't add, change or delete anything.</p>
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request" value="${requestId}">
  <button type="submit" name="decision" value="allow">Allow</button>
  <button type="submit" name="decision" value="cancel">Cancel</button>
</form>`,
    ),
    { headers: PAGE_HEADERS },
  );
}

/**
 * The answer to a request to connect that can't be sent back to the agent,
 * because it isn't known where to send it.
 */
export function cannotConnectPage(why: string, status = 400): Response {
  return new Response(
    page(
      "Can't connect",
      html`<h1>This app can't connect</h1>
<p>${why}</p>
<p><a href="/">Back to your documents</a></p>`,
    ),
    { status, headers: PAGE_HEADERS },
  );
}
