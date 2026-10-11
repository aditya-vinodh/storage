import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const STYLE = `
body { font: 16px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
h1 { font-size: 1.4rem; }
.code { font: 600 2rem/1.2 ui-monospace, monospace; letter-spacing: 0.1em; margin: 1rem 0; }
.warning { background: #fff4d6; border: 1px solid #e0b43c; border-radius: 6px; padding: 0.75rem 1rem; }
a.button { display: block; margin: 0.75rem 0; padding: 0.6rem 1rem; border: 1px solid #1a1a1a; border-radius: 6px; color: #1a1a1a; text-decoration: none; text-align: center; }
input { font: inherit; padding: 0.4rem; }
`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Renders an HTML page. `bodyHtml` must already be escaped; escape every interpolated value with escapeHtml. */
export function page(c: Context, title: string, bodyHtml: string, status: ContentfulStatusCode = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>
`;
  return c.html(html, status, { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" });
}

/** A page with a single message. */
export function messagePage(c: Context, title: string, message: string, status: ContentfulStatusCode): Response {
  return page(c, title, `<p>${escapeHtml(message)}</p>`, status);
}
