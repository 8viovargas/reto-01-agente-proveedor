import path from "node:path"
import { construirXlsx, type CeldaXlsx } from "./xlsx"
import { construirPdf, type FilaPdf } from "./pdf"
import { escribirTexto, relativa, valorMaestro } from "./repo"
import type { CasoCargado } from "./caso"
import type { Contexto, Formato, ItemMapeo, Mapeo, Valor } from "./tipos"

export interface FormularioGenerado {
  ruta: string
  absoluta: string
  formato: Formato
  advertencias: string[]
}

type Estado = "lleno" | "requiere_confirmacion" | "faltante"
interface Resuelto { estado: Estado; item: ItemMapeo; real?: Valor }

const clave = (hoja: string | undefined, etiqueta: string): string => `${hoja ?? ""}|${etiqueta}`

/** Los valores se leen SIEMPRE del maestro por «ruta»; lo que el modelo haya escrito en el mapeo no se usa. */
function resolver(mapeo: Mapeo, maestro: Record<string, unknown>): Map<string, Resuelto> {
  const m = new Map<string, Resuelto>()
  const poner = (items: ItemMapeo[], estado: Estado): void => {
    for (const item of items) {
      const real = item.ruta && estado !== "faltante" ? valorMaestro(maestro, item.ruta) : undefined
      m.set(clave(item.hoja, item.etiqueta), { estado: real === undefined && estado !== "faltante" ? "faltante" : estado, item, ...(real !== undefined ? { real } : {}) })
    }
  }
  poner(mapeo.llenos, "lleno")
  poner(mapeo.requiere_confirmacion, "requiere_confirmacion")
  poner(mapeo.faltantes, "faltante")
  return m
}

const texto = (v: Valor | undefined): string => (v === undefined ? "" : typeof v === "boolean" ? (v ? "Sí" : "No") : String(v))

export async function producirFormulario(
  ctx: Contexto,
  caso: CasoCargado,
  mapeo: Mapeo,
  maestro: Record<string, unknown>,
  carpetaSalida: string,
): Promise<FormularioGenerado> {
  const r = resolver(mapeo, maestro)
  const advertencias: string[] = []

  if (caso.formato === "xlsx") {
    const celdas: CeldaXlsx[] = []
    for (const c of caso.campos) {
      if (!c.hoja || !c.celda_etiqueta || !c.celda_valor) continue
      celdas.push({ hoja: c.hoja, ref: c.celda_etiqueta, valor: c.etiqueta, estilo: "etiqueta" })
      const x = r.get(clave(c.hoja, c.etiqueta))
      if (!x || x.estado === "faltante") celdas.push({ hoja: c.hoja, ref: c.celda_valor, valor: null, estilo: "faltante" })
      else {
        const v = typeof x.real === "number" ? x.real : texto(x.real)
        celdas.push({ hoja: c.hoja, ref: c.celda_valor, valor: v, estilo: x.estado === "requiere_confirmacion" ? "confirmar" : "normal" })
      }
    }
    const absoluta = path.join(carpetaSalida, "formulario.xlsx")
    await escribirTexto(absoluta, await construirXlsx(celdas))
    advertencias.push("Celdas amarillas = requieren confirmación; celdas rojas vacías = faltantes (no se inventó ningún valor).")
    return { ruta: relativa(ctx, absoluta), absoluta, formato: "xlsx", advertencias }
  }

  if (caso.formato === "pdf") {
    const filas: FilaPdf[] = caso.campos.map((c) => {
      const x = r.get(clave(c.hoja, c.etiqueta))
      if (!x || x.estado === "faltante") return { etiqueta: c.etiqueta, obligatorio: c.obligatorio, valor: null, estado: "faltante" }
      return { etiqueta: c.etiqueta, obligatorio: c.obligatorio, valor: texto(x.real), estado: x.estado, ...(x.item.nota ? { nota: x.item.nota } : {}) }
    })
    const bytes = await construirPdf(
      "Formulario de registro de proveedor",
      [`Cliente: ${caso.cliente}`, `Solicitud: ${caso.solicitud.asunto}`, `Fecha de la solicitud: ${caso.solicitud.fecha}`, `País del cliente: ${caso.pais}`],
      filas,
    )
    const absoluta = path.join(carpetaSalida, "formulario.pdf")
    await escribirTexto(absoluta, bytes)
    return { ruta: relativa(ctx, absoluta), absoluta, formato: "pdf", advertencias }
  }

  // portal: no se automatiza; se entregan los valores listos para copiar
  const L: string[] = [
    `# Valores para el portal de ${caso.cliente}`,
    "",
    `> Formato **portal web**: no soportado por el agente. Un humano ingresa las credenciales, copia estos valores y da clic en «Enviar».`,
    "",
  ]
  if (caso.campos.length === 0) {
    L.push("_El cliente no entregó una lista de campos (falta `plantilla-campos.json`)._")
    advertencias.push("No hay lista de campos del portal; el archivo no contiene valores.")
  } else {
    L.push("| Campo | Valor | Estado | Nota |", "|---|---|---|---|")
    for (const c of caso.campos) {
      const x = r.get(clave(c.hoja, c.etiqueta))
      const celda = (s: string): string => s.replace(/\|/g, "\\|")
      if (!x || x.estado === "faltante") L.push(`| ${celda(c.etiqueta)} | _(faltante)_ | faltante | ${celda(x?.item.motivo ?? "")} |`)
      else L.push(`| ${celda(c.etiqueta)} | ${celda(texto(x.real))} | ${x.estado === "lleno" ? "lleno" : "requiere confirmación"} | ${celda(x.item.nota ?? x.item.motivo ?? "")} |`)
    }
  }
  const absoluta = path.join(carpetaSalida, "valores-portal.md")
  await escribirTexto(absoluta, L.join("\n") + "\n")
  return { ruta: relativa(ctx, absoluta), absoluta, formato: "portal", advertencias: [...advertencias, "formato no soportado"] }
}
