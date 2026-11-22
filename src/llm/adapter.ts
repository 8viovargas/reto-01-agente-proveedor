/** Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos. */
export interface LlamadaHerramienta {
  id: string
  nombre: string
  argumentos: Record<string, unknown>
}

export type MensajeLlm =
  | { rol: "system"; texto: string }
  | { rol: "user"; texto: string }
  | { rol: "assistant"; texto: string; llamadas: LlamadaHerramienta[] }
  | { rol: "tool"; resultados: { id: string; nombre: string; contenido: string }[] }

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  /** JSON Schema del objeto de argumentos. */
  parametros: Record<string, unknown>
}

export interface RespuestaLlm {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: { entrada: number; salida: number }
}

export type CodigoErrorLlm = "config" | "timeout" | "auth" | "limite" | "servidor" | "formato"

export class ErrorLlm extends Error {
  constructor(mensaje: string, readonly codigo: CodigoErrorLlm) {
    super(mensaje)
    this.name = "ErrorLlm"
  }
}

export interface AdaptadorLlm {
  readonly proveedor: string
  readonly modelo: string
  readonly configurado: boolean
  enviar(mensajes: MensajeLlm[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm>
}
