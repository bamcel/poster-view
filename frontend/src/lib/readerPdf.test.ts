// @vitest-environment node
import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

it("loads a real PDF and extracts searchable text", async () => {
  let source = "%PDF-1.4\n";
  const offsets = [0];
  const stream = "BT /F1 20 Tf 20 100 Td (Reader sample) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = source.length;
  source += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const task = getDocument({
    data: new TextEncoder().encode(source),
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(1);
    const page = await pdf.getPage(1);
    const text = await page.getTextContent();
    expect(
      text.items.map((i) => ("str" in i ? i.str : "")).join(" "),
    ).toContain("Reader sample");
  } finally {
    await task.destroy();
  }
});
