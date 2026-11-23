# SOLUCION.md — Agente «Registro como Proveedor»

## 1. Problema en una frase

La analista administrativa de Periferia transcribe a mano, entre 8 y 12 veces al mes, los mismos datos corporativos en Excel, PDF o portales de clientes (con riesgo de error en NIT y cuenta bancaria y con días de demora); el agente prepara el formulario y el paquete para firma y deja la decisión final a una persona.

## 2. Arquitectura

```
┌────────────┐  HTTP   ┌──────────────────────────────────────────────┐
│ web/ chat  │ ──────▶ │ src/server.ts  (API, límites, estáticos,     │
│ tool calls │ ◀────── │                 descarga de /out/)           │
│ confirmar  │         │   └─ src/agent/loop.ts  ciclo del agente     │
└────────────┘         │        ├─ src/llm/adapter.ts (interfaz)      │
                       │        │    ├─ anthropic.ts  └─ mock.ts      │
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
| **Conocimiento** | `src/knowledge/registro-proveedor.md` (texto que se inyecta al prompt) y `src/knowledge/reglas.json` (identificador por país, etiquetas ambiguas, umbrales; lo leen las herramientas) |
| **Ejecución** | `src/tools/proveedor.ts` y `src/tools/lib/` |

Cambiar un umbral, un país o una etiqueta ambigua implica editar `reglas.json`, no el servidor.

**Herramientas** (`proveedor_<export>`, argumentos validados con zod, respuesta `{ ok, data }` o `{ ok: false, error }`, nunca lanzan): `listar_casos`, `leer_solicitud`, `mapear_campos`, `generar_formulario`, `armar_paquete` y `simular_envio`.

**Despliegue.** La aplicación se publica con el `Dockerfile` del repositorio en Render (plan gratuito). El mismo código corre en local con `npm run dev`. Sin clave de modelo arranca en modo `mock` (modelo simulado y determinista); con `ANTHROPIC_API_KEY` usa el modelo real. La clave vive solo en variables de entorno del backend. Para limitar costos y abuso, el despliegue define `ACCESS_KEY` (el chat y la descarga de archivos la piden), `MAX_TOKENS_SESION`, `MAX_TURNOS_SESION` y `RATE_LIMIT_POR_MINUTO`.

**Archivos generados.** El servidor expone `/out/`, una página que lista los archivos de cada caso procesado (formulario, paquete, checklist, borrador de correo, envío simulado) con enlaces de descarga. Solo sirve nombres que cumplen una lista blanca de caracteres y extensiones (`.xlsx`, `.pdf`, `.md`, `.txt`, `.json`, `.jsonl`) y exige `ACCESS_KEY` si está definida. El chat incluye el enlace «Archivos generados».

## 3. Ciclo del agente

`ejecutarTurno` (`src/agent/loop.ts`) arma `[system, ...historial]`, llama a `adaptador.enviar` y, si el modelo pide herramientas, valida los argumentos con zod, las ejecuta, agrega los resultados al historial y repite; si no pide herramientas, devuelve el texto.

- **Tope de iteraciones (CA1):** `MAX_ITERACIONES` (25 por defecto). Al alcanzarlo hace una última llamada *sin herramientas* para resumir lo logrado y lo que falta; si esa llamada falla, el servidor arma el resumen con las llamadas ya ejecutadas.
- **Control de costo:** tope de tokens por sesión (`MAX_TOKENS_SESION`), tope de turnos, `max_tokens` por respuesta, límite de peticiones por IP y por minuto, y mensajes de hasta 2000 caracteres.
- **Errores (CA5):** timeout, 401, 429, 5xx y respuestas mal formadas del proveedor se traducen a mensajes claros en el chat; la sesión sigue activa. Las herramientas nunca lanzan excepciones hacia el agente.
- **Confirmación humana (CA3, RN4):** la decide el *servidor*, no el modelo. Tras `armar_paquete` (o tras un `simular_envio` rechazado) la sesión queda con una acción pendiente y el turno termina con una pregunta explícita; el servidor la añade si el modelo no la formuló. En el mensaje inmediatamente siguiente solo cuenta como confirmación si afirma y no niega («envíes» o «sí, no envíes» no cuentan). El servidor pasa `ctx.confirmacionUsuario` a la herramienta; `simular_envio` exige `confirmado: true` **y** que el host no lo niegue, de modo que un modelo que declare una confirmación inexistente no logra enviar. El front resalta el estado y ofrece los botones «Sí, realiza el envío simulado» y «No, esperar».
- **Trazabilidad (CA4, RN5):** cada llamada queda visible en el chat (nombre, argumentos, resultado), en `out/log.jsonl` (con `sessionId`) y en `out/<caso>/log.jsonl` (`{ ts, herramienta, ok, resumen }`).
- **Vigencias:** se evalúan contra la fecha de ejecución (hoy), no contra la fecha de la solicitud. `armar_paquete` devuelve `fecha_ejecucion`, la nota de cada soporte vencido la incluye y el prompt indica que un soporte marcado como vencido se informa tal cual, con ambas fechas.
- **Nombres de caso:** se validan con una expresión regular (`[A-Za-z0-9_-]`) antes de construir cualquier ruta, incluido el registro de logs, para que un nombre como `../../etc` no pueda salir de `out/`.

**Por qué el modelo no necesita afirmar valores (CA2).** `generar_formulario` ignora los valores del `mapeo` que envíe el modelo y relee todo del maestro por `ruta`; si el mapeo recibido no coincide con el recalculado, usa el recalculado y lo advierte. `mapear_campos` solo mapea etiquetas presentes en la plantilla del cliente (RN2). El número de cuenta se enmascara en lo que ve el modelo y en los logs; el valor real solo llega al archivo generado.

## 4. Elección del modelo

- **Proveedor y modelo por defecto:** Anthropic, `claude-sonnet-5-5` (configurable con `ANTHROPIC_MODEL`; `claude-haiku-5-5` es la alternativa económica). El flujo son entre 4 y 6 llamadas a herramientas con instrucciones estrictas (no inventar valores, no enviar sin confirmación); un modelo con buen seguimiento de instrucciones y uso de herramientas reduce desvíos, y las garantías duras no dependen del modelo (ver sección 3).
- **Costo estimado por caso:** un caso típico son unas 6 llamadas al modelo con historial creciente, del orden de **12 000 a 20 000 tokens de entrada y 1 500 a 2 500 de salida**. Costo = `entrada × P_in + salida × P_out`. Con un precio de referencia de 3 USD (entrada) y 15 USD (salida) por millón de tokens, equivale a unos **0,05 a 0,09 USD por caso**. La respuesta de `/api/chat` incluye `usage` acumulado por sesión, que permite medir el consumo real.
- **Sin modelo:** `LLM_PROVIDER=mock` y `demo.ts` funcionan sin clave. El adaptador es una interfaz propia (`enviar(mensajes, herramientas) → respuesta`): agregar otro proveedor es crear un archivo en `src/llm/`, sin tocar el ciclo del agente.

## 5. Diseño del portal web

**Estrategia.** Un navegador controlado (Playwright o una extensión de navegador) operado por el agente en modo *asistido*: el agente abre el portal, **la persona inicia sesión**, y el agente recorre el formulario con selectores por etiqueta (no por posición) y lo rellena desde `valores-portal.md`. Cada campo queda registrado en un log y se toma una captura antes de enviar. Se descarta el RPA por coordenadas por su fragilidad ante cambios de diseño.

**Límites.** CAPTCHA y MFA no se automatizan: los resuelve la persona. Un cambio de diseño rompe los selectores; en ese caso el agente se detiene, reporta el campo que no encontró y deja el resto como valores copiables. Las sesiones pueden expirar. En portales cuyos términos prohíben la automatización solo se entrega `valores-portal.md`.

**Credenciales.** Nunca en el repositorio, el prompt ni los logs. Las ingresa la persona directamente en la ventana del navegador (el agente no las ve) o provienen de un gestor de secretos (Key Vault, 1Password) inyectado al navegador sin pasar por el modelo. Los logs enmascaran los valores de campos de tipo contraseña o cuenta.

**Reparto de responsabilidades.** Agente: preparar los valores, navegar, rellenar, verificar contra el maestro y capturar evidencia. Persona (como mínimo): ingresar credenciales, MFA y CAPTCHA, y dar clic en «Enviar» tras revisar el resumen y confirmar.

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| El servidor controla la confirmación (`ctx.confirmacionUsuario`) | Confiar en que el prompt haga que el modelo pida y respete la confirmación | Un prompt no es una garantía; RN4 es una regla de negocio y se hace cumplir en código. |
| Recalcular el mapeo en `generar_formulario` y leer los valores del maestro | Escribir lo que el modelo envíe en `mapeo` | Evita que el modelo altere valores o filtre datos bancarios; el costo es recalcular (milisegundos). |
| Coincidencia difusa por **palabras** (umbral 0,8 para llenar y 0,5 para proponer) | Distancia de edición sobre el texto completo | La comparación por letras emparejaba «Número de contribuyente especial» con «Número de cuenta» (0,5) y habría propuesto la cuenta bancaria; por palabras queda en 0,33 y el campo resulta faltante. |
| Escritor mínimo de `.xlsx` con `jszip` y PDF con `pdf-lib` | `exceljs` y `pdfkit` | Menos dependencias y salida determinista (fechas fijas en el zip y el PDF). Trade-off: sin fórmulas ni estilos avanzados. |
| Front HTML plano servido por el mismo backend | React con Vite | Sin paso de compilación, un solo comando de arranque y política de seguridad estricta (`default-src 'self'`). |
| Sesiones en memoria y archivos en disco local | Base de datos y almacenamiento de objetos | Lo permite el PRD; la contrapartida es que se pierden al reiniciar el servicio. |
| `simular_envio` no se bloquea por soportes vencidos; registra los pendientes | Bloquear siempre | El PRD espera `ENVIO-SIMULADO.md` tras confirmar incluso en `ec-corp-andina`, que tiene bloqueos; las advertencias quedan en el archivo y en la respuesta. |
| Páginas de descarga con lista blanca de nombres y extensiones | Servir `out/` como carpeta estática | Evita exponer archivos no previstos y recorridos de directorios. |

## 7. Supuestos

1. **Casos:** se usan los cuatro entregados por Periferia (`co-industrias-delta`, `ec-corp-andina`, `hn-agroexport-sula`, `pa-logistica-istmo`), sin modificar. La plantilla de campos de nueve elementos (con Banco, Número de cuenta y SWIFT) se asignó al caso de portal `pa-logistica-istmo`, por ser la única plantilla de campos restante.
2. **Fecha de ejecución:** es la fecha del día en que se ejecuta (en UTC) y puede fijarse con la variable `FECHA_EJECUCION` (formato `AAAA-MM-DD`). Con las vigencias del repositorio, la Cámara de Comercio figura vencida desde el 1 de octubre de 2026 y los parafiscales desde el 1 de septiembre de 2026. Con una fecha de ejecución anterior (por ejemplo `FECHA_EJECUCION=2026-08-30`), `co-industrias-delta` queda listo para firma.
3. Un soporte con `vigencia_hasta: null` (el RUT) no vence. Un soporte vence si `vigencia_hasta` es anterior a la fecha de ejecución; si vence ese mismo día, aún es vigente.
4. Un campo que no está en el glosario ni en el maestro es `faltante`. El glosario es la única fuente de sinónimos; «Correo electrónico» se mapea a `contacto_comercial.email`, según el glosario entregado.
5. En las plantillas Excel no existe el atributo `obligatorio`; se asume `false`.
6. En países distintos de Colombia, cualquier campo que mapee a `nit` pasa a `requiere_confirmacion` (RN1), aunque la etiqueta sea «RUC» o «RTN».
7. En `hn-agroexport-sula` el cliente pide el «registro tributario de su país»; el único RUT del repositorio es el colombiano (emisor CO) y se entrega tal cual, a criterio de la analista. La exigencia «no mayor a 30 días» de la Cámara de Comercio se anota como observación en el checklist porque el índice solo registra `vigencia_hasta`, no la fecha de expedición.
8. Las celdas de la plantilla Excel se generan desde cero, ya que no se entregó el `.xlsx` original del cliente: amarillo indica «por confirmar» y rojo vacío indica «faltante».

## 8. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer solicitud | Hecho | Leer el correo y los adjuntos reales; detectar el formato automáticamente. |
| HU-2 Mapear campos | Hecho | Confirmación interactiva de campos ambiguos; incorporación de nuevos sinónimos con un dueño del glosario. |
| HU-3 P0 Excel | Hecho | Rellenar la plantilla original del cliente (hoy se genera una equivalente). |
| HU-3 P1 PDF | Hecho (PDF generado, no AcroForm) | Rellenar los AcroForm del cliente. |
| HU-3 P2 Portal | Según el alcance del PRD: responde «formato no soportado» y produce `valores-portal.md`; diseño en la sección 5 | Implementación asistida del portal. |
| HU-4 Paquete | Hecho | Verificar la fecha de expedición real de la Cámara de Comercio; entregar el paquete comprimido. |
| HU-5 Errores | Hecho | Más casos de plantillas degradadas. |
| Descarga de archivos generados (adicional) | Hecho (`/out/`) | Almacenamiento persistente y control de acceso por usuario. |
| Módulo reutilizable (bonus) | Hecho: `modulo/` se genera desde las mismas fuentes y `npm run modulo:check` detecta divergencias | Publicarlo como paquete versionado. |
| Enlace público | Hecho: despliegue en Render con el `Dockerfile` del repositorio | Dominio propio, almacenamiento persistente y autenticación real. |

**Verificación realizada.**

- `npm run demo` ejecuta los cuatro casos sin modelo y comprueba reglas de negocio (RN1 a RN3), confirmación humana, robustez ante entradas inválidas y determinismo (dos ejecuciones producen archivos idénticos).
- Flujo HTTP completo con el modelo simulado: procesar, negar, reprocesar, confirmar y un envío sin confirmación previa en una sesión nueva, que queda bloqueado.
- Prueba de punta a punta con `claude-sonnet-5-5` en el despliegue: resumen del caso, tarjetas de herramientas, pregunta de confirmación y envío simulado.
- El `.xlsx` generado se abrió con `openpyxl` y el PDF se leyó con `pypdf` para confirmar celdas, campos y orden.
- El adaptador de Anthropic se probó además con respuestas simuladas de la API (conversión de mensajes, `tool_use`, error 429 y ausencia de clave).

**Limitaciones conocidas.**

- El servicio gratuito de Render se duerme tras 15 minutos sin tráfico y la primera carga posterior puede tardar cerca de un minuto.
- El disco del servicio es efímero: los archivos de `out/` y las sesiones se pierden al reiniciar o redesplegar.
- El PDF es generado (no un AcroForm rellenado) y el Excel se construye desde cero.
- El costo por caso es una estimación; el consumo real se mide con el campo `usage`.

## 9. Uso de IA

Construí la solución con **Claude** (asistente de Anthropic, en su interfaz de chat) como asistente de desarrollo.

**Para qué lo usé:**

- Diseñar la arquitectura y el contrato de herramientas a partir del PRD.
- Escribir el código TypeScript de las herramientas, el ciclo del agente, los adaptadores de modelo, el servidor, el front de chat, `demo.ts`, el script que genera `modulo/` y el `Dockerfile`.
- Redactar esta documentación, el `README.md` y las guías de prueba.
- Orientarme en la creación del repositorio, el despliegue en Render y la clave de la API.

**Qué descarté o corregí de lo propuesto, a partir de pruebas:**

1. **Coincidencia por distancia de edición:** proponía la cuenta bancaria para «Número de contribuyente especial». Se reemplazó por coincidencia por palabras.
2. **Confirmación declarada por el modelo:** se movió al servidor, que la decide con el mensaje inmediatamente posterior a la pregunta.
3. **Registro de logs fuera de `out/`:** al ejecutar `demo.ts` apareció una carpeta `etc/` fuera del proyecto. La causa era que el log por caso usaba un nombre sin validar (`../../etc`). Se corrigió validando el nombre antes de construir la ruta y se agregó una verificación de regresión en `demo.ts`.
4. **Duda del modelo sobre un soporte vencido:** el modelo comparaba la vigencia con la fecha de la solicitud. La herramienta ahora devuelve `fecha_ejecucion` y el prompt indica que un soporte marcado como vencido se informa sin cuestionarlo.
5. **Frase de confirmación ambigua:** el botón enviaba «Sí, envía», que el modelo interpretaba de forma inconsistente. Ahora dice «Sí, realiza el envío simulado».
6. **Vulnerabilidad reportada por `npm audit` en `zod`:** decidí aceptarla en este ejercicio (ver sección 10) y documentarla.

**Cómo lo validé:** ejecuté `demo.ts`, probé el chat en local y en el despliegue con el modelo real, revisé los archivos generados y los logs, y ajusté lo que las pruebas mostraron.

## 10. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo «completa» un campo faltante | Las herramientas son la única fuente de valores; los valores se releen del maestro; el prompt lo prohíbe; los faltantes quedan visibles en el checklist. |
| Maestro desactualizado | Dueño del dato, fecha de última revisión en el maestro y alertas de vigencia. |
| Soportes vencidos enviados al cliente | Bloqueo de `listo_para_firma`; además, validar la fecha de expedición real. |
| Fuga de datos bancarios | Enmascarado en chat y logs, ausencia en el borrador de correo; en producción, cifrado en reposo y control de acceso a los archivos. |
| Abuso de la clave del modelo | Límites por sesión, por turnos y por IP, `ACCESS_KEY`; en producción, autenticación real y cuotas por usuario. |
| Prompt injection desde correos y adjuntos reales | Tratar el contenido del correo como datos, herramientas sin acceso a shell y acciones externas siempre con confirmación validada en el servidor. |
| Plantillas reales más degradadas que los fixtures | Revisión humana siempre, más casos de prueba y un modo de «solo reporte de faltantes». |
| Persistencia en memoria y disco efímero | Base de datos, almacenamiento de objetos y auditoría inmutable. |
| Portales con CAPTCHA o MFA | Persona en el bucle (sección 5). |
| Dependencias con avisos de `npm audit` | `zod` anterior a 4.6.6 reporta consumo excesivo de memoria con colecciones muy grandes. En este ejercicio el servidor limita el cuerpo de las peticiones a 16 KB y los mensajes a 2000 caracteres; en producción se actualiza a `zod` 4.6.7 o superior y se ejecuta `npm audit` en el pipeline. |
