import type { MensajeLlm } from "../llm/adapter"

export interface LlamadaVisible {
  id: string
  nombre: string
  argumentos: Record<string, unknown>
  ok: boolean
  resumen: string
  /** Resultado serializado y recortado, solo para mostrar en el front. */
  detalle: string
}

export interface EntradaHistorial {
  rol: "user" | "assistant"
  texto: string
  ts: string
  toolCalls?: LlamadaVisible[]
  needsConfirmation?: boolean
  error?: boolean
}

export interface Sesion {
  id: string
  mensajes: MensajeLlm[]
  historial: EntradaHistorial[]
  uso: { entrada: number; salida: number }
  turnos: number
  /** Acción externa a la espera de un «sí» en el mensaje inmediatamente siguiente (RN4 / CA3). */
  pendiente: { caso: string; accion: "envio" } | null
  ocupada: boolean
  actualizada: number
}

const MAX_SESIONES = 200
const sesiones = new Map<string, Sesion>()

export const ID_SESION_RE = /^[A-Za-z0-9_-]{8,64}$/

export function obtenerSesion(id: string): Sesion {
  let s = sesiones.get(id)
  if (!s) {
    if (sesiones.size >= MAX_SESIONES) {
      const masVieja = [...sesiones.values()].sort((a, b) => a.actualizada - b.actualizada)[0]
      if (masVieja) sesiones.delete(masVieja.id)
    }
    s = { id, mensajes: [], historial: [], uso: { entrada: 0, salida: 0 }, turnos: 0, pendiente: null, ocupada: false, actualizada: Date.now() }
    sesiones.set(id, s)
  }
  s.actualizada = Date.now()
  return s
}

export const buscarSesion = (id: string): Sesion | undefined => sesiones.get(id)
