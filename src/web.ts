import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";

/**
 * The chat UI (web/, built into dist/public). Served from memory: only the
 * three known files, so no request path ever reaches the filesystem.
 */
export type WebAssets = {
  indexHtml: string;
  appJs: string;
  stylesCss: string;
};

// The page renders model output. Even after sanitizing (web/src/markdown.ts),
// the browser may only run this site's own script and connect to this site.
// No inline script or style, no images from elsewhere, no framing.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Reads the built UI. `loginUrl` is where the page sends people to sign in. */
export async function loadWebAssets(
  dir: string,
  loginUrl: string
): Promise<WebAssets> {
  const [html, appJs, stylesCss] = await Promise.all([
    readFile(path.join(dir, "index.html"), "utf8"),
    readFile(path.join(dir, "assets/app.js"), "utf8"),
    readFile(path.join(dir, "assets/styles.css"), "utf8"),
  ]);
  return {
    indexHtml: html.replace("__IVRM_LOGIN_URL__", escapeAttribute(loginUrl)),
    appJs,
    stylesCss,
  };
}

/** GET handler for every path outside /api. Unknown paths get the page. */
export function webHandler(assets: WebAssets) {
  return (c: Context) => {
    const p = c.req.path;
    if (p === "/api" || p.startsWith("/api/")) {
      return c.json({ error: "not_found" }, 404);
    }
    let body: string;
    let type: string;
    let cache = "no-cache";
    if (p === "/assets/app.js") {
      body = assets.appJs;
      type = "text/javascript; charset=utf-8";
    } else if (p === "/assets/styles.css") {
      body = assets.stylesCss;
      type = "text/css; charset=utf-8";
    } else if (p.startsWith("/assets/")) {
      return c.text("not found", 404, SECURITY_HEADERS);
    } else {
      body = assets.indexHtml;
      type = "text/html; charset=utf-8";
      cache = "no-store";
    }
    return c.body(body, 200, {
      ...SECURITY_HEADERS,
      "content-type": type,
      "cache-control": cache,
    });
  };
}
