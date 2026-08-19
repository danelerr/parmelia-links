# CODEX_PLAN_DE_IMPLEMENTACION_Y_MEJORAS

> **SUPERSEDIDO (2026-07-02):** este plan fue auditado, verificado y ejecutado
> casi en su totalidad por la pasada de endurecimiento de julio 2026 — el
> documento vigente de auditoría, estado y pendientes es
> **`CLAUDE_REVIEW_FABLE.md`**. Se conserva como registro histórico de la
> auditoría de Codex del 2026-06-30; no usar sus "pendientes" como fuente de
> verdad.

Fecha de auditoría: 2026-06-30  
Repositorio: `gatopago`

## 1. Resumen ejecutivo

El proyecto tiene una base técnica seria: contratos con Foundry, backend en Cloudflare Workers/Hono/D1, cliente React/Vite/PWA, dashboard operativo, documentación de arquitectura y una suite de pruebas que hoy pasa. La mayor parte del riesgo no está en que "no compile", sino en cuatro frentes:

1. **Seguridad operacional**: hay un archivo local de Firebase service account dentro del workspace. Parece ignorado por Git y no aparece trackeado en el checkout actual, pero sigue siendo una credencial sensible en la raíz del repo y debe rotarse/eliminarse.
2. **Preparación real para producción**: varios documentos dicen simultáneamente que ciertos flujos están operativos y que faltan deploys, smoke tests o redeploys de contratos. Hay que separar estado de código, estado de deploy y estado de validación e2e.
3. **Escalabilidad del backend**: varias rutas esperan confirmaciones on-chain dentro del request HTTP. En Workers esto funciona para demos o bajo bajo volumen, pero no es el patrón robusto para pagos, recovery y flujos cross-chain.
4. **Calidad UX/accesibilidad**: existen problemas sistemáticos de foco visible, navegación implementada con botones, `transition-all`, autoFocus en mobile, formatos hardcodeados y falta de confirmación en acciones destructivas.

La recomendación es no abrir producción con fondos reales hasta cerrar los P0/P1 de este documento.

## 2. Evidencia revisada

### Comandos ejecutados

- `pnpm --filter server test`: OK, 4 archivos, 38 tests.
- `pnpm --filter server exec tsc --noEmit`: OK.
- `pnpm --filter client build`: OK. Bundle principal aprox. 499.21 KB sin gzip / 162.44 KB gzip; chunk Firebase aprox. 33.30 KB gzip; chunk `jsQR` lazy aprox. 47.46 KB gzip.
- `pnpm --filter dashboard build`: OK. Bundle principal aprox. 381.70 KB sin gzip / 123.48 KB gzip; chunk Firebase aprox. 33.08 KB gzip.
- `forge test`: OK, 57 tests.
- `pnpm --filter client lint`: ejecuta, pero deja 9 warnings de dependencias de hooks.

### Fuentes externas y guías usadas

- Vercel Web Interface Guidelines: `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md`
- Vercel React/Next performance guidance disponible localmente en `.agents/skills/vercel-react-best-practices`.
- Cloudflare Workers best practices: `https://developers.cloudflare.com/workers/best-practices/workers-best-practices/`
- Cloudflare Queues: `https://developers.cloudflare.com/queues/`
- Uniswap V3 deployments: `https://docs.uniswap.org/contracts/v3/reference/deployments/`
- Circle CCTP contract addresses y dominios soportados: `https://developers.circle.com/cctp/references/contract-addresses`
- OpenZeppelin Contracts 5.x: `https://docs.openzeppelin.com/contracts/5.x/`

### Revisión visual/runtime

- Cliente mobile `390x844`: `/login` renderiza sin overflow horizontal.
- Cliente desktop `1280x900`: aviso desktop renderiza sin overflow horizontal.
- Dashboard desktop `1280x900`: login renderiza sin overflow horizontal.
- Auditoría de teclado: el primer `Tab` enfoca "Continuar con Google", pero el foco queda visualmente invisible por `outline: none` global y ausencia de `box-shadow`/outline sustitutivo.

### Hallazgos con referencia directa

