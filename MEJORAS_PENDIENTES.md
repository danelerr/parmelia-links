# Mejoras Pendientes (Backlog Técnico)

> Backlog de mejoras **identificadas pero no implementadas todavía**, para retomarlas
> después. Lo ya hecho está al final como referencia.
> Estado: junio 2026 (migrando a Arbitrum). Convenciones de prioridad:
> **P0** = bloquea el lanzamiento en Arbitrum · **P1** = pre-producción ·
> **P2** = al escalar · **Futuro** = post-PMF / opcional.

---

## P0 — Pasos para correr en Arbitrum

Sin esto la app no opera en la nueva cadena.

| # | Tarea | Notas |
|---|---|---|
| 1 | **Desplegar contratos V2 en Arbitrum** (`forge script ...:DeployV2 --broadcast`) | Usa el deploy determinista (CREATE2) ya listo. El deployer EOA necesita ETH. |
| 2 | **Rellenar direcciones** en `shared/networks.ts` → `contracts` (verifier/factory/paymaster) | Las imprime el script. |
| 3 | **Confirmar USDC de Arbitrum Sepolia** (Circle docs) y ponerla | Hoy es `TODO`. Mainnet ya está (`0xaf88...`). |
| 4 | **Aplicar migración D1 en remoto**: `wrangler d1 migrations apply PARMELIA_DB --remote` | Crea la tabla `passkeys` (0002). |
| 5 | **Configurar secrets del Worker** en Arbitrum: `RPC_URL` (con ETH en el relayer), `PRIVATE_KEY`, `PAYMASTER_SIGNER_PRIVATE_KEY` | — |
| 6 | Verificar EntryPoint v0.9 (`0x433709...09`) desplegado en Arbitrum | ✅ ya confirmado en Arbiscan. |

---

## P1 — Endurecer pre-producción

| # | Tarea | Impacto | Esfuerzo |
|---|---|---|---|
| 7 | **Least-privilege de claves**: separar deployer / faucet / guardian / relayer en EOAs distintas | Reduce blast radius si una clave se filtra | Bajo (config de deploy) |
| 8 | **Guardian fuera de la clave caliente** del relayer (clave dedicada o multisig) | El guardian de todas las wallets hoy es el EOA del server | Medio |
| 9 | **Rate limiting + Turnstile** en endpoints públicos (`/account/create`, `/account/fund`) | Anti-abuso antes de abrir al público | Medio |
| 10 | ~~Setear `ALLOWED_ORIGINS`~~ | ✅ Hecho: allowlist en `wrangler.jsonc` (parmelia.me + www + localhost). Agregar dominios de preview si se usan. | — |
| 11 | ~~Label humano del passkey~~ | ✅ Hecho: `createPasskey(uid, label)` — el diálogo del SO muestra email/nombre; el `uid` sigue siendo el id estable. | — |
| 12 | ~~Fallback `"parmelia-user"`~~ | ✅ Hecho: sin uid se corta con error de sesión en vez de un id compartido. | — |

---

## P2 — Al escalar (volumen real)

| # | Tarea | Por qué | Notas |
|---|---|---|---|
| 13 | **Migrar a un bundler ERC-4337 (Pimlico/Alchemy/Stackup)** | Resuelve el **cuello de botella del relayer único** (nonce/throughput), da **batching automático** y **estimación de gas L2 correcta** | Mantener el paymaster propio; cambia el `submit` de self-`handleOps` a `eth_sendUserOperation`. Requiere API key. |
| 14 | **Indexer (Ponder)** para historial | Hoy `/user/transactions` reconstruye on-chain en cada poll (15s/usuario) → no escala | Ingerir eventos a DB y servir lecturas desde ahí. Software gratis; hosting + RPC no. |
| 15 | **`waitForReceipt` async completo**: `submit` responde inmediato + cliente pollea estado | Quita la espera síncrona del request | Toca frontend (por eso quedó pendiente; ya tuneamos polling para Arbitrum) |
| 16 | **Cola idempotente** para pagos (Cloudflare Queues) | Reconciliar "tx enviada pero recibo no confirmado" | Va de la mano con #13/#15 |
| 17 | **Caché de balance/historial** (mientras no haya indexer) | Reduce llamadas RPC/explorer | TTL corto en D1/Cache API |

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
| 20 | ~~`CHECK (currency ...)` en `payment_links`~~ | ❌ Descartado: la whitelist de monedas ahora es **config por red** (`shared/networks.ts`, incluye WBTC) — un CHECK fijo en la DB pelearía con la config. La validación server-side (`normalizeCurrency` + whitelist) es la fuente de verdad. |
| 21 | Normalizar direcciones a minúscula | Cambio de comportamiento; las comparaciones críticas ya hacen `lowercase`. |
| 22 | `amount` como entero raw (smallest unit) | El string decimal está bien; raw habilitaría `SUM()` en SQL pero es cambio mayor (YAGNI). |
| 23 | Tabla `transactions`/ledger unificada | Ligado al indexer (#14); es la dirección futura del historial. |

---

## Frontend / Producto

| # | Tarea | Notas |
|---|---|---|
| 24 | ~~PWA instalable~~ | 🟡 Casi: manifest + service worker (shell cache-first para assets, network-first para navegación; la API jamás se cachea) + registro solo en prod. **Pendiente:** exportar iconos PNG 192/512 + apple-touch-icon 180px desde los assets de marca (iOS ignora SVG) y push notifications. |
| 25 | **App nativa (Expo/React Native)** | Post-PMF, enfocada al comerciante. Mismo RP ID de passkeys + push. Las skills de RN ya están instaladas. |
| 26 | **Tests de cliente / E2E** | Hoy el cliente no tiene tests. |
| 27 | ~~Comprobantes detallados~~ | ✅ Hecho: fecha, hora y N° de comprobante (tx hash) en el bloque inferior del modal (`ReceiptModal`) y en `PaymentStatus`. |
| 28 | ~~Pantalla de extractos y filtros temporales~~ | ✅ Hecho: Home compacto ("Actividad reciente", 5 + "Ver extracto completo") y página `/extractos` con rangos rápidos (semana/mes/2 meses), rango personalizado, filtro por moneda y por tipo (enviados/recibidos/cobros por link — campo `kind` del server). |
| 29 | ~~Contactos e invitaciones~~ | ✅ Hecho: página `/contactos` (agregar por usuario, pagar en un toque, eliminar), invitación con `?ref=` + contador de invitados (migración 0004, `/contacts/*`, atribución en `/account/create`). Entrada en Ajustes. |

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
| 38 | **Depósitos y Retiros Cross-Chain** | 🟡 Parcial: quotes reales vía API pública de Across (`/bridge/config`, `/bridge/quote`) + página `/depositar` (depósitos continúan en Across con la cuenta del usuario prefijada — sin custodia; retiros: cotizados, ejecución desde la smart account = siguiente paso, requiere SpokePool verificado). Direcciones USDC externas: re-verificar contra Circle antes de mainnet. |

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
