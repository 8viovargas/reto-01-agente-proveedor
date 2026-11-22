# Reto 01 · Agente conversacional «Registro como Proveedor»

Agente de chat que lee la solicitud de un cliente, cruza los campos con el repositorio maestro, genera el formulario (Excel / PDF / valores para portal) y arma el paquete para firma. **Nunca firma ni envía**: pide confirmación y, en este reto, «enviar» solo escribe `out/<caso>/ENVIO-SIMULADO.md`.

## Arranque (un comando)

```bash
npm install            # o: bun install
cp .env.example .env   # opcional: pega tu ANTHROPIC_API_KEY
npm run dev            # o: bun run dev   → http://localhost:3000
```

- **Sin clave** el servidor arranca en modo `mock` (modelo simulado y determinista): sirve para ver el front, el ciclo del agente y la confirmación humana.
- **Con `ANTHROPIC_API_KEY`** usa el modelo de `ANTHROPIC_MODEL`. La clave solo vive en la variable de entorno del backend.
- Requiere Node ≥ 20 (o Bun). Docker: `docker build -t reto01 . && docker run -p 3000:3000 --env-file .env reto01`.

## Verificación sin modelo

```bash
npm run demo           # o: bun run demo.ts
```

Procesa todos los casos de `fixtures/reto-01/casos/`, prueba confirmación humana, robustez, reglas RN1–RN3 y determinismo (dos corridas → mismos hashes). No necesita clave. `FECHA_EJECUCION=2026-08-30 npm run demo` fija la fecha con la que se evalúan las vigencias (con esa fecha `co-industrias-delta` queda *listo para firma*).

## Variables de entorno

Ver `.env.example`: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `LLM_PROVIDER`, `PORT`, `MAX_ITERACIONES` (25), `MAX_TOKENS_SESION`, `MAX_TURNOS_SESION`, `MAX_TOKENS_RESPUESTA`, `LLM_TIMEOUT_MS`, `RATE_LIMIT_POR_MINUTO`, `ACCESS_KEY` (opcional), `FECHA_EJECUCION` (opcional).

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, usage }` |
| `GET` | `/api/sessions/:id` | Historial completo, uso de tokens y `pendienteConfirmacion` |
| `GET` | `/api/health` | `{ ok, provider, model, configured }` (sin claves) |

`sessionId`: 8–64 caracteres `[A-Za-z0-9_-]`. Si defines `ACCESS_KEY`, envía el header `x-access-key`.

## Estructura

```
agent/prompt.md              comportamiento (system prompt)
src/knowledge/               conocimiento: registro-proveedor.md + reglas.json
src/tools/proveedor.ts       ejecución: herramientas zod (proveedor_<export>)
src/tools/lib/               mapeo, xlsx, pdf, paquete (sin servidor)
src/agent/                   ciclo del agente, sesiones, registro de herramientas
src/llm/                     adapter.ts + anthropic.ts + mock.ts
src/server.ts                API HTTP + estáticos
web/                         front de chat (HTML/CSS/JS plano)
demo.ts                      herramientas sin modelo
modulo/                      bonus: agente empaquetado (npm run modulo:sync / modulo:check)
fixtures/                    entradas entregadas por Periferia (4 casos, sin modificar)
```

## Link de prueba

> **Pendiente:** despliega con el `Dockerfile` (Render, Railway, Fly.io…), define `ANTHROPIC_API_KEY` (y `ACCESS_KEY` si quieres protegerlo) y escribe aquí la URL y la clave de acceso.
