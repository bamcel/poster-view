import DOMPurify from "dompurify";

function withoutBracketedNotes(text: string): string {
  let result = "", cursor = 0, start = 0, depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "[") {
      if (depth === 0) start = index;
      depth++;
    } else if (text[index] === "]" && depth > 0) {
      depth--;
      if (depth === 0) {
        result += text.slice(cursor, start) + " ";
        cursor = index + 1;
      }
    }
  }
  return result + text.slice(cursor);
}

/** Provider synopsis markup rendered as plain text, never executable HTML. */
export function mediaDescription(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const clean=DOMPurify.sanitize(value.replace(/&lt;br\s*\/?\s*&gt;/gi,"\n").replace(/<\/(?:p|div)>/gi,"\n").replace(/<br\s*\/?\s*>/gi,"\n"),{ALLOWED_TAGS:[],ALLOWED_ATTR:[]});
  const doc=new DOMParser().parseFromString(clean,"text/html");
  return withoutBracketedNotes(doc.body.textContent ?? "").replace(/\r\n?/g,"\n").replace(/[\t ]*\n(?:[\t ]*\n)*[\t ]*/g,"\n").replace(/[\t ]{2,}/g," ").trim();
}
