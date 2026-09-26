import createDOMPurify from "dompurify";
import { epubPath } from "./reader";

// Sanitize into an inert DOM, removing resource URLs before anything is attached
// to the live document. Keep only in-book raster image references for our loader.
export function readerContent(source: string, chapter: string): HTMLElement {
  const purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (node, attribute) => {
    if (attribute.attrName === "src") {
      if (node.tagName === "IMG") {
        const path = epubPath(chapter, attribute.attrValue);
        if (path && /\.(png|jpe?g|gif|webp)$/i.test(path)) {
          node.setAttribute("data-reader-resource", path);
        }
      }
      attribute.keepAttr = false;
    }
  });
  return purifier.sanitize(source, {
    RETURN_DOM: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "link", "form", "input", "button", "iframe", "object", "embed", "audio", "video", "source"],
    FORBID_ATTR: ["style", "src", "srcset", "target", "ping", "background"],
  }) as HTMLElement;
}
