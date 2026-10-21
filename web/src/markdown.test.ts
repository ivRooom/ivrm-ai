// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createRenderer } from "./markdown.js";

const render = createRenderer(window);
const html = (markdown: string) => {
  const div = document.createElement("div");
  div.append(render(markdown));
  return div.innerHTML.trim();
};

describe("markdown renderer", () => {
  it("renders basic Markdown", () => {
    expect(html("**bold** and `code`")).toBe(
      "<p><strong>bold</strong> and <code>code</code></p>"
    );
  });

  it.each([
    ["script", "<script>alert(1)</script>"],
    ["event handler", '<p onclick="alert(1)">x</p>'],
    ["iframe", '<iframe src="https://evil.example"></iframe>'],
    ["style", "<style>body{display:none}</style>"],
    ["svg", "<svg><script>alert(1)</script></svg>"],
  ])("drops %s", (_name, input) => {
    const out = html(input);
    expect(out).not.toMatch(/<script|onclick|<iframe|<style|<svg/i);
  });

  it("drops images, so output cannot load anything", () => {
    expect(html("![x](https://evil.example/p.png?leak=1)")).not.toContain(
      "<img"
    );
  });

  it.each(["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x"])(
    "removes the %s link target",
    (href) => {
      expect(html(`[click](${href})`)).not.toContain("href");
    }
  );

  it("opens http(s) links in a new tab without a referrer", () => {
    expect(html("[ivRooom](https://ivrm.jp)")).toBe(
      '<p><a href="https://ivrm.jp" target="_blank" rel="noopener noreferrer nofollow">ivRooom</a></p>'
    );
  });

  it("keeps code blocks as text", () => {
    expect(html("```\n<b>x</b>\n```")).toBe(
      "<pre><code>&lt;b&gt;x&lt;/b&gt;\n</code></pre>"
    );
  });
});
