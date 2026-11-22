---
name: registro-proveedor
description: Proceso y reglas de negocio para registrar a Periferia como proveedor ante clientes de CO, EC, PE, PA y HN (identificador tributario por país, datos bancarios, soportes y vigencias, confirmación humana). Úsala al procesar solicitudes de registro.
---

# Registro como proveedor — conocimiento del proceso

Este documento describe el proceso y las reglas de negocio. El comportamiento del agente está en `agent/prompt.md` y la ejecución en `src/tools/`. Las reglas numéricas y de país viven en `reglas.json` (esta misma carpeta), de modo que cambiarlas no exige tocar el servidor.

## Qué es una solicitud

Un cliente (Colombia, Ecuador, Perú, Panamá u Honduras) escribe a recepción pidiendo que Periferia se registre como proveedor. Cada caso trae: el correo normalizado, la plantilla (Excel por celdas, PDF por campos o portal web) y la lista de soportes exigidos. La salida es siempre un **paquete para firma del representante legal**; el agente prepara, un humano firma y envía.

## Estados de un campo

| Estado | Cuándo |
|---|---|
| `lleno` | Hay un dato en el maestro y el mapeo es seguro (coincidencia exacta con el glosario o confianza ≥ 0.8). |
| `requiere_confirmacion` | Mapeo con confianza < 0.8, etiqueta ambigua o regla de país. |
| `faltante` | No existe en el glosario/maestro. Nunca se inventa: se lista en el checklist. |

## Reglas de negocio

- **RN1 — Identificador tributario por país:** CO → NIT, EC → RUC, PE → RUC, PA → RUC, HN → RTN. Periferia solo tiene NIT colombiano: para otros países el campo se llena con el NIT y se marca `requiere_confirmacion` con la nota «identificador extranjero». Etiquetas ambiguas («Identificación tributaria», «Número de identificación fiscal») también se confirman y se propone el equivalente del país.
- **RN2 — Datos bancarios:** solo si la plantilla los pide explícitamente. Nunca en `borrador-correo.md`. El número de cuenta se muestra enmascarado en el chat y en los logs.
- **RN3 — Listo para firma:** un soporte vencido (`vigencia_hasta` anterior a la fecha de ejecución) o ausente lo bloquea. Un campo faltante no lo bloquea, pero aparece en el checklist. Un soporte sin vigencia (`null`, p. ej. el RUT) no vence.
- **RN4 — Acciones externas:** envío, firma o carga a portal exigen confirmación explícita del usuario en el turno inmediatamente anterior. En este proyecto «enviar» solo escribe `ENVIO-SIMULADO.md`.
- **RN5 — Trazabilidad:** cada ejecución deja `{ ts, herramienta, ok, resumen }` en `out/<caso>/log.jsonl`.

## Tipos de soporte

`camara_comercio` (existencia y representación legal; los clientes suelen exigir ≤ 30 días de expedición), `rut`, `certificacion_bancaria`, `parafiscales`, `estados_financieros`, `certificado_iso_9001`, y los que un cliente pida y no estén en el repositorio (p. ej. `certificado_cumplimiento_tributario`), que quedan **ausentes**.

## Portal web

No se automatiza. El agente responde «formato no soportado» y produce `valores-portal.md` con los valores para copiar. Credenciales y clic en «Enviar» son humanos.
