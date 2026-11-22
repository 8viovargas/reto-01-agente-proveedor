import { z } from "zod/v4"
import * as proveedor from "../tools/proveedor"
import type { Contexto } from "../tools/lib/tipos"
import type { DefinicionHerramienta } from "../llm/adapter"

export interface HerramientaRegistrada {
  /** Nombre que ve el modelo: <archivo>_<export>. */
  nombre: string
  descripcion: string
  esquema: z.ZodObject<z.ZodRawShape>
  definicion: DefinicionHerramienta
  ejecutar(args: unknown, ctx: Contexto): Promise<string>
}

interface HerramientaCruda {
  description: string
  args: z.ZodRawShape
  execute: (args: never, ctx: Contexto) => Promise<string>
}

function esHerramienta(x: unknown): x is HerramientaCruda {
  if (typeof x !== "object" || x === null) return false
  const o = x as Record<string, unknown>
  return typeof o["description"] === "string" && typeof o["args"] === "object" && o["args"] !== null && typeof o["execute"] === "function"
}

/** Descubre las herramientas exportadas por tools/proveedor.ts: la lista no se mantiene a mano. */
export function cargarHerramientas(): HerramientaRegistrada[] {
  const salida: HerramientaRegistrada[] = []
  for (const [exportado, valor] of Object.entries(proveedor)) {
    if (!esHerramienta(valor)) continue
    const nombre = `proveedor_${exportado}`
    const esquema = z.object(valor.args)
    const { $schema: _omitido, ...parametros } = z.toJSONSchema(esquema) as Record<string, unknown>
    salida.push({
      nombre,
      descripcion: valor.description,
      esquema,
      definicion: { nombre, descripcion: valor.description, parametros },
      async ejecutar(args, ctx) {
        const r = esquema.safeParse(args)
        if (!r.success) {
          const p = r.error.issues[0]
          return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}${p && p.path.length > 0 ? ` («${p.path.join(".")}»)` : ""}: ${p?.message ?? "formato incorrecto"}.` })
        }
        return valor.execute(r.data as never, ctx)
      },
    })
  }
  return salida
}