| Prioridad | Evidencia | Impacto |
|---|---|---|
| P0 | `proyecto-prueba-push-firebase-firebase-adminsdk-fbsvc-8d9f2d3ec8.json` existe localmente en la raíz y contiene una service account; `git ls-files` y `git log -- <path>` no muestran tracking actual. | La credencial puede filtrarse por ZIP, backup, sync, screenshot o carga manual aunque Git la ignore. |
| P0 | `MEJORAS_PENDIENTES.md:9-10`, `MEJORAS_PENDIENTES.md:19`, `MEJORAS_PENDIENTES.md:133-134`, `CROSSCHAIN_DESIGN.md:15-16`, `CROSSCHAIN_DESIGN.md:30`, `CROSSCHAIN_DESIGN.md:36-38`. | El producto mezcla "implementado", "desplegado" y "probado e2e"; en pagos esto puede inducir decisiones operativas incorrectas. |
| P0 | `shared/networks.ts:193-197` mantiene `TODO_DEPLOY` para Arbitrum One; `server/src/chain.ts:22` dice que el default es `monad-testnet` aunque el default real es Arbitrum Sepolia. | Riesgo de activar producción con config incompleta o documentación de runtime incorrecta. |
| P1 | `server/src/routes/pay.routes.ts:485` y `server/src/routes/account.routes.ts:76,136,304,366,404` esperan receipts on-chain dentro del request. | Timeouts, mala idempotencia y reintentos frágiles bajo congestión. |
| P1 | `server/src/services/paymentRouter.ts:86` cae a `PAYMASTER_SIGNER_PRIVATE_KEY`; `server/src/services/userOp.ts:152-153` cae a `PRIVATE_KEY`. | Rompe least privilege: una llave filtrada puede firmar más superficies de las necesarias. |
| P1 | `server/src/services/webhooks.ts:93,110,119` procesa hasta 25 deliveries secuenciales con timeout de 10s cada una; `server/src/routes/v1.routes.ts:174-180` emite `payment.created` best effort. | Un flush puede superar holgadamente límites prácticos de Worker y perder señal operativa si el outbox falla. |
| P1 | `server/migrations/0001_schema.sql:21-29` hace drops destructivos; `0004_push_tokens.sql:7-13` y `0005_crosschain.sql:9-43` no tienen la misma dureza de `STRICT`, FK y `CHECK` que el schema base. | Migraciones peligrosas para prod y datos menos confiables en tablas nuevas. |
| P1 | `server/src/middlewares/auth.ts:99` y ramas de `server/src/routes/pay.routes.ts` como `:327` devuelven error sin `error_code`. | Contrato API inconsistente; i18n y SDKs no pueden depender de códigos estables. |
| P1 | `client/src/index.css:165,171` y `dashboard/src/index.css:97-98` remueven outline global; runtime confirmó foco invisible. | Accesibilidad teclado rota en flujos de login/pago. |
| P1 | Navegación vía botones en `client/src/pages/Home.tsx:126,133,223,254,278,321` y páginas similares. | Semántica de navegador y accesibilidad peores que con `Link`/anchor. |

## 3. P0 - Bloqueantes antes de producción

### P0.1 Rotar y retirar service account de Firebase del workspace

**Evidencia**

- Existe `proyecto-prueba-push-firebase-firebase-adminsdk-fbsvc-8d9f2d3ec8.json` en la raíz del repo.
- El archivo contiene una service account con clave privada.
- `.gitignore` ya tiene patrones como `*-firebase-adminsdk-*.json`.
- `git ls-files` no lo muestra como trackeado en el checkout actual, y `git log -- <archivo>` no devolvió commits para ese path.

**Riesgo**

Una credencial de servidor en la raíz del proyecto es un incidente esperando ocurrir aunque esté ignorada por Git. Puede subirse por ZIP, captura, backup, sync, o un comando manual.

**Plan**

1. Revocar/rotar esa service account en Firebase/GCP.
2. Eliminar el JSON local del workspace después de confirmar que ya no se usa.
3. Cargar la credencial por secreto administrado: `wrangler secret put FCM_SERVICE_ACCOUNT` o dividir los campos necesarios si el código lo requiere.
4. Ejecutar secret scanning sobre el repo e historial.
5. Documentar el procedimiento en `SECURITY.md` o `docs/ops/secrets.md`.

