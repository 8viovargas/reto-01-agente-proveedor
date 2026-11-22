// Verificación sin modelo: ejecuta las herramientas directamente sobre todos los casos.
//   bun install && bun run demo.ts        (o: npm install && npm run demo)
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as t from "./src/tools/proveedor"
import type { Contexto } from "./src/tools/lib/tipos"

const RAIZ = fileURLToPath(new URL("./", import.meta.url))
const OUT = path.join(RAIZ, "out")
const hoy = process.env["FECHA_EJECUCION"] ?? new Date().toISOString().slice(0, 10)
process.env["FECHA_EJECUCION"] = hoy
const ctx: Contexto = { directory: RAIZ, sessionId: "demo" }

interface Salida { ok: boolean; data?: Record<string, unknown>; error?: string }
const j = (s: string): Salida => JSON.parse(s) as Salida
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const fallos: string[] = []
const verifica = (cond: boolean, msg: string): void => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) fallos.push(msg) }

function archivos(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? archivos(p, base) : [path.relative(base, p)]
  }).sort()
}

function huella(): Map<string, string> {
  const m = new Map<string, string>()
  for (const f of archivos(OUT)) {
    if (path.basename(f) === "log.jsonl") continue
    m.set(f, createHash("sha256").update(readFileSync(path.join(OUT, f))).digest("hex").slice(0, 12))
  }
  return m
}

async function procesar(caso: string, verbose: boolean): Promise<void> {
  const leer = j(await t.leer_solicitud.execute({ caso }, ctx))
  const mapeo = j(await t.mapear_campos.execute({ caso }, ctx))
  const form = j(await t.generar_formulario.execute({ caso, mapeo: mapeo.data as never }, ctx))
  const paq = j(await t.armar_paquete.execute({ caso }, ctx))
  if (!verbose) return
  console.log(`\n▶ ${caso}`)
  console.log(`  solicitud : ${leer.ok ? leer.data?.["resumen"] : leer.error}`)
  console.log(`  mapeo     : ${mapeo.ok ? mapeo.data?.["resumen"] : mapeo.error}`)
  for (const f of lista(mapeo.data?.["faltantes"])) console.log(`      faltante : ${(f as { etiqueta: string }).etiqueta}`)
  for (const f of lista(mapeo.data?.["requiere_confirmacion"])) console.log(`      confirmar: ${(f as { etiqueta: string }).etiqueta} — ${(f as { motivo: string }).motivo}`)
  console.log(`  formulario: ${form.ok ? form.data?.["resumen"] : form.error}`)
  console.log(`  paquete   : ${paq.ok ? paq.data?.["resumen"] : paq.error}`)
  for (const b of lista((paq.data?.["checklist"] as { bloqueos?: unknown } | undefined)?.bloqueos)) console.log(`      bloqueo  : ${String(b)}`)
}

async function todosLosCasos(verbose: boolean): Promise<string[]> {
  const casos = j(await t.listar_casos.execute({}, ctx)).data?.["casos"] as string[]
  for (const c of casos) await procesar(c, verbose)
  return casos
}

