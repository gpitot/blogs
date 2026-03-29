import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import sanitizeHtml from "sanitize-html";
import { parseDocument } from "htmlparser2";
import render from "dom-serializer";

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
      // HTML content
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr",
      "ul", "ol", "li",
      "blockquote", "pre", "code",
      "em", "strong", "b", "i", "u", "s", "sub", "sup",
      "a", "img",
      "figure", "figcaption",
      "table", "thead", "tbody", "tr", "th", "td",
      "div", "span",
      // SVG
      "svg", "path", "circle", "rect", "line", "polyline", "polygon",
      "ellipse", "g", "defs", "use", "text", "tspan", "style",
      "clippath", "mask", "marker", "pattern", "lineargradient",
      "radialgradient", "stop", "symbol", "title", "desc",
      // MathML
      "math", "mrow", "mi", "mo", "mn", "msup", "msub", "msubsup",
      "mfrac", "msqrt", "mroot", "mover", "munder", "munderover",
      "mtable", "mtr", "mtd", "mspace", "mtext", "menclose",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      // Allow all attributes on SVG and MathML elements
      svg: ["*"],
      path: ["*"],
      circle: ["*"],
      rect: ["*"],
      line: ["*"],
      polyline: ["*"],
      polygon: ["*"],
      ellipse: ["*"],
      g: ["*"],
      defs: ["*"],
      use: ["*"],
      text: ["*"],
      tspan: ["*"],
      style: ["*"],
      clippath: ["*"],
      mask: ["*"],
      marker: ["*"],
      pattern: ["*"],
      lineargradient: ["*"],
      radialgradient: ["*"],
      stop: ["*"],
      symbol: ["*"],
      math: ["*"],
      mrow: ["*"],
      mi: ["*"],
      mo: ["*"],
      mn: ["*"],
      msup: ["*"],
      msub: ["*"],
      msubsup: ["*"],
      mfrac: ["*"],
      msqrt: ["*"],
      mroot: ["*"],
      mover: ["*"],
      munder: ["*"],
      munderover: ["*"],
      mtable: ["*"],
      mtr: ["*"],
      mtd: ["*"],
      mspace: ["*"],
      mtext: ["*"],
      menclose: ["*"],
    },
    transformTags: {
      a: (tagName, attribs) => {
        if (attribs.href && !attribs.href.startsWith("http")) {
          try {
            attribs.href = new URL(attribs.href, url).href;
          } catch { /* ignore */ }
        }
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        if (attribs.src && !attribs.src.startsWith("http")) {
          try {
            attribs.src = new URL(attribs.src, url).href;
          } catch { /* ignore */ }
        }
        return { tagName, attribs };
      },
    },
    // <style> inside <svg> <defs> is needed for SVG class-based styling
    allowVulnerableTags: true,
    parser: { decodeEntities: true },
  });

  return {
    title: article.title ?? "",
    content: toXhtml(cleanedContent),
    byline: article.byline ?? "",
  };
}

// SVG attributes that require camelCase in XHTML (htmlparser2 lowercases them)
const SVG_ATTR_CASE: Record<string, string> = {
  viewbox: "viewBox",
  basefrequency: "baseFrequency",
  clippathunits: "clipPathUnits",
  diffuseconstant: "diffuseConstant",
  edgemode: "edgeMode",
  filterunits: "filterUnits",
  glyphref: "glyphRef",
  gradienttransform: "gradientTransform",
  gradientunits: "gradientUnits",
  kernelmatrix: "kernelMatrix",
  lengthadjust: "lengthAdjust",
  markerheight: "markerHeight",
  markerunits: "markerUnits",
  markerwidth: "markerWidth",
  maskcontentunits: "maskContentUnits",
  maskunits: "maskUnits",
  pathlength: "pathLength",
  patterncontentunits: "patternContentUnits",
  patterntransform: "patternTransform",
  patternunits: "patternUnits",
  pointsatx: "pointsAtX",
  pointsaty: "pointsAtY",
  pointsatz: "pointsAtZ",
  preserveaspectratio: "preserveAspectRatio",
  repeatcount: "repeatCount",
  repeatdur: "repeatDur",
  requiredextensions: "requiredExtensions",
  specularconstant: "specularConstant",
  specularexponent: "specularExponent",
  spreadmethod: "spreadMethod",
  startoffset: "startOffset",
  stddeviation: "stdDeviation",
  stitchtiles: "stitchTiles",
  surfacescale: "surfaceScale",
  textlength: "textLength",
  xchannelselector: "xChannelSelector",
  ychannelselector: "yChannelSelector",
};

// SVG/MathML tags that require camelCase in XHTML
const SVG_TAG_CASE: Record<string, string> = {
  clippath: "clipPath",
  lineargradient: "linearGradient",
  radialgradient: "radialGradient",
  textpath: "textPath",
  foreignobject: "foreignObject",
  mathvariant: "mathvariant",
};

/** Convert HTML to valid XHTML using htmlparser2 + dom-serializer. */
function toXhtml(html: string): string {
  const dom = parseDocument(html);
  let xhtml = render(dom, { xmlMode: true });

  // Restore camelCase SVG attributes
  for (const [lower, correct] of Object.entries(SVG_ATTR_CASE)) {
    if (xhtml.includes(lower + "=")) {
      xhtml = xhtml.replaceAll(lower + "=", correct + "=");
    }
  }

  // Restore camelCase SVG/MathML tag names
  for (const [lower, correct] of Object.entries(SVG_TAG_CASE)) {
    if (xhtml.includes("<" + lower)) {
      xhtml = xhtml.replaceAll("<" + lower, "<" + correct);
      xhtml = xhtml.replaceAll("</" + lower, "</" + correct);
    }
  }

  return xhtml;
}
