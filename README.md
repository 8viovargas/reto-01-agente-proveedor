# Reto 01 · Agente conversacional «Registro como Proveedor»

Agente de chat que lee la solicitud de un cliente, cruza los campos con el repositorio maestro, genera el formulario (Excel, PDF o valores para portal) y arma el paquete para firma. Nunca firma ni envía: pide confirmación y, en este reto, «enviar» solo escribe `out/<caso>/ENVIO-SIMULADO.md`.

## Link de prueba

La aplicación está desplegada y se prueba desde la URL proporcionada en el correo de entrega, junto con la clave de acceso si el chat la solicita. El servicio gratuito se duerme tras 15 minutos sin uso, por lo que la primera carga puede tardar cerca de un minuto.

## Arranque en local

```bash
npm install
npm run dev
```

La aplicación queda en `http://localhost:3000`. Requiere Node 20 o superior.

Sin clave de modelo arranca en modo `mock` (modelo simulado y determinista). Para usar un modelo real, copia `.env.example` a `.env` y define `ANTHROPIC_API_KEY`. La clave solo vive en la variable de entorno del backend.

Con Docker:

```bash
docker build -t reto01 .
docker run -p 3000:3000 --env-file .env reto01
```

## Verificación sin modelo

```bash
npm run demo
```

Procesa los cuatro casos de `fixtures/reto-01/casos/` llamando directamente a las herramientas, sin clave de ningún proveedor. Verifica confirmación humana, robustez, reglas de negocio y determinismo.

## Variables de entorno

Ver `.env.example`:

| Variable | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | Clave del modelo (solo backend) |
| `ANTHROPIC_MODEL` | Modelo a usar |
| `LLM_PROVIDER` | `anthropic` o `mock` |
| `PORT` | Puerto del servidor (3000 por defecto) |
| `MAX_ITERACIONES` | Tope de iteraciones por turno (25) |
| `MAX_TOKENS_SESION` | Tope de tokens por sesión |
| `MAX_TURNOS_SESION` | Tope de turnos por sesión |
| `MAX_TOKENS_RESPUESTA` | Tokens máximos por respuesta del modelo |
| `LLM_TIMEOUT_MS` | Timeout al proveedor |
| `RATE_LIMIT_POR_MINUTO` | Peticiones por minuto por IP |
| `ACCESS_KEY` | Clave de acceso a la API (opcional) |
| `FECHA_EJECUCION` | Fecha para evaluar vigencias, formato AAAA-MM-DD (opcional) |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, usage }` |
| `GET` | `/api/sessions/:id` | Historial, uso de tokens y confirmación pendiente |
| `GET` | `/api/health` | `{ ok, provider, model, configured }` (sin claves) |

## Estructura

```
agent/prompt.md           comportamiento (system prompt)
src/knowledge/            conocimiento: registro-proveedor.md y reglas.json
src/tools/proveedor.ts    ejecución: herramientas tipadas con zod
src/agent/                ciclo del agente y sesiones
src/llm/                  adaptador del modelo (anthropic, mock)
src/server.ts             API HTTP
web/                      front de chat
demo.ts                   herramientas sin modelo
modulo/                   agente empaquetado como módulo reutilizable
fixtures/                 entradas entregadas por Periferia
```

La documentación técnica está en `SOLUCION.md`.
