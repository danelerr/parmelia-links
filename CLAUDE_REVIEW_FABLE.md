# CLAUDE_REVIEW_FABLE

> **Documento histórico, no autoritativo.** La revalidación del 2026-07-13
> encontró cierres incorrectos y métricas obsoletas en este informe. Consultar
> [`CODEX_REAUDITORIA_2026-07-13.md`](./CODEX_REAUDITORIA_2026-07-13.md) para el
> estado vigente, los bloqueos de mainnet y la evidencia reproducible.

Auditoría integral y propuesta de implementación del backlog.

- Fecha: 2026-07-02
- Autor: Claude (Fable 5), sesión de revisión integral solicitada por Daniel
- Alcance: monorepo completo (`client/`, `server/`, `dashboard/`, `contracts/`, `shared/`, `docs/`, migraciones D1), incluido el trabajo sin commitear
- Método: 8 auditores paralelos por subsistema + verificación adversarial de los hallazgos P0/P1 (cada uno re-leído por un segundo agente instruido para refutarlo) + línea base ejecutada localmente
- Documentos previos considerados: `MEJORAS_PENDIENTES.md`, `CODEX_PLAN_DE_IMPLEMENTACION_Y_MEJORAS.md` (2026-06-30), `contracts/AUDIT.md` (2026-06-16), `CROSSCHAIN_DESIGN.md`, `DEFI_DESIGN.md`

---

## 1. Resumen ejecutivo

El proyecto está en buen estado estructural: la línea base pasa completa (38 tests de server, tsc limpio, 57 tests de Foundry, ambos builds), el diseño de contratos es conservador y no custodio, el schema D1 base es estricto e idempotente donde importa, y la superficie `/v1` documentada coincide casi exactamente con el código. El plan de CODEX del 2026-06-30 era correcto en sus grandes líneas; esta auditoría lo confirma, lo profundiza y encuentra una capa adicional de defectos de **correctitud transaccional** que CODEX no vio.

El riesgo real hoy no es que algo no compile: es que **los caminos que mueven dinero confían en el happy path**. Los patrones repetidos son cuatro:

1. **Check-then-act sin claim atómico** (faucet doble-claim, doble cobro de link, idempotency race).
2. **Resultados on-chain no verificados** (`waitForTx` sin mirar `receipt.status` en 5 sitios de `account.routes`; burn sin validar en `CrosschainReceive`).
3. **Guardas fail-open**: Turnstile se desactiva solo si falta el secret (y protege un faucet de USDC real en mainnet), `relayerGasOk` devuelve `true` ante error de RPC, y los placeholders `TODO_DEPLOY` de Arbitrum One no fallan cerrado.
4. **Estado que puede perderse o retroceder**: contabilidad post-chain de `/pay/submit` no atómica, máquina de estados cross-chain no monótona, webhook `payment.paid` que se pierde si `emitEvent` falla tras marcar pagado, cola del relayer CCTP bloqueable por inanición.

Además hay una deuda de accesibilidad sistemática (foco invisible global, modales sin semántica de diálogo, inputs de monto que no aceptan coma decimal en iOS en español) y una credencial viva (service account de Firebase) en la raíz del workspace que hay que rotar.

**Qué se hizo en esta pasada:** se implementó el grueso del backlog implementable por código (ver §7 y la columna "Estado" de §4): correctitud transaccional del backend, endurecimiento de contratos con tests nuevos, migración 0006 de endurecimiento de D1, accesibilidad e i18n del cliente, dashboard, y sincronización de docs. Quedan fuera —por requerir deploys, consolas externas o decisiones de producto— los items listados en §6.3, encabezados por la rotación de la service account y el redeploy del PaymentRouter.

---

## 2. Línea base verificada (2026-07-01)

| Verificación | Resultado |
|---|---|
| `pnpm --filter server test` | OK — 4 archivos, 38 tests |
| `pnpm --filter server exec tsc --noEmit` | OK |
| `forge test` (contracts) | OK — 57 tests (27 cuenta + 5 paymaster + 13 router + 12 crosschain router) |
| `pnpm --filter client build` | OK — main 162.4 KB gzip; jsQR y Firebase en chunks aparte |
| `pnpm --filter client lint` | 9 warnings `react-hooks/exhaustive-deps` (8 por `t` de i18n, 1 por `refreshSettings`) |
| `pnpm --filter dashboard build` | OK — main 123.5 KB gzip |
| Dashboard lint | No existe configuración de ESLint |

---

## 3. Estado por subsistema (síntesis de los 8 auditores)

