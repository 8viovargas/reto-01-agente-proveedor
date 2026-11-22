# Módulo reutilizable · agente «Registro como Proveedor»

Generado por `npm run modulo:sync` desde las mismas fuentes que usa la aplicación:

| Pieza del módulo | Fuente en la app |
|---|---|
| `agent.md` (cuerpo = system prompt) | `agent/prompt.md` |
| `tools/` | `src/tools/` (carpeta completa; sin servidor HTTP ni adaptador LLM) |
| `knowledge/reglas.json` | `src/knowledge/reglas.json` (lo leen las herramientas) |
| `skill/registro-proveedor/SKILL.md` | `src/knowledge/registro-proveedor.md` |

`npm run modulo:check` falla si algo se desincroniza.

## Integración

- Importa las herramientas: `import * as proveedor from "./tools/proveedor"`. Cada export es `{ description, args (zod), execute(args, ctx) }`; el nombre que ve el modelo es `proveedor_<export>`.
- `ctx` = `{ directory, sessionId, confirmacionUsuario? }`. `directory` es la raíz que contiene `fixtures/reto-01/` y donde se escribe `out/`.
- **Confirmación (RN4):** el host debe fijar `ctx.confirmacionUsuario = true` solo cuando el usuario confirmó en el mensaje inmediatamente anterior; `proveedor_simular_envio` lo respeta aunque el modelo pase `confirmado: true`.
- Dependencias de ejecución: `zod` (≥ 3.25, se importa `zod/v4`), `jszip`, `pdf-lib`.
- `agent.md` declara `edit: deny` y `bash: deny`: el agente solo actúa a través de estas herramientas.
