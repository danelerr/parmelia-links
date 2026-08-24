# Roadmap técnico de GatoPago

**Fecha de consolidación:** 23 de agosto de 2026  
**Estado:** backlog operativo vigente; cada cierre requiere evidencia nueva  
**Fuente inicial:** [auditoría técnica del 23 de agosto de 2026](./audits/2026-08-23.md)

Este archivo reemplaza `MEJORAS_PENDIENTES.md` como única lista de trabajo técnico. No demuestra que una tarea siga abierta ni que esté cerrada: antes de cambiar su estado hay que comprobar el código, el entorno correspondiente y, cuando aplique, el flujo real.

## P0 — Antes del siguiente despliegue

- [ ] **Contener secretos locales.** Sacarlos de OneDrive, verificar revocación OIDC y Firebase, rotar cualquier credencial potencialmente sincronizada y conservar solo un inventario sin valores. Cierre: ningún secreto operativo dentro del workspace y revocaciones confirmadas en proveedor.
- [ ] **Resolver `user_event_outbox_dead`.** Consultar únicamente identificador, tipo y error redactado; corregir y reintentar de forma idempotente o cerrar como no entregable. Cierre: `/health` en estado lógico `ok`, contador dead en cero y runbook documentado.

## P1 — Próximo ciclo corto

- [ ] **Añadir CI reproducible en Node 24/Linux.** Incluir instalación congelada, verificación, E2E crítico, migraciones, contratos y scanners con versiones fijadas. Cierre: ningún merge de release con gates rojos.
- [ ] **Aplicar cabeceras y separar health público/operativo.** Empezar CSP en Report-Only, añadir pruebas y limitar liveness público. Cierre: CSP sin violaciones funcionales y detalle operativo solo autenticado.
- [ ] **Corregir caché de Vercel y service worker.** Assets con hash inmutables; HTML y SW revalidables; esperar escrituras de Cache Storage. Cierre: segunda visita sin revalidar chunks y pruebas offline/upgrade verdes.

## P2 — Próxima semana de ingeniería

- [ ] **Reducir hotspots por dominio.** Prioridad: `storage.ts`, `indexer.ts`, `ScanQR.tsx` y `PayPage.tsx`. Mantener transacciones en una sola frontera y extraer lógica pura con pruebas.
- [ ] **Unificar duplicación sensible.** Una fuente para EIP-712, checkpoints, decoding, indexación y outbox.
- [ ] **Pagar deuda de efectos React.** Reactivar `set-state-in-effect` como warning y resolver por lotes con E2E de formularios.
- [ ] **Cubrir flujos reales faltantes.** Perfil, wallet/passkey, envío, swap, cross-chain, webhooks y recovery con evidencia de navegador, API y chain; un build no cuenta como validación funcional.

## P3 — Próximas 2–4 semanas

- [ ] **Optimizar bundles con medición.** Evaluar `sileo`, analytics y Firebase; definir presupuestos y medir LCP, INP y CLS antes y después.
- [ ] **Actualizar dependencias por lotes.** Primero patches compatibles; TypeScript 7 como migración separada. Exigir lockfile limpio, verificación completa, dry-run del Worker y E2E de firmas.
- [ ] **Crear el gate explícito de mainnet.** Cero `TODO_DEPLOY`, direcciones y claves segregadas, fork tests, simulacro de rollback y revisión externa independiente.

## Regla de actualización

Cada tarea cerrada debe registrar fecha, evidencia y entorno. Si un nuevo audit descubre trabajo, se añade aquí y el informe queda como evidencia fechada; no se crea otro backlog paralelo.
