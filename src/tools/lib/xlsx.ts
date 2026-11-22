import JSZip from "jszip"

export type EstiloCelda = "normal" | "etiqueta" | "confirmar" | "faltante"
export interface CeldaXlsx {
  hoja: string
  ref: string
  valor: string | number | null
  estilo: EstiloCelda
}

const FECHA_FIJA = new Date(Date.UTC(2000, 0, 1))
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function partesRef(ref: string): { col: number; fila: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)
  if (!m) return { col: 1, fila: 1 }
  let col = 0
  for (const ch of m[1] ?? "") col = col * 26 + (ch.charCodeAt(0) - 64)
  return { col, fila: Number(m[2]) }
}

// 0 normal · 1 etiqueta · 2 confirmar · 3 faltante · 4 número
const ESTILOS = `${XML}<styleSheet xmlns="${NS}">
<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF8CBAD"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FF999999"/></left><right style="thin"><color rgb="FF999999"/></right><top style="thin"><color rgb="FF999999"/></top><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

function estiloId(c: CeldaXlsx): number {
  if (c.estilo === "etiqueta") return 1
  if (c.estilo === "confirmar") return 2
  if (c.estilo === "faltante") return 3
  return typeof c.valor === "number" ? 4 : 0
}

function xmlHoja(celdas: CeldaXlsx[]): string {
  const filas = new Map<number, { col: number; xml: string }[]>()
  for (const c of celdas) {
    const { col, fila } = partesRef(c.ref)
    const s = estiloId(c)
    let xml: string
    if (c.valor === null) xml = `<c r="${c.ref}" s="${s}"/>`
    else if (typeof c.valor === "number" && Number.isFinite(c.valor)) xml = `<c r="${c.ref}" s="${s}"><v>${c.valor}</v></c>`
    else xml = `<c r="${c.ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(String(c.valor))}</t></is></c>`
    const lista = filas.get(fila) ?? []
    lista.push({ col, xml })
    filas.set(fila, lista)
  }
  const cuerpo = [...filas.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fila, cs]) => `<row r="${fila}">${cs.sort((a, b) => a.col - b.col).map((x) => x.xml).join("")}</row>`)
    .join("")
  const anchos = '<cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="48" customWidth="1"/></cols>'
  return `${XML}<worksheet xmlns="${NS}">${anchos}<sheetData>${cuerpo}</sheetData></worksheet>`
}

/** Escritor mínimo de .xlsx (hojas en orden de aparición, salida determinista). */
export async function construirXlsx(celdas: CeldaXlsx[]): Promise<Uint8Array> {
  const hojas: string[] = []
  for (const c of celdas) if (!hojas.includes(c.hoja)) hojas.push(c.hoja)
  if (hojas.length === 0) hojas.push("Hoja1")

  const zip = new JSZip()
  const opt = { date: FECHA_FIJA }
  const overrides = hojas
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("")
  zip.file("[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`, opt)
  zip.file("_rels/.rels", `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`, opt)
  zip.file("xl/workbook.xml", `${XML}<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets>${hojas.map((h, i) => `<sheet name="${esc(h)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`, opt)
  zip.file("xl/_rels/workbook.xml.rels", `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`, opt)
  zip.file("xl/styles.xml", ESTILOS, opt)
  hojas.forEach((h, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, xmlHoja(celdas.filter((c) => c.hoja === h)), opt)
  })
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } })
}
