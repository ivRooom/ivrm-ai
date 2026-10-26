import createDOMPurify from "dompurify";
import { Marked } from "marked";

// Model output is untrusted. It is parsed as Markdown and then sanitized to a
// small allowlist: no images, no raw HTML elements beyond basic formatting, no
// attributes beyond links, and only http(s) / mailto URLs. The page's CSP
// (src/web.ts) is the second line of defense.

const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

/** Returns sanitized nodes, so the page never assigns HTML strings. */
export type Renderer = (markdown: string) => DocumentFragment;

export function createRenderer(window: Window): Renderer {
  const purify = createDOMPurify(
    window as unknown as Parameters<typeof createDOMPurify>[0]
  );
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
  const marked = new Marked({ gfm: true, breaks: true, async: false });

  return (markdown) =>
    purify.sanitize(marked.parse(markdown) as string, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: ["href", "title", "target", "rel"],
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
      ALLOW_DATA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    });
}
