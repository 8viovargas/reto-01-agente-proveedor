import { z } from "zod/v4"

export type Valor = string | number | boolean
export type Formato = "xlsx" | "pdf" | "portal"

/** Contexto que el host entrega a cada herramienta. */
export interface Contexto {
  /** Raíz del proyecto; todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /** Lo fija el host (no el modelo): true solo si el usuario confirmó en el turno inmediatamente anterior. */
  confirmacionUsuario?: boolean
  /** YYYY-MM-DD. Por defecto FECHA_EJECUCION o la fecha de hoy. */
  fechaEjecucion?: string
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

export const SolicitudSchema = z.object({
  id: z.string().optional(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  cuerpo: z.string().default(""),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  adjuntos: z.array(z.string()).default([]),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CELDA_RE = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/
export const PlantillaCeldasSchema = z.array(
  z.object({
    hoja: z.string().min(1).max(31).regex(/^[^[\]:*?/\\]+$/, "nombre de hoja inválido"),
    celda_etiqueta: z.string().regex(CELDA_RE, "celda inválida"),
    etiqueta: z.string().min(1),
    celda_valor: z.string().regex(CELDA_RE, "celda inválida"),
  }),
)
export const PlantillaCamposSchema = z.array(
  z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean() }),
)
export const SoportesExigidosSchema = z.array(z.string().min(1))
export const GlosarioSchema = z.record(z.string(), z.string())
export const MaestroSchema = z.record(z.string(), z.unknown())
export type Maestro = z.infer<typeof MaestroSchema>
export const IndiceSoportesSchema = z.array(
  z.object({
    tipo: z.string(),
    archivo: z.string(),
    vigencia_hasta: z.string().nullable(),
    pais_emisor: z.string(),
    descripcion: z.string().optional(),
  }),
)
export type SoporteIndice = z.infer<typeof IndiceSoportesSchema>[number]

export const ReglasSchema = z.object({
  pais_maestro: z.string(),
  identificador_por_pais: z.record(z.string(), z.string()),
  nota_identificador_extranjero: z.string(),
  claves_identificador: z.array(z.string()),
  etiquetas_ambiguas: z.array(z.string()),
  claves_sensibles: z.array(z.string()),
  umbral_confianza: z.number(),
  umbral_propuesta: z.number(),
})
export type Reglas = z.infer<typeof ReglasSchema>

export interface CampoSolicitado {
  etiqueta: string
  obligatorio: boolean
  hoja?: string
  celda_etiqueta?: string
  celda_valor?: string
}

export interface ItemMapeo {
  etiqueta: string
  hoja?: string
  obligatorio: boolean
  ruta?: string
  /** Valor visible para el modelo y los logs (enmascarado si es sensible). */
  valor?: Valor
  confianza?: number
  sensible?: boolean
  motivo?: string
  nota?: string
  propuesta?: string
}
export interface Mapeo {
  llenos: ItemMapeo[]
  faltantes: ItemMapeo[]
  requiere_confirmacion: ItemMapeo[]
}