async function main(): Promise<void> {
  console.log(`Demo sin modelo · fecha de ejecución ${hoy}`)
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const casos = await todosLosCasos(true)
  const primera = huella()

  console.log("\n▶ Confirmación humana (RN4) — ec-corp-andina")
  const sinConf = j(await t.simular_envio.execute({ caso: "ec-corp-andina", confirmado: false }, ctx))
  verifica(!sinConf.ok && sinConf.error === "requiere confirmación explícita", "sin confirmación: { ok:false, error:\"requiere confirmación explícita\" }")
  const negada = j(await t.simular_envio.execute({ caso: "ec-corp-andina", confirmado: true }, { ...ctx, confirmacionUsuario: false }))
  verifica(!negada.ok, "el modelo dice true pero el usuario no confirmó: el host lo niega")
  verifica(!archivos(path.join(OUT, "ec-corp-andina")).includes("ENVIO-SIMULADO.md"), "no existe ENVIO-SIMULADO.md antes de confirmar")
  const conf = j(await t.simular_envio.execute({ caso: "ec-corp-andina", confirmado: true }, { ...ctx, confirmacionUsuario: true }))
  verifica(conf.ok && archivos(path.join(OUT, "ec-corp-andina")).includes("ENVIO-SIMULADO.md"), "con confirmación: se escribe solo ENVIO-SIMULADO.md")

  console.log("\n▶ Robustez (HU-5)")
  const noExiste = j(await t.leer_solicitud.execute({ caso: "no-existe" }, ctx))
  verifica(!noExiste.ok && /no existe/.test(noExiste.error ?? ""), `caso inexistente → «${noExiste.error?.slice(0, 50)}…»`)
  verifica(!j(await t.leer_solicitud.execute({ caso: "../../etc" }, ctx)).ok, "nombre de caso con «..» rechazado")
  const raizT = mkdtempSync(path.join(tmpdir(), "reto01-t-"))
  const marca = `reto01-traversal-${process.pid}`
  await t.leer_solicitud.execute({ caso: `../../${marca}` }, { directory: raizT, sessionId: "demo-t" })
  const escapo = existsSync(path.join(path.dirname(raizT), marca))
  rmSync(path.join(path.dirname(raizT), marca), { recursive: true, force: true })
  rmSync(raizT, { recursive: true, force: true })
  verifica(!escapo, "un nombre de caso con «..» no escribe ningún log fuera de out/")

  const tmp = mkdtempSync(path.join(tmpdir(), "reto01-"))
  cpSync(path.join(RAIZ, "fixtures"), path.join(tmp, "fixtures"), { recursive: true })
  writeFileSync(path.join(tmp, "fixtures/reto-01/casos/ec-corp-andina/plantilla-campos.json"), "{ esto no es json")
  const ctxMalo: Contexto = { directory: tmp, sessionId: "demo-malo" }
  const l2 = j(await t.leer_solicitud.execute({ caso: "ec-corp-andina" }, ctxMalo))
  verifica(!l2.ok && /corrupto/.test(l2.error ?? "") && !/\bat \w|Error:/.test(l2.error ?? ""), `plantilla corrupta → mensaje claro sin traza: «${l2.error?.slice(0, 60)}…»`)
  const p2 = j(await t.armar_paquete.execute({ caso: "ec-corp-andina" }, ctxMalo))
  verifica(p2.ok && p2.data?.["listo_para_firma"] === false, "plantilla corrupta → igual arma el checklist de soportes (no listo para firma)")
  verifica(j(await t.armar_paquete.execute({ caso: "co-industrias-delta" }, ctxMalo)).ok, "un caso malo no impide el siguiente")
  rmSync(tmp, { recursive: true, force: true })

  console.log("\n▶ Reglas de negocio")
  const ec = j(await t.mapear_campos.execute({ caso: "ec-corp-andina" }, ctx)).data
  const ruc = lista(ec?.["requiere_confirmacion"]).find((x) => (x as { etiqueta: string }).etiqueta === "RUC") as { nota?: string } | undefined
  verifica(ruc?.nota === "identificador extranjero", "RN1: RUC de Ecuador → requiere_confirmacion con nota «identificador extranjero»")
  verifica(lista(ec?.["faltantes"]).some((x) => (x as { etiqueta: string }).etiqueta === "Número de contribuyente especial"), "campo sin fuente → faltante (no se inventa)")
  const corr = readFileSync(path.join(OUT, "ec-corp-andina/paquete/borrador-correo.md"), "utf8")
  verifica(!/03100012345|Bancolombia|COLOCOBM|900123456/.test(corr), "RN2: el borrador de correo no incluye datos bancarios ni identificadores")
  const coCheck = readFileSync(path.join(OUT, "co-industrias-delta/paquete/checklist.md"), "utf8")
  verifica(/vencido|LISTO PARA FIRMA/.test(coCheck), "RN3: el checklist marca soportes vencidos (según la fecha de ejecución)")
  const mCo = j(await t.mapear_campos.execute({ caso: "co-industrias-delta" }, ctx)).data
  verifica(lista(mCo?.["llenos"]).length === 17, "co-industrias-delta: los 17 campos de la plantilla quedan llenos")

  console.log("\n▶ Determinismo")
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  await todosLosCasos(false)
  const segunda = huella()
  const iguales = primera.size > 0 && [...segunda.entries()].every(([k, v]) => primera.get(k) === v)
  verifica(iguales, `dos ejecuciones consecutivas producen los mismos ${segunda.size} archivos (hash idéntico; el log tiene timestamps)`)

  console.log(`\n${casos.length} casos procesados. Salidas en out/<caso>/`)
  if (fallos.length > 0) { console.log(`\n${fallos.length} verificación(es) fallaron.`); process.exit(1) }
  console.log("Todas las verificaciones pasaron.")
}

main().catch((e) => { console.error("demo.ts falló:", e instanceof Error ? e.message : String(e)); process.exit(1) })
