# Mejoras Pendientes (Backlog Técnico)

> Backlog de mejoras **identificadas pero no implementadas todavía**, para retomarlas
> después. Lo ya hecho está al final como referencia.
> Estado: junio 2026 (migrando a Arbitrum). Convenciones de prioridad:
> **P0** = bloquea el lanzamiento en Arbitrum · **P1** = pre-producción ·
> **P2** = al escalar · **Futuro** = post-PMF / opcional.

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
| 7 | **Least-privilege de claves**: separar deployer / faucet / guardian / relayer en EOAs distintas | Reduce blast radius si una clave se filtra. **Documentado en `DEPLOY.md` §11** (en testnet una sola EOA es aceptable; separar para mainnet) | Bajo (config de deploy) |
| 8 | **Guardian fuera de la clave caliente** del relayer (clave dedicada o multisig) | El guardian de todas las wallets hoy es el EOA del server (`account.routes.ts`). Ver `DEPLOY.md` §11 | Medio |
| 9 | **Rate limiting** en endpoints públicos (`/account/create`, `/account/fund`) | Anti-abuso. ✅ **Turnstile ya hecho** (ver #39); falta rate-limiting de zona (regla de Cloudflare cuando haya dominio propio). | Bajo |
| 10 | ~~Setear `ALLOWED_ORIGINS`~~ | ✅ Hecho: allowlist en `wrangler.jsonc` (parmelia.me + www + localhost). Agregar dominios de preview si se usan. | - |
| 11 | ~~Label humano del passkey~~ | ✅ Hecho: `createPasskey(uid, label)` - el diálogo del SO muestra email/nombre; el `uid` sigue siendo el id estable. | - |
| 12 | ~~Fallback `"parmelia-user"`~~ | ✅ Hecho: sin uid se corta con error de sesión en vez de un id compartido. | - |

---

## P2 - Al escalar (volumen real)

| # | Tarea | Por qué | Notas |
|---|---|---|---|
| 13 | **Migrar a un bundler ERC-4337 (Pimlico/Alchemy/Stackup)** | Resuelve el **cuello de botella del relayer único** (nonce/throughput), da **batching automático** y **estimación de gas L2 correcta** | Mantener el paymaster propio; cambia el `submit` de self-`handleOps` a `eth_sendUserOperation`. Requiere API key. |
| 14 | ~~Indexer para historial~~ | ✅ Resuelto **Cloudflare-nativo** (sin Ponder/hosting): tabla `ledger` en D1 escrita al relayar (la app conoce todo lo que pasa por ella, ambos lados si es interno) + **cron indexer** (`services/indexer.ts`, cada 2 min) que ingiere solo transferencias ERC-20 **entrantes externas** con cursor en `sync_state`. `/user/transactions` lee solo D1. `history.ts` eliminado. | Límite conocido: depósitos externos de ETH nativo no emiten logs (Across entrega USDC); sharding del filtro `to` al pasar miles de wallets. |
| 15 | **`waitForReceipt` async completo**: `submit` responde inmediato + cliente pollea estado | Quita la espera síncrona del request | Toca frontend (por eso quedó pendiente; ya tuneamos polling para Arbitrum) |
| 16 | **Cola idempotente** para pagos (Cloudflare Queues) | Reconciliar "tx enviada pero recibo no confirmado" | Va de la mano con #13/#15. Las escrituras del ledger ya son idempotentes (índice único). |
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
| 30 | **Multi-red en producción** | La portabilidad ya está lista (config por red). Elegir red(es) de settlement por fees/liquidez de USDC. |
| 31 | **Uniswap crosschain / pagos multi-activo** | Post-PMF. UUPS permite agregarlo **sin cambiar direcciones de wallet**. |
| 32 | **EIP-7702** (EOAs que delegan a contratos) | Complementario a 4337; no urgente para el modelo de passkeys. |
| 33 | **Compresión de calldata** | ⚠️ **No recomendado** salvo que se mida como techo real: forzaría forkear el verifier auditado de OZ (alto riesgo). Post-blobs en Arbitrum el beneficio es chico. |
| 34 | **Descentralizar el guardian** (guardians plurales / social recovery) | Evolución de #8. |

---

## Funcionalidades de Negocio y Tokens Pendientes (100% Arbitrum)

| # | Tarea | Notas |
|---|---|---|
| 35 | ~~Soporte de Tokens Adicionales~~ | ✅ Hecho: **WBTC** (8 dec, `0x2f2a...5B0f`) whitelisted en `shared/networks.ts` (Arbitrum One); selector de saldo en Home, pagos/links genéricos por whitelist (server), balance en `/user/balance`. WETH es interno (wrap de rutas), no se muestra al usuario. Sin WBTC canónico en Sepolia (omitido a propósito). |
| 36 | ~~Intercambios Nativos (Swaps)~~ | ✅ Hecho: `/swap/quote` + `/swap/prepare` (quoters v3+v4 on-chain, Universal Router, fees con hard cap 1%), página `/cambiar` con confirmación passkey. Pendiente: smoke test on-chain tras el deploy P0. |
| 37 | **Modo Ahorro / Rendimiento (Earn en Arbitrum)** | Diseñado en `DEFI_DESIGN.md` §4 (LP v3 primero, 3 niveles de riesgo, performance fee sobre fees). Implementación pendiente. |
| 38 | **Depósitos y Retiros Cross-Chain** | 🟡 Parcial. **Diseño afinado y autoritativo en `CROSSCHAIN_DESIGN.md`**: rail principal **CCTP v2 directo** (USDC-only v1, relayer propio, sin apilar fees), Across queda como fallback/benchmark (ya no depender del endpoint legacy keyless - requiere API key + integratorId). Hecho hoy: quotes vía Across + página `/depositar` (handoff sin custodia) + **contrato `ParmeliaCrosschainRouter` (Flow B outbound) con tests (12) y script de deploy**. Pendiente: deploy + backend (storage/relayer/rutas) → Flow A inbound. Ver orden en el design doc §10. |
| 49 | **`payInvoiceWithPermit` (EIP-2612) en ParmeliaPaymentRouter** | Mejora extraída de AvaSettle (única que aplica): pago de wallet externa en **1 tx** (en vez de `approve`+`payInvoice`). Solo aplica a **Payments API Flow B** (y futuro inbound cross-chain), **no** al `CrosschainRouter` (ese lo llama la propia smart account, que ya batchea el approve). USDC soporta permit; usar patrón `try/catch` anti-front-run. El router **aún no está desplegado** → agregar la función ahora es gratis (sin redeploy). Alternativa superior: **EIP-3009 `receiveWithAuthorization`** (gasless). **No** adoptar el modelo sin-firma de AvaSettle (incompatible con non-custodial + fee). `SettlementVault` de AvaSettle = rail de payouts custodial, archivado como referencia para payouts masivos/referidos a futuro. |

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
- **Tests**: 18 (Vitest server) + 32 (Foundry: 27 cuenta + 5 paymaster).
- **Limpieza**: `.DS_Store`, lockfiles npm en workspace pnpm, leftovers de Vite, `walkthrough.md` stale.
- **Docs**: `ARCHITECTURE.md` reescrito (D1, Arbitrum, v0.9), `EVALUACION_TECNICA.md`.