**Criterio de aceptación**

- No existe ningún `*-firebase-adminsdk-*.json` en el workspace.
- La clave antigua está revocada.
- El Worker puede enviar push usando binding/secreto, no archivo local.
- CI bloquea commits con claves privadas o service accounts.

### P0.2 Resolver contradicciones de estado deploy/e2e/cross-chain

**Evidencia**

- `MEJORAS_PENDIENTES.md` dice que falta `wrangler deploy` y redeploy del cliente, pero también dice que la app ya está operativa en Arbitrum Sepolia.
- `CROSSCHAIN_DESIGN.md` marca flujos como implementados/probados y, en otras líneas, como pendientes de deploy y smoke test e2e.
- `shared/networks.ts` tiene contratos `TODO_DEPLOY` para `arbitrum-one`.
- `MEJORAS_PENDIENTES.md` indica que `payInvoiceWithPermit` está implementado pero requiere redeploy del `PaymentRouter`.

**Riesgo**

El equipo puede comunicar funcionalidades como listas cuando solo están implementadas en código. En pagos, esta diferencia importa.

**Plan**

1. Crear una matriz única de estado por feature:
   - `implementado en código`
   - `desplegado`
   - `configurado en cliente/shared`
   - `probado unit/integration`
   - `probado e2e en red`
2. Actualizar `MEJORAS_PENDIENTES.md`, `CROSSCHAIN_DESIGN.md` y cualquier copy público usando esa matriz.
3. Bloquear modo mainnet/live si hay direcciones `TODO_DEPLOY` o `ZERO_ADDRESS`.
4. Añadir smoke tests por red para:
   - login/passkey
   - crear link
   - pagar link
   - depositar
   - flow cross-chain inbound/outbound
   - dashboard payment detail

**Criterio de aceptación**

- No hay claims contradictorios en docs.
- La UI no muestra una red como lista si faltan contratos o watchers.
- Cada feature pública tiene evidencia de deploy y prueba e2e con fecha.

### P0.3 Desplegar nuevo PaymentRouter o ocultar `payInvoiceWithPermit`

**Evidencia**

- `contracts/src/ParmeliaPaymentRouter.sol` tiene `payInvoiceWithPermit`.
- `MEJORAS_PENDIENTES.md` dice que falta redeploy del router.
- `shared/networks.ts` sigue apuntando a un router existente en Arbitrum Sepolia.

**Riesgo**

El frontend/backend pueden asumir una función que el contrato desplegado no tiene. Esto rompe pagos o fuerza fallback manual.

**Plan**

1. Desplegar el nuevo `ParmeliaPaymentRouter`.
2. Ejecutar configuración de tokens soportados.
3. Actualizar `shared/networks.ts`.
4. Verificar ABI usada por backend/cliente.
5. Ejecutar prueba e2e de `payInvoiceWithPermit`.
6. Si no se despliega aún, ocultar o desactivar cualquier flujo que dependa de esa función.

**Criterio de aceptación**

- `shared/networks.ts` contiene la dirección nueva verificada.
- El evento esperado aparece en el watcher.
- Hay transacción real de smoke test documentada.

## 4. P1 - Backend Workers, pagos y contratos API

### P1.1 Sacar confirmaciones on-chain del request HTTP

**Evidencia**

- `server/src/routes/pay.routes.ts` espera `waitForTx` en `/pay/submit`.
- `server/src/routes/account.routes.ts` también espera `waitForTx` en creación, funding y recovery.
- Cloudflare recomienda usar Queues/Workflows o `ctx.waitUntil` para trabajo posterior al response, y evitar requests largos para tareas retriables.

**Riesgo**

Timeouts, dobles submissions, mala UX bajo congestión de red, y dificultad para reintentar operaciones parcialmente exitosas.

**Plan**

1. Cambiar operaciones on-chain a modelo de job:
   - request valida y persiste intención
   - responde `202 Accepted` con `jobId` o `paymentId`
   - Queue/Workflow ejecuta transacción
   - endpoint de estado entrega `pending/submitted/confirmed/failed`
