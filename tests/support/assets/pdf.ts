/** Small real PDFs with xref offsets, so browser tests exercise PDF.js rather than a parser mock. */
export function textPdf(pages: string[][] = [['File budget: 42.']], options: { blank?: boolean; malformed?: boolean; unicode?: boolean; paddingBytes?: number; fontSize?: number } = {}) {
  const objects: string[] = ['', ''];
  const font = 3;
  if (options.unicode) {
    objects.push('<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>');
    objects.push('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> /DW 1000 >>');
    const chars = [...new Set(pages.flat().join('').split(''))];
    const mapping = chars.map((char) => { const hex = char.charCodeAt(0).toString(16).padStart(4, '0'); return `<${hex}> <${hex}>`; }).join('\n');
    const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /TestUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${mapping}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
    objects.push(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
  } else objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const lines of pages) {
    const page = objects.length + 1, stream = page + 1; kids.push(page);
    const contents = options.blank ? '' : `${options.paddingBytes ? `%${'x'.repeat(options.paddingBytes)}\n` : ''}BT /F1 ${options.fontSize ?? 12} Tf 50 750 Td\n${lines.map((line, index) => `${index ? '0 -16 Td ' : ''}${options.unicode ? `<${line.split('').map((char) => char.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>` : `(${line.replace(/[\\()]/g, '\\$&')})`} Tj`).join('\n')}\nET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}\nendstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.7\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return options.malformed ? Buffer.from('%PDF-1.7\nnot a PDF\n') : Buffer.from(pdf);
}
