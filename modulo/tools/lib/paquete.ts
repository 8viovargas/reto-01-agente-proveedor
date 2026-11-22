import { copyFile, mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { escribirTexto, leerJson, rutas } from "./repo"
import { IndiceSoportesSchema, type Contexto, type Resultado } from "./tipos"

export type EstadoSoporte = "presente" | "ausente" | "vencido"
export interface ItemSoporte {
  tipo: string
  estado: EstadoSoporte
  archivo: string | null
  vigencia_hasta: string | null
  pais_emisor: string | null
  nota?: string
}

async function existeArchivo(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

export async function evaluarSoportes(
  ctx: Contexto,
  exigidos: string[],
  hoy: string,
  observaciones: Map<string, string>,
): Promise<Resultado<ItemSoporte[]>> {
  const r = rutas(ctx)
  const indice = await leerJson(r.indiceSoportes, IndiceSoportesSchema, "soportes/index.json")
  if (!indice.ok) return indice
  const items: ItemSoporte[] = []
  for (const tipo of exigidos) {
    const nota = observaciones.get(tipo)
    const s = indice.data.find((x) => x.tipo === tipo)
    if (!s) {
      items.push({ tipo, estado: "ausente", archivo: null, vigencia_hasta: null, pais_emisor: null, nota: "No existe en el índice del repositorio." })
      continue
    }
    if (!(await existeArchivo(path.join(r.soportes, s.archivo)))) {
      items.push({ tipo, estado: "ausente", archivo: s.archivo, vigencia_hasta: s.vigencia_hasta, pais_emisor: s.pais_emisor, nota: "El índice lo lista pero el archivo no está." })
      continue
    }
    const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < hoy
    items.push({
      tipo,
      estado: vencido ? "vencido" : "presente",
      archivo: s.archivo,
      vigencia_hasta: s.vigencia_hasta,
      pais_emisor: s.pais_emisor,
      ...(vencido ? { nota: `Venció el ${s.vigencia_hasta}; hay que actualizarlo.` } : nota ? { nota } : {}),
    })
  }
  return { ok: true, data: items }
}

export async function copiarSoportes(ctx: Contexto, items: ItemSoporte[], destino: string): Promise<string[]> {
  const copiados: string[] = []
  await mkdir(destino, { recursive: true })
  for (const i of items) {
    if (!i.archivo || i.estado === "ausente") continue
    await copyFile(path.join(rutas(ctx).soportes, i.archivo), path.join(destino, i.archivo))
    copiados.push(i.archivo)
  }
  return copiados
}

export async function limpiarCarpeta(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
}

export { escribirTexto }