2. Hacer idempotentes los submits por `invoiceId`, `userOpHash`, `chainId`, `operationType`.
3. Mantener `waitForTx` solo para scripts, tests o paths explícitamente síncronos de bajo riesgo.
4. Añadir reintentos con backoff y dead-letter handling.

**Criterio de aceptación**

- Ninguna ruta pública crítica bloquea hasta receipt on-chain.
- El usuario puede refrescar sin duplicar operación.
- El dashboard muestra estado transaccional claro.

### P1.2 Unificar contrato de errores API

**Evidencia**

- `ERROR_CODES.md` define `error_code` como contrato estable.
- `server/src/middlewares/auth.ts` devuelve errores sin `error_code`.
- `server/src/routes/pay.routes.ts` tiene múltiples ramas que devuelven `{ error: ... }` sin código.

**Riesgo**

El cliente no puede mapear mensajes traducidos de forma confiable y los integradores reciben respuestas inconsistentes.

**Plan**

1. Crear helper único `apiError(c, status, code, message, meta?)`.
2. Prohibir respuestas `{ error }` manuales fuera del helper.
3. Añadir códigos faltantes en `shared/errors.ts`.
4. Añadir traducciones `err.*` en todos los locales.
5. Test de contrato que recorra rutas representativas y falle si falta `error_code`.

**Criterio de aceptación**

- Todo error JSON público contiene `error_code`.
- Documentación OpenAPI y `ERROR_CODES.md` coinciden.
- El frontend no depende de strings del backend para UX.

### P1.3 Usar tipos generados de Wrangler como fuente principal

**Evidencia**

- `server/worker-configuration.d.ts` existe.
- `server/src/middlewares/auth.ts` mantiene un `Bindings` manual con riesgo de drift.
- Cloudflare recomienda generar tipos con Wrangler y evitar Env handwritten disperso.

**Plan**

1. Definir una interfaz única de entorno:
   - generated `CloudflareBindings`
   - extensión explícita para secrets no inferibles si hace falta
2. Eliminar `Bindings` manuales duplicados.
3. Añadir script `wrangler types` y gate CI que falle si el archivo generado queda desactualizado.

**Criterio de aceptación**

- Un solo tipo de Env se importa en rutas/middlewares.
- Cambiar `wrangler.jsonc` o bindings obliga a regenerar tipos.

### P1.4 Tests en runtime real de Workers

**Evidencia**

- El backend usa Vitest Node y pasa.
- No hay evidencia de ejecución con `@cloudflare/vitest-pool-workers`.

**Riesgo**

Node puede ocultar diferencias de APIs, bindings, crypto, streams, ExecutionContext y D1.

**Plan**

1. Añadir suite mínima con Worker runtime.
2. Probar auth, D1 migrations, cron handlers, CORS, webhooks y rutas de pago críticas.
3. Mantener tests unitarios Node para lógica pura.

**Criterio de aceptación**

- CI ejecuta tests unitarios y tests Worker runtime.
- Las rutas críticas se prueban con bindings simulados equivalentes.

### P1.4.1 Separar llaves calientes y eliminar fallbacks peligrosos

**Evidencia**

- `server/src/services/paymentRouter.ts:86` usa `PAYMENT_ROUTER_SIGNER_PRIVATE_KEY || PAYMASTER_SIGNER_PRIVATE_KEY`.
- `server/src/services/userOp.ts:152-153` usa `PAYMASTER_SIGNER_PRIVATE_KEY || PRIVATE_KEY`.
- `server/README.md:50-51` documenta `PRIVATE_KEY` como EOA multiuso de relayer/deploy/guardian/faucet.

**Riesgo**

Una sola llave o una llave reutilizada amplía el radio de explosión: comprometer el paymaster puede terminar firmando autorizaciones de router, y comprometer el relayer puede terminar firmando sponsorships.

**Plan**

1. Requerir explícitamente:
   - `RELAYER_PRIVATE_KEY`
   - `PAYMASTER_SIGNER_PRIVATE_KEY`
   - `PAYMENT_ROUTER_SIGNER_PRIVATE_KEY`
   - `DEPLOYER_PRIVATE_KEY` solo en scripts, nunca en Worker runtime
