import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib"

export interface FilaPdf {
  etiqueta: string
  obligatorio: boolean
  valor: string | null
  estado: "lleno" | "requiere_confirmacion" | "faltante"
  nota?: string
}

const PERMITIDOS = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac])

/** pdf-lib con fuentes estándar solo codifica WinAnsi: lo demás se reemplaza. */
export function limpiar(s: string): string {
  let r = ""
  for (const ch of s.replace(/\r?\n/g, " ")) {
    const c = ch.codePointAt(0) ?? 63
    r += (c >= 32 && c <= 255) || PERMITIDOS.has(c) ? ch : "?"
  }
  return r
}

function envolver(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of limpiar(texto).split(" ")) {
    let p = palabra
    while (fuente.widthOfTextAtSize(p, tam) > ancho) {
      let corte = p.length - 1
      while (corte > 1 && fuente.widthOfTextAtSize(p.slice(0, corte), tam) > ancho) corte--
      if (actual) { lineas.push(actual); actual = "" }
      lineas.push(p.slice(0, corte))
      p = p.slice(corte)
    }
    const prueba = actual ? `${actual} ${p}` : p
    if (fuente.widthOfTextAtSize(prueba, tam) <= ancho) actual = prueba
    else { lineas.push(actual); actual = p }
  }
  if (actual || lineas.length === 0) lineas.push(actual)
  return lineas
}

export async function construirPdf(titulo: string, encabezado: string[], filas: FilaPdf[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false })
  pdf.setTitle(limpiar(titulo))
  pdf.setProducer("reto-01")
  pdf.setCreator("reto-01")
  pdf.setCreationDate(new Date(0))
  pdf.setModificationDate(new Date(0))
  const normal = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)

  const W = 595.28, H = 841.89, M = 56, COL = 190, XV = M + COL + 10
  const anchoValor = W - M - XV
  const gris = rgb(0.6, 0.6, 0.6)
  let page = pdf.addPage([W, H])
  let y = H - M

  const nuevaPagina = (): void => { page = pdf.addPage([W, H]); y = H - M }

  page.drawText(limpiar(titulo), { x: M, y: y - 14, size: 15, font: negrita })
  y -= 34
  for (const l of encabezado) {
    page.drawText(limpiar(l), { x: M, y: y - 10, size: 10, font: normal, color: rgb(0.25, 0.25, 0.25) })
    y -= 15
  }
  y -= 8

  for (const f of filas) {
    const etiqueta = envolver(`${f.etiqueta}${f.obligatorio ? " *" : ""}`, negrita, 9.5, COL)
    const textoValor =
      f.estado === "faltante" ? "— FALTANTE: completar manualmente —"
      : f.estado === "requiere_confirmacion" ? `${f.valor ?? ""}  [REQUIERE CONFIRMACIÓN${f.nota ? `: ${f.nota}` : ""}]`
      : (f.valor ?? "")
    const valor = envolver(textoValor, normal, 10, anchoValor)
    const alto = Math.max(etiqueta.length, valor.length) * 13 + 8
    if (y - alto < M + 110) nuevaPagina()
    const color = f.estado === "faltante" ? rgb(0.75, 0.1, 0.1) : f.estado === "requiere_confirmacion" ? rgb(0.75, 0.45, 0) : rgb(0, 0, 0)
    etiqueta.forEach((l, i) => page.drawText(l, { x: M, y: y - 11 - i * 13, size: 9.5, font: negrita }))
    valor.forEach((l, i) => page.drawText(l, { x: XV, y: y - 11 - i * 13, size: 10, font: normal, color }))
    y -= alto
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.4, color: gris })
  }

  if (y - 100 < M) nuevaPagina()
  y -= 30
  page.drawText("* Campo obligatorio", { x: M, y, size: 8.5, font: normal, color: gris })
  y -= 50
  page.drawLine({ start: { x: M, y }, end: { x: M + 230, y }, thickness: 0.8 })
  page.drawText("Firma del representante legal", { x: M, y: y - 12, size: 9.5, font: normal })
  page.drawText("Nombre y documento: ______________________", { x: M, y: y - 28, size: 9.5, font: normal })

  const paginas = pdf.getPages()
  paginas.forEach((p, i) => p.drawText(`Página ${i + 1} de ${paginas.length}`, { x: W - M - 70, y: 28, size: 8, font: normal, color: gris }))
  return pdf.save({ useObjectStreams: false })
}
