"use strict"
const chat = document.getElementById("chat")
const entrada = document.getElementById("entrada")
const form = document.getElementById("form")
const btnEnviar = document.getElementById("enviar")
const pensando = document.getElementById("pensando")
const chipModelo = document.getElementById("modelo")

const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9_-]/g, "")
let sessionId = sessionStorage.getItem("sessionId") || nuevoId()
sessionStorage.setItem("sessionId", sessionId)
let claveAcceso = sessionStorage.getItem("claveAcceso") || ""

function el(tag, clase, texto) {
  const e = document.createElement(tag)
  if (clase) e.className = clase
  if (texto !== undefined) e.textContent = texto
  return e
}

// Markdown mínimo y seguro: todo se inserta como texto (nunca innerHTML).
function inline(padre, texto) {
  for (const parte of texto.split(/(\*\*[^*]+\*\*|`[^`]+`|_\([^)]*\)_)/g)) {
    if (!parte) continue
    if (parte.startsWith("**")) padre.appendChild(el("strong", null, parte.slice(2, -2)))
    else if (parte.startsWith("`")) padre.appendChild(el("code", null, parte.slice(1, -1)))
    else padre.appendChild(document.createTextNode(parte))
  }
}
function render(texto) {
  const raiz = el("div")
  const lineas = texto.split("\n")
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i]
    if (/^\s*[-*] /.test(l)) {
      const ul = el("ul")
      while (i < lineas.length && /^\s*[-*] /.test(lineas[i])) { const li = el("li"); inline(li, lineas[i].replace(/^\s*[-*] /, "")); ul.appendChild(li); i++ }
      i--; raiz.appendChild(ul)
    } else if (/^\s*\|/.test(l)) {
      const filas = []
      while (i < lineas.length && /^\s*\|/.test(lineas[i])) { filas.push(lineas[i]); i++ }
      i--
      const t = el("table")
      filas.filter((f) => !/^\s*\|[\s:|-]+\|\s*$/.test(f)).forEach((f, n) => {
        const tr = el("tr")
        f.trim().replace(/^\||\|$/g, "").split("|").forEach((c) => { const td = el(n === 0 ? "th" : "td"); inline(td, c.trim()); tr.appendChild(td) })
        t.appendChild(tr)
      })
      raiz.appendChild(t)
    } else if (l.trim() !== "") {
      const p = el("p"); inline(p, l.replace(/^#+\s*/, "")); raiz.appendChild(p)
    }
  }
  return raiz
}

function pintarTools(llamadas) {
  if (!llamadas || llamadas.length === 0) return
  const caja = el("div", "tools")
  for (const l of llamadas) {
    const d = el("details", "tool" + (l.ok ? "" : " fallo"))
    const s = el("summary")
    s.appendChild(el("span", "tn", (l.ok ? "✓ " : "✗ ") + l.nombre))
    s.appendChild(el("span", "tr", l.resumen))
    d.appendChild(s)
    d.appendChild(el("pre", null, "argumentos: " + JSON.stringify(l.argumentos, null, 2) + "\n\nresultado: " + l.detalle))
    caja.appendChild(d)
  }
  chat.appendChild(caja)
}

function pintarMensaje(rol, texto, extra = {}) {
  if (rol === "assistant") pintarTools(extra.toolCalls)
  const m = el("div", "msg " + (rol === "user" ? "user" : "asistente") + (extra.error ? " error" : "") + (extra.needsConfirmation ? " confirma" : ""))
  if (rol === "user") m.textContent = texto
  else m.appendChild(render(texto))
  if (extra.needsConfirmation) {
    const b = el("div", "banner")
    b.appendChild(el("span", null, "⚠ Requiere tu confirmación"))
    const si = el("button", "si", "Sí, realiza el envío simulado"); si.type = "button"; si.onclick = () => enviarTexto("Sí, realiza el envío simulado")
    const no = el("button", null, "No, esperar"); no.type = "button"; no.onclick = () => enviarTexto("No, todavía no")
    b.append(si, no)
    m.appendChild(b)
  }
  chat.appendChild(m)
  chat.scrollTop = chat.scrollHeight
}

function cabeceras() {
  const h = { "content-type": "application/json" }
  if (claveAcceso) h["x-access-key"] = claveAcceso
  return h
}

async function enviarTexto(texto) {
  texto = texto.trim()
  if (!texto) return
  chat.querySelectorAll(".banner button").forEach((b) => (b.disabled = true))
  pintarMensaje("user", texto)
  entrada.value = ""
  btnEnviar.disabled = true
  pensando.hidden = false
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: cabeceras(), body: JSON.stringify({ sessionId, message: texto }) })
    if (r.status === 401) {
      claveAcceso = prompt("Este agente requiere una clave de acceso:") || ""
      sessionStorage.setItem("claveAcceso", claveAcceso)
      pintarMensaje("assistant", "Clave de acceso requerida. Vuelve a enviar tu mensaje.", { error: true })
      return
    }
    const j = await r.json().catch(() => ({}))
    if (!r.ok) pintarMensaje("assistant", j.error || "El servidor respondió con un error. Intenta de nuevo.", { error: true })
    else pintarMensaje("assistant", j.reply, { toolCalls: j.toolCalls, needsConfirmation: j.needsConfirmation, error: j.error })
  } catch {
    pintarMensaje("assistant", "No pude conectar con el servidor. Revisa tu conexión e intenta de nuevo.", { error: true })
  } finally {
    pensando.hidden = true
    btnEnviar.disabled = false
    entrada.focus()
  }
}

form.addEventListener("submit", (e) => { e.preventDefault(); enviarTexto(entrada.value) })
entrada.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarTexto(entrada.value) } })
document.querySelectorAll(".atajos button").forEach((b) => b.addEventListener("click", () => enviarTexto(b.dataset.q)))
document.getElementById("nueva").addEventListener("click", () => {
  sessionId = nuevoId();
  sessionStorage.setItem("sessionId", sessionId);
  chat.textContent = "";

  pintarMensaje(
    "assistant",
    `¡Hola! 👋 Estoy listo para ayudarte a procesar cualquiera de los siguientes casos:

- **ec-corp-andina**
- **co-industrias-delta**
- **hn-agroexport-sula**
- **pa-logistica-istmo**

Indícame cuál deseas procesar. Por ejemplo:

**Procesa el caso "ec-corp-andina"**

Prepararé el formulario y el paquete correspondiente. La firma y el envío final seguirán siendo decisión tuya.`
  );
});

async function iniciar() {
  try {
    const h = await (await fetch("/api/health")).json()
    chipModelo.textContent = h.provider === "mock" ? "modo demo (sin modelo)" : `${h.provider} · ${h.model}`
    if (!h.configured) chipModelo.textContent += " · sin clave"
  } catch { chipModelo.textContent = "sin conexión" }
  try {
    const r = await fetch("/api/sessions/" + sessionId, { headers: cabeceras() })
    if (r.ok) {
      const s = await r.json()
      for (const e of s.historial) pintarMensaje(e.rol, e.texto, e)
      if (s.historial.length > 0) return
    }
  } catch { /* sesión nueva */ }
  pintarMensaje(
  "assistant",
  `¡Hola! 👋 Estoy listo para ayudarte a procesar cualquiera de los siguientes casos:

- **ec-corp-andina**
- **co-industrias-delta**
- **hn-agroexport-sula**
- **pa-logistica-istmo**

Indícame cuál deseas procesar. Por ejemplo:

**Procesa el caso "ec-corp-andina"**

Prepararé el formulario y el paquete correspondiente. La firma y el envío final seguirán siendo decisión tuya.`
)
}
iniciar()