2. Fallar cerrado si falta una llave dedicada.
3. Permitir fallback solo en test local con flag explícito: `ALLOW_INSECURE_KEY_FALLBACK=true`.
4. Actualizar `server/README.md`, `.dev.vars.example` y runbooks.
5. Añadir test que confirme que producción no arranca con fallback.

**Criterio de aceptación**

- Ningún signer productivo cae a otra variable por defecto.
- Cada secreto tiene rol, rotación y owner operativo.

### P1.4.2 Hacer webhooks realmente operables

**Evidencia**

- `server/src/services/webhooks.ts:93` procesa hasta 25 deliveries.
- `server/src/services/webhooks.ts:110` hace `fetch` secuencial.
- `server/src/services/webhooks.ts:119` usa timeout de 10s por delivery.
- `server/src/routes/v1.routes.ts:174-180` emite `payment.created` como best effort después del response.

**Riesgo**

Un cron o `waitUntil` puede acumular hasta 250s teóricos de I/O si 25 endpoints tardan 10s. Además, si `emitEvent` falla después de un estado crítico, el dashboard/API puede quedar sin evento entregable.

**Plan**

1. Cambiar delivery a cola por webhook o a batch con concurrencia limitada y timeout menor.
2. Persistir outbox dentro de la misma transacción lógica que cambia el estado de pago cuando sea posible.
3. Registrar estado `event_pending`/`webhook_pending` si el outbox no pudo escribirse.
4. Añadir dead-letter/retry policy y métrica de `attempts`, `next_attempt_at`, `last_error`.
5. Hacer que el dashboard exponga reenvío manual, payload y firma esperada sin mostrar secretos.

**Criterio de aceptación**

- Un endpoint lento no bloquea el flush completo.
- Todo pago confirmado tiene evento auditable o estado explícito de evento pendiente.

### P1.4.3 Endurecer D1 y separar migraciones de demo/prod

**Evidencia**

- `server/migrations/0001_schema.sql:21-29` contiene `DROP TABLE IF EXISTS` para tablas base.
- El schema base usa `STRICT`, FK y `CHECK` en varias tablas.
- `server/migrations/0004_push_tokens.sql:7-13` y `server/migrations/0005_crosschain.sql:9-43` no siguen completamente ese estándar.

**Riesgo**

Las migraciones de reset son aceptables en testnet, pero peligrosas en producción. Las tablas nuevas pueden aceptar estados imposibles o filas huérfanas que luego rompen indexers, dashboard o conciliación.

**Plan**

1. Congelar una migración baseline para producción sin `DROP TABLE`.
2. Mantener reset scripts solo bajo nombre explícito `reset-dev`.
3. Añadir `STRICT`, FK y `CHECK` a `push_tokens` y `crosschain_operations`.
4. Agregar constraints para `direction`, `status`, `provider`, `mode`, `source_chain_id`, `dest_chain_id` y `uid`.
5. Crear prueba de migraciones que aplique todas sobre D1 local y valide constraints.

**Criterio de aceptación**

- Ninguna migración prod destruye tablas.
- Las operaciones cross-chain no pueden persistir estados fuera del enum esperado.

### P1.4.4 Hacer que el relayer cross-chain falle cerrado cuando no puede operar

**Evidencia**

- `server/src/services/crosschainRelayer.ts:71-80` devuelve `true` si el check de gas/RPC falla.
- `server/src/routes/crosschain.routes.ts:151-155`, `:277`, `:381` y `:413` dependen de `relayerGasOk` para exponer disponibilidad.
- `shared/networks.ts:261-285` codifica direcciones CCTP V2 y dominios para Arbitrum Sepolia/Base Sepolia.

**Riesgo**

Si el RPC o el check de balance falla, el sistema puede mostrar rutas como disponibles aunque el relayer no pueda mintear en destino. En cross-chain esto degrada a "burn hecho, mint pendiente", que debe ser recuperable, pero no debería venderse como ruta saludable.

**Plan**

1. Cambiar el check a fail-closed para disponibilidad pública.
2. Distinguir estados: `available`, `degraded`, `unavailable`, `manual_recovery_available`.
3. Exigir RPC dedicado por chain en producción; no depender de públicos por defecto.
4. Verificar direcciones y dominios CCTP contra documentación oficial de Circle antes de mainnet y guardar fecha/fuente en `shared/networks.ts`.
5. Añadir smoke test que simule RPC caído y confirme que la UI no ofrece la ruta como normal.

