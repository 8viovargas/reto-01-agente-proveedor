// Cada export es una herramienta. El modelo la ve como `proveedor_<export>`.
// Contrato: execute() devuelve un string JSON { ok: true, data } o { ok: false, error } y NUNCA lanza.
import path from "node:path"
import { readFile } from "node:fs/promises"
import { z } from "zod/v4"
import { cargarCaso, listarCasos, type CasoCargado } from "./lib/caso"
import { producirFormulario } from "./lib/formulario"
import { calcularMapeo, normalizar } from "./lib/mapeo"
import { copiarSoportes, evaluarSoportes, limpiarCarpeta, type ItemSoporte } from "./lib/paquete"
import { cargarReglas, escribirTexto, fechaEjecucion, leerJson, mensajeDe, registrar, relativa, rutas } from "./lib/repo"
import { GlosarioSchema, MaestroSchema, type CampoSolicitado, type Contexto, type Mapeo, type Resultado } from "./lib/tipos"

type Datos = { resumen: string }

async function correr<T extends Datos>(
  nombre: string,
  caso: string | undefined,
  ctx: Contexto,
  fn: () => Promise<Resultado<T>>,
): Promise<string> {
  let res: Resultado<T>
  try {
    res = await fn()
  } catch (e) {
    res = { ok: false, error: `Error interno en ${nombre}: ${mensajeDe(e)}` }
  }
  if (caso !== undefined) await registrar(ctx, caso, nombre, res.ok, res.ok ? res.data.resumen : res.error)
  return JSON.stringify(res)
}

function herramienta<S extends z.ZodRawShape>(
  description: string,
  args: S,
  execute: (a: z.infer<z.ZodObject<S>>, ctx: Contexto) => Promise<string>,
) {
  return { description, args, execute }
}

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, por ejemplo «ec-corp-andina»")

async function cargarFuentes(ctx: Contexto): Promise<Resultado<{ maestro: Record<string, unknown>; glosario: Record<string, string> }>> {
  const r = rutas(ctx)
  const maestro = await leerJson(r.maestro, MaestroSchema, "el repositorio maestro (maestro.json)")
  if (!maestro.ok) return maestro
  const glosario = await leerJson(r.glosario, GlosarioSchema, "el glosario de campos (glosario-campos.json)")
  if (!glosario.ok) return glosario
  return { ok: true, data: { maestro: maestro.data, glosario: glosario.data } }
}

function observaciones(c: CasoCargado): Map<string, string> {
  const m = new Map<string, string>()
  const dias = /no mayor a (\d+) d[ií]as/i.exec(c.solicitud.cuerpo)
  if (dias) m.set("camara_comercio", `El cliente pide emisión no mayor a ${dias[1]} días: verificar la fecha de expedición (el índice solo registra vigencia_hasta).`)
  return m
}

const firmaMapeo = (m: Mapeo): string =>
  JSON.stringify(
    (["llenos", "requiere_confirmacion", "faltantes"] as const).map((k) =>
      m[k].map((i) => [i.hoja ?? "", i.etiqueta, i.ruta ?? ""]).sort((a, b) => a.join("|").localeCompare(b.join("|"))),
    ),
  )

// ── herramientas ─────────────────────────────────────────────────────────────

export const listar_casos = herramienta(
  "Lista los casos (solicitudes de clientes) disponibles para procesar.",
  {},
  async (_a, ctx) =>
    correr("proveedor_listar_casos", undefined, ctx, async () => {
      const casos = await listarCasos(ctx)
      return { ok: true, data: { casos, resumen: `${casos.length} casos disponibles` } }
    }),
)

export const leer_solicitud = herramienta(
  "Lee la solicitud del cliente y su plantilla: devuelve país, cliente, formato de salida, campos solicitados y soportes exigidos.",
  { caso: argCaso },
  async ({ caso }, ctx) => {
    const archivo = await correr("proveedor_leer_solicitud", caso, ctx, async () => {
      const c = await cargarCaso(ctx, caso)
      if (!c.ok) return c
      const reglas = cargarReglas()
      const ambiguas = new Set(reglas.etiquetas_ambiguas.map(normalizar))
      const esperado = reglas.identificador_por_pais[c.data.pais]
      const campos = c.data.campos.map((f) => ({
        ...f,
        ...(ambiguas.has(normalizar(f.etiqueta)) ? { requiere_confirmacion: true, equivalente_pais: esperado ?? null } : {}),
      }))
      const advertencias: string[] = []
      if (c.data.errorPlantilla) advertencias.push(`Plantilla ilegible: ${c.data.errorPlantilla}`)
      if (c.data.errorSoportes) advertencias.push(`Soportes exigidos ilegibles: ${c.data.errorSoportes}`)
      if (c.data.formato === "portal" && c.data.campos.length === 0) advertencias.push("Formato portal sin lista de campos.")
      const data = {
        caso, pais: c.data.pais, cliente: c.data.cliente, formato: c.data.formato,
        asunto: c.data.solicitud.asunto, fecha: c.data.solicitud.fecha,
        campos, soportes: c.data.soportes, advertencias,
        resumen: `${c.data.cliente} (${c.data.pais}), formato ${c.data.formato}, ${campos.length} campos, ${c.data.soportes.length} soportes`,
      }
      // Plantilla corrupta: error claro, pero se entrega lo que sí se pudo leer.
      if (c.data.errorPlantilla) return { ok: false, error: `${c.data.errorPlantilla} Puedo seguir con el reporte de soportes (proveedor_armar_paquete).` }
      return { ok: true, data }
    })
    return archivo
  },
)

