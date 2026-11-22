// Genera modulo/ a partir de las MISMAS fuentes que usa la aplicación (sin copias divergentes).
//   npm run modulo:sync     → escribe modulo/
//   npm run modulo:check    → falla si modulo/ no coincide con las fuentes
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const RAIZ = fileURLToPath(new URL("../", import.meta.url))
const leer = (rel: string): string => readFileSync(path.join(RAIZ, rel), "utf8")

function listar(dir: string): string[] {
  return readdirSync(path.join(RAIZ, dir)).flatMap((n) => {
    const rel = path.posix.join(dir, n)
    return statSync(path.join(RAIZ, rel)).isDirectory() ? listar(rel) : [rel]
  })
}

const esperado = new Map<string, string>()

const prompt = leer("agent/prompt.md").trimEnd()
esperado.set(
  "modulo/agent.md",
  `---
description: Prepara formularios de registro como proveedor (Excel, PDF o valores para portal) y el paquete para firma del representante legal; nunca firma ni envía sin confirmación.
mode: primary
permission:
  edit: deny
  bash: deny
---

${prompt}
`,
)

for (const f of listar("src/tools")) esperado.set(f.replace(/^src\/tools\//, "modulo/tools/"), leer(f))
esperado.set("modulo/knowledge/reglas.json", leer("src/knowledge/reglas.json"))

esperado.set(
  "modulo/skill/registro-proveedor/SKILL.md",
  `---
name: registro-proveedor
description: Proceso y reglas de negocio para registrar a Periferia como proveedor ante clientes de CO, EC, PE, PA y HN (identificador tributario por país, datos bancarios, soportes y vigencias, confirmación humana). Úsala al procesar solicitudes de registro.
---

${leer("src/knowledge/registro-proveedor.md").trimEnd()}
`,
)

esperado.set(
  "modulo/README.md",
  `# Módulo reutilizable · agente «Registro como Proveedor»

Generado por \`npm run modulo:sync\` desde las mismas fuentes que usa la aplicación:

| Pieza del módulo | Fuente en la app |
|---|---|
| \`agent.md\` (cuerpo = system prompt) | \`agent/prompt.md\` |
| \`tools/\` | \`src/tools/\` (carpeta completa; sin servidor HTTP ni adaptador LLM) |
| \`knowledge/reglas.json\` | \`src/knowledge/reglas.json\` (lo leen las herramientas) |
| \`skill/registro-proveedor/SKILL.md\` | \`src/knowledge/registro-proveedor.md\` |

\`npm run modulo:check\` falla si algo se desincroniza.

## Integración

- Importa las herramientas: \`import * as proveedor from "./tools/proveedor"\`. Cada export es \`{ description, args (zod), execute(args, ctx) }\`; el nombre que ve el modelo es \`proveedor_<export>\`.
- \`ctx\` = \`{ directory, sessionId, confirmacionUsuario? }\`. \`directory\` es la raíz que contiene \`fixtures/reto-01/\` y donde se escribe \`out/\`.
- **Confirmación (RN4):** el host debe fijar \`ctx.confirmacionUsuario = true\` solo cuando el usuario confirmó en el mensaje inmediatamente anterior; \`proveedor_simular_envio\` lo respeta aunque el modelo pase \`confirmado: true\`.
- Dependencias de ejecución: \`zod\` (≥ 3.25, se importa \`zod/v4\`), \`jszip\`, \`pdf-lib\`.
- \`agent.md\` declara \`edit: deny\` y \`bash: deny\`: el agente solo actúa a través de estas herramientas.
`,
)

const check = process.argv.includes("--check")
const distintos: string[] = []
for (const [rel, contenido] of esperado) {
  const abs = path.join(RAIZ, rel)
  if (check) {
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== contenido) distintos.push(rel)
  } else {
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, contenido)
  }
}
if (check) {
  if (distintos.length > 0) { console.error(`modulo/ desincronizado:\n${distintos.map((d) => `  - ${d}`).join("\n")}\nEjecuta: npm run modulo:sync`); process.exit(1) }
  console.log(`modulo/ sincronizado con las fuentes (${esperado.size} archivos).`)
} else {
  console.log(`modulo/ generado (${esperado.size} archivos).`)
}