**Criterio de aceptación**

- Una falla de RPC/gas no se interpreta como disponibilidad.
- El usuario ve estado honesto y hay ruta manual de recuperación documentada.

## 5. P1 - Seguridad y smart contracts

### P1.5 Endurecer recovery en `AccountWebAuthnV2`

**Evidencia**

- `contracts/AUDIT.md` ya documenta que un guardian puede proponer signers/threshold inválidos y bloquear recovery hasta cancelación.
- `forge test` pasa, pero este comportamiento queda como riesgo de griefing.

**Plan**

1. Validar en `proposeRecovery`:
   - signers no vacíos
   - threshold > 0
   - threshold <= signers.length
   - sin duplicados
   - sin address cero si aplica
2. Añadir tests negativos.
3. Actualizar `AUDIT.md`.

**Criterio de aceptación**

- No se puede crear una propuesta de recovery inválida.
- `forge test` cubre el caso.

### P1.6 Caps y protección de gas en Paymaster

**Evidencia**

- `contracts/AUDIT.md` indica que no hay max gas cost on-chain.
- Actualmente el backend firma y controla la política.

**Plan**

1. Evaluar cap on-chain por operación o por token/day/account.
2. Añadir pausabilidad operacional si no existe en el flujo completo.
3. Exponer métricas y alertas de gasto paymaster.

**Criterio de aceptación**

- Una firma backend comprometida no implica gasto ilimitado sin controles adicionales.
- Hay límites y alertas documentados.

### P1.7 Gate de upgrades y storage layout

**Plan**

1. Añadir `forge inspect <Contract> storage-layout` a CI.
2. Guardar snapshot de storage layout para contratos upgradeables.
3. Bloquear PRs que cambien layout sin revisión explícita.
4. Añadir fuzz/invariant para:
   - router no retiene fondos
   - invoices no se pagan dos veces
   - paymaster no acepta tokens no soportados

**Criterio de aceptación**

- Cambios de layout se detectan automáticamente.
- Las invariants corren en CI o nightly.

## 6. P1 - Frontend, UX y accesibilidad

### P1.8 Restaurar foco visible global

**Evidencia**

- `client/src/index.css` y `dashboard/src/index.css` definen `outline: none` para controles.
- No se encontró reemplazo global equivalente con `:focus-visible`.
- Vercel Web Interface Guidelines marca esto como issue crítico.

**Plan**

1. Quitar `outline: none` global o reemplazarlo por estilos accesibles.
2. Añadir `:focus-visible` consistente para botones, links, inputs, selects, textareas y controles custom.
3. Verificar navegación completa con teclado.

**Criterio de aceptación**

- Todo elemento interactivo tiene foco visible.
- No hay `outline: none` sin reemplazo.

### P1.9 Usar links reales para navegación

**Evidencia**

- Varias páginas usan `<button onClick={() => navigate(...)}` para navegación: `Home.tsx`, `CreateLink.tsx`, `Contacts.tsx`, entre otras.

**Riesgo**

Se pierde abrir en nueva pestaña, copiar link, semántica de navegador y accesibilidad.

**Plan**

1. Crear o estandarizar `LinkButton` basado en `react-router-dom` `Link`.
2. Reservar `<button>` para acciones que cambian estado.
3. Migrar navegación principal y CTAs internos.

**Criterio de aceptación**

- Navegación usa anchors/Link.
- Acciones usan button.

### P1.10 Formularios: labels, autocomplete, names y autoFocus

**Evidencia**

- Inputs de login y pago usan `autoFocus` en varias páginas.
- Hay formularios con labels/metadata incompletos.
- Las guías recomiendan `autoFocus` solo con mucha cautela, especialmente en mobile.

**Plan**

1. Revisar todos los forms de cliente y dashboard.
2. Añadir `name`, `autoComplete`, `inputMode`, `aria-describedby` donde corresponda.
3. Remover `autoFocus` en mobile o hacerlo condicional a viewport desktop.
4. Asegurar mensajes de error asociados al campo.

**Criterio de aceptación**

