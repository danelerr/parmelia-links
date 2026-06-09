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
| 10 | **Setear `ALLOWED_ORIGINS`** en prod (CORS ya es configurable) | Defensa en profundidad | Trivial |
| 11 | **`user.name`/`displayName` del passkey** usar email/nombre en vez del `uid` | Cosmético: el diálogo del SO muestra un string críptico | Bajo |
| 12 | Evitar el fallback constante `"parmelia-user"` como `user.id` de WebAuthn | Caso borde: dos users sin uid se pisan la resident key | Trivial |

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
| 20 | `CHECK (currency IN ('USDC','ETH'))` en `payment_links` | SQLite no permite `ALTER ADD CHECK`; requiere rebuild de tabla sobre datos existentes. |
| 21 | Normalizar direcciones a minúscula | Cambio de comportamiento; las comparaciones críticas ya hacen `lowercase`. |
| 22 | `amount` como entero raw (smallest unit) | El string decimal está bien; raw habilitaría `SUM()` en SQL pero es cambio mayor (YAGNI). |
| 23 | Tabla `transactions`/ledger unificada | Ligado al indexer (#14); es la dirección futura del historial. |

---

## Frontend / Producto

| # | Tarea | Notas |
|---|---|---|
| 24 | **PWA instalable** (manifest + service worker + push) | Para retención del comerciante. **No forzar** la instalación (rompería el funnel del pagador). |
| 25 | **App nativa (Expo/React Native)** | Post-PMF, enfocada al comerciante. Mismo RP ID de passkeys + push. Las skills de RN ya están instaladas. |
| 26 | **Tests de cliente / E2E** | Hoy el cliente no tiene tests. |

---

## Futuro / investigación

| # | Tarea | Notas |
|---|---|---|
| 27 | **Multi-red en producción** | La portabilidad ya está lista (config por red). Elegir red(es) de settlement por fees/liquidez de USDC. |
| 28 | **Uniswap crosschain / pagos multi-activo** | Post-PMF. UUPS permite agregarlo **sin cambiar direcciones de wallet**. |
| 29 | **EIP-7702** (EOAs que delegan a contratos) | Complementario a 4337; no urgente para el modelo de passkeys. |
| 30 | **Compresión de calldata** | ⚠️ **No recomendado** salvo que se mida como techo real: forzaría forkear el verifier auditado de OZ (alto riesgo). Post-blobs en Arbitrum el beneficio es chico. |
| 31 | **Descentralizar el guardian** (guardians plurales / social recovery) | Evolución de #8. |

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
