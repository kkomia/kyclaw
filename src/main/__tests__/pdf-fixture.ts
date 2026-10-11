/**
 * 自造最小 PDF（测试 fixture，模块 2）：用来钉"真 PDF → 真文本"这条链路，不引外部样本文件。
 *
 * 结构刻意最小：Catalog → Pages → 每页一个 Page + 一个内容流（`BT … Tj … ET`）+ 一个共享的
 * Helvetica 字体对象。**xref 偏移量按字节算**，所以 fixture 的正文请用 ASCII
 * （非 ASCII 会让字符数与字节数不等，偏移就错了）。
 */

/** PDF 字符串里的字面量转义（\ ( ) 三个字符才需要转义） */
function escapePdf(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** 一页的正文：每行一条 `Tj`，行距 = leading */
function contentStream(lines: readonly string[], fontSize: number, leading: number): string {
  if (lines.length === 0) return ''
  const show = lines
    .map((line, index) => `${index === 0 ? '' : `0 -${leading} Td `}(${escapePdf(line)}) Tj`)
    .join(' ')
  return `BT /F1 ${fontSize} Tf 72 720 Td ${show} ET`
}

export interface PdfFixtureOptions {
  /** 页面宽高（PDF 单位）。**注意**：pdf.js 的 getTextContent 会丢掉跑出页面框的文字，
   *  所以"一页里放很多人肉长行"的 fixture 必须把页面开得足够大。 */
  width?: number
  height?: number
  fontSize?: number
  leading?: number
}

/** 造一份 PDF：`pages` 是每页的文本行（空数组 = 该页没有文字层，用来模拟扫描件） */
export function buildPdf(
  pages: ReadonlyArray<readonly string[]>,
  options: PdfFixtureOptions = {}
): Uint8Array {
  const width = options.width ?? 612
  const height = options.height ?? 792
  const fontSize = options.fontSize ?? 18
  const leading = options.leading ?? 24
  const pageCount = pages.length
  const fontObject = 3 + 2 * pageCount
  const kids = pages.map((_, index) => `${3 + 2 * index} 0 R`).join(' ')

  // 对象号 → 内容（下标从 1 开始；0 号是 PDF 规定的空对象）
  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`
  pages.forEach((lines, index) => {
    const pageObject = 3 + 2 * index
    const contentObject = pageObject + 1
    const stream = contentStream(lines, fontSize, leading)
    objects[pageObject] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`
    objects[contentObject] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  objects[fontObject] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let number = 1; number <= fontObject; number++) {
    offsets[number] = out.length
    out += `${number} 0 obj\n${objects[number]}\nendobj\n`
  }

  const xrefOffset = out.length
  out += `xref\n0 ${fontObject + 1}\n0000000000 65535 f \n`
  for (let number = 1; number <= fontObject; number++) {
    out += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${fontObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return new TextEncoder().encode(out)
}