- Login, pago, swap, deposit, settings y dashboard forms pasan revisión manual con teclado y screen reader básico.

### P1.11 Confirmación/undo en acciones destructivas

**Evidencia**

- Eliminación de contactos y webhooks/API keys parecen ejecutarse con confirmación limitada o inconsistente.

**Plan**

1. Toda acción destructiva debe tener confirmación explícita o undo.
2. Acciones irreversibles deben indicar objeto afectado.
3. Añadir optimistic UI solo si existe rollback correcto.

**Criterio de aceptación**

- No se puede borrar/revocar por click accidental.

## 7. P1 - Performance React y bundles

### P1.12 Corregir warnings de hooks y hacer lint bloqueante

**Evidencia**

- `pnpm --filter client lint` deja 9 warnings de `react-hooks/exhaustive-deps`.

**Plan**

1. Corregir dependencias faltantes o estabilizar callbacks.
2. Configurar CI para tratar warnings como error.
3. Añadir lint al dashboard si no existe.

**Criterio de aceptación**

- `pnpm --filter client lint` corre sin warnings.
- Dashboard tiene lint equivalente.

### P1.13 Presupuesto de bundles y lazy loading medido

**Evidencia**

- Client main bundle gzip aprox. 162.44 KB.
- Dashboard main bundle gzip aprox. 123.48 KB.
- Firebase aparece como chunk separado, pero sigue siendo una dependencia importante.

**Plan**

1. Añadir bundle analyzer o reporte CI.
2. Definir presupuestos por entrypoint.
3. Confirmar que QR scanner, Firebase-auth-only paths, dashboard y páginas pesadas estén lazy-loaded.
4. Medir antes/después, no optimizar a ciegas.

**Criterio de aceptación**

- PRs muestran impacto de bundle.
- Rutas no cargan módulos pesados innecesarios.

### P1.14 Estado en URL para filtros y vistas compartibles

**Evidencia**

- `Statement.tsx` mantiene filtros en estado local.

**Plan**

1. Sincronizar filtros relevantes con query params.
2. Mantener defaults limpios.
3. Preservar navegación back/forward.

**Criterio de aceptación**

- Una vista filtrada se puede compartir por URL.

## 8. P2 - Internacionalización, copy y consistencia visual

### P2.1 Centralizar formatos de número, fecha y moneda

**Evidencia**

- Hay `toLocaleString("en-US")`, `toLocaleString("es")` y formatos dispersos en cliente y dashboard.

**Plan**

1. Crear helpers `formatDate`, `formatDateTime`, `formatTokenAmount`, `formatFiat`.
2. Usar locale activo de i18n.
3. Definir reglas para tokens, fiat y porcentajes.

**Criterio de aceptación**

- No quedan formatos hardcodeados salvo tests o fallbacks intencionales.

### P2.2 Eliminar `transition-all`

**Evidencia**

- Hay clases `transition-all` en varias pantallas.
- Las guías recomiendan transicionar propiedades específicas.

**Plan**

1. Reemplazar por `transition-colors`, `transition-transform`, `transition-opacity` o CSS específico.
2. Revisar animaciones con `prefers-reduced-motion`.

**Criterio de aceptación**

- No queda `transition-all` en UI productiva.

### P2.3 Dimensiones explícitas en imágenes

**Evidencia**

- Avatares de usuario usan `<img>` sin `width`/`height` explícitos en páginas como Home/Settings.

**Plan**

1. Añadir dimensiones o contenedores con tamaño estable.
2. Usar skeletons si se cargan imágenes remotas.

**Criterio de aceptación**

- No hay layout shift visible por avatares/imágenes.

### P2.4 Copy de producto: no prometer más que el sistema

**Plan**

1. Revisar textos públicos contra la matriz de estado.
2. Cambiar "operativo", "completo" o "listo" por lenguaje verificable si falta deploy/e2e.
3. Mantener un changelog de disponibilidad por red.

**Criterio de aceptación**

- El copy público coincide con capacidades desplegadas.

## 9. P2 - Observabilidad y operaciones

### P2.5 Logs estructurados y correlación

**Plan**