export const mapear_campos = herramienta(
  "Cruza los campos solicitados con el repositorio maestro y el glosario; clasifica cada uno como lleno, faltante o requiere_confirmacion.",
  {
    caso: argCaso,
    campos: z
      .array(z.object({
        etiqueta: z.string().describe("Etiqueta exactamente como la devolvió proveedor_leer_solicitud"),
        hoja: z.string().optional().describe("Hoja de Excel, si aplica"),
      }))
      .optional()
      .describe("Subconjunto de campos a mapear; si se omite se mapean todos los de la plantilla"),
  },
  async ({ caso, campos }, ctx) =>
    correr("proveedor_mapear_campos", caso, ctx, async () => {
      const c = await cargarCaso(ctx, caso)
      if (!c.ok) return c
      if (c.data.errorPlantilla) return { ok: false, error: c.data.errorPlantilla }
      const f = await cargarFuentes(ctx)
      if (!f.ok) return f
      // RN2: solo se mapea lo que la plantilla pide; cualquier otra etiqueta se ignora.
      let seleccion: CampoSolicitado[] = c.data.campos
      const ignorados: string[] = []
      if (campos && campos.length > 0) {
        const pedidas = new Set(campos.map((x) => normalizar(x.etiqueta)))
        const enPlantilla = new Set(c.data.campos.map((x) => normalizar(x.etiqueta)))
        seleccion = c.data.campos.filter((x) => pedidas.has(normalizar(x.etiqueta)))
        for (const x of campos) if (!enPlantilla.has(normalizar(x.etiqueta))) ignorados.push(x.etiqueta)
      }
      const mapeo = calcularMapeo(seleccion, c.data.pais, f.data.maestro, f.data.glosario, cargarReglas())
      return {
        ok: true,
        data: {
          ...mapeo,
          ...(ignorados.length > 0 ? { ignorados, aviso: "Estas etiquetas no están en la plantilla del cliente y no se mapearon." } : {}),
          resumen: `${mapeo.llenos.length} llenos, ${mapeo.faltantes.length} faltantes, ${mapeo.requiere_confirmacion.length} por confirmar`,
        },
      }
    }),
)

const ItemMapeoArg = z.object({
  etiqueta: z.string().describe("Etiqueta del campo"),
  hoja: z.string().optional().describe("Hoja de Excel, si aplica"),
  ruta: z.string().optional().describe("Ruta del dato en el maestro"),
})

export const generar_formulario = herramienta(
  "Genera el formulario lleno en el formato del cliente (xlsx, pdf; portal produce valores-portal.md) dentro de out/<caso>/.",
  {
    caso: argCaso,
    mapeo: z
      .object({
        llenos: z.array(ItemMapeoArg),
        faltantes: z.array(ItemMapeoArg),
        requiere_confirmacion: z.array(ItemMapeoArg),
      })
      .optional()
      .describe("Resultado de proveedor_mapear_campos; los valores siempre se releen del maestro"),
  },
  async ({ caso, mapeo }, ctx) =>
    correr("proveedor_generar_formulario", caso, ctx, async () => {
      const c = await cargarCaso(ctx, caso)
      if (!c.ok) return c
      if (c.data.errorPlantilla) return { ok: false, error: `${c.data.errorPlantilla} No se puede generar el formulario.` }
      const f = await cargarFuentes(ctx)
      if (!f.ok) return f
      const calculado = calcularMapeo(c.data.campos, c.data.pais, f.data.maestro, f.data.glosario, cargarReglas())
      const advertencias: string[] = []
      if (mapeo && firmaMapeo(mapeo as Mapeo) !== firmaMapeo(calculado)) {
        advertencias.push("El mapeo recibido no coincide con el recalculado desde el maestro; se usó el recalculado.")
      }
      const out = await producirFormulario(ctx, c.data, calculado, f.data.maestro, path.join(rutas(ctx).out, caso))
      const aviso = out.formato === "portal" ? "formato no soportado" : undefined
      return {
        ok: true,
        data: {
          ruta: out.ruta,
          formato: out.formato,
          ...(aviso ? { estado: aviso } : {}),
          advertencias: [...advertencias, ...out.advertencias.filter((x) => x !== "formato no soportado")],
          resumen: aviso ? `Formato portal no soportado: se generó ${out.ruta} para copiar a mano` : `Formulario ${out.formato} generado en ${out.ruta}`,
        },
      }
    }),
)

