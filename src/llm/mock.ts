import type { AdaptadorLlm, DefinicionHerramienta, LlamadaHerramienta, MensajeLlm, RespuestaLlm } from "./adapter"

/**
 * Modelo simulado y determinista (sin clave): sirve para probar el ciclo, el front y el despliegue.
 * Solo entiende «procesa el caso X» y una confirmación de envío; todo el texto sale de lo que devolvieron las herramientas.
 */
const SIN_USO = { entrada: 0, salida: 0 }
let contador = 0
const llamada = (nombre: string, argumentos: Record<string, unknown>): LlamadaHerramienta => ({ id: `mock_${++contador}`, nombre, argumentos })

function parse(contenido: string): { ok: boolean; data: Record<string, unknown>; error: string } {
  try {
    const j: unknown = JSON.parse(contenido)
    if (typeof j === "object" && j !== null) {
      const o = j as Record<string, unknown>
      return { ok: o["ok"] === true, data: (typeof o["data"] === "object" && o["data"] !== null ? o["data"] : {}) as Record<string, unknown>, error: String(o["error"] ?? "") }
    }
  } catch { /* cae al valor por defecto */ }
  return { ok: false, data: {}, error: "respuesta ilegible" }
}

const lista = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])

export class MockAdapter implements AdaptadorLlm {
  readonly proveedor = "mock"
  readonly modelo = "mock-determinista"
  readonly configurado = true

  async enviar(mensajes: MensajeLlm[], _h: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    let ultimoUser = -1
    mensajes.forEach((m, i) => { if (m.rol === "user") ultimoUser = i })
    const texto = ultimoUser >= 0 ? ((mensajes[ultimoUser] as { texto: string }).texto) : ""
    const turno = mensajes.slice(ultimoUser + 1)
    const hechos = new Map<string, { ok: boolean; data: Record<string, unknown>; error: string; args: Record<string, unknown> }>()
    for (let i = 0; i < turno.length; i++) {
      const m = turno[i]
      if (m?.rol !== "tool") continue
      const previo = turno[i - 1]
      for (const r of m.resultados) {
        const args = previo?.rol === "assistant" ? (previo.llamadas.find((l) => l.id === r.id)?.argumentos ?? {}) : {}
        hechos.set(r.nombre, { ...parse(r.contenido), args })
      }
    }
    const casoTexto = [...mensajes.slice(0, ultimoUser + 1)].reverse().map((m) => (m.rol === "user" ? /\b([a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)*)\b/i.exec(m.texto)?.[1] : undefined)).find(Boolean)
    const caso = casoTexto?.toLowerCase()
    const di = (t: string): RespuestaLlm => ({ texto: t, llamadas: [], uso: SIN_USO })
    const pide = (nombre: string, args: Record<string, unknown>): RespuestaLlm => ({ texto: "", llamadas: [llamada(nombre, args)], uso: SIN_USO })

    const confirma = /\b(si|sí|envia|envía|enviar|confirmo|adelante|dale)\b/i.test(texto) && !/\bno\b/i.test(texto)
    const envio = hechos.get("proveedor_simular_envio")
    if (envio) return di(envio.ok ? `Listo: simulé el envío del caso **${caso}**. Solo se escribió \`${String(envio.data["ruta"])}\`; no salió ningún correo.` : `No pude simular el envío: ${envio.error}.`)
    if (confirma && caso && !hechos.has("proveedor_leer_solicitud")) return pide("proveedor_simular_envio", { caso, confirmado: true })

    if (/procesa|proces[ae]r|arma|prepara/i.test(texto) && caso) {
      const leer = hechos.get("proveedor_leer_solicitud")
      if (!leer) return pide("proveedor_leer_solicitud", { caso })
      if (!leer.ok) return di(`No pude leer el caso: ${leer.error}`)
      const mapeo = hechos.get("proveedor_mapear_campos")
      if (!mapeo) return pide("proveedor_mapear_campos", { caso })
      if (!mapeo.ok) return di(`No pude mapear los campos: ${mapeo.error}`)
      const form = hechos.get("proveedor_generar_formulario")
      if (!form) return pide("proveedor_generar_formulario", { caso })
      const paq = hechos.get("proveedor_armar_paquete")
      if (!paq) return pide("proveedor_armar_paquete", { caso })
      if (!paq.ok) return di(`No pude armar el paquete: ${paq.error}`)

      const cl = (paq.data["checklist"] ?? {}) as Record<string, unknown>
      const faltantes = lista(mapeo.data["faltantes"])
      const conf = lista(mapeo.data["requiere_confirmacion"])
      const sop = lista(cl["soportes"]).filter((s) => s["estado"] !== "presente")
      const L = [
        `Procesé el caso **${caso}** (${String(leer.data["cliente"])}, formato ${String(leer.data["formato"])}).`,
        "",
        `**Campos:** ${lista(mapeo.data["llenos"]).length} llenos, ${faltantes.length} faltantes, ${conf.length} por confirmar.`,
        ...faltantes.map((f) => `- Falta: ${String(f["etiqueta"])}`),
        ...conf.map((f) => `- Por confirmar: ${String(f["etiqueta"])} — ${String(f["motivo"])}`),
        "",
        `**Formulario:** ${String(form.ok ? form.data["ruta"] : form.error)}`,
        `**Paquete:** ${String(paq.data["ruta"])} — ${paq.data["listo_para_firma"] === true ? "LISTO para firma" : "NO listo para firma"}.`,
        ...sop.map((s) => `- Soporte ${String(s["estado"])}: ${String(s["tipo"])}${s["nota"] ? ` (${String(s["nota"])})` : ""}`),
        "",
        "_(Modo demo sin modelo de lenguaje: este resumen se arma solo con lo que devolvieron las herramientas.)_",
      ]
      return di(L.join("\n"))
    }
    return di('Estoy en modo demo (sin modelo de lenguaje). Pídeme, por ejemplo: **Procesa el caso "ec-corp-andina"**. Casos de ejemplo: co-industrias-delta, ec-corp-andina, hn-agroexport-sula, pa-logistica-istmo.')
  }
}
