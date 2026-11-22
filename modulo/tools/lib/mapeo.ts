import type { CampoSolicitado, ItemMapeo, Mapeo, Reglas, Valor } from "./tipos"
import { valorMaestro } from "./repo"

export function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

const STOP = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "a", "en", "para", "por", "con"])
const tokens = (n: string): string[] => n.split(" ").filter((t) => t !== "" && !STOP.has(t))

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const arriba = prev[j] ?? 0
      const costo = a[i - 1] === b[j - 1] ? 0 : 1
      prev[j] = Math.min(arriba + 1, (prev[j - 1] ?? 0) + 1, diag + costo)
      diag = arriba
    }
  }
  return prev[b.length] ?? 0
}

/** Dos palabras coinciden si son iguales o difieren en una letra (typo) y son largas. */
function mismaPalabra(a: string, b: string): boolean {
  return a === b || (Math.min(a.length, b.length) >= 5 && levenshtein(a, b) <= 1)
}

/** Fracción de palabras (sin conectores) que coinciden. Sin comparar letras sueltas: evita falsos positivos tipo «contribuyente especial» ≈ «cuenta». */
function similitud(a: string, b: string): number {
  const A = tokens(a)
  const B = tokens(b)
  if (A.length === 0 || B.length === 0) return 0
  const usados = new Set<number>()
  let coinciden = 0
  for (const x of A) {
    const j = B.findIndex((y, i) => !usados.has(i) && mismaPalabra(x, y))
    if (j >= 0) { usados.add(j); coinciden++ }
  }
  return coinciden / Math.max(A.length, B.length)
}

interface EntradaGlosario { clave: string; norm: string; ruta: string }

export function indexarGlosario(glosario: Record<string, string>): EntradaGlosario[] {
  return Object.entries(glosario).map(([clave, ruta]) => ({ clave, norm: normalizar(clave), ruta }))
}

export function buscarEnGlosario(
  etiqueta: string,
  indice: EntradaGlosario[],
): { ruta: string; confianza: number; clave: string } | null {
  const n = normalizar(etiqueta)
  const exacta = indice.find((e) => e.norm === n)
  if (exacta) return { ruta: exacta.ruta, confianza: 1, clave: exacta.clave }
  let mejor: { ruta: string; confianza: number; clave: string } | null = null
  for (const e of indice) {
    const c = similitud(n, e.norm)
    if (!mejor || c > mejor.confianza) mejor = { ruta: e.ruta, confianza: c, clave: e.clave }
  }
  return mejor ? { ...mejor, confianza: Math.round(mejor.confianza * 100) / 100 } : null
}

export function enmascarar(valor: Valor): string {
  const s = String(valor)
  return s.length <= 4 ? "****" : `${"*".repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`
}

/** Convierte etiquetas solicitadas en llenos / faltantes / requiere_confirmacion. Nunca inventa valores. */
export function calcularMapeo(
  campos: CampoSolicitado[],
  pais: string,
  maestro: Record<string, unknown>,
  glosario: Record<string, string>,
  reglas: Reglas,
): Mapeo {
  const indice = indexarGlosario(glosario)
  const ambiguas = new Set(reglas.etiquetas_ambiguas.map(normalizar))
  const salida: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }

  for (const campo of campos) {
    const base: ItemMapeo = { etiqueta: campo.etiqueta, obligatorio: campo.obligatorio, ...(campo.hoja ? { hoja: campo.hoja } : {}) }
    const m = buscarEnGlosario(campo.etiqueta, indice)
    if (!m || m.confianza < reglas.umbral_propuesta) {
      salida.faltantes.push({ ...base, motivo: "No existe un dato equivalente en el glosario ni en el maestro." })
      continue
    }
    const real = valorMaestro(maestro, m.ruta)
    if (real === undefined) {
      salida.faltantes.push({ ...base, ruta: m.ruta, motivo: `El maestro no tiene valor para «${m.ruta}».` })
      continue
    }
    const sensible = reglas.claves_sensibles.includes(m.ruta)
    const item: ItemMapeo = {
      ...base,
      ruta: m.ruta,
      valor: sensible ? enmascarar(real) : real,
      confianza: m.confianza,
      ...(sensible ? { sensible: true } : {}),
    }

    const esId = reglas.claves_identificador.includes(m.ruta)
    const esperado = reglas.identificador_por_pais[pais]
    const esAmbigua = ambiguas.has(normalizar(campo.etiqueta))

    if (esId && pais !== reglas.pais_maestro) {
      salida.requiere_confirmacion.push({
        ...item,
        nota: reglas.nota_identificador_extranjero,
        propuesta: esperado,
        motivo: `Regla de país: el cliente (${pais}) espera ${esperado ?? "un identificador tributario local"}; Periferia solo tiene NIT colombiano.`,
      })
    } else if (esId && esAmbigua) {
      salida.requiere_confirmacion.push({
        ...item,
        propuesta: esperado,
        motivo: `Etiqueta ambigua; para ${pais} equivale a ${esperado ?? "el identificador local"}.`,
      })
    } else if (esAmbigua) {
      salida.requiere_confirmacion.push({ ...item, motivo: "Etiqueta ambigua; confirmar el dato correcto." })
    } else if (m.confianza < reglas.umbral_confianza) {
      salida.requiere_confirmacion.push({
        ...item,
        motivo: `Confianza ${m.confianza} < ${reglas.umbral_confianza}: parecida a «${m.clave}».`,
      })
    } else {
      salida.llenos.push(item)
    }
  }
  return salida
}