function checklistMd(
  c: CasoCargado, hoy: string, listo: boolean, bloqueos: string[],
  soportes: ItemSoporte[], mapeo: Mapeo | null, rutaForm: string | null,
): string {
  const L: string[] = [
    `# Checklist del paquete · ${c.cliente} (${c.id})`,
    "",
    `- Fecha de ejecución: ${hoy}`,
    `- Estado: **${listo ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}**`,
    `- Formulario: ${rutaForm ?? "no generado"}`,
    "",
    "## Bloqueos",
    ...(bloqueos.length > 0 ? bloqueos.map((b) => `- ${b}`) : ["- Ninguno"]),
    "",
    "## Soportes exigidos",
    "| Soporte | Estado | Archivo | Vigencia hasta | Emisor | Nota |",
    "|---|---|---|---|---|---|",
    ...soportes.map((s) => `| ${s.tipo} | ${s.estado} | ${s.archivo ?? "—"} | ${s.vigencia_hasta ?? "no aplica"} | ${s.pais_emisor ?? "—"} | ${s.nota ?? ""} |`),
    "",
  ]
  if (mapeo) {
    L.push("## Campos faltantes (no bloquean, pero hay que completarlos a mano)")
    L.push(...(mapeo.faltantes.length > 0 ? mapeo.faltantes.map((f) => `- ${f.etiqueta}${f.obligatorio ? " (obligatorio)" : ""}: ${f.motivo ?? ""}`) : ["- Ninguno"]))
    L.push("", "## Campos por confirmar")
    L.push(...(mapeo.requiere_confirmacion.length > 0 ? mapeo.requiere_confirmacion.map((f) => `- ${f.etiqueta}: ${f.motivo ?? ""}`) : ["- Ninguno"]))
    L.push("")
  }
  return L.join("\n")
}

function correoMd(c: CasoCargado, razon: string, adjuntos: string[], formulario: string | null): string {
  // RN2: este borrador jamás incluye datos bancarios ni identificadores.
  const lista = [...(formulario ? [`Formulario diligenciado (${formulario})`] : []), ...adjuntos.map((a) => `Soporte: ${a}`)]
  return [
    `**Para:** ${c.solicitud.de}`,
    `**Asunto:** RE: ${c.solicitud.asunto}`,
    "",
    `Estimados señores de ${c.cliente}:`,
    "",
    `Adjuntamos el formulario de registro como proveedor firmado por nuestro representante legal, junto con los soportes solicitados:`,
    "",
    ...lista.map((x) => `- ${x}`),
    "",
    "Quedamos atentos a cualquier observación o documento adicional que requieran.",
    "",
    "Cordialmente,",
    `Área Administrativa — ${razon}`,
    "",
  ].join("\n")
}

