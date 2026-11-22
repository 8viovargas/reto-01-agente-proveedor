# SOLUCION.md — Agente «Registro como Proveedor»

## 1. Problema en una frase

La analista administrativa de Periferia transcribe a mano, 8–12 veces al mes, los mismos datos corporativos en Excel, PDF o portales de clientes (con riesgo de error en NIT y cuenta bancaria y días de demora); el agente prepara el formulario y el paquete para firma y deja la decisión final a un humano.

## 2. Arquitectura

```
┌────────────┐  HTTP   ┌──────────────────────────────────────────────┐
│ web/ chat  │ ──────▶ │ src/server.ts  (API, límites, estáticos)     │
│ tool calls │ ◀────── │   └─ src/agent/loop.ts  ciclo del agente     │
│ confirmar  │         │        ├─ src/llm/adapter.ts (interfaz)      │
└────────────┘         │        │    ├─ anthropic.ts  └─ mock.ts      │
                       │        └─ src/agent/registro.ts (descubre    │
                       │             los exports de tools/proveedor)  │
                       └───────────────┬──────────────────────────────┘
                                       ▼
                       src/tools/proveedor.ts  (zod, { ok, data })
                          └─ lib/: caso · mapeo · formulario · xlsx · pdf · paquete
                                       │
                 fixtures/ (solo lectura) ─┴─▶ out/<caso>/ (escritura)
```

