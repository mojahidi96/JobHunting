import sanitizeHtml from "sanitize-html";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const styleValue = [/^[^;{}<>]*$/];
/** Email-safe HTML: no scripts, forms, iframes, event handlers or javascript: URLs. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "b", "strong", "i", "em", "u", "s", "a", "ul", "ol", "li", "h1", "h2", "h3", "h4", "div", "span",
      "table", "thead", "tbody", "tr", "td", "th", "blockquote", "hr", "img", "pre", "code", "small", "sub", "sup",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel", "title"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan", "align"],
      th: ["colspan", "rowspan", "align"],
      "*": ["style"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https"] },
    allowedStyles: {
      "*": Object.fromEntries(
        ["color", "background-color", "font-size", "font-weight", "font-style", "font-family", "text-align", "text-decoration",
          "margin", "margin-top", "margin-bottom", "padding", "line-height", "border", "width", "max-width"].map((p) => [p, styleValue]),
      ),
    },
    transformTags: {
      a: (tag, attribs) => ({ tagName: tag, attribs: { ...attribs, rel: "noopener noreferrer", target: "_blank" } }),
    },
  });
}
