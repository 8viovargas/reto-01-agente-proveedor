import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const RAIZ = fileURLToPath(new URL("../", import.meta.url))

/** Carga .env sin dependencias y sin pisar variables ya definidas. */
function cargarEnv(): void {
  const archivo = path.join(RAIZ, ".env")
  if (!existsSync(archivo)) return
  for (const linea of readFileSync(archivo, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(linea)
    if (!m || linea.trim().startsWith("#")) continue
    const [, k = "", v = ""] = m
    if (process.env[k] === undefined) process.env[k] = v.replace(/^["']|["']$/g, "")
  }
}
cargarEnv()

const num = (v: string | undefined, def: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : def
}

const apiKey = process.env["ANTHROPIC_API_KEY"] || undefined
const proveedorPedido = process.env["LLM_PROVIDER"]

export const config = {
  puerto: num(process.env["PORT"], 3000),
  proveedor: proveedorPedido ?? (apiKey ? "anthropic" : "mock"),
  anthropicApiKey: apiKey,
  modelo: process.env["ANTHROPIC_MODEL"] || "claude-sonnet-5-5",
  maxIteraciones: num(process.env["MAX_ITERACIONES"], 25),
  maxTokensSesion: num(process.env["MAX_TOKENS_SESION"], 200_000),
  maxTurnosSesion: num(process.env["MAX_TURNOS_SESION"], 40),
  maxTokensRespuesta: num(process.env["MAX_TOKENS_RESPUESTA"], 2000),
  timeoutLlmMs: num(process.env["LLM_TIMEOUT_MS"], 60_000),
  limitePorMinuto: num(process.env["RATE_LIMIT_POR_MINUTO"], 30),
  claveAcceso: process.env["ACCESS_KEY"] || undefined,
}
export type Config = typeof config
