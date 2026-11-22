import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile, readdir, stat } from "node:fs/promises"
import { timingSafeEqual } from "node:crypto"
import path from "node:path"
import { z } from "zod/v4"
import { config, RAIZ } from "./config"
import { AnthropicAdapter } from "./llm/anthropic"
import { MockAdapter } from "./llm/mock"
import type { AdaptadorLlm } from "./llm/adapter"
import { cargarHerramientas } from "./agent/registro"
import { ejecutarTurno, type DepsAgente } from "./agent/loop"
import { buscarSesion, ID_SESION_RE, obtenerSesion } from "./agent/sesion"

function crearAdaptador(): AdaptadorLlm {
  if (config.proveedor === "mock") return new MockAdapter()
  return new AnthropicAdapter({ apiKey: config.anthropicApiKey, modelo: config.modelo, timeoutMs: config.timeoutLlmMs, maxTokens: config.maxTokensRespuesta })
}

async function construirDeps(): Promise<DepsAgente> {
  const prompt = await readFile(path.join(RAIZ, "agent", "prompt.md"), "utf8")
  const conocimiento = await readFile(path.join(RAIZ, "src", "knowledge", "registro-proveedor.md"), "utf8")
  return {
    adaptador: crearAdaptador(),
    herramientas: cargarHerramientas(),
    systemPrompt: `${prompt}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento}`,
    limites: { maxIteraciones: config.maxIteraciones, maxTokensSesion: config.maxTokensSesion, maxTurnosSesion: config.maxTurnosSesion },
    directory: RAIZ,
  }
}

const CuerpoChat = z.object({ sessionId: z.string().regex(ID_SESION_RE, "sessionId inválido"), message: z.string().trim().min(1, "El mensaje está vacío").max(2000, "El mensaje es demasiado largo (máx. 2000 caracteres)") })

const TIPOS: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }
const CABECERAS_SEGURAS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
}

function json(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CABECERAS_SEGURAS })
  res.end(JSON.stringify(cuerpo))
}

function leerCuerpo(req: IncomingMessage, limite = 16_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0
    const partes: Buffer[] = []
    req.on("data", (c: Buffer) => {
      total += c.length
      if (total > limite) { reject(new Error("cuerpo demasiado grande")); req.destroy() } else partes.push(c)
    })
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(partes).toString("utf8"))) } catch { reject(new Error("JSON inválido")) } })
    req.on("error", reject)
  })
}

// Límite simple por IP (en memoria): protege la clave del modelo de abuso.
const ventanas = new Map<string, number[]>()
function excedeLimite(ip: string): boolean {
  const ahora = Date.now()
  const recientes = (ventanas.get(ip) ?? []).filter((t) => ahora - t < 60_000)
  recientes.push(ahora)
  ventanas.set(ip, recientes)
  return recientes.length > config.limitePorMinuto
}

function claveValida(req: IncomingMessage): boolean {
  if (!config.claveAcceso) return true
  const dada = Buffer.from(String(req.headers["x-access-key"] ?? ""))
  const real = Buffer.from(config.claveAcceso)
  return dada.length === real.length && timingSafeEqual(dada, real)
}


// ── Descarga de archivos generados (out/) ───────────────────────────────────
const NOMBRE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/
const TIPOS_SALIDA: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
}

function claveCoincide(dada: string): boolean {
  if (!config.claveAcceso) return true
  const a = Buffer.from(dada)
  const b = Buffer.from(config.claveAcceso)
  return a.length === b.length && timingSafeEqual(a, b)
}

