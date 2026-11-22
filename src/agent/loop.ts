import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { ErrorLlm, type AdaptadorLlm, type MensajeLlm } from "../llm/adapter"
import type { HerramientaRegistrada } from "./registro"
import type { LlamadaVisible, Sesion } from "./sesion"

export interface LimitesAgente {
  maxIteraciones: number
  maxTokensSesion: number
  maxTurnosSesion: number
}

export interface DepsAgente {
  adaptador: AdaptadorLlm
  herramientas: HerramientaRegistrada[]
  systemPrompt: string
  limites: LimitesAgente
  directory: string
}

export interface ResultadoTurno {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  error?: boolean
}

const MAX_RESULTADO_AL_MODELO = 12_000
const MAX_DETALLE_VISIBLE = 1_800

const norm = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()

/** Confirmación explícita: afirma y no niega. «envíes» no cuenta; «sí, no envíes» tampoco. */
export function esAfirmativo(texto: string): boolean {
  const t = norm(texto)
  if (/\b(no|nunca|cancela|cancelar|espera|esperar|detente|todavia no|aun no)\b/.test(t)) return false
  return /\b(si|ok|okay|dale|vale|adelante|confirmo|confirmado|envia|enviala|envialo|enviar|procede|hazlo|de acuerdo|claro)\b/.test(t)
}

function leerResultado(contenido: string): { ok: boolean; resumen: string } {
  try {
    const j: unknown = JSON.parse(contenido)
    if (typeof j === "object" && j !== null) {
      const o = j as Record<string, unknown>
      if (o["ok"] === true) {
        const d = o["data"]
        const r = typeof d === "object" && d !== null ? (d as Record<string, unknown>)["resumen"] : undefined
        return { ok: true, resumen: typeof r === "string" ? r : "ok" }
      }
      return { ok: false, resumen: String(o["error"] ?? "error desconocido") }
    }
  } catch { /* se trata como error abajo */ }
  return { ok: false, resumen: "La herramienta devolvió una respuesta ilegible." }
}

const casoDe = (l: LlamadaVisible): string | undefined => (typeof l.argumentos["caso"] === "string" ? l.argumentos["caso"] : undefined)

async function registrarGlobal(directory: string, sesionId: string, l: LlamadaVisible): Promise<void> {
  try {
    const dir = path.join(directory, "out")
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), sessionId: sesionId, herramienta: l.nombre, argumentos: l.argumentos, ok: l.ok, resumen: l.resumen }) + "\n")
  } catch { /* best-effort */ }
}

function resumenSinModelo(llamadas: LlamadaVisible[], motivo: string): string {
  const lineas = llamadas.map((l) => `- ${l.nombre}: ${l.ok ? "ok" : "error"} — ${l.resumen}`)
  return `${motivo}${lineas.length > 0 ? `\n\nLo que alcancé a hacer en este turno:\n${lineas.join("\n")}` : ""}`
}