1. Añadir `requestId`, `paymentId`, `invoiceId`, `chainId`, `txHash` a logs.
2. Evitar logs de PII o secretos.
3. Crear eventos de auditoría para:
   - submit pago
   - tx enviada
   - tx confirmada/fallida
   - webhook entregado/fallido
   - recovery iniciado/ejecutado

**Criterio de aceptación**

- Se puede reconstruir un pago fallido de punta a punta sin revisar manualmente D1.

### P2.6 Alertas operativas

**Plan**

1. Alertar por:
   - cola acumulada
   - webhook delivery failures
   - tx failures por red
   - gasto paymaster anómalo
   - errores 5xx
2. Añadir runbooks breves.

**Criterio de aceptación**

- Hay responsable y acción documentada por alerta.

## 10. Secuencia recomendada de implementación

### Semana 1: seguridad y verdad operacional

1. Rotar/eliminar service account local.
2. Crear matriz de estado deploy/e2e.
3. Corregir docs contradictorios.
4. Bloquear mainnet/live cuando existan `TODO_DEPLOY` o `ZERO_ADDRESS`.
5. Decidir deploy inmediato del nuevo `PaymentRouter` o desactivar `payInvoiceWithPermit`.

### Semana 2: backend robusto

1. Helper único de errores API.
2. Migrar rutas críticas a jobs/queues.
3. Idempotencia para submits.
4. Webhooks con cola/concurrencia limitada y dead-letter.
5. Separar llaves calientes y eliminar fallbacks implícitos.
6. Tipos Wrangler generados como fuente única.
7. Tests Worker runtime mínimos.
8. Migraciones D1 prod-safe y constraints para tablas nuevas.

### Semana 3: UX y accesibilidad

1. Foco visible global.
2. Migrar navegación de botones a links.
3. Forms con labels/autocomplete/name.
4. Confirmaciones destructivas.
5. Barrido visual responsive con Playwright.

### Semana 4: contratos, performance y CI

1. Validar recovery al proponer.
2. Storage-layout gate.
3. Invariants/fuzz para router/paymaster.
4. Corregir lint warnings y hacerlo bloqueante.
5. Bundle budgets y analyzer.

## 11. Gates mínimos antes de producción con fondos reales

- Secret scan limpio.
- Sin credenciales locales en el workspace.
- `pnpm --filter server test` OK.
- Tests Worker runtime OK.
- `pnpm --filter client lint` sin warnings.
- `pnpm --filter client build` OK con presupuesto de bundle.
- `pnpm --filter dashboard build` OK.
- `forge test` OK.
- Storage layout snapshot revisado.
- Smoke test on-chain por red documentado.
- Smoke test cross-chain documentado contra direcciones oficiales.
- Disponibilidad cross-chain fail-closed ante RPC/gas desconocido.
- Webhooks con retry/dead-letter y sin flush secuencial largo en Worker.
- Sin fallbacks de llaves entre router/paymaster/relayer en entorno live.
- Migraciones productivas sin `DROP TABLE` destructivo.
- Dashboard puede rastrear cada pago por `paymentId` y `txHash`.
- Docs públicas no contradicen el estado real.

## 12. No hacer

- No esconder warnings de lint bajando reglas.
- No declarar una feature "operativa" si solo está implementada localmente.
- No usar archivos JSON de credenciales en el repo para entornos reales.
- No esperar receipts on-chain en requests públicos de pago si el flujo puede ser asíncrono.
- No reutilizar llaves entre router, paymaster, relayer y deployer en entornos live.
- No reportar una ruta cross-chain como disponible cuando el RPC/gas del relayer no pudo verificarse.
- No ejecutar migraciones destructivas contra D1 productivo.
- No añadir optimizaciones de bundle sin medición antes/después.
- No corregir accesibilidad solo con `aria-*` si el HTML semántico correcto resuelve el problema.

## 13. Observación final

El estado actual es bueno para continuar iterando: build y tests base pasan, y las piezas principales están conectadas. El salto pendiente es pasar de "funciona en el flujo feliz" a "es operable, accesible, auditable y seguro bajo fallos reales". Ese salto requiere sobre todo disciplina de despliegue, jobs asíncronos para operaciones on-chain, contratos API consistentes y un cierre serio de seguridad operacional.