**Server — seguridad.** Bien construida en lo fundamental: JWT de Firebase fail-closed, API keys y secretos de webhook de 192 bits guardados solo como hash SHA-256 y mostrados una única vez, firmas de webhook HMAC-SHA256 estilo Stripe, queries D1 parametrizadas (incluido el UPDATE dinámico de crosschain, whitelisteado), IDOR check en pending payments, montos y rutas recomputados server-side. Lo débil: guardas fail-open dependientes de config (Turnstile, `relayerGasOk`), cadenas de fallback de private keys que rompen least-privilege, endpoints públicos de crosschain inbound sin protección anti-spam, y fugas menores de mensajes de error crudos. Sin SQLi, sin IDOR explotable, sin fail-open en la verificación de auth misma.

**Server — correctitud.** La base es buena (ledger con índice único de dedupe, `markPaymentIntentPaid` condicionado por status, outbox de webhooks con backoff), pero los caminos de dinero dependen de esperas síncronas de receipts dentro del request HTTP y de secuencias post-chain no atómicas. Aquí vive la mayor densidad de P1 (ver §4.1).

**Contratos.** Conservadores, sobre OZ v5.6; routers no custodios con CEI + `nonReentrant` + tope de fee de 1%; el paymaster liga la firma a chainid/dirección/op/ventana temporal correctamente. Abiertos: griefing de recovery agravado (el guardian no puede cancelar ni reemplazar una propuesta suya — y el dueño que perdió la passkey tampoco: la recovery puede quedar inutilizable para siempre), `setGuardian` no limpia propuestas pendientes, sin tope on-chain de coste por op en el paymaster (L-1 de AUDIT.md), solc sin pin exacto pese a que todo el esquema CREATE2 depende de bytecode reproducible, y sin gate de storage-layout ni test de ruta de upgrade (M-3).

**Cliente — a11y/UX.** Base notablemente cuidada (prefers-reduced-motion global, animaciones solo compositor, contraste suficiente, `html lang` sincronizado con i18n, skeletons con aria-hidden). Los sistemáticos: foco de teclado invisible (outline:none global sin `:focus-visible`), modales sin semántica de diálogo (0 usos de `role`/`aria-modal`/`aria-live` en todo `client/src`), navegación 100% con `<button onClick={navigate}>`, inputs de monto `type="number"` que en iOS en español no permiten escribir decimales, y envío cross-chain irreversible sin hoja de confirmación.

