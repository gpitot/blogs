import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import sanitizeHtml from "sanitize-html";

export interface ExtractedArticle {
  title: string;
  content: string;
  byline: string;
}

export function extractArticle(rawHtml: string, url: string): ExtractedArticle {
  const { document } = parseHTML(rawHtml);

  Object.defineProperty(document, "documentURI", { value: url });

  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    throw new Error(`Readability could not extract article from ${url}`);
  }

  const cleanedContent = sanitizeHtml(article.content ?? "", {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr",
      "ul", "ol", "li",
      "blockquote", "pre", "code",
      "em", "strong", "b", "i", "u", "s", "sub", "sup",
      "a", "img",
      "figure", "figcaption",
      "table", "thead", "tbody", "tr", "th", "td",
      "div", "span",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    transformTags: {
      a: (tagName, attribs) => {
        if (attribs.href && !attribs.href.startsWith("http")) {
          try {
            attribs.href = new URL(attribs.href, url).href;
          } catch {}
        }
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        if (attribs.src && !attribs.src.startsWith("http")) {
          try {
            attribs.src = new URL(attribs.src, url).href;
          } catch {}
        }
        return { tagName, attribs };
      },
    },
    exclusiveFilter: (frame) => {
      const emptyTags = ["div", "span", "p"];
      return emptyTags.includes(frame.tag) && !frame.text.trim() && !frame.mediaChildren;
    },
  });

  return {
    title: article.title ?? "",
    content: cleanedContent,
    byline: article.byline ?? "",
  };
}