export async function ejecutarTurno(deps: DepsAgente, sesion: Sesion, mensajeUsuario: string): Promise<ResultadoTurno> {
  const { adaptador, herramientas, limites } = deps
  const ahora = (): string => new Date().toISOString()
  const llamadasTurno: LlamadaVisible[] = []

  // Confirmación humana: la decide el servidor mirando el mensaje inmediatamente posterior a la pregunta.
  const pendienteAntes = sesion.pendiente
  const confirmoAhora = pendienteAntes !== null && esAfirmativo(mensajeUsuario)
  sesion.pendiente = null

  sesion.historial.push({ rol: "user", texto: mensajeUsuario, ts: ahora() })
  sesion.turnos++

  const cerrar = (reply: string, error = false): ResultadoTurno => {
    const needs = sesion.pendiente !== null
    const final = needs && !reply.trimEnd().endsWith("?") && sesion.pendiente
      ? `${reply.trimEnd()}\n\n¿Confirmas que simule el envío del paquete de «${sesion.pendiente.caso}»? Responde «sí, envía» para continuar, o dime qué quieres cambiar antes.`
      : reply
    sesion.historial.push({ rol: "assistant", texto: final, ts: ahora(), toolCalls: llamadasTurno, needsConfirmation: needs, ...(error ? { error: true } : {}) })
    return { reply: final, toolCalls: llamadasTurno, needsConfirmation: needs, ...(error ? { error: true } : {}) }
  }

  if (sesion.turnos > limites.maxTurnosSesion) {
    return cerrar("Esta sesión llegó al máximo de turnos permitido. Abre una sesión nueva para seguir.", true)
  }

  sesion.mensajes.push({ rol: "user", texto: mensajeUsuario })
  const encabezado: MensajeLlm = { rol: "system", texto: deps.systemPrompt }
  const defs = herramientas.map((h) => h.definicion)

  const presupuestoAgotado = (): boolean => sesion.uso.entrada + sesion.uso.salida >= limites.maxTokensSesion

  for (let iter = 0; iter < limites.maxIteraciones; iter++) {
    if (presupuestoAgotado()) return cerrar(resumenSinModelo(llamadasTurno, "Se alcanzó el tope de tokens de esta sesión; abre una sesión nueva para continuar."), true)
    let r
    try {
      r = await adaptador.enviar([encabezado, ...sesion.mensajes], defs)
    } catch (e) {
      const msg = e instanceof ErrorLlm ? e.message : "Ocurrió un error inesperado al consultar el modelo."
      return cerrar(resumenSinModelo(llamadasTurno, `${msg} La sesión sigue activa: puedes reintentar.`), true)
    }
    sesion.uso.entrada += r.uso.entrada
    sesion.uso.salida += r.uso.salida

    if (r.llamadas.length === 0) {
      sesion.mensajes.push({ rol: "assistant", texto: r.texto, llamadas: [] })
      return cerrar(r.texto.trim() === "" ? "No tengo nada más que agregar." : r.texto)
    }

    const resultados: { id: string; nombre: string; contenido: string }[] = []
    for (const llamada of r.llamadas) {
      const h = herramientas.find((x) => x.nombre === llamada.nombre)
      let contenido: string
      if (!h) {
        contenido = JSON.stringify({ ok: false, error: `La herramienta «${llamada.nombre}» no existe.` })
      } else {
        const casoLlamada = typeof llamada.argumentos["caso"] === "string" ? llamada.argumentos["caso"] : undefined
        const confirmacionUsuario = confirmoAhora && pendienteAntes?.caso === casoLlamada
        try {
          contenido = await h.ejecutar(llamada.argumentos, { directory: deps.directory, sessionId: sesion.id, confirmacionUsuario })
        } catch {
          contenido = JSON.stringify({ ok: false, error: `La herramienta ${llamada.nombre} falló de forma inesperada.` })
        }
      }
      const { ok, resumen } = leerResultado(contenido)
      const visible: LlamadaVisible = { id: llamada.id, nombre: llamada.nombre, argumentos: llamada.argumentos, ok, resumen, detalle: contenido.length > MAX_DETALLE_VISIBLE ? `${contenido.slice(0, MAX_DETALLE_VISIBLE)}…` : contenido }
      llamadasTurno.push(visible)
      await registrarGlobal(deps.directory, sesion.id, visible)
      resultados.push({ id: llamada.id, nombre: llamada.nombre, contenido: contenido.length > MAX_RESULTADO_AL_MODELO ? `${contenido.slice(0, MAX_RESULTADO_AL_MODELO)}… [recortado]` : contenido })
    }
    sesion.mensajes.push({ rol: "assistant", texto: r.texto, llamadas: r.llamadas })
    sesion.mensajes.push({ rol: "tool", resultados })

    // Estado de confirmación pendiente (se actualiza con lo que realmente ocurrió en el turno).
    const ultimaArmado = [...llamadasTurno].reverse().find((l) => l.nombre === "proveedor_armar_paquete" && l.ok)
    const envioOk = llamadasTurno.some((l) => l.nombre === "proveedor_simular_envio" && l.ok)
    const envioRechazado = [...llamadasTurno].reverse().find((l) => l.nombre === "proveedor_simular_envio" && !l.ok && /confirmaci/.test(l.resumen))
    if (envioOk) sesion.pendiente = null
    else if (envioRechazado) sesion.pendiente = { caso: casoDe(envioRechazado) ?? pendienteAntes?.caso ?? "", accion: "envio" }
    else if (ultimaArmado) sesion.pendiente = { caso: casoDe(ultimaArmado) ?? "", accion: "envio" }
  }

  // CA1: tope alcanzado → una última llamada SIN herramientas para resumir lo hecho y lo que falta.
  try {
    sesion.mensajes.push({ rol: "user", texto: "[sistema] Alcanzaste el tope de iteraciones de este turno. Responde ahora, sin llamar herramientas, con lo que lograste y lo que falta." })
    const r = await adaptador.enviar([encabezado, ...sesion.mensajes], [])
    sesion.uso.entrada += r.uso.entrada
    sesion.uso.salida += r.uso.salida
    sesion.mensajes.push({ rol: "assistant", texto: r.texto, llamadas: [] })
    return cerrar(r.texto.trim() !== "" ? r.texto : resumenSinModelo(llamadasTurno, "Alcancé el tope de iteraciones de este turno."))
  } catch {
    return cerrar(resumenSinModelo(llamadasTurno, "Alcancé el tope de iteraciones de este turno."), true)
  }
}
