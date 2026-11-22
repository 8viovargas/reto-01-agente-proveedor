import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import {
  PlantillaCamposSchema,
  PlantillaCeldasSchema,
  SoportesExigidosSchema,
  SolicitudSchema,
  type CampoSolicitado,
  type Contexto,
  type Formato,
  type Resultado,
  type Solicitud,
} from "./tipos"
import { CASO_RE, leerJson, rutas } from "./repo"

export interface CasoCargado {
  id: string
  dir: string
  solicitud: Solicitud
  formato: Formato
  pais: string
  cliente: string
  campos: CampoSolicitado[]
  soportes: string[]
  /** Si la plantilla no se pudo leer, el caso sigue disponible para el resto del flujo. */
  errorPlantilla?: string
  errorSoportes?: string
}

export async function listarCasos(ctx: Contexto): Promise<string[]> {
  try {
    const entradas = await readdir(rutas(ctx).casos, { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

async function existe(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function cargarCaso(ctx: Contexto, caso: string): Promise<Resultado<CasoCargado>> {
  if (!CASO_RE.test(caso)) {
    return { ok: false, error: `El nombre de caso «${caso}» no es válido (solo letras, números, guion y guion bajo).` }
  }
  const dir = path.join(rutas(ctx).casos, caso)
  if (!(await existe(dir))) {
    const disponibles = await listarCasos(ctx)
    const lista = disponibles.length > 0 ? ` Casos disponibles: ${disponibles.join(", ")}.` : " No hay casos disponibles."
    return { ok: false, error: `El caso «${caso}» no existe.${lista}` }
  }

  const sol = await leerJson(path.join(dir, "solicitud.json"), SolicitudSchema, "solicitud.json")
  if (!sol.ok) return { ok: false, error: `Caso «${caso}»: ${sol.error}` }
  const solicitud = sol.data
  const formato = solicitud.formato
  const base = { id: solicitud.id ?? caso, dir, solicitud, formato, pais: solicitud.pais.toUpperCase(), cliente: solicitud.cliente }

  let campos: CampoSolicitado[] = []
  let errorPlantilla: string | undefined
  if (formato === "xlsx") {
    const p = await leerJson(path.join(dir, "plantilla-celdas.json"), PlantillaCeldasSchema, "plantilla-celdas.json")
    if (p.ok) campos = p.data.map((c) => ({ etiqueta: c.etiqueta, obligatorio: false, hoja: c.hoja, celda_etiqueta: c.celda_etiqueta, celda_valor: c.celda_valor }))
    else errorPlantilla = p.error
  } else {
    const archivo = path.join(dir, "plantilla-campos.json")
    if (formato === "pdf" || (await existe(archivo))) {
      const p = await leerJson(archivo, PlantillaCamposSchema, "plantilla-campos.json")
      if (p.ok) campos = p.data.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio }))
      else errorPlantilla = p.error
    }
  }

  let soportes: string[] = []
  let errorSoportes: string | undefined
  const s = await leerJson(path.join(dir, "soportes-exigidos.json"), SoportesExigidosSchema, "soportes-exigidos.json")
  if (s.ok) soportes = s.data
  else errorSoportes = s.error

  return { ok: true, data: { ...base, campos, soportes, errorPlantilla, errorSoportes } }
}