function pagina(titulo: string, cuerpo: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titulo}</title><link rel="stylesheet" href="/style.css"></head><body><main id="chat"><div class="msg asistente">${cuerpo}</div></main></body></html>`
}

function html(res: ServerResponse, estado: number, cuerpo: string): void {
  res.writeHead(estado, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...CABECERAS_SEGURAS })
  res.end(cuerpo)
}

async function archivosDe(dir: string): Promise<string[]> {
  try {
    const entradas = await readdir(dir, { withFileTypes: true })
    return entradas.filter((e) => e.isFile() && NOMBRE_RE.test(e.name)).map((e) => e.name).sort()
  } catch {
    return []
  }
}

async function servirSalidas(res: ServerResponse, ruta: string, key: string): Promise<void> {
  if (!claveCoincide(key)) {
    return html(res, 401, pagina("Archivos generados", `<h2>Archivos generados</h2><p>Escribe la clave de acceso.</p><form method="get" action="/out/"><input type="password" name="key" autofocus> <button type="submit">Entrar</button></form>`))
  }
  const q = config.claveAcceso ? `?key=${encodeURIComponent(key)}` : ""
  const raizOut = path.join(RAIZ, "out")

  if (ruta === "/out" || ruta === "/out/") {
    let casos: string[] = []
    try {
      casos = (await readdir(raizOut, { withFileTypes: true })).filter((e) => e.isDirectory() && NOMBRE_RE.test(e.name)).map((e) => e.name).sort()
    } catch { /* aún no hay salidas */ }
    let cuerpo = "<h2>Archivos generados</h2>"
    if (casos.length === 0) cuerpo += "<p>Todavía no hay archivos. Procesa un caso en el chat y vuelve a abrir esta página.</p>"
    for (const c of casos) {
      const base = await archivosDe(path.join(raizOut, c))
      const paq = await archivosDe(path.join(raizOut, c, "paquete"))
      cuerpo += `<h3>${c}</h3><ul>` + base.map((f) => `<li><a href="/out/${c}/${f}${q}">${f}</a></li>`).join("") + paq.map((f) => `<li><a href="/out/${c}/paquete/${f}${q}">paquete/${f}</a></li>`).join("") + "</ul>"
    }
    cuerpo += "<p><small>Los archivos viven en el disco temporal del servidor: se borran si el servicio se reinicia o se duerme.</small></p>"
    return html(res, 200, pagina("Archivos generados", cuerpo))
  }

  const m = /^\/out\/([A-Za-z0-9_-]+)(?:\/(paquete))?\/([A-Za-z0-9._-]+)$/.exec(ruta)
  const nombre = m?.[3] ?? ""
  const tipo = TIPOS_SALIDA[path.extname(nombre)]
  if (!m || !tipo || !NOMBRE_RE.test(nombre)) return json(res, 404, { error: "Archivo no encontrado." })
  const absoluta = path.join(raizOut, m[1] ?? "", m[2] ?? "", nombre)
  try {
    if (!(await stat(absoluta)).isFile()) throw new Error("no es archivo")
    const datos = await readFile(absoluta)
    const adjunto = tipo.startsWith("text/") ? {} : { "content-disposition": `attachment; filename="${nombre}"` }
    res.writeHead(200, { "content-type": tipo, "cache-control": "no-store", ...adjunto, ...CABECERAS_SEGURAS })
    res.end(datos)
  } catch {
    json(res, 404, { error: "Archivo no encontrado." })
  }
}

async function main(): Promise<void> {
  const deps = await construirDeps()

  const servidor = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      const ruta = url.pathname

      if (req.method === "GET" && ruta === "/api/health") {
        return json(res, 200, { ok: true, provider: deps.adaptador.proveedor, model: deps.adaptador.modelo, configured: deps.adaptador.configurado, protegido: Boolean(config.claveAcceso) })
      }

      if (ruta.startsWith("/api/")) {
        if (!claveValida(req)) return json(res, 401, { error: "Clave de acceso requerida o incorrecta." })
        const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0]?.trim() ?? "?"
        if (excedeLimite(ip)) return json(res, 429, { error: "Demasiadas solicitudes; espera un momento e intenta de nuevo." })

        if (req.method === "POST" && ruta === "/api/chat") {
          let cuerpo: unknown
          try { cuerpo = await leerCuerpo(req) } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : "Solicitud inválida" }) }
          const v = CuerpoChat.safeParse(cuerpo)
          if (!v.success) return json(res, 400, { error: v.error.issues[0]?.message ?? "Solicitud inválida" })
          const sesion = obtenerSesion(v.data.sessionId)
          if (sesion.ocupada) return json(res, 409, { error: "Todavía estoy procesando tu mensaje anterior en esta sesión." })
          sesion.ocupada = true
          try {
            const r = await ejecutarTurno(deps, sesion, v.data.message)
            return json(res, 200, { sessionId: sesion.id, ...r, usage: sesion.uso })
          } finally {
            sesion.ocupada = false
          }
        }

        const m = /^\/api\/sessions\/([^/]+)$/.exec(ruta)
        if (req.method === "GET" && m) {
          const id = decodeURIComponent(m[1] ?? "")
          const s = ID_SESION_RE.test(id) ? buscarSesion(id) : undefined
          if (!s) return json(res, 404, { error: "Sesión no encontrada." })
          return json(res, 200, { sessionId: s.id, historial: s.historial, usage: s.uso, turnos: s.turnos, pendienteConfirmacion: s.pendiente !== null })
        }
        return json(res, 404, { error: "Ruta no encontrada." })
      }

      if (req.method === "GET" && (ruta === "/out" || ruta.startsWith("/out/"))) {
        return void (await servirSalidas(res, ruta, url.searchParams.get("key") ?? ""))
      }

      if (req.method === "GET") {
        const archivo = ruta === "/" ? "index.html" : ruta.replace(/^\/+/, "")
        const tipo = TIPOS[path.extname(archivo)]
        if (tipo && !archivo.includes("..") && !archivo.includes("/")) {
          try {
            const datos = await readFile(path.join(RAIZ, "web", archivo))
            res.writeHead(200, { "content-type": tipo, "cache-control": "no-store", ...CABECERAS_SEGURAS })
            return void res.end(datos)
          } catch { /* cae al 404 */ }
        }
      }
      json(res, 404, { error: "No encontrado." })
    } catch (e) {
      // Nunca se expone traza ni mensaje interno al cliente.
      console.error("[error]", e instanceof Error ? e.message : String(e))
      if (!res.headersSent) json(res, 500, { error: "Error interno del servidor. Intenta de nuevo." })
    }
  })

  servidor.listen(config.puerto, () => {
    const a = deps.adaptador
    console.log(`Agente listo en http://localhost:${config.puerto} · proveedor=${a.proveedor} modelo=${a.modelo}${a.configurado ? "" : " (SIN CLAVE: configura ANTHROPIC_API_KEY o usa LLM_PROVIDER=mock)"}`)
    console.log(`Herramientas: ${deps.herramientas.map((h) => h.nombre).join(", ")}`)
  })
}

main().catch((e) => { console.error("No se pudo iniciar:", e instanceof Error ? e.message : String(e)); process.exit(1) })