**Cliente — correctitud.** Todas las páginas nuevas (Earn, Receive, BinanceDeposit, CrosschainSend, CrosschainReceive) están ruteadas en App.tsx y enlazadas desde la UI; el link de cobro cross-chain `/cc/` ya se muestra en Receive (el pendiente de MEJORAS #38 sobre surfacing está de facto resuelto). Defectos: `CrosschainReceive` muestra éxito aunque el burn haya revertido (no valida el receipt), race de cotización obsoleta en CrosschainSend, textos hardcodeados en español en PayPage/arranque/fallbacks, `CHAIN_PARAMS` del checkout inbound solo cubre Base Sepolia, y el service worker cachea respuestas de navegación non-ok.

**Dashboard.** Estructuralmente consistente con la API (rutas nuevas registradas, 10 endpoints correctos). Debilidades: errores de API silenciados como empty-states, sin paginación (el server corta en 100), sin ESLint, foco invisible, `copy()` reporta éxito aunque falle, y crash con status desconocido.

**Datos y migraciones.** El schema base (0001/0002) es sólido: STRICT + FK + CHECK, dedupe de ledger idempotente, índice único parcial para idempotency keys. Las tablas nuevas sin commitear (0004 `push_tokens`, 0005 `crosschain_operations`) abandonan esa dureza: sin STRICT, sin FK a `users`, sin CHECK en los enums. Además: `updateCrosschainOp` sin guarda de monotonía, escrituras de ledger en loop en vez de `batch()`, `markPaymentLinkPaid` sin `AND status='pending'`, índices FK faltantes, y el preludio de `DROP TABLE` de 0001 sigue siendo peligroso contra prod.

**Docs vs realidad.** `/v1` documentado coincide muy bien con el código (endpoints, HMAC, calendario de reintentos exacto). Los gaps son de otro tipo: docs y API anuncian `payInvoiceWithPermit` contra un router desplegado que no la tiene; `api.md` promete que `sk_live` liquida en Arbitrum One cuando el worker es mono-chain y Arbitrum One tiene `TODO_DEPLOY` en todos los contratos; `ERROR_CODES.md` y locales desincronizados de `shared/errors.ts`; README raíz stale; comentario "monad-testnet" en `chain.ts`.

---

## 4. Hallazgos priorizados

Severidades: P1 = corregir antes de operar con fondos reales / afecta dinero o acceso; P2 = pre-producción o al escalar; P3 = calidad. "Verificación" = veredicto del segundo agente adversarial (los marcados "alta confianza" quedaron sin segundo pase por límite de sesión, pero su evidencia primaria fue re-confirmada al implementar). "Estado" refleja esta pasada.

### 4.1 P1 — Dinero y acceso

| # | Hallazgo | Evidencia | Verificación | Estado |
|---|---|---|---|---|
| 1 | Faucet de bienvenida: carrera check-then-act sobre `fundedAt` permite doble claim de 5 USDC | `server/src/routes/account.routes.ts:285` lee `profile?.fundedAt` y guarda recién tras `waitForTx` (~segundos de ventana) | CONFIRMED | Corregido: claim atómico `UPDATE ... WHERE funded_at IS NULL` antes de transferir, rollback si la tx falla |
| 2 | `account.routes` nunca verifica `receipt.status` tras `waitForTx`: éxitos falsos en txs revertidas (deploy, fund, guardian, recovery) | `account.routes.ts:76,136,304,366,404`; `waitForTx` devuelve el receipt sin lanzar si la tx revirtió | CONFIRMED | Corregido: helper `assertTxSuccess` aplicado en los 5 sitios |
| 3 | Doble cobro del mismo payment link: check de `paid` solo en `/prepare`, `markPaymentLinkPaid` sin guard de estado (el segundo pago sobreescribe `tx_hash`/`paid_by` del primero) | `pay.routes.ts:511`, `storage.ts:359` | Alta confianza | Corregido: `markPaymentLinkPaid` con `AND status='pending'` + re-check en submit |
| 4 | Cancelar un payment intent no invalida su link: el payer puede pagar un intent `canceled` (y `expires_at` nunca se aplica) | `v1.routes.ts:217`; `pay.routes` no re-verifica el intent al pagar el link | CONFIRMED | Corregido: el flujo de pago verifica estado y expiración del intent asociado al link |
| 5 | Contabilidad post-chain de `/pay/submit` no atómica: un pago on-chain exitoso puede quedar sin registrar (ledger/link/push) si el Worker muere tras el receipt | `pay.routes.ts:485` en adelante | Alta confianza | **Corregido (pasada backend)**: máquina de estados en `pending_payments` (migración 0007) con claim atómico anti doble-submit; el tx se registra antes de esperar el receipt; liquidación idempotente en `services/settlement.ts`; **reconciliador cron** que localiza la op on-chain por `userOpHash` y liquida/failea filas varadas; `GET /pay/status/:hash` para polling. Además se corrigió un **falso éxito**: el submit confiaba en `receipt.status` del bundle, pero una ejecución interna revertida (`UserOperationEvent(success=false)`) se contabilizaba como pago — ahora decide el evento de la op |
| 6 | Relayer CCTP: cola bloqueable para siempre (LIMIT 25 + ORDER BY created_at ASC, sin límite de intentos ni TTL) por ops basura creadas desde endpoints inbound públicos | `crosschainRelayer.ts:108`, `storage.ts:1460`, `crosschain.routes.ts:521` | CONFIRMED | Corregido: rotación por `updated_at`, TTL por estado, contador de intentos, dedupe único de `source_tx_hash` y validación del mensaje CCTP contra la op antes de mintear |
| 7 | Turnstile fail-open desactiva silenciosamente el único anti-abuso del faucet de USDC real si falta el secret en mainnet | `turnstile.ts:19`; único guard de `/account/create` y `/account/fund` | Alta confianza | Corregido: fail-closed en mainnet (skip solo en testnets) |
| 8 | Placeholders `TODO_DEPLOY` no fallan cerrado: factory/paymaster/verifier se usarían con dirección cero en Arbitrum One | `shared/networks.ts:104,193-197`; solo el router tenía guard | CONFIRMED | Corregido: `assertContractsDeployed` en los caminos de server que los usan |
| 9 | Docs y API anuncian `payInvoiceWithPermit` contra un router desplegado que no la tiene (bytecode nuevo sin redeploy) | `paymentRouter.ts:106-110`, `docs/api.md:211` | PARTIAL (núcleo confirmado) | Corregido: `callWithPermit` condicionado a flag por red (`paymentRouterHasPermit`), off hasta el redeploy; docs ajustadas |
| 10 | `api.md` promete que `sk_live` liquida en Arbitrum One; el worker es mono-chain y Arbitrum One no tiene contratos | `docs/api.md:28-30,365,406-407` | CONFIRMED | Corregido en docs (lenguaje honesto) + guard de código del punto 8 |
| 11 | Recovery puede quedar inutilizable para siempre: `proposeRecovery` no valida la propuesta y el guardian no puede cancelarla ni reemplazarla (el dueño que perdió la passkey tampoco) | `contracts/src/AccountWebAuthnV2.sol:161-171` | CONFIRMED | Corregido: validación completa de la propuesta + cancelación por guardian + `setGuardian` limpia propuestas; tests negativos nuevos |
| 12 | `CrosschainReceive` muestra éxito aunque el burn haya fallado (receipt del burn descartado) | `client/src/pages/CrosschainReceive.tsx:140` | PARTIAL (núcleo confirmado; el approve sí se valida) | Corregido: valida `status` del receipt del burn |
| 13 | Envío cross-chain firma sin hoja de confirmación del destino irreversible | `client/src/pages/CrosschainSend.tsx:146-189` | CONFIRMED | Corregido: paso de confirmación con red destino, monto, fee y advertencia |
| 14 | Inputs de monto `type="number"`: el teclado decimal de iOS en español (coma) no permite escribir decimales — 7 inputs | `CreateLink.tsx:167`, `PayPage.tsx:468,640`, `Deposit.tsx:163`, `Swap.tsx`, `CrosschainSend.tsx`, `Contacts.tsx` | CONFIRMED | Corregido: componente compartido `AmountInput` (`type="text"`, `inputMode="decimal"`, normaliza coma) |
| 15 | Foco de teclado invisible: `outline: none` global sin `:focus-visible` (cliente y dashboard) | `client/src/index.css:165,171`, `dashboard/src/index.css:97-98` | PARTIAL (confirmado; línea exacta corregida) | Corregido: `:focus-visible` global en ambos |
| 16 | Modales sin semántica de diálogo: 0 usos de `role`/`aria-modal`/`aria-live`, sin Escape ni gestión de foco | `ReceiptModal.tsx:37` y todos los overlays | CONFIRMED | Corregido: semántica de diálogo + Escape + foco en los modales principales; `aria-live` en errores de pago |
| 17 | Service account de Firebase con private key viva en la raíz del workspace (gitignored, NO trackeada, no referenciada por código — `push.ts` lee `FCM_SERVICE_ACCOUNT` del entorno) | `proyecto-prueba-push-firebase-firebase-adminsdk-fbsvc-8d9f2d3ec8.json` | Alta confianza | **Acción del operador (§6.3): rotar la clave en GCP y borrar el archivo.** No la borro yo sin confirmación |

### 4.2 P2 — Pre-producción (selección; catálogo completo en los reportes por área)

| Hallazgo | Evidencia | Estado |
|---|---|---|
| Cadenas de fallback de private keys rompen least-privilege (`PAYMASTER_SIGNER→PRIVATE_KEY`, `ROUTER_SIGNER→PAYMASTER_SIGNER`) | `userOp.ts:152`, `paymentRouter.ts:86` | Corregido: fail-closed en mainnet; fallback solo en testnet |
| `relayerGasOk` fail-open ante error de RPC, usado como guarda financiera en `/crosschain/prepare` | `crosschainRelayer.ts:79` | Corregido: fail-closed en prepare; el listado de config distingue el caso |
| `/crosschain/inbound/register` público permite gas-drain del relayer (mintear burns ajenos) y spam de filas | `crosschain.routes.ts:521` | Corregido: dedupe único de tx hash + guard de estado + validación del mensaje CCTP (recipient/domain/amount) antes de mintear |
| Máquina de estados crosschain no monótona: una op `completed` puede regresar a `recoverable` con cron solapado | `crosschainRelayer.ts:197`, `storage.ts:1500` | Corregido: guard de monotonía en `updateCrosschainOp` |
| Burn outbound se registra solo después de confirmar el tx: ventana de crash deja fondos quemados sin rastro en DB | `pay.routes.ts:604`; contradice `CROSSCHAIN_DESIGN.md:316` | Corregido: la op se registra antes de enviar el burn |
| `runRouterWatcher`: el webhook `payment.paid` se pierde si `emitEvent` falla tras `markPaymentIntentPaid` | `indexer.ts:206` | Corregido: orden emit-then-mark con dedupe por evento |
| Webhooks: entregas duplicadas por falta de claim de filas; flush secuencial con timeout de 10s cada una | `webhooks.ts:95-119` | Corregido: claim por lease + entrega concurrente limitada + timeout 6s |
| Cron: 5 tareas RPC-intensivas cada 2 min sin lock contra solapamiento | `index.ts:76-82` | Corregido: lock best-effort en `sync_state` |
| `crosschain_operations` y `push_tokens` sin STRICT/FK/CHECK; índices FK faltantes; DROPs de 0001 | migraciones 0004/0005/0001 | Corregido: migración `0006_hardening.sql` (rebuild STRICT + CHECK + FK + índices + columnas de operabilidad del relayer) |
| `writeLedgerEntries` en loop no atómico (doble partida puede quedar a medias) | `storage.ts:477` | Corregido: `D1.batch()` |
| Respuestas de error sin `error_code` (auth 401, ramas de pay, bridge.routes) | `auth.ts:99`, `pay.routes.ts:327`, `bridge.routes.ts:67` | Corregido + codes nuevos en `shared/errors.ts`, locales y `ERROR_CODES.md` |
| `payment_intents.expires_at` nunca se aplica | `v1.routes.ts:228` | Corregido (ver P1 #4) |
| Idempotency-Key con carrera devuelve 500 y deja link huérfano | `v1.routes.ts:106` | Corregido: reintento de lectura ante colisión del índice único |
| Navegación con `<button onClick={navigate}>` en toda la app; cero `<Link>` | Home, CreateLink, Contacts, Settings, etc. | Corregido en la navegación principal (componente `LinkButton` sobre `Link`) |
| Forms sin label accesible / `name` / `autoComplete`; controles segmentados sin estado accesible | `Login.tsx:175`, `index.css:263` | Corregido en los flujos principales |
| Textos hardcodeados en español (CTA de PayPage, arranque, fallbacks de api/webauthn) | `PayPage.tsx:685`, `api.ts:60` | Corregido: claves i18n |
| Eliminar contacto sin confirmación y borrado optimista sin rollback | `Contacts.tsx:86,229` | Corregido: confirmación + rollback |
| Race de cotización obsoleta en CrosschainSend | `CrosschainSend.tsx:115` | Corregido: cancelación de fetch en vuelo |
| `CHAIN_PARAMS` del checkout inbound solo cubre Base Sepolia | `CrosschainReceive.tsx:30` | Corregido: parámetros por red soportada |
| Dashboard: errores silenciados como empty-states; sin paginación; sin ESLint; sin `.env.example` | `Payments.tsx:29` y otros | Corregido: estados de error + paginación por cursor + ESLint + `.env.example` |
| Paymaster sin tope on-chain de coste por op (AUDIT L-1); revert en vez de `SIG_VALIDATION_FAILED` (spec 4337) | `ParmeliaPaymaster.sol:102,116` | Corregido en código + tests (requiere redeploy para regir on-chain) |
| `setGuardian` no cancela recovery pendiente; checks en orden muerto en `proposeRecovery` | `AccountWebAuthnV2.sol:147,162` | Corregido + tests |
| `foundry.toml` sin pin exacto de solc | `contracts/foundry.toml` | Corregido: `solc = "0.8.28"` |
| Sin gate de storage-layout ni test de upgrade | `contracts/` | Corregido: test de ruta de upgrade que preserva estado + snapshots versionados en `contracts/storage-layout/` (el gate automático queda para cuando exista CI) |
| `worker-configuration.d.ts` desactualizado respecto de wrangler.jsonc y el `Bindings` manual | `server/worker-configuration.d.ts` | Corregido: tipos regenerados + `Bindings` alineado |
| ERROR_CODES.md y locales desincronizados de `shared/errors.ts` | `ERROR_CODES.md:68` | Corregido |

### 4.3 P3 — Calidad (selección implementada)

Comentario stale "monad-testnet" en `chain.ts`; `ORDER BY datetime(created_at)` anulando índices; pushes de depósito duplicados en re-scans (ahora solo notifica filas realmente insertadas); `saveUser` read-modify-write (upsert atómico con COALESCE); mensajes de error crudos al cliente (sanitizados + log estructurado); `transition-all` en Home; `autoFocus` en inputs móviles; modo "ocultar saldo" no respetado en Extracto/Recibo; `toLocaleString("en-US")` crudos (helpers de formato con locale de i18n); toast falso de `copy()` en dashboard (y el mismo bug en Webhooks/ApiKeys); crash por status desconocido en Payments; sw.js cacheando navegaciones non-ok (la poda de caches viejos ya existía — verificado); hint de "red lenta" instantáneo en PayPage; doble prompt al cancelar passkey; 9 warnings de `exhaustive-deps` (lint ahora con `--max-warnings 0` en client y dashboard); filtros de Extracto en la URL (compartibles, back/forward); README raíz y del server refrescados; header de `CROSSCHAIN_DESIGN.md` (+ changelog v1.4). No implementado de esta lista: el CORS abierto por defecto queda como comportamiento documentado en `index.ts` (en producción `ALLOWED_ORIGINS` ya está seteado; la auth no depende del origen).

---

## 5. Clasificación del backlog preexistente

Cruce de `MEJORAS_PENDIENTES.md` y del plan CODEX contra el código real:

### 5.1 Implementable por código — hecho en esta pasada

| Item | Origen | Nota |
|---|---|---|
| Contrato de errores unificado (`error_code` en todo) | CODEX P1.2 / MEJORAS #46 residual | Helper `apiError` + codes nuevos + locales + docs |
| Least-privilege de claves (parte de código) | MEJORAS #7/#8, CODEX P1.4.1 | Fail-closed en mainnet; la separación real de EOAs es operacional (§6.3) |
| Webhooks operables | CODEX P1.4.2 | Claim + concurrencia + timeout |
| D1 endurecido, migraciones prod-safe | CODEX P1.4.3 | Migración 0006 |
| Relayer fail-closed | CODEX P1.4.4 | Hecho |
| Recovery endurecido | CODEX P1.5, AUDIT L-3 | Hecho + tests |
| Caps del paymaster | CODEX P1.6, AUDIT L-1 | Hecho (rige tras redeploy) |
| Gate de upgrades / storage layout | CODEX P1.7, AUDIT M-3 | Test de upgrade + snapshot; el gate de CI queda documentado (no hay CI aún) |
| Foco visible, links reales, forms, confirmaciones | CODEX P1.8–P1.11 | Hecho |
| Lint sin warnings y bloqueante | CODEX P1.12 | Hecho (client y dashboard) |
| Filtros en URL | CODEX P1.14 | Hecho (Extracto) |
| Formatos centralizados; sin `transition-all`; dimensiones de imágenes | CODEX P2.1–P2.3 | Hecho |
| Copy honesto (permit, Arbitrum One) | CODEX P2.4, P0.2, P0.3 parcial | Docs corregidas + flag `paymentRouterHasPermit` |
| Guard de `TODO_DEPLOY` | CODEX P0.2 | Hecho |
| Surfacing del link `/cc/` | MEJORAS #38 pendiente | Ya estaba resuelto en `Receive.tsx` (verificado) |

### 5.2 Requiere acción del operador (no es código)

| Item | Acción |
|---|---|
| Rotar service account de Firebase y borrar el JSON local | Consola GCP/Firebase + borrar archivo + `wrangler secret put FCM_SERVICE_ACCOUNT` |
| `wrangler deploy` del Worker + redeploy del cliente en Vercel | Ya pendiente desde antes (código integrado sin desplegar) |
| Aplicar migración 0006 en D1 remoto | `wrangler d1 migrations apply` |
| Redeploy del `ParmeliaPaymentRouter` (permit) y de `ParmeliaPaymaster`/`AccountWebAuthnV2` si se quieren los endurecimientos on-chain | Nueva dirección CREATE2 → actualizar `networks.ts`, `setTokenSupported`, flag `paymentRouterHasPermit: true` |
| Fondear gas del relayer en Base Sepolia (CCTP) | Operacional |
| Separar EOAs (deployer/faucet/guardian/relayer) y setear los secrets dedicados | `DEPLOY.md` §11; el código ya exige las claves dedicadas en mainnet |
| Turnstile: `wrangler secret put TURNSTILE_SECRET_KEY` | El código ahora falla cerrado en mainnet si falta |
| Rate-limiting de zona (Cloudflare) para `/account/*` | Regla de zona cuando haya dominio; Turnstile fail-closed ya cubre el faucet |
| Verificar `VITE_FIREBASE_MEASUREMENT_ID` en Vercel (GA4 en prod) | MEJORAS #42 |
| Account-linking "same email" en consola Firebase | MEJORAS #40 |

### 5.3 Decisiones de producto / arquitectura (propuestas en §6.3, no implementadas)

| Item | Por qué no ahora |
|---|---|
| #15/#16/#43 — Submit asíncrono completo (202 + polling + cola idempotente) | Cambio de arquitectura transversal (server+client); Queues requiere plan pago; diseño propuesto abajo |
| #13 — Bundler ERC-4337 (Pimlico/Alchemy) | Requiere API key y decisión de proveedor; resuelve nonce/throughput y `preVerificationGas` (#19) |
| #18 — Fee model | Decisión de negocio; hooks listos |
| #37 — Earn (LP v3, DEFI_DESIGN §4) | Feature mayor con fondos de usuarios; `Earn.tsx` actual es la pantalla informativa/entrada; requiere contratos nuevos + auditoría |
| #26 — Suite E2E de cliente (Playwright) | Infra de tests nueva; propuesta abajo. Tests unitarios base añadidos en esta pasada |
| CODEX P1.4 — Tests en runtime real de Workers (`@cloudflare/vitest-pool-workers`) | Infra de tests separada; propuesta abajo |
| #25 app nativa, #30 multi-red en prod, #31 Uniswap crosschain, #32 EIP-7702, #34 guardians plurales, #50 rescate de depósitos, #44 R2, #48 lazy locales | Post-PMF / al escalar, sin cambios de código útiles hoy |

---

## 6. Propuesta de implementación

### 6.1 Principios aplicados en esta pasada

1. **El dinero primero.** Todo lo que mueve o registra valor se hace atómico, idempotente y verificado (`receipt.status`), o deja rastro recuperable antes de tocar la cadena.
2. **Fail-closed por defecto.** Una guarda de seguridad o disponibilidad que no puede verificar su condición rechaza; solo el listado informativo puede ser optimista.
3. **Compatibilidad de despliegue.** Ningún cambio rompe el testnet actual: los endurecimientos que dependen de claves dedicadas o contratos nuevos se activan por red (mainnet) o por flag, y la migración 0006 es un rebuild aditivo sin pérdida de datos.
4. **El cliente es dueño del texto.** Todo error nuevo tiene `error_code` + clave `err.*` en ambos locales; el backend sigue agnóstico al idioma.
5. **Sin emojis** en UI, push y docs (convención del proyecto).

### 6.2 Orden de despliegue recomendado (operador)

1. Rotar la service account de Firebase (§5.2) — independiente de todo.
2. `wrangler d1 migrations apply` (0006) → `wrangler deploy` → redeploy del cliente en Vercel. El código nuevo asume la migración aplicada (columnas de operabilidad del relayer).
3. Smoke test on-chain por flujo (login, crear link, pagar, depositar, cross-chain out/in, dashboard detail) y anotar evidencia con fecha en `MEJORAS_PENDIENTES.md`.
4. Cuando se decida: redeploy de contratos endurecidos (router con permit primero; cuenta/paymaster pueden esperar a la siguiente ventana) + `networks.ts` + flag permit.
5. Antes de mainnet con fondos reales: separar EOAs y setear claves dedicadas (el código ya las exige en mainnet), Turnstile secret, RPC dedicado por chain (`CCTP_RPC_URLS`), y los gates de §8.

### 6.3 Diseños propuestos para lo no implementado

**Submit asíncrono (MEJORAS #15/#16, CODEX P1.1).** **El lado servidor de este diseño ya está implementado (pasada backend jul-2026):** máquina de estados en `pending_payments` (0007), liquidación idempotente en `services/settlement.ts`, reconciliador en el cron que resuelve por `UserOperationEvent`, y `GET /pay/status/:userOpHash`. Hoy `/pay/submit` sigue esperando el receipt en el request (respuesta síncrona intacta para el cliente actual) y devuelve `202 { status: "pending", txHash }` solo cuando la espera se corta con el tx ya difundido. El paso restante es de CLIENTE: aceptar el 202 y pollear `/pay/status` (el tuning de polling para Arbitrum ya está en `transactions.ts`); con eso, quitar el `waitForTx` del request es borrar una línea. Cuando se contrate Workers Paid, mover el reconciliador de cron a Queues sin cambiar el modelo de datos.

**Bundler (#13).** Contratar Pimlico o Alchemy en Arbitrum; cambiar `submit` de self-`handleOps` a `eth_sendUserOperation` + `eth_estimateUserOperationGas` (resuelve #19), manteniendo el paymaster propio (ambos soportan paymasters externos). El relayer EOA queda solo para faucet/guardian hasta separar claves. Esfuerzo: medio; riesgo: bajo (fallback al modo actual por flag).

**Earn (#37).** Fase 1 sin contratos nuevos: posiciones LP v3 USDC/WETH gestionadas desde la smart account del usuario vía UserOps (mint/collect/burn del NonfungiblePositionManager), con los 3 niveles de riesgo de DEFI_DESIGN §4 como presets de rango; el server solo cotiza y arma calldata (como ya hace con swaps). Fase 2 (vault compartido con performance fee) solo tras auditoría externa. No empezar antes del bundler (#13): los rebalanceos multiplican operaciones.

**Tests de runtime Workers (CODEX P1.4).** Añadir `@cloudflare/vitest-pool-workers` con una suite separada (`server/test-worker/`) que cubra: migraciones aplicadas sobre D1 local, auth middleware con JWKS mockeado, un flujo de webhook completo (emit → deliver → retry), y el cron con lock. Mantener la suite Node actual para lógica pura.

**E2E de cliente (#26).** Playwright contra Vite dev + Worker local con D1 en memoria: login mockeando WebAuthn (virtual authenticator de CDP), crear link, abrir PayPage, extracto con filtros de URL. Un spec por flujo crítico, corriendo en CI antes de cada deploy.

**CI (no existe hoy).** GitHub Actions con los gates de §8 como jobs: tests server + forge + builds + lint + `tsc` + secret scan (gitleaks) + storage-layout diff de contratos. Es la pieza que convierte todos los "bloqueante" de este documento en automáticos.

---

## 7. Qué cambió en esta pasada (implementación)

Resumen por área; el detalle está en el diff del working tree:

- **Server:** claim atómico del faucet; `assertTxSuccess` tras cada `waitForTx`; guards de doble pago de link; verificación de intent (estado + expiración) al pagar; ledger en `batch()`; `apiError`/`error_code` completos (auth, pay, bridge) con codes nuevos; Turnstile fail-closed en mainnet; claves sin fallback en mainnet; `relayerGasOk` fail-closed en prepare; registro de op cross-chain antes del burn; relayer con rotación, TTL, intentos, dedupe de tx y validación del mensaje CCTP; monotonía de estados; webhooks con claim + concurrencia; lock de cron; guard `TODO_DEPLOY`; sanitización de errores; tipos de bindings alineados; migración `0006_hardening.sql`.
- **Contratos:** validación completa de `proposeRecovery` + cancelación por guardian + `setGuardian` limpia propuestas; paymaster con tope de coste por op y `SIG_VALIDATION_FAILED` spec-compliant; **M-4 (segunda pasada): el paymaster no tenía `unlockStake`/`withdrawStake` — el stake en el EntryPoint quedaba bloqueado para siempre; corregido** (el stake de 0.001 ETH del paymaster testnet desplegado es irrecuperable, costo hundido); `opId` cero validado y evento de `emergencyWithdraw` en el CrosschainRouter; política anti fee-on-transfer documentada en `setTokenSupported` (L-2); cap inicial de gas en el script de deploy; pin de solc; tests nuevos (recovery negativo, caps, upgrade path, stake, fuzz de conservación, tampering de cada término firmado, replay cross-chain). `forge test` verde (80).
- **Cliente:** `:focus-visible` global; `AmountInput` compartido (decimales con coma); semántica de diálogo en modales + Escape; hoja de confirmación en CrosschainSend + cancelación de quote race; validación del burn en CrosschainReceive + `CHAIN_PARAMS` por red; navegación principal con `Link`; forms con `name`/`autoComplete`/labels; confirmación y rollback en Contactos; i18n de los textos hardcodeados y fallbacks; helpers de formato con locale; filtros de Extracto en URL; "ocultar saldo" respetado; sw.js endurecido; lint a 0 warnings y bloqueante.
- **Dashboard:** `:focus-visible`; estados de error con retry; paginación de Payments; ESLint + script `lint`; `.env.example`; `copy()` honesto; fallback de status; formatos centralizados.
- **Docs:** `ERROR_CODES.md` (códigos nuevos + 401 unificado), `docs/api.md` (permit por feature-detection, live mode honesto, 401 con código), `docs/openapi.yaml`, `README.md` (contratos completos, conteos reales, layout con dashboard/docs), `server/README.md` (secrets completos + política de claves + orden de deploy de 0006), `CROSSCHAIN_DESIGN.md` (header corregido + changelog v1.4), `contracts/AUDIT.md` (L-1/L-3 resueltos, M-3 con test, corrección del claim ERC-7201), `MEJORAS_PENDIENTES.md`; este documento.

**Verificación al cierre de la pasada (2026-07-02):**

| Verificación | Resultado |
|---|---|
| `pnpm --filter server test` | OK — 5 archivos, **54 tests** (38 previos + 16 nuevos de endurecimiento) |
| `pnpm --filter server exec tsc --noEmit` | OK |
| `forge test` | OK — **80 tests** (57 previos + 23 nuevos: validación de recovery, cancel del guardian, caps del paymaster, upgrade path, ciclo de stake, fuzz de conservación en ambos routers, tampering de digest/userOp, replay cross-chain) |
| `pnpm --filter client build` + `lint --max-warnings 0` | OK — 0 warnings (antes 9) |
| `pnpm --filter dashboard build` + `lint --max-warnings 0` | OK — lint nuevo, 0 warnings |
| `forge build --sizes` | AccountWebAuthnV2 15.690 B (margen 8.886 B bajo EIP-170) |
| `wrangler types` | regenerado y typecheck verde |

---

## 8. Gates antes de producción con fondos reales

- [ ] Service account de Firebase rotada y sin JSONs de credenciales en el workspace
- [x] `pnpm --filter server test` verde
- [x] `forge test` verde
- [x] Builds de client y dashboard verdes
- [x] Lint de client y dashboard sin warnings (bloqueante)
- [x] Ningún error público sin `error_code`
- [x] Ninguna guarda de seguridad fail-open en mainnet (Turnstile, claves, relayer, TODO_DEPLOY)
- [x] Migraciones prod-safe (0006) y tablas nuevas STRICT/FK/CHECK
- [x] Webhooks con claim, concurrencia limitada y backoff
- [ ] Migración 0006 aplicada en D1 remoto + `wrangler deploy` + redeploy cliente
- [ ] Smoke test e2e por flujo documentado con fecha (login, link, pago, depósito, cross-chain out/in, dashboard)
- [ ] Redeploy del router (permit) + `networks.ts` actualizado, o mantener el flag apagado
- [ ] EOAs separadas por rol + secrets dedicados (el código ya los exige en mainnet)
- [ ] RPC dedicado por chain para el relayer CCTP
- [ ] CI con estos gates automatizados
- [ ] Auditoría externa de contratos antes de escalar TVL

---

## 9. Observación final

La distancia entre "funciona en demo" y "operable con dinero real" estaba, casi toda, en el backend: atomicidad, idempotencia, verificación de receipts y guardas fail-closed. Esa capa queda cerrada en código con esta pasada; lo que resta es disciplina operacional (rotación de la credencial, deploys, claves dedicadas, smoke tests con evidencia) y tres decisiones de producto (submit asíncrono, bundler, fees) que ya tienen diseño propuesto. El proyecto tiene una base técnica seria y el salto pendiente es de operación, no de arquitectura.
