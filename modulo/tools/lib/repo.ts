import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod/v4"
import { ReglasSchema, type Contexto, type Reglas, type Resultado, type Valor } from "./tipos"

export const CASO_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function rutas(ctx: Contexto) {
  const fixtures = path.join(ctx.directory, "fixtures", "reto-01")
  return {
    casos: path.join(fixtures, "casos"),
    maestro: path.join(fixtures, "repositorio", "maestro.json"),
    indiceSoportes: path.join(fixtures, "repositorio", "soportes", "index.json"),
    soportes: path.join(fixtures, "repositorio", "soportes"),
    glosario: path.join(fixtures, "glosario-campos.json"),
    out: path.join(ctx.directory, "out"),
  }
}

export function relativa(ctx: Contexto, absoluta: string): string {
  return path.relative(ctx.directory, absoluta).split(path.sep).join("/")
}

export function mensajeDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function leerJson<S extends z.ZodType>(
  archivo: string,
  esquema: S,
  nombre: string,
): Promise<Resultado<z.infer<S>>> {
  let texto: string
  try {
    texto = await readFile(archivo, "utf8")
  } catch {
    return { ok: false, error: `No se encontró ${nombre}.` }
  }
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    return { ok: false, error: `${nombre} está corrupto (JSON inválido).` }
  }
  const r = esquema.safeParse(crudo)
  if (!r.success) {
    const p = r.error.issues[0]
    const donde = p && p.path.length > 0 ? ` en «${p.path.join(".")}»` : ""
    return { ok: false, error: `${nombre} no tiene la estructura esperada${donde}: ${p?.message ?? "formato inválido"}.` }
  }
  return { ok: true, data: r.data }
}

export async function escribirTexto(archivo: string, contenido: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(archivo), { recursive: true })
  await writeFile(archivo, contenido)
}

/** Registro por caso (RN5). Nunca debe romper la herramienta. */
export async function registrar(
  ctx: Contexto,
  caso: string,
  herramienta: string,
  ok: boolean,
  resumen: string,
): Promise<void> {
  // El nombre de caso viene del usuario/modelo: nunca debe poder salirse de out/ (ej. «../../etc»).
  if (!CASO_RE.test(caso)) return
  try {
    const dir = path.join(rutas(ctx).out, caso)
    await mkdir(dir, { recursive: true })
    const linea = JSON.stringify({ ts: new Date().toISOString(), herramienta, ok, resumen })
    await appendFile(path.join(dir, "log.jsonl"), linea + "\n")
  } catch {
    /* el log es best-effort */
  }
}

export function fechaEjecucion(ctx: Contexto): string {
  const f = ctx.fechaEjecucion ?? process.env.FECHA_EJECUCION
  if (f && /^\d{4}-\d{2}-\d{2}$/.test(f)) return f
  return new Date().toISOString().slice(0, 10)
}

let reglasCache: Reglas | null = null
export function cargarReglas(): Reglas {
  if (reglasCache) return reglasCache
  const archivo = fileURLToPath(new URL("../../knowledge/reglas.json", import.meta.url))
  reglasCache = ReglasSchema.parse(JSON.parse(readFileSync(archivo, "utf8")))
  return reglasCache
}

/** Lee una ruta con puntos («banco.nombre») del maestro. Devuelve undefined si no hay un valor usable. */
export function valorMaestro(maestro: Record<string, unknown>, ruta: string): Valor | undefined {
  let actual: unknown = maestro
  for (const parte of ruta.split(".")) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return undefined
    actual = (actual as Record<string, unknown>)[parte]
  }
  if (typeof actual === "string") return actual.trim() === "" ? undefined : actual
  if (typeof actual === "number" || typeof actual === "boolean") return actual
  if (Array.isArray(actual) && actual.every((x) => typeof x === "string") && actual.length > 0) {
    return actual.join(", ")
  }
  return undefined
}