| Capa | Dónde vive |
|---|---|
| **Comportamiento** | `agent/prompt.md` |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` (texto, se inyecta al prompt) y `reglas.json` (identificador por país, etiquetas ambiguas, umbrales; lo leen las herramientas) |
| **Ejecución** | `src/tools/proveedor.ts` + `src/tools/lib/` |

Cambiar un umbral, un país o una etiqueta ambigua toca `reglas.json`, no el servidor.

## 3. Ciclo del agente

`ejecutarTurno` (src/agent/loop.ts): arma `[system, ...historial]` → `adaptador.enviar` → si hay llamadas a herramientas, valida con zod, ejecuta, agrega los resultados y repite; si no, devuelve el texto.

- **Tope (CA1):** `MAX_ITERACIONES` (25). Al alcanzarlo hace una última llamada *sin herramientas* para resumir lo logrado y lo que falta; si esa falla, el servidor arma el resumen con las llamadas ya hechas.
- **Costo:** tope de tokens por sesión (`MAX_TOKENS_SESION`), de turnos, `max_tokens` por respuesta, límite por IP por minuto, mensajes ≤ 2000 caracteres.
- **Errores (CA5):** timeout, 401, 429, 5xx y respuestas mal formadas del proveedor se traducen a mensajes claros en el chat; la sesión no muere. Las herramientas nunca lanzan: `{ ok, data }` / `{ ok:false, error }`.
- **Confirmación humana (CA3/RN4):** el *servidor*, no el modelo, decide. Tras `armar_paquete` (o un `simular_envio` rechazado) la sesión queda con una acción pendiente y el turno termina con una pregunta explícita (el servidor la añade si el modelo no la hizo). En el mensaje inmediatamente siguiente solo cuenta si afirma y no niega («envíes», «sí, no envíes» no cuentan). El servidor pasa `ctx.confirmacionUsuario` a la herramienta; `simular_envio` exige `confirmado: true` **y** que el host no lo niegue, así que un modelo que “alucina” la confirmación no logra enviar (probado en `demo.ts` y por HTTP). El front resalta el estado y ofrece botones Sí / No.
- **Trazabilidad:** cada llamada queda en el chat (nombre, argumentos, resultado), en `out/log.jsonl` (con sessionId) y en `out/<caso>/log.jsonl` (`{ts, herramienta, ok, resumen}`).

**Cómo se hace innecesario que el modelo afirme valores (CA2):** `generar_formulario` ignora los valores del `mapeo` que envíe el modelo y relee todo del maestro por `ruta`; si el mapeo no coincide con el recalculado, usa el recalculado y lo advierte. `mapear_campos` solo mapea etiquetas presentes en la plantilla (RN2). El número de cuenta se enmascara en lo que ve el modelo y en los logs; el valor real solo llega al archivo.

## 4. Elección del modelo

- **Proveedor/modelo por defecto:** Anthropic, `claude-sonnet-5-5` (configurable con `ANTHROPIC_MODEL`; `claude-haiku-5-5` es la opción barata). Razón: el flujo es de 4–6 llamadas a herramientas con instrucciones estrictas (no inventar, no enviar sin confirmar); un modelo con buen seguimiento de instrucciones y tool use reduce desvíos, y las garantías duras no dependen del modelo (ver §3).
- **Costo por caso (estimación a verificar):** un caso típico son ~6 llamadas al modelo con el historial creciente: del orden de **12–20 k tokens de entrada y 1,5–2,5 k de salida**. Costo = `entrada × P_in + salida × P_out`. Con un precio *de ejemplo* de 3 USD / 15 USD por millón de tokens (entrada/salida; confirma la tarifa vigente del modelo elegido) serían ≈ **0,05–0,09 USD por caso**. `/api/chat` devuelve `usage` acumulado por sesión para medir el valor real.
- **Sin modelo:** `LLM_PROVIDER=mock` y `demo.ts` funcionan sin clave. El adaptador es una interfaz propia: otro proveedor = un archivo nuevo en `src/llm/`.

## 5. Diseño del portal web (solo documentación)

**Estrategia.** Navegador controlado (Playwright, o una extensión de navegador) operado por el agente en modo *asistido*: el agente abre el portal, **el humano inicia sesión**, y el agente recorre el formulario con selectores por etiqueta (no por posición) y rellena desde `valores-portal.md`. Cada campo queda en un log y se toma captura antes de enviar. Alternativa descartada: RPA de coordenadas (frágil ante cambios de layout).

**Límites.** CAPTCHA y MFA no se automatizan (el humano los resuelve); un cambio de layout rompe selectores → el agente se detiene, reporta el campo que no encontró y deja el resto como copiable; sesiones que expiran; portales con ToS que prohíben automatización → ahí solo se entrega `valores-portal.md`.

**Credenciales.** Nunca en el repo, el prompt ni los logs. Las ingresa la persona directamente en la ventana del navegador (el agente no las ve) o provienen de un gestor de secretos (Key Vault / 1Password) inyectado al navegador, sin pasar por el modelo. Los logs enmascaran valores de campos de tipo contraseña/cuenta.

**Reparto.** Agente: preparar valores, navegar, rellenar, verificar contra el maestro, capturar evidencia. Humano (mínimo): ingresar credenciales/MFA/CAPTCHA y **dar clic en «Enviar»**, tras revisar el resumen y confirmar.

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| El servidor controla la confirmación (`ctx.confirmacionUsuario`) | Confiar en que el prompt haga al modelo pedir y respetar la confirmación | Un prompt no es una garantía; RN4 es regla de negocio y se hace cumplir en código. |
| Recalcular el mapeo en `generar_formulario` y leer valores del maestro | Escribir lo que el modelo envíe en `mapeo` | Evita que el modelo cambie valores o filtre datos bancarios; el costo es recomputar (milisegundos). |
| Coincidencia difusa por **palabras** (umbral 0,8 / propuesta 0,5) | Distancia de edición sobre el texto completo | Mi primera versión emparejaba «Número de contribuyente especial» con «Número de cuenta» (0,5): habría propuesto la cuenta bancaria. Por palabras queda en 0,33 → faltante. |
| Escritor mínimo de `.xlsx` con `jszip` y PDF con `pdf-lib` | `exceljs` / `pdfkit` | Menos dependencias y salida determinista (fechas fijas en zip/PDF); las pruebas con `openpyxl`/`pypdf` leyeron las celdas exactas. Trade-off: sin fórmulas ni estilos avanzados. |
| Front HTML plano servido por el mismo backend | React/Vite | Cero build, un solo comando, CSP estricta (`default-src 'self'`). |
| Sesiones en memoria | Base de datos | Lo permite el PRD; se pierden al reiniciar. |
| `simular_envio` no se bloquea por soportes vencidos; registra los pendientes | Bloquear siempre | El PRD espera `ENVIO-SIMULADO.md` tras confirmar incluso en `ec-corp-andina`, que tiene bloqueos; la advertencia queda en el archivo y en la pregunta. |

## 7. Supuestos

1. **Casos:** los cuatro son los entregados por Periferia (`co-industrias-delta`, `ec-corp-andina`, `hn-agroexport-sula`, `pa-logistica-istmo`), sin modificar. Una versión previa de mi trabajo usó casos hn/pa inventados; ya fueron reemplazados. Asigné `plantilla-campos` de 9 campos (con Banco, Cuenta y SWIFT) al caso portal `pa-logistica-istmo` por ser la única plantilla de campos restante.
2. **Fecha de ejecución** = hoy (`FECHA_EJECUCION` para fijarla). Con la fecha real la Cámara de Comercio (vigencia 2026-09-30) y parafiscales (2026-08-31) aparecen vencidos, por eso ningún caso sale «listo» hoy; con `FECHA_EJECUCION=2026-08-30`, `co-industrias-delta` sí.
3. Un soporte con `vigencia_hasta: null` (RUT) no vence. Vence si `vigencia_hasta < fecha` (el mismo día vale).
4. «Fuera del glosario» = faltante. El glosario es la única fuente de sinónimos; el campo `Correo electrónico` mapea a `contacto_comercial.email` según el glosario entregado.
5. Para plantillas Excel `obligatorio` no existe: se asume `false`.
6. Para países ≠ CO, cualquier campo que mapee a `nit` va a `requiere_confirmacion` (RN1) aunque la etiqueta sea «RUC».
7. En `hn-agroexport-sula` el cliente pide «registro tributario de su país»: el único RUT del repositorio es el colombiano (`emisor CO`); se entrega tal cual y la analista decide si basta. «No mayor a 30 días» del correo solo se anota como observación en el checklist: el índice no trae fecha de expedición.
8. Las celdas de la plantilla Excel se generan desde cero (no se parte del `.xlsx` original del cliente, que no se entregó): amarillo = por confirmar, rojo vacío = faltante.

## 8. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer solicitud | Hecho | Leer el correo y adjuntos reales; detectar formato automáticamente. |
| HU-2 Mapear campos | Hecho | Confirmación interactiva de campos ambiguos; aprendizaje de nuevos sinónimos con dueño del glosario. |
| HU-3 P0 Excel | Hecho | Rellenar la plantilla original del cliente (hoy se genera una equivalente). |
| HU-3 P1 PDF | Hecho (PDF generado, no AcroForm) | Rellenar AcroForms del cliente. |
| HU-3 P2 Portal | Parcial: «formato no soportado» + `valores-portal.md`; diseño en §5 | Implementación asistida. |
| HU-4 Paquete | Hecho | Verificar fecha de expedición real de la Cámara; empaquetar en zip. |
| HU-5 Errores | Hecho | Más casos de plantillas degradadas. |
| Bonus módulo | Hecho (`modulo/` generado desde las mismas fuentes; `modulo:check` detecta divergencias) | Publicar como paquete versionado. |
| **Enlace público** | **No hecho** (no pude desplegar desde mi entorno) | Desplegar con el `Dockerfile` y escribir la URL en el README. |

**Verificado:** `demo.ts` (casos, RN1–RN3, confirmación, robustez, determinismo: pasa); flujo HTTP completo con el modelo simulado (procesar → negar → reprocesar → confirmar; envío sin confirmación en sesión nueva bloqueado); `.xlsx` abierto con `openpyxl` y PDF leído con `pypdf`; adaptador Anthropic probado con `fetch` simulado (conversión de mensajes, tool_use, 429, sin clave).
**No verificado:** llamadas reales a la API de Anthropic (sin red ni clave en mi entorno); `tsc` completo con `@types/node` (solo lo corrí con declaraciones mínimas: sin errores de tipos propios); apertura del `.xlsx` en Excel (sí en openpyxl).

## 9. Uso de IA

Declara aquí con tus palabras lo que realmente usaste. Esta entrega se redactó con **Claude** (asistente de Anthropic) para: diseño de la arquitectura, código TypeScript de herramientas, ciclo, adaptadores, front, `demo.ts`, scripts y esta documentación. **Descartado/corregido tras revisión y pruebas:** el emparejamiento difuso por distancia de edición (proponía la cuenta bancaria para «contribuyente especial»); dar por buena la confirmación que declara el modelo (se movió al servidor). Debes poder explicar cada línea: revisa sobre todo `src/agent/loop.ts`, `src/tools/lib/mapeo.ts` y `src/tools/proveedor.ts`.

## 10. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo «completa» un campo faltante | Herramientas como única fuente; valores releídos del maestro; prompt lo prohíbe; faltantes visibles en checklist. |
| Maestro desactualizado | Dueño del dato, fecha de última revisión en el maestro, alerta de vigencias. |
| Soportes vencidos enviados | Bloqueo `listo_para_firma`; además validar fecha de expedición. |
| Fuga de datos bancarios | Enmascarado en chat/logs, ausentes del correo; en producción, cifrado en reposo y control de acceso. |
| Abuso de la clave del modelo | Límites por sesión/IP, `ACCESS_KEY`, autenticación real y cuotas por usuario. |
| Prompt injection desde correos/adjuntos reales | Tratar el contenido del correo como datos; herramientas sin shell; acciones externas siempre con confirmación en servidor. |
| Plantillas reales peores que los fixtures | Revisión humana siempre; ampliar pruebas; modo «solo reporte de faltantes». |
| Persistencia en memoria | Base de datos/colas y auditoría inmutable. |
| Portales con CAPTCHA/MFA | Humano en el bucle (§5). |