export const armar_paquete = herramienta(
  "Arma el paquete para firma en out/<caso>/paquete/ (formulario, soportes, checklist.md, borrador-correo.md) y determina si está listo para firma.",
  { caso: argCaso },
  async ({ caso }, ctx) =>
    correr("proveedor_armar_paquete", caso, ctx, async () => {
      const c = await cargarCaso(ctx, caso)
      if (!c.ok) return c
      if (c.data.errorSoportes) return { ok: false, error: c.data.errorSoportes }
      const hoy = fechaEjecucion(ctx)
      const sop = await evaluarSoportes(ctx, c.data.soportes, hoy, observaciones(c.data))
      if (!sop.ok) return sop
      const f = await cargarFuentes(ctx)
      if (!f.ok) return f

      const carpeta = path.join(rutas(ctx).out, caso)
      const paquete = path.join(carpeta, "paquete")
      await limpiarCarpeta(paquete)

      const bloqueos: string[] = []
      for (const s of sop.data) {
        if (s.estado === "vencido") bloqueos.push(`Soporte vencido: ${s.tipo} (venció ${s.vigencia_hasta})`)
        if (s.estado === "ausente") bloqueos.push(`Soporte ausente: ${s.tipo}`)
      }

      let mapeo: Mapeo | null = null
      let formularioRel: string | null = null
      let nombreForm: string | null = null
      if (c.data.errorPlantilla) {
        bloqueos.push(`Formulario no generado: ${c.data.errorPlantilla}`)
      } else {
        mapeo = calcularMapeo(c.data.campos, c.data.pais, f.data.maestro, f.data.glosario, cargarReglas())
        const out = await producirFormulario(ctx, c.data, mapeo, f.data.maestro, carpeta)
        formularioRel = out.ruta
        nombreForm = path.basename(out.absoluta)
        await escribirTexto(path.join(paquete, nombreForm), await readFile(out.absoluta))
        if (out.formato === "portal") bloqueos.push("Formulario no generado por el agente (formato portal): lo diligencia un humano en el portal.")
      }

      const copiados = await copiarSoportes(ctx, sop.data, paquete)
      const listo = bloqueos.length === 0
      await escribirTexto(path.join(paquete, "checklist.md"), checklistMd(c.data, hoy, listo, bloqueos, sop.data, mapeo, formularioRel))
      const razon = typeof f.data.maestro["razon_social"] === "string" ? f.data.maestro["razon_social"] : "Periferia"
      await escribirTexto(path.join(paquete, "borrador-correo.md"), correoMd(c.data, razon, sop.data.filter((s) => s.estado === "presente").map((s) => s.archivo ?? s.tipo), nombreForm))
      await escribirTexto(path.join(carpeta, "estado.json"), JSON.stringify({ listo_para_firma: listo, bloqueos, fecha: hoy }, null, 2))

      const checklist = {
        soportes: sop.data,
        faltantes: mapeo?.faltantes.map((x) => ({ etiqueta: x.etiqueta, obligatorio: x.obligatorio })) ?? [],
        por_confirmar: mapeo?.requiere_confirmacion.map((x) => ({ etiqueta: x.etiqueta, motivo: x.motivo ?? "" })) ?? [],
        bloqueos,
      }
      return {
        ok: true,
        data: {
          ruta: relativa(ctx, paquete),
          listo_para_firma: listo,
          checklist,
          archivos: [...(nombreForm ? [nombreForm] : []), ...copiados, "checklist.md", "borrador-correo.md"],
          resumen: `Paquete en ${relativa(ctx, paquete)}: ${listo ? "listo para firma" : `NO listo (${bloqueos.length} bloqueo${bloqueos.length === 1 ? "" : "s"})`}`,
        },
      }
    }),
)

export const simular_envio = herramienta(
  "Simula el envío del paquete al cliente (solo escribe ENVIO-SIMULADO.md); exige confirmación explícita del usuario en el turno inmediatamente anterior.",
  {
    caso: argCaso,
    confirmado: z.boolean().describe("true únicamente si el usuario acaba de confirmar de forma explícita el envío"),
  },
  async ({ caso, confirmado }, ctx) =>
    correr("proveedor_simular_envio", caso, ctx, async () => {
      // RN4: el host puede negar la confirmación aunque el modelo diga true.
      if (!confirmado || ctx.confirmacionUsuario === false) return { ok: false, error: "requiere confirmación explícita" }
      const c = await cargarCaso(ctx, caso)
      if (!c.ok) return c
      const carpeta = path.join(rutas(ctx).out, caso)
      const estado = await leerJson(path.join(carpeta, "estado.json"), z.object({ listo_para_firma: z.boolean(), bloqueos: z.array(z.string()), fecha: z.string() }), "el estado del paquete")
      if (!estado.ok) return { ok: false, error: "Primero hay que armar el paquete (proveedor_armar_paquete)." }
      const L = [
        `# ENVÍO SIMULADO · ${c.data.cliente} (${caso})`,
        "",
        "> No se envió ningún correo. Este archivo es el único efecto de la simulación.",
        "",
        `- Destinatario: ${c.data.solicitud.de}`,
        `- Asunto: RE: ${c.data.solicitud.asunto}`,
        `- Paquete: out/${caso}/paquete/`,
        `- Listo para firma al momento del envío: ${estado.data.listo_para_firma ? "sí" : "NO"}`,
        ...(estado.data.bloqueos.length > 0 ? ["", "## Pendientes con los que se simuló el envío", ...estado.data.bloqueos.map((b) => `- ${b}`)] : []),
        "",
      ]
      const ruta = path.join(carpeta, "ENVIO-SIMULADO.md")
      await escribirTexto(ruta, L.join("\n"))
      return {
        ok: true,
        data: {
          ruta: relativa(ctx, ruta),
          advertencias: estado.data.listo_para_firma ? [] : estado.data.bloqueos,
          resumen: `Envío simulado: ${relativa(ctx, ruta)}${estado.data.listo_para_firma ? "" : " (con pendientes)"}`,
        },
      }
    }),
)
