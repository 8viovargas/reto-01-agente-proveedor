import { z } from "zod/v4"
import { ErrorLlm, type AdaptadorLlm, type DefinicionHerramienta, type MensajeLlm, type RespuestaLlm } from "./adapter"

const RespuestaSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
      z.object({ type: z.string() }),
    ]),
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
})

type BloqueAnthropic =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
interface MensajeAnthropic { role: "user" | "assistant"; content: string | BloqueAnthropic[] }

function convertir(mensajes: MensajeLlm[]): { system: string; messages: MensajeAnthropic[] } {
  let system = ""
  const messages: MensajeAnthropic[] = []
  for (const m of mensajes) {
    if (m.rol === "system") system += (system ? "\n\n" : "") + m.texto
    else if (m.rol === "user") messages.push({ role: "user", content: m.texto })
    else if (m.rol === "assistant") {
      const bloques: BloqueAnthropic[] = []
      if (m.texto.trim() !== "") bloques.push({ type: "text", text: m.texto })
      for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.argumentos })
      messages.push({ role: "assistant", content: bloques })
    } else {
      messages.push({ role: "user", content: m.resultados.map((r): BloqueAnthropic => ({ type: "tool_result", tool_use_id: r.id, content: r.contenido })) })
    }
  }
  return { system, messages }
}

export interface OpcionesAnthropic {
  apiKey: string | undefined
  modelo: string
  timeoutMs: number
  maxTokens: number
}

export class AnthropicAdapter implements AdaptadorLlm {
  readonly proveedor = "anthropic"
  constructor(private readonly op: OpcionesAnthropic) {}
  get modelo(): string { return this.op.modelo }
  get configurado(): boolean { return Boolean(this.op.apiKey) }

  async enviar(mensajes: MensajeLlm[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    if (!this.op.apiKey) throw new ErrorLlm("El proveedor de lenguaje no está configurado (falta ANTHROPIC_API_KEY en el servidor).", "config")
    const { system, messages } = convertir(mensajes)
    let res: Response
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.op.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.op.modelo,
          max_tokens: this.op.maxTokens,
          system,
          messages,
          ...(herramientas.length > 0 ? { tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.parametros })) } : {}),
        }),
        signal: AbortSignal.timeout(this.op.timeoutMs),
      })
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new ErrorLlm(`El modelo tardó más de ${Math.round(this.op.timeoutMs / 1000)} s en responder.`, "timeout")
      }
      throw new ErrorLlm("No se pudo contactar al proveedor de lenguaje (error de red).", "servidor")
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new ErrorLlm("El proveedor rechazó la credencial del servidor (clave inválida o sin permisos).", "auth")
      if (res.status === 429) throw new ErrorLlm("El proveedor de lenguaje está limitando las solicitudes; intenta de nuevo en unos segundos.", "limite")
      if (res.status >= 500) throw new ErrorLlm("El proveedor de lenguaje tiene un problema temporal; intenta de nuevo.", "servidor")
      throw new ErrorLlm(`El proveedor rechazó la solicitud (HTTP ${res.status}).`, "formato")
    }
    const parsed = RespuestaSchema.safeParse(await res.json().catch(() => null))
    if (!parsed.success) throw new ErrorLlm("La respuesta del proveedor no tiene el formato esperado.", "formato")
    let texto = ""
    const llamadas = []
    for (const b of parsed.data.content) {
      if ("text" in b && b.type === "text") texto += b.text
      else if ("id" in b && b.type === "tool_use") llamadas.push({ id: b.id, nombre: b.name, argumentos: b.input })
    }
    return { texto, llamadas, uso: { entrada: parsed.data.usage.input_tokens, salida: parsed.data.usage.output_tokens } }
  }
}
