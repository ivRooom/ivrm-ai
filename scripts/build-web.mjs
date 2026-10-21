// Bundles the chat UI (web/) into dist/public. No inline scripts or styles, so
// the page can run under a strict Content-Security-Policy (src/web.ts).
import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const out = "dist/public";
await mkdir(`${out}/assets`, { recursive: true });
await build({
  entryPoints: ["web/src/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  outfile: `${out}/assets/app.js`,
});
await copyFile("web/styles.css", `${out}/assets/styles.css`);
await copyFile("web/index.html", `${out}/index.html`);
console.log(`web: built ${out}`);
