# Mejoras Pendientes (Backlog Técnico)

> Backlog de mejoras **identificadas pero no implementadas todavía**, para retomarlas
> después. Lo ya hecho está al final como referencia.
> Estado: junio 2026 (migrando a Arbitrum). Convenciones de prioridad:
> **P0** = bloquea el lanzamiento en Arbitrum · **P1** = pre-producción ·
> **P2** = al escalar · **Futuro** = post-PMF / opcional.
>
> **Nota de precedencia (14-jul-2026):** este backlog conserva contexto
> histórico. El estado verificado y los pendientes vigentes están en
> `CODEX_REAUDITORIA_2026-07-13.md`.

> **Pendiente de promover (código ya integrado):** configurar branch protection
> y el environment `worker-testnet`, y ejecutar `deploy-worker.yml`. Ese workflow
> verifica el artefacto CI, respalda D1, aplica la migración 0011 y despliega el
> Worker sin recompilar; si readiness falla, revierte el Worker automáticamente.
> También falta promover cliente/dashboard en Vercel,
> fondear gas del relayer en **Base Sepolia** y revocar/rotar en GCP la service
> account de Firebase retirada. El JSON local ya fue eliminado; eso no revoca la
> credencial en el proveedor.
>
> **Pasada de endurecimiento jul-2026 (Claude Fable):** auditoría integral +
> implementación del backlog implementable por código. Detalle, prioridades y lo
> que sigue: **`CLAUDE_REVIEW_FABLE.md`**. Resumen: correctitud transaccional del
> backend (faucet atómico, receipts verificados, doble-pago de links, expiración
> de intents, webhooks con claim, cron con lock, relayer CCTP con validación de
> mensaje/TTL/intentos, fail-closed de Turnstile/claves/gas/TODO_DEPLOY,
> migración 0006 STRICT+FK+CHECK), contratos (validación de recovery + cancel
> del guardian, cap de gas del paymaster, SIG_VALIDATION_FAILED, solc pineado,
> test de upgrade, snapshots de storage layout — **requieren redeploy**), cliente
> (focus-visible, diálogos accesibles, AmountInput decimal-coma, confirmación
> cross-chain, navegación con Link, i18n de restos, filtros en URL, lint 0
> bloqueante) y dashboard (estados de error, paginación, ESLint). Segunda pasada
> de contratos: **M-4 stake irrecuperable del paymaster** (sin
> `unlockStake`/`withdrawStake`) encontrado y resuelto, `opId` validado en el
> CrosschainRouter, fuzz de conservación + tampering en routers y paymaster, cap
> de gas en el script de deploy. Tercera pasada (backend, cierre): **bug de
> falso éxito corregido** (el submit confiaba en `receipt.status` del bundle; una
> ejecución interna revertida se contabilizaba como pago — ahora decide el
> `UserOperationEvent`), máquina de estados de `pending_payments` con claim
> atómico anti doble-submit (migración **0007**, aplicarla antes del deploy),
> liquidación extraída a `services/settlement.ts` (idempotente) + **reconciliador
> cron** para pagos varados por muerte del Worker, `GET /pay/status/:hash` y
> `GET /crosschain/status/:opId` para polling (cubre el #15 del lado servidor),
> rate limiting D1 en `/account/create|fund` y `/crosschain/inbound/*`
> (`RATE_LIMITED` 429), warning de CORS abierto en mainnet, `.dev.vars.example`
> completo. Tests: server 38→59, contratos 57→80.

---

## P0 - Pasos para correr en Arbitrum (100% Completado)

La app ya está operativa en Arbitrum Sepolia.

| # | Tarea | Notas |
|---|---|---|
| 1 | ~~**Desplegar contratos V2 en Arbitrum**~~ | ✅ Hecho (desplegados con CREATE2). |
| 2 | ~~**Rellenar direcciones** en `shared/networks.ts`~~ | ✅ Hecho (registradas verifier, factory y paymaster). |
| 3 | ~~**Confirmar USDC de Arbitrum Sepolia**~~ | ✅ Hecho (Circle USDC `0x75fa...` configurado). |
| 4 | ~~**Aplicar migración D1 en remoto**~~ | ✅ Hecho (aplicada migración v2 consolidada). |
| 5 | ~~**Configurar secrets del Worker**~~ | ✅ Hecho (claves de API y de firma configuradas). |
| 6 | ~~Verificar EntryPoint v0.9 (`0x433709...09`)~~ | ✅ Hecho (confirmado en Arbiscan). |

---

## P1 - Endurecer pre-producción

| # | Tarea | Impacto | Esfuerzo |
|---|---|---|---|
| 7 | ~~**Least-privilege adicional**: separar faucet de relayer~~ | ✅ `FAUCET_PRIVATE_KEY` dedicada, lease de nonce propio, exclusión correcta del indexer y colisiones bloqueadas en mainnet. | - |
| 8 | ~~**Guardian fuera de la clave caliente**~~ | ✅ Clave dedicada obligatoria y distinta en mainnet; para alto valor queda multisig/MPC/HSM. | Operativo |
| 9 | ~~**Rate limiting in-Worker**~~ | ✅ Turnstile + límites D1 fail-closed; falta sólo la regla de zona Cloudflare cuando haya dominio propio. | Operativo |
| 10 | ~~Setear `ALLOWED_ORIGINS`~~ | ✅ Hecho: allowlist en `wrangler.jsonc` (parmelia.me + www + localhost). Agregar dominios de preview si se usan. | - |
| 11 | ~~Label humano del passkey~~ | ✅ Hecho: `createPasskey(uid, label)` - el diálogo del SO muestra email/nombre; el `uid` sigue siendo el id estable. | - |
| 12 | ~~Fallback `"parmelia-user"`~~ | ✅ Hecho: sin uid se corta con error de sesión en vez de un id compartido. | - |

---

## P2 - Al escalar (volumen real)

| # | Tarea | Por qué | Notas |
|---|---|---|---|
| 13 | **Migrar a un bundler ERC-4337 (Pimlico/Alchemy/Stackup)** | Resuelve el **cuello de botella del relayer único** (nonce/throughput), da **batching automático** y **estimación de gas L2 correcta** | Mantener el paymaster propio; cambia el `submit` de self-`handleOps` a `eth_sendUserOperation`. Requiere API key. |
| 14 | ~~Indexer para historial~~ | ✅ Resuelto **Cloudflare-nativo** (sin Ponder/hosting): tabla `ledger` en D1 escrita al relayar (la app conoce todo lo que pasa por ella, ambos lados si es interno) + **cron indexer** (`services/indexer.ts`, cada 2 min) que ingiere solo transferencias ERC-20 **entrantes externas** con cursor en `sync_state`. `/user/transactions` lee solo D1. `history.ts` eliminado. | Límite conocido: depósitos externos de ETH nativo no emiten logs (Across entrega USDC); sharding del filtro `to` al pasar miles de wallets. |
| 15 | ~~**`waitForReceipt` async completo**~~ | ✅ Resuelto | `/pay/submit` y cuenta/faucet/recovery responden 202; cliente pollea estado y los cron reconciliadores finalizan de forma durable. |
| 16 | ~~**Cola idempotente para pagos**~~ | ✅ Resuelto sin Queue obligatoria | D1 conserva la máquina de estados, tx/userOp, claims y outbox; el cron reconcilia operaciones varadas y las escrituras de ledger son idempotentes. |
| 17 | ~~Caché de balance/historial~~ | ✅ Resuelto de raíz por #14: el historial ya no toca RPC/explorer en el request (solo D1). El balance sigue on-chain (barato, 2-4 eth_call). | - |

---

## Económico (cuando se decida cobrar)

| # | Tarea | Notas |
|---|---|---|
| 18 | **Fee model** vía paymaster | El **hook ya está listo** en `postOp` del `ParmeliaPaymaster`. Opciones: (a) descontar un fee USDC en el `execute` del UserOp (no-custodial), o (b) token paymaster que deduce en `postOp`. |
| 19 | **`preVerificationGas` correcto en Arbitrum** (cubrir dato L1) | Idealmente viene del bundler (#13). Hoy es un valor fijo. |

---

## Datos (opcionales, bajo valor/riesgo)

| # | Tarea | Por qué no se hizo ya |
|---|---|---|
| 20 | ~~`CHECK (currency ...)` en `payment_links`~~ | ❌ Descartado: la whitelist de monedas ahora es **config por red** (`shared/networks.ts`, incluye WBTC) - un CHECK fijo en la DB pelearía con la config. La validación server-side (`normalizeCurrency` + whitelist) es la fuente de verdad. |
| 21 | Normalizar direcciones a minúscula | Cambio de comportamiento; las comparaciones críticas ya hacen `lowercase`. |
| 22 | `amount` como entero raw (smallest unit) | El string decimal está bien; raw habilitaría `SUM()` en SQL pero es cambio mayor (YAGNI). |
| 23 | ~~Tabla ledger unificada~~ | ✅ Hecho (migración `0005_rebuild_v2`, esquema v2 con datos de testnet reseteados): `ledger` + `sync_state`, `users` con wallet única lowercase + `referral_code`, `pending_payments.meta`, `swap_quotes.status='executed'`. `sent_transactions` absorbida. |

---

## Frontend / Producto

| # | Tarea | Notas |
|---|---|---|
| 24 | ~~PWA instalable~~ | ✅ Hecho: manifest + service worker (shell cache-first para assets, network-first para navegación; la API jamás se cachea) + registro solo en prod + **iconos PNG 192/512/maskable + apple-touch-icon 180px** (generados del SVG de marca) + meta tags iOS. Push notifications ya implementadas (#41). |
| 25 | **App nativa (Expo/React Native)** | Post-PMF, enfocada al comerciante. Mismo RP ID de passkeys + push. Las skills de RN ya están instaladas. |
| 26 | **Tests de cliente / E2E** | Hoy el cliente no tiene tests. |
| 27 | ~~Comprobantes detallados~~ | ✅ Hecho: fecha, hora y N° de comprobante (tx hash) en el bloque inferior del modal (`ReceiptModal`) y en `PaymentStatus`. |
| 28 | ~~Pantalla de extractos y filtros temporales~~ | ✅ Hecho: Home compacto ("Actividad reciente", 5 + "Ver extracto completo") y página `/extractos` con rangos rápidos (semana/mes/2 meses), rango personalizado, filtro por moneda y por tipo (enviados/recibidos/cobros por link - campo `kind` del server). |
| 29 | ~~Contactos e invitaciones~~ | ✅ Hecho: página `/contactos` (agregar por usuario, pagar en un toque, eliminar), invitación con `?ref=` + contador de invitados (migración 0004, `/contacts/*`, atribución en `/account/create`). Entrada en Ajustes. |
| 45 | ~~i18n cliente (ES/EN)~~ | ✅ Hecho: `react-i18next` + detector (ES si el navegador es español, EN para cualquier otro idioma; fallback EN), selector en Ajustes persistido en `localStorage:parmelia:lang`, ~250 strings en `client/src/locales/{es,en}.json`. Fechas usan `i18n.resolvedLanguage`. SW precachea el shell. |
| 46 | ~~i18n de errores del backend (contrato de `error_code`)~~ | ✅ Hecho (Opción A, todas las rutas). Códigos canónicos en `shared/errors.ts` (`ERR.*`, ~45 códigos); cada respuesta de error lleva `error_code` además del `error` humano (back-compat: sin code, el cliente cae al texto). **Cliente:** `ApiError.code` (`api.ts`); `humanizeError` prefiere `t("err."+code)` con el mensaje del server como `defaultValue` → **cubre toda la app** vía `notifyError`; PayPage igual para el error inline; claves `err.*` en `locales/{es,en}.json`. **Server cableado:** `pay`, `swap`, `account`, `links`, `contacts`, `bridge`, `user.routes.ts` + handler global en `index.ts` (`SERVER_ERROR`). El backend queda agnóstico al idioma; el cliente es el único dueño del texto (UI + errores en un solo sistema i18n). **Se descartó la Opción B** (header `Accept-Language` + i18n en el server) para no duplicar el sistema de idioma. **Estándares HTTP/REST:** `shared/errors.ts` documentado y agrupado por clase de status, con mapa canónico `ERROR_HTTP_STATUS` (código→status); se corrigieron 4 violaciones REST (estados de conflicto de recurso 400→**409**: `LINK_ALREADY_PAID`, `RECOVERY_IN_PROGRESS/NONE/NOT_READY`); referencia en **`ERROR_CODES.md`**; test `server/test/errors.test.ts` impide códigos sin status. Verificado: server `tsc` 0, 38 tests, client build OK. |
| 47 | ~~jsQR como import dinámico (fallback)~~ | ✅ Hecho: `jsQR` (~47 KB gzip) ya **no va en el chunk de `/escanear`**; se carga con `import("jsqr")` cacheado **solo** cuando el navegador no tiene `BarcodeDetector` nativo. La pantalla de escaneo bajó de ~51 KB gzip a **~3.8 KB**; el resto (130 KB) queda en un chunk `jsQR-*.js` aparte. La cámara (`getUserMedia` + loop) es independiente, no se afectó. |
| 48 | **Lazy-load de locales i18n** | ⚠️ Opcional, **solo si crecen los idiomas**. Hoy `es.json` + `en.json` (~6 KB gzip del idioma no usado) van embebidos en el bundle principal. A 2 idiomas no vale la pena; con muchos, cargar solo el activo vía `import()` dinámico por idioma (o `i18next-http-backend`). |

---

## Plataforma - Firebase y Cloudflare (evaluado jun-2026)

> Clave: el método de login es independiente de las passkeys (estas viven en el
> gestor del SO: Google Password Manager en Android, Llavero de iCloud en
> iPhone). Cambiar/añadir login NO afecta la custodia. El server solo verifica
> el JWT de Firebase → añadir proveedores = cero cambios de backend.

| # | Tarea | Plataforma | Notas |
|---|---|---|---|
| 39 | ~~Turnstile en create/fund~~ | Cloudflare | ✅ Hecho. `services/turnstile.ts` + verificación en `/account/create` y `/account/fund`; widget `components/Turnstile.tsx` (Managed) en Onboarding y faucet. Falta del lado consola: `wrangler secret put TURNSTILE_SECRET_KEY` (site key ya en `client/.env`). Feature-flag: sin secret, se omite. |
| 40 | ~~Login Email link~~ | Firebase | ✅ Magic link implementado (Login: "Continuar con correo" → enlace → vuelve a `/login` y completa; pantalla "revisa tu correo" + fallback "confirma tu correo" en otro dispositivo). Server sin cambios. **Pendiente consola:** confirmar account-linking "same email". **Apple: descartado** (código eliminado del cliente; login = Google + magic link). |
| 41 | ~~FCM push "te pagaron"~~ | Firebase | ✅ **En vivo.** `push_token` en D1 (migración 0002), `services/push.ts` (OAuth2 service-account vía jose → FCM HTTP v1), disparos en `/pay/submit` (interno), indexer (depósito externo, verificado con MetaMask→Parmelia) y **`runRecoveryWatcher`** (aviso de seguridad ante `RecoveryProposed`, mitiga M-1: el dueño puede cancelar dentro de las 48h). Cliente: `lib/push.ts` + opt-in en Ajustes + handlers `push`/`notificationclick` en `sw.js`. Limpieza de tokens muertos (404/UNREGISTERED) automática (solo poda en 404, nunca en errores transitorios). iOS solo con PWA instalada. **Multi-dispositivo:** ✅ tabla `push_tokens` (migración 0004, una fila por dispositivo, `ON CONFLICT` mueve el token si cambia de cuenta); `notifyUser` hace fan-out en paralelo a todos los dispositivos del usuario. |
| 42 | ~~Analytics (GA4)~~ | Firebase | ✅ **En vivo.** `lib/analytics.ts` + `initAnalytics()` en `App.tsx` + 5 eventos cableados (`wallet_created`, `link_created`, `payment_sent`, `swap_completed`, `invite_shared`). Measurement ID configurado. **Verificar:** que `VITE_FIREBASE_MEASUREMENT_ID` esté también en Vercel (no solo `.env` local) para que producción reporte. |
| 43 | **Queues** para submit asíncrono | Cloudflare (Workers Paid $5/m) | NO implementado por decisión: requiere plan pago. Retomar al pasar a mainnet (junto a #15/#16). |
| 44 | **R2** para avatares/archivos | Cloudflare | Cuando exista la feature. |
| - | **Descartados a propósito** (simplicidad) | - | Firestore/RTDB (ya hay D1), Cloud Functions (ya hay Workers), Durable Objects (innecesario tras bundler #13), Privy, Workers AI. |

---

## Futuro / investigación

| # | Tarea | Notas |
|---|---|---|
| 30 | **Multi-red en producción** | La portabilidad ya está lista (config por red). Elegir red(es) de settlement por fees/liquidez de USDC. **Evaluación Avalanche (jul-2026): NO migrar.** Sus dos ventajas citadas se evaporan al inspeccionarlas (CCTP v2 Fast está igual en Arbitrum — el módulo propio ya corre sobre él; fees: ambas sub-centavo, ruido vs el costo de migrar) y Avalanche recién activó P256 (ACP-204, nov-2025, 6.900 gas vs 3.450 de RIP-7212 en Arbitrum) mientras su liquidez Uniswap/Aave es más fina. Regla de decisión: migrar solo con (1) ventaja de NEGOCIO concreta (grant/partnership/usuarios), (2) target con CCTP v2 + precompile P256 + profundidad Aave/Uniswap + EntryPoint canónico, (3) transición corriendo ambas redes, nunca corte duro. La arquitectura config-driven es el seguro: ejercerlo por negocio, no por spec-sheet. |
| 31 | **Uniswap crosschain / pagos multi-activo** | Post-PMF. UUPS permite agregarlo **sin cambiar direcciones de wallet**. |
| 32 | **EIP-7702** (EOAs que delegan a contratos) | Complementario a 4337; no urgente para el modelo de passkeys. |
| 33 | **Compresión de calldata** | ⚠️ **No recomendado** salvo que se mida como techo real: forzaría forkear el verifier auditado de OZ (alto riesgo). Post-blobs en Arbitrum el beneficio es chico. |
| 34 | **Descentralizar el guardian** (guardians plurales / social recovery) | Evolución de #8. |
| 50 | **Rescate de depósitos mal dirigidos** | Si alguien manda USDC a la dirección de un usuario en **otra red** (sin checkout/CCTP), queda varado ahí. **Recuperable SI la smart account puede reproducirse y controlarse en esa red** (CREATE2 determinista: desplegar la cuenta ahí + bridge); hoy es manual y no automático. Futuro: watcher que detecte y recupere vía CCTP. Detalle en `CROSSCHAIN_DESIGN.md` §12. Soporte/seguro, no core. |

---

## Funcionalidades de Negocio y Tokens Pendientes (100% Arbitrum)

| # | Tarea | Notas |
|---|---|---|
| 35 | ~~Soporte de Tokens Adicionales~~ | ✅ Hecho: **WBTC** (8 dec, `0x2f2a...5B0f`) whitelisted en `shared/networks.ts` (Arbitrum One); selector de saldo en Home, pagos/links genéricos por whitelist (server), balance en `/user/balance`. WETH es interno (wrap de rutas), no se muestra al usuario. Sin WBTC canónico en Sepolia (omitido a propósito). |
| 36 | ~~Intercambios Nativos (Swaps)~~ | ✅ Hecho: `/swap/quote` + `/swap/prepare` (quoters v3+v4 on-chain, Universal Router, fees con hard cap 1%), página `/cambiar` con confirmación passkey. Pendiente: smoke test on-chain tras el deploy P0. |
| 37 | ~~Modo Ahorro / Rendimiento (Earn en Arbitrum)~~ | ✅ **IMPLEMENTADO (2026-07-03)** según `DEFI_DESIGN.md` v2.0: Aave v3 supply de USDC directo desde la smart account (cero contratos nuevos, cero custodia, fee 0). Direcciones verificadas contra el aave-address-book (el reserve de Sepolia usa el mismo Circle USDC de Parmelia → probable en testnet). Server: `services/earn.ts` + `/earn/{config,prepare}` + settlement `EARN_*` + migración `0008` (ledger kind `earn`) + 8 tests. Cliente: `Earn.tsx` producto completo ("Ahorro") + i18n + `savings` en balance. **Pendiente (operador):** promoción verificada y smoke e2e autenticado con el faucet de Aave. |
| 38 | **Depósitos y Retiros Cross-Chain** | 🟢 **Flow B (enviar) y Flow A (recibir) completos** (CCTP v2 directo, USDC-only), código integrado y verificado. Diseño en `CROSSCHAIN_DESIGN.md`. **Flow B outbound:** contrato `ParmeliaCrosschainRouter` desplegado (`0x0816…D777`) + 12 tests; relayer; rutas `/crosschain/{config,quote,prepare}` + rama submit; `CrosschainSend` (`/crosschain`) — **probado e2e** (Arbitrum→Base). **Flow A inbound:** rutas públicas `/crosschain/inbound/{config,prepare,register,status}` (el pagador externo llama directo al TokenMessenger de CCTP, sin nuestro router); relayer maneja inbound (mint en Arbitrum, lo acredita el indexer); checkout público `CrosschainReceive` (`/cc/:recipient`, wallet externa vía `window.ethereum`, sin viem). El link `/cc/<username>` ya se muestra con acciones de copiar y compartir en la pantalla Recibir. Storage `crosschain_operations` (migración 0005 aplicada ✅). **Pendiente:** deploy mediante `deploy-worker.yml`, promoción del cliente y gas del relayer por red destino. Across queda como fallback/benchmark (sigue en endpoint legacy). |
| 49 | ~~**`payInvoiceWithPermit` (EIP-2612)**~~ | ✅ **Implementado** en `ParmeliaPaymentRouter` (`_settle` factorizado + `payInvoiceWithPermit` con permit `try/catch` anti-front-run; +2 tests, 13 total). Backend `/onchain` devuelve `callWithPermit`; docs (api.md + openapi) actualizados. **Pendiente: redeploy del router** (el bytecode cambió → nueva dirección CREATE2 → actualizar `networks.ts` + re-`setTokenSupported`). El router viejo (`0x607f…`) sigue funcionando con `payInvoice` normal hasta el redeploy. Alternativa futura superior: EIP-3009 `receiveWithAuthorization` (gasless). `SettlementVault` de AvaSettle = rail de payouts custodial, archivado como referencia. |

---

## Ya implementado (referencia)

Limpieza y refactors hechos en esta tanda:

- **Config de red unificada y portable** (`shared/networks.ts`) + direcciones por red.
- **Migración a Arbitrum** (Sepolia default + One) + **deploy determinista CREATE2** (misma dirección cross-chain → migración trivial).
- **Helpers de server**: `clients.ts` (clients + `waitForTx` tuneado para Arbitrum), `userOp.ts` (`buildSponsoredUserOp`, `serializeBigInts`, `normalizeLowS`), `validation.ts` (normalizadores + dedup).
- **Eliminado**: migración legacy V1→V2, `/account/reset-wallet`, semántica legacy, código muerto de storage, tipos D1 hechos a mano.
- **Paymaster v2**: `validAfter`/`validUntil` firmados (anti-replay) + hook de fee documentado en `postOp`.
- **Tabla `passkeys`** (D1): qx/qy server-side → multi-passkey/recovery cross-device real.
- **RPC failover** (multi-URL), **CORS configurable** (`ALLOWED_ORIGINS`), **code-splitting** del cliente.
- **Tests**: 18 (Vitest server) + 32 (Foundry) en aquella tanda; hoy 59 + 80 (ver arriba).
- **Limpieza**: `.DS_Store`, lockfiles npm en workspace pnpm, leftovers de Vite, `walkthrough.md` stale.
- **Docs**: `ARCHITECTURE.md` reescrito (D1, Arbitrum, v0.9), `EVALUACION_TECNICA.md`.
