# Runbook - Poner GatoPago a funcionar en Arbitrum

> Orden exacto para activar todo lo implementado (contratos V2, ledger D1,
> indexación dirigida por eventos, swaps, referidos) en **Arbitrum Sepolia**. Al final, el delta
> para **Arbitrum One**.

## 0. Corte de Fase 2: dos Workers y dos D1

**Estado al 26-08-2026:** el recut semántico Cloudflare y la promoción Vercel
están ejecutados y verificados. `server` usa
`PAYMENTS_CUTOVER_MODE=payments`; Payments apunta a
`gatopago-payments-semantic-20260826`, tiene bootstrap desactivado, migraciones
`0001`–`0006` y checksum semántico fijado. `app.parmelia.me` y
`dashboard.parmelia.me` responden anónimamente; el dashboard muestra el login de
GatoPago y no Vercel SSO. `PAYMENT_LIVE_ENABLED=false` permanece sin cambios.
La D1 histórica no se borra ni se reimporta. El procedimiento que produjo este
estado está en
[`payments-semantic-recut.md`](./docs/runbooks/payments-semantic-recut.md). La secuencia siguiente queda como runbook reproducible y
de recuperación. Los deploys manuales se ejecutan
con `pnpm --filter payments-worker run deploy` y
`pnpm --filter server run deploy`; sin `run`, pnpm 11 interpreta `deploy` como
su comando incorporado.

Antes de tocar una credencial, consulta el
[`inventario canónico de secretos y configuración`](./docs/operations/worker-variables.md):
distingue el valor público del secreto, registra su procedencia real y señala
qué valores sólo tienen nombre remoto verificable.

Orden de promoción (no intercambiarlo):

1. Ejecutar `pnpm verify:all`, `pnpm check:d1:restore` y
   `.\scripts\invoke-phase2-preflight.ps1`. El segundo ensaya tanto el backup de App como
   el split, checksum y restauración independiente de las dos bases. El preflight
   sólo lee Cloudflare, exporta un snapshot a un directorio temporal que elimina
   al terminar y sale con estado no-cero mientras falten recursos de la promoción;
   nunca crea, migra, importa ni despliega.
2. Crear explícitamente una D1 Payments **nueva**; conservar
   `gatopago-payments` histórica y las Queue/DLQ existentes. Reemplazar el UUID
   del binding sólo con el ID nuevo devuelto y mediante un diff versionado.
3. Sobre la D1 Payments todavía vacía, aplicar con Wrangler **todas** las
   migraciones descubiertas en `payments-worker/migrations/` (actualmente
   `0001`–`0006`) y comprobar que figuran en `d1_migrations`. No importar un dump de schema ni insertar
   manualmente en la tabla de historial de Wrangler.

   ```powershell
   pnpm --filter payments-worker exec wrangler d1 migrations list PAYMENTS_DB --remote
   pnpm --filter payments-worker exec wrangler d1 migrations apply PAYMENTS_DB --remote
   pnpm --filter payments-worker exec wrangler d1 migrations list PAYMENTS_DB --remote
   ```
4. Cargar en Payments sus secretos dedicados: signer EIP-712, RPCs por chain,
   relayer CCTP, cifrado de webhooks, token de ops y opcionalmente Circle API.
   Dejar `PAYMENT_FEE_POLICY_JSON` ausente/vacío (política `free-default`) y
   habilitar `PAYMENT_ROUTER_PREFLIGHT_ENABLED=true`. No copiar `PRIVATE_KEY`,
   paymaster, OTP o guardian desde App.
   El primer deploy conserva `PAYMENTS_BOOTSTRAP_MODE=true`,
   `PAYMENTS_DATA_CUTOVER_CHECKSUM=pending` y
   `PAYMENT_LIVE_ENABLED=false`.
5. Desplegar **primero** `gatopago-payments-api` en bootstrap. `/health/live`
   debe mostrar `bootstrapActive=true`; `/health` degradado es deliberado porque
   todavía no puede aceptar escrituras. Esto crea el target antes que el caller.
6. Aplicar las migraciones expand-first App `0033` y `0034`, y desplegar App con
   `PAYMENTS_CUTOVER_MODE=legacy` + `PAYMENTS_SYNC_ENABLED=false`. Comprobar que
   no cambió el comportamiento. Después desplegar
   `PAYMENTS_CUTOVER_MODE=frozen`, manteniendo sync apagado: todos los
   `POST`/`PUT`/`PATCH`/`DELETE` de pagos deben devolver `503` con
   `Retry-After`, mientras los `GET` legacy siguen disponibles. No continúes
   hasta drenar jobs/outbox activos y capturar watermark, conteos y checksum.
7. Con las escrituras congeladas, exportar `GATOPAGO_DB`.
   El migrador acepta directamente el SQL de Wrangler y lo materializa en un
   SQLite temporal aislado. Ejecutar:

   ```powershell
   .\scripts\prepare-payments-semantic-split.ps1 `
     -SourceSql C:\secure\gatopago-app.sql `
     -TargetSqlite C:\secure\gatopago-payments.sqlite `
     -EvidenceDirectory C:\secure\gatopago-split-backup
   ```

   El wrapper recupera desde DPAPI la clave de webhooks existente y sólo la
   expone al proceso hijo; no la imprime ni rota. `--source` sigue disponible
   en el script Node si el operador ya materializó un SQLite. En un corte real
   `WEBHOOK_SECRET_ENCRYPTION_KEY` y su key ID son obligatorios; el script
   rehúsa sobreescribir target/backups, conserva IDs, verifica conteos/checksum,
   `quick_check`/FK y abre ambas copias restauradas. Además genera
   `gatopago-payments-data.sql`: contiene **solo datos**, excluye
   `d1_migrations`, ordena padres antes que hijos y lleva un guard que rechaza
   una D1 no vacía o un replay. El drill importa ese archivo sobre un schema
   nuevo creado por todas las migraciones Payments y vuelve a verificar
   contenido/IDs/checksum e índices críticos. El manifest debe ser versión 4 y
   el checksum semántico versión 2; webhooks se escriben como `enc:v2`.

   Las operaciones CCTP personales históricas **no se copian**: permanecen en
   App. Payments importa sólo CCTP ligado a attempts merchant (cero en el
   baseline auditado). El migrador falla en vez de omitir merchants, API keys,
   webhooks, eventos o referencias inválidas.

   Revisa el SHA-256 de `split-manifest.json` e importa exclusivamente ese
   artefacto sobre la D1 ya migrada:

   ```powershell
   pnpm --filter payments-worker exec wrangler d1 execute PAYMENTS_DB --remote `
     --file=C:\secure\gatopago-split-backup\gatopago-payments-data.sql
   ```

   El SQL contiene datos operativos y secretos de webhook ya cifrados: trátalo
   como backup sensible, no lo subas a Git y bórralo/archívalo cifrado según la
   política de retención después de validar el corte.
8. Exportar primero la D1 nueva después del import y ejecutar
   `split-payments-d1.mjs --verify-target-sql ... --manifest ...`, o el preflight
   protegido que realiza esa comparación. Sólo con el target verificado y App
   todavía `frozen`, copiar `split-manifest.json.verification.checksum` a
   `PAYMENTS_DATA_CUTOVER_CHECKSUM` —no el SHA del archivo manifest—, conservar
   `PAYMENTS_BOOTSTRAP_MODE=true`, desplegar Payments y exigir
   `checks.dataCutover=verified`. Después cambiar sólo
   `PAYMENTS_BOOTSTRAP_MODE=false` y desplegar de nuevo
   `gatopago-payments-api`. Los guards de deploy rechazan cualquier salto que
   habilite dos escritores o active Payments con `pending`. Verificar `/health/live`,
   `/health`, un checkout migrado real por acceso directo y una operación `/v1`
   test con App detenido. El preflight read-only exige además que ese mismo
   checkout responda por el proxy temporal de App después de actualizarlo.
9. Validar que `/health/ops` de Payments explica y deja en cero
   `activeAttempts`, `pendingWebhooks`, `pendingOutbox` y `activeJobLeases`, o
   documentar cada excepción. Con App todavía `frozen`, habilitar
   `PAYMENTS_SYNC_ENABLED=true`, desplegar y drenar ambos outbox de frontera.
   Luego cambiar App a `PAYMENTS_CUTOVER_MODE=payments`, conservar sync activo,
   desplegar `server` in-place y probar el mismo checkout a través del Service
   Binding. Si el binding falla, App debe responder `503`, nunca escribir en la
   D1 equivocada.
10. Completar `vercel login` y ejecutar desde la raíz:

   ```powershell
   pwsh -File scripts/deploy-phase2-frontends.ps1
   pnpm preflight:frontends:remote
   ```

   El script verifica el link existente de `client/`, crea/vincula
   `gatopago-dashboard`, configura sólo los nombres Production declarados,
   despliega ambas superficies y asigna `dashboard.parmelia.me`. Los valores se
   entregan a Vercel por stdin y no se escriben en el repositorio.
   Un deploy real falla si el árbol relevante está dirty/untracked, si HEAD no
   tiene upstream o si el commit publicado difiere. El preflight también rechaza
   Vercel SSO en una superficie que deba ser pública.
   `VITE_SERVER_URL` conserva el proxy sólo durante el soak N-1.
11. Mantener tablas legadas read-only y los backups durante el soak. Un rollback
   de código cambia versiones de Workers; jamás borra ni fusiona D1. Resolver
   primero las escrituras en vuelo antes de reabrir el dominio anterior.

La dependencia RPC es sólo App → Payments. El dashboard no tiene Worker propio
y no se despliega un tercer consumidor hasta activar un gate medido documentado
en `docs/design/universal-checkout-multichain.md`.

El procedimiento, los criterios de abortar y el rollback están aislados en
[`docs/runbooks/payments-cutover.md`](./docs/runbooks/payments-cutover.md). No
se activa mainnet en este corte. La sustitución de la evidencia histórica está
en [`docs/runbooks/payments-semantic-recut.md`](./docs/runbooks/payments-semantic-recut.md).
`PAYMENT_LIVE_ENABLED=false` permanece en
Wrangler y el backend exige además rutas mainnet desplegadas en el manifest.

Secrets dedicados de Payments (ejecutar desde `payments-worker/` solo durante
una promoción autorizada):

```powershell
npx wrangler secret put PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY
npx wrangler secret put PAYMENT_RPC_URLS
npx wrangler secret put PAYMENT_RELAYER_PRIVATE_KEY
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY_ID
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS
npx wrangler secret put OPS_HEALTH_TOKEN
npx wrangler secret put CIRCLE_API_KEY # opcional
```

`PAYMENT_FEE_POLICY_JSON` y `PAYMENT_PLATFORM_FEE_RECIPIENT` permanecen vacíos
en el lanzamiento. Si alguna vez contienen una regla positiva, trátalos como
configuración económica controlada, con revisión y canary según §12.6; no como
un cambio rutinario de entorno.


## 1. Claves y fondos (una sola vez)

Cinco roles básicos (pueden ser la misma clave en testnet, pero mejor no):

| Rol | Para qué | Necesita |
|---|---|---|
| **Deployer** (tu keystore `wallet-0x75`) | Desplegar contratos + stake/deposit del paymaster | ~0.05 ETH en Arbitrum Sepolia |
| **Relayer** (`PRIVATE_KEY` del worker) | `handleOps`, crear cuentas y CCTP | ~0.05 ETH en las redes donde envía transacciones |
| **Faucet** (`FAUCET_PRIVATE_KEY`) | Custodiar y transferir el presupuesto de bienvenida | ETH para gas **+ USDC de prueba** |
| **Paymaster signer** (`PAYMASTER_SIGNER_PRIVATE_KEY`) | Firmar patrocinios de gas | Nada (solo firma) |
| **Recovery guardian** (`RECOVERY_GUARDIAN_PRIVATE_KEY`) | Proponer/cancelar recovery con timelock | ETH para sus transacciones |

```bash
# Generar las claves nuevas que falten
cast wallet new   # relayer
cast wallet new   # faucet
cast wallet new   # paymaster signer
```

Fondos: ETH de Sepolia → bridge a Arbitrum Sepolia (o faucet de Arbitrum);
USDC de prueba para el **faucet** en https://faucet.circle.com (red: Arbitrum Sepolia).

## 2. Desplegar contratos (CREATE2 determinista)

```bash
cd contracts
forge script script/Deploy.s.sol:DeployV2 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --account wallet-0x75 \
  --sender 0x75464f762bc50d0A0B127ab5a085504BF102Bb88 \
  --broadcast
```

**`--sender` es obligatorio** (la dirección de `wallet-0x75`). Sin él,
`msg.sender` es el DefaultSender de Foundry y la política compartida aborta antes
de emitir transacciones. En testnet, si no defines variables `GATOPAGO_*`, el
deployer queda como owner/sponsor por simplicidad.

El summary imprime `verifier / factory / paymaster`. **Anótalos.**
(El script ya hace `addStake` 0.001 ETH, `deposit` 0.01 ETH y fija el cap de gas
patrocinado por op `setMaxSponsoredGasCost(0.005 ether)` del paymaster.)

> Nota (jul-2026): las fuentes de los contratos avanzaron respecto de lo
> desplegado en Sepolia — router con `payInvoiceWithPermit`, recovery validada +
> cancel del guardian, paymaster con cap de gas, `SIG_VALIDATION_FAILED` y ciclo
> de stake (`unlockStake`/`withdrawStake`; la instancia vieja NO los tiene: su
> stake de 0.001 ETH es costo hundido). Un redeploy cambia las direcciones
> CREATE2 → actualizar `shared/networks.ts` (+ flag `paymentRouterHasPermit`) y
> re-correr `setTokenSupported`. Detalle en `contracts/AUDIT.md`.

En **testnet no necesitas** `setSponsorSigner`: el constructor deja al deployer
como signer. En mainnet el script exige `GATOPAGO_PAYMASTER_SIGNER`, lo configura
antes de terminar y emite `SponsorSignerSet` (ver §11).

## 3. Verificar contratos (Sourcify - sin API key)

Opcional pero recomendado: publica el código fuente para inspeccionar e
interactuar con los contratos desde el explorador. `forge verify-contract` usa
**Sourcify por defecto** (no requiere API key) y `--watch` espera hasta confirmar
`Status: exact_match`.

Usa las direcciones del summary del paso 2 y verifica **en este orden** (el
verifier y la implementación no llevan constructor-args; factory y paymaster sí):

```bash
cd contracts

# 1. Verifier WebAuthn (sin constructor-args)
forge verify-contract <VERIFIER> src/ERC7913WebAuthnVerifier.sol:ERC7913WebAuthnVerifier \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch

# 2. Implementación de la smart account (sin constructor-args)
forge verify-contract <ACCOUNT_IMPL> src/AccountWebAuthnV2.sol:AccountWebAuthnV2 \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch

# 3. Factory - constructor: la dirección de la implementación
forge verify-contract <FACTORY> src/AccountFactoryV2.sol:AccountFactoryV2 \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch \
  --constructor-args $(cast abi-encode "constructor(address)" <ACCOUNT_IMPL>)

# 4. Paymaster - constructor: EntryPoint + owner (= el --sender del deploy)
forge verify-contract <PAYMASTER> src/ParmeliaPaymaster.sol:ParmeliaPaymaster \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    0x433709009B8330FDa32311DF1C2AFA402eD8D009 <DEPLOYER>)
```

Notas:
- Los `--constructor-args` deben coincidir **exacto** con los del deploy. En el
  paymaster, el 2º arg es el owner = tu `--sender` (`wallet-0x75`); si pones otra
  dirección la verificación falla (`bytecode mismatch`).
- `$(cast abi-encode ...)` es sintaxis de bash (Git Bash); funciona tal cual.
- Verificar es idempotente: re-correrlo sobre un contrato ya verificado responde
  "already verified".
- ¿Prefieres **Arbiscan** en vez de Sourcify? Añade
  `--verifier etherscan --etherscan-api-key <API_KEY>` (requiere cuenta Arbiscan).
  Sourcify basta para leer/interactuar y no pide key.

## 4. Rellenar direcciones en `shared/networks.ts`

En `NETWORKS["arbitrum-sepolia"].contracts` reemplaza los `TODO_DEPLOY`:
`factory`, `paymaster`, `verifier` (los del paso 2). EntryPoint y USDC ya están.

> **Desplegado en Arbitrum Sepolia (redeploy endurecido, 5-jul-2026):**
> | Contrato | Dirección |
> |---|---|
> | verifier  | `0x14D5D46fc6ED1154F3719f87ae72C3020d4fb886` |
> | impl      | `0xDFA9df7d6CCc3b92F8a8e245D6E9760c3346184C` |
> | factory   | `0xb97E923E27CB258012081446e4b436afd3974108` |
> | paymaster | `0x913a1B51c4f5b1a458A56D0d700c956834cc1d15` |
> | paymentRouter | `0xaF5a6856F65eab6bd8d0e403E4cFd49aD0c0c04f` (con permit; USDC habilitado, min 1 USDC) |
> | crosschainRouter | `0xD089c3764a8F2E62eFDf280Eb2432c1dC647400c` (outbound endurecido, 24-ago-2026) |
>
> Generación anterior (jun-2026, cuentas existentes siguen operativas):
> verifier `0xb7fA10dE…06d6`, impl `0xa450bc49…527e`, factory
> `0x75c7761d…EDEB`, paymaster `0x31f357a6…5753` (stake hundido; el
> depósito de gas es recuperable con `withdrawTo`), paymentRouter
> `0x607fF0c2…975A`, crosschainRouter `0x0816d133…D777`. El outbound
> `0x88Ae8A42…3a1` (jul-2026) fue reemplazado por el router endurecido indicado
> arriba.
>
> La `impl` no va en `networks.ts` (la factory ya la referencia); solo se usó para
> verificar. Si re-despliegas con distinto bytecode (cambio de `foundry.toml` o de
> contratos), estas direcciones cambian.

## 5. Base de datos remota (migraciones)

### Preflight obligatorio: bookmark, backup y restore drill

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
mantiene recuperación punto-en-tiempo automáticamente, pero su retención es
limitada. Antes de cada migración remota, captura el bookmark y un
[export SQL](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
cifrado de largo plazo con una clave estable guardada en el gestor de secretos
del operador (no es un secret del Worker y nunca va al repositorio):

```powershell
$env:D1_BACKUP_ENCRYPTION_KEY = "<32 bytes en hex o base64>"
$env:D1_BACKUP_ENCRYPTION_KEY_ID = "archivo-2026-07"
pnpm d1:backup
```

El comando obtiene primero el bookmark actual de Time Travel, ejecuta
`wrangler d1 export --remote`, cifra el SQL en streaming con AES-256-GCM,
calcula hashes de plaintext/ciphertext, restaura una copia local aislada y exige
`PRAGMA quick_check`, `foreign_key_check` y las tablas críticas. Sólo entonces
conserva `backups/parmeliadb-<fecha>.sql.enc` y su manifest. El export remoto
bloquea consultas mientras corre: programarlo en una ventana de bajo tráfico.

Verifica de nuevo un archivo histórico antes de usarlo:

```powershell
node scripts/d1-backup.mjs --verify backups/parmeliadb-<fecha>.sql.enc
```

Para una recuperación fuera de la ventana de Time Travel, descifra a una ruta
protegida, importa el SQL en una **D1 nueva**, valida la aplicación y cambia el
binding. No importes el dump encima de una base con tablas existentes:

```powershell
node scripts/d1-backup.mjs --decrypt backups/parmeliadb-<fecha>.sql.enc --output C:\secure\parmeliadb-recovery.sql
```

Para errores recientes, usa preferentemente el bookmark registrado con
`wrangler d1 time-travel restore`; es destructivo sobre la D1 activa y cancela
queries en vuelo, por lo que exige aprobación operativa y comprobación posterior.
Antes de desplegar, ejecuta localmente `pnpm check:d1:restore`; usa dos bases
locales desechables para ensayar todo el formato cifrado y la restauración.

```bash
cd server
npx wrangler d1 migrations apply GATOPAGO_DB --remote
```

No confíes en una lista manual para conocer el estado remoto. Ejecuta primero
`npx wrangler d1 migrations list GATOPAGO_DB --remote` y aplica, en orden, todo
lo que falte hasta `0034_sponsorship_observability.sql`. El Worker actual requiere
la cadena completa: además del hardening y los ciclos durables originales,
`0012`-`0026` incorporan journal canónico, read models de Home, evidencia y
rollback de reorg, shards del indexador, suscripciones de proveedor, control
plane RPC, finality de Arbitrum, outboxes, ciclo durable de UserOperations,
paginación del ledger, cache durable de capacidades del bundler, cola de
reconciliación, auditorías de balance y registro incremental de wallets. `0027`
a `0032` agregan consistencia del indexador, marca, códigos de correo con consumo
atómico, registro WebAuthn ligado al servidor y step-up de recuperación. `0033`
establece la frontera con Payments y `0034` persiste proveedor y dirección exacta
de sponsorship para rotación/observabilidad.
REGLA: migraciones SIEMPRE antes del `wrangler deploy` del Worker que las usa.
El prólogo `DROP` de `0001` fue una decisión de testnet (datos desechables);
nunca replicar ese patrón hacia producción.

### Reserva de nonce bloqueada

`GET /health` devuelve `503` y `issueCount > 0` si una operación queda en
`needs_review`. El código `signer_nonce_blocked` se consulta sólo en
`GET /health/ops` con `X-Ops-Token`. Es intencional: continuar firmando podría
reemplazar una transacción cuyo nonce ya fue consumido.

1. Consulta la fila en D1 (`id`, `tx_hash`, `signer_address`, `nonce`,
   `raw_transaction`, `last_error`).
2. Comprueba el receipt por `tx_hash` y `eth_getTransactionCount` del firmante
   en `latest` y `pending`, usando al menos dos RPCs.
3. Si minó, ejecuta/repara la finalización idempotente antes de marcarla
   terminal. Si no minó y el nonce sigue libre, reemite **la misma**
   `raw_transaction`.
4. No borres ni cambies la fila para “desbloquear” sin demostrar el estado
   on-chain; documenta la resolución y conserva el hash para auditoría.

## 6. Secrets del worker

La lista siguiente es operativa; la fuente, ubicación, estado remoto y rotación
de cada nombre están en el
[`inventario canónico`](./docs/operations/worker-variables.md). No asumas que un
archivo local coincide con Cloudflare: los valores remotos no se pueden leer.

```bash
cd server
npx wrangler secret put RPC_URL          # compatibilidad; no mezclar roles nuevos aquí
npx wrangler secret put RPC_READ_URLS    # pool de lecturas puntuales
npx wrangler secret put RPC_WRITE_URLS   # broadcast/simulación crítica
npx wrangler secret put RPC_INDEXER_URLS # pool canónico eth_getLogs
npx wrangler secret put RPC_ARCHIVE_URLS # backfills aislados, si se habilitan
npx wrangler secret put RPC_PROVIDER_CAPABILITIES # límites/prioridad por endpoint
npx wrangler secret put PRIVATE_KEY                        # relayer handleOps/CCTP
npx wrangler secret put FAUCET_PRIVATE_KEY                 # fondos del faucet (mainnet: obligatoria si se activa)
npx wrangler secret put RECOVERY_GUARDIAN_PRIVATE_KEY      # guardian (mainnet: obligatorio y distinto)
npx wrangler secret put PAYMASTER_SIGNER_PRIVATE_KEY       # solo provider Parmelia: firma sponsorships
npx wrangler secret put PAYMENT_ROUTER_SIGNER_PRIVATE_KEY  # firma invoices Flow B
npx wrangler secret put OPS_HEALTH_TOKEN                   # token aleatorio 32+ caracteres para /health/ops
# Opcionales en TESTNET (feature-flag). En MAINNET: TURNSTILE es OBLIGATORIO
# (sin el, /account/create y /account/fund fallan cerrado) y las claves
# dedicadas de arriba tambien (los fallbacks entre claves estan prohibidos).
npx wrangler secret put TURNSTILE_SECRET_KEY           # anti-abuso en crear cuenta + faucet
Get-Content -Raw ..\<service-account>.json | npx wrangler secret put FCM_SERVICE_ACCOUNT  # push
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT       # JSON de service account para Custom Tokens/Admin API
npx wrangler secret put FIREBASE_WEB_API_KEY            # API key publica de Firebase Web Auth
npx wrangler secret put AUTH_CODE_PEPPER                # aleatorio, minimo 32 caracteres; HMAC de correo/codigo/proofs
npx wrangler secret put CCTP_RPC_URLS                  # opcional: RPCs dedicados cross-chain
npx wrangler secret put ALCHEMY_WEBHOOK_ID             # Address Activity
npx wrangler secret put ALCHEMY_WEBHOOK_NETWORK        # red exacta del webhook
npx wrangler secret put ALCHEMY_WEBHOOK_SIGNING_KEY    # HMAC Address Activity
npx wrangler secret put ALCHEMY_ADDRESS_WEBHOOKS_JSON  # reemplazo multi-slot opcional
npx wrangler secret put ALCHEMY_NOTIFY_AUTH_TOKEN      # API Notify; no es la key RPC
npx wrangler secret put ALCHEMY_CUSTOM_WEBHOOK_ID      # eventos de router/recovery
npx wrangler secret put ALCHEMY_CUSTOM_WEBHOOK_SIGNING_KEY
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY  # 32 bytes base64/hex; obligatorio en mainnet
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY_ID # ID corto, por ejemplo 2026_07
```

Configura además el adaptador de sponsorship en `server/wrangler.jsonc` (o como
vars del entorno), sin poner claves en Git:

```text
SPONSORSHIP_PROVIDER=parmelia             # parmelia | erc7677 | self-funded
SPONSORSHIP_FALLBACK_PROVIDER=            # opcional; solo se intenta antes de firmar
SPONSORSHIP_PAYMASTER_ADDRESS=<CONTRATO>  # override versionado del paymaster propio
SPONSORSHIP_HEALTH_CHECK_ENABLED=true
PAYMASTER_MIN_DEPOSIT_WEI=1000000000000000
PAYMASTER_SERVICE_URL=                    # HTTPS para ERC-7677
PAYMASTER_SERVICE_EXPECTED_PAYMASTER=     # pin obligatorio en mainnet
PAYMASTER_SERVICE_TIMEOUT_MS=8000
```

Si el proveedor ERC-7677 requiere credenciales dentro de su contexto, carga
`PAYMASTER_SERVICE_CONTEXT_JSON` con `wrangler secret put`; no lo declares como
var pública. `self-funded` no es un fallback mágico: antes de pedir la firma el
Worker verifica depósito de EntryPoint y balance nativo suficiente de la cuenta.

El binding `EMAIL` y `AUTH_EMAIL_FROM` están declarados en `server/wrangler.jsonc`.
Antes de publicar, valida en Cloudflare Email Sending que
`acceso@parmelia.me` sea un remitente permitido. No guardes el JSON de Firebase
ni `AUTH_CODE_PEPPER` en archivos sincronizados, variables `VITE_*` o GitHub.

`GET /health/live` comprueba únicamente que el proceso responde. `GET /health`
devuelve `200` sólo si la configuración es coherente y publica únicamente
`status`, `network`, `issueCount` y `warningCount`. El diagnóstico completo se
obtiene desde `GET /health/ops` con `X-Ops-Token`; sin token válido responde 404.
En mainnet, el Worker responde/falla cerrado con `503 SERVICE_UNAVAILABLE` si
faltan contratos, CORS HTTPS, Turnstile, APP_URL, Email Sending, la configuración
Firebase/OTP, cifrado o claves dedicadas. Las cuentas activas de relayer, faucet,
paymaster, invoices y guardian deben ser distintas.

### Rotación de la clave de webhooks

1. Conserva temporalmente la clave anterior en
   `WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS`, como JSON `{"id_viejo":"clave"}`.
2. Carga la clave nueva en `WEBHOOK_SECRET_ENCRYPTION_KEY` y cambia
   `WEBHOOK_SECRET_ENCRYPTION_KEY_ID` a un ID nuevo.
3. Despliega. El job de rotación descifra con la clave anterior y recifra gradualmente en
   formato `enc:v2:<id_nuevo>`, usando compare-and-set para no pisar ediciones.
4. Comprueba que no queden filas antiguas y elimina
   `WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS` con `wrangler secret delete`.

No retires la clave previa antes del paso 4: las entregas de esos endpoints no
podrían firmarse.

Ya configurado en `wrangler.jsonc`: `CHAIN_KEY=arbitrum-sepolia`,
`ALLOWED_ORIGINS`, una Queue y `EventJobScheduler`. App no tiene Cron Trigger: el
Durable Object conserva una alarma sólo mientras exista trabajo y la elimina al
vaciarse. El consumidor usa `max_batch_size=1`, de modo que cada
indexador/reconciliador recibe una invocación y un presupuesto de subrequests
independiente. Configura `APP_URL`, flags cross-chain y fees (`GATOPAGO_*`)
explícitamente para cada entorno; mainnet no acepta el fallback de `APP_URL`.
Payments sí tiene un Cron por minuto, limitado a recuperar outbox y watchers
activos; Queue y `PaymentJobScheduler` siguen ejecutando y deduplicando el
trabajo.

### Rotación de paymaster o proveedor de sponsorship

Cambiar de paymaster **no migra las smart accounts**: la cuenta firma una
UserOperation que contiene el paymaster elegido. Sí exige respetar la frontera
de firma y drenar operaciones en curso:

1. Despliega y fondea/stakea el nuevo paymaster propio, o valida el endpoint
   ERC-7677 y fija `PAYMASTER_SERVICE_EXPECTED_PAYMASTER` en mainnet.
2. Comprueba EntryPoint, código, signer, depósito/capacidad y una preparación
   canary. No cambies todavía el contrato viejo.
3. Cambia `SPONSORSHIP_PROVIDER`/`SPONSORSHIP_PAYMASTER_ADDRESS` y despliega App.
   Cada intento de fallback reconstruye y reestima la UserOperation **antes**
   de mostrarla para firma; nunca se sustituye `paymasterAndData` después.
4. Verifica `/health` y `/health/ops`. Este último agrupa operaciones activas
   por proveedor **y dirección exacta** de paymaster.
5. Las operaciones ya preparadas conservan el proveedor y contrato viejos.
   Déjalas enviar o expirar; no las reescribas. Espera al menos el TTL máximo
   actual de sponsorship (600 s) y exige conteo activo cero para la dirección
   antigua antes de retirar depósito, desbloquear stake o apagar el servicio.
6. Si también rotas `PAYMASTER_SIGNER_PRIVATE_KEY`, mantén el signer antiguo en
   el contrato viejo durante ese drenaje. La nueva clave solo debe coincidir con
   el nuevo contrato.
7. Rollback: restaura el provider/address anterior y vuelve a preparar nuevas
   UserOperations. Una operación firmada para un paymaster no es portable a otro.

La política evita doble firma, invalidez silenciosa y retiro prematuro de fondos
operativos. El health registra capacidad; no garantiza por sí solo que un
proveedor externo acepte todas las políticas comerciales.

### RPC: capacidades por endpoint

El Worker separa lecturas, escrituras, indexación y archivo. Cada rol admite un
pool y `RPC_URL` queda sólo como fallback de compatibilidad:

| Rol | Uso |
|---|---|
| `RPC_READ_URLS` | balances puntuales, receipts y llamadas de contrato |
| `RPC_WRITE_URLS` | simulación y broadcast |
| `RPC_INDEXER_URLS` | `eth_getLogs` del journal y reconciliadores |
| `RPC_ARCHIVE_URLS` | backfill histórico aislado |
| `BUNDLER_RPC_URLS` | métodos ERC-4337; no equivale a un Node RPC |

Los planes no se codifican por hostname. En
`RPC_PROVIDER_CAPABILITIES`, cada posición declara ID seguro, prioridad,
concurrencia y rango:

```json
{
  "indexer": [
    { "id": "managed", "priority": 0, "maxConcurrency": 4, "maxLogRange": 10 },
    { "id": "public", "priority": 1, "maxConcurrency": 2, "maxLogRange": 2000 }
  ]
}
```

Así ambos endpoints pueden coexistir. Una consulta de 2.000 usa sólo un
proveedor elegible; una de 10 intenta por prioridad. Si falla el proveedor
grande, el scanner reduce el span hasta que otro sea elegible. El checkpoint
sólo avanza después de persistir journal y proyecciones.

`RpcAdmissionController` impone `maxConcurrency` globalmente por endpoint/lane,
además del semáforo local y circuit breaker. Subir o bajar de plan cambia la
configuración, no el indexador. Antes de promover:

```powershell
$env:CHAIN_KEY = "arbitrum-sepolia"
$env:RPC_INDEXER_URLS = "<ENDPOINT_1>,<ENDPOINT_2>"
$env:RPC_PROVIDER_CAPABILITIES = '{"indexer":[...]}'
pnpm check:rpc-indexer
```

Una API key expuesta en captura, terminal o ticket se rota antes de habilitar el
endpoint. La clave del Node RPC va dentro de la URL y por eso se carga como
secret. Para Address Activity también hacen falta
`ALCHEMY_WEBHOOK_SIGNING_KEY`, `ALCHEMY_WEBHOOK_ID` y
`ALCHEMY_NOTIFY_AUTH_TOKEN`; este último es el token de Notify y **no** la API
key del Node RPC.

### Alchemy Notify (para cero polling permanente)

La URL RPC de Node no activa Notify. Crea dos webhooks en Alchemy:

Nunca reutilices una Node API key que haya aparecido en una captura o chat:
rótala primero. Notify usa además signing keys y un auth token propios; mantener
los dos flags en `false` es el modo seguro mientras falten esas credenciales.

1. **Address Activity** → `https://server.parmelia.workers.dev/ingest/alchemy`.
   Guarda su ID, network, signing key y el token de administración Notify en los
   secrets `ALCHEMY_WEBHOOK_*`/`ALCHEMY_NOTIFY_AUTH_TOKEN`, o usa
   `ALCHEMY_ADDRESS_WEBHOOKS_JSON` para varios slots. Luego cambia
   `ALCHEMY_WEBHOOK_ENABLED` a `true`. GatoPago sincroniza las wallets nuevas en
   ese webhook y vuelve a leer cada bloque con el pool `RPC_INDEXER_URLS`. El
   primer inventario remoto se pagina y persiste; después sólo se envían diffs
   de hasta 500 direcciones contra un espejo D1. Las señales de actividad
   solicitan además un balance canónico de la wallet para cubrir ETH nativo.
2. **Custom Webhook (GraphQL)** →
   `https://server.parmelia.workers.dev/ingest/alchemy/custom`. Filtra
   exclusivamente las direcciones y topics de `InvoicePaid` del
   `ParmeliaPaymentRouter` y de los eventos de recovery de
   `AccountWebAuthnV2`; no uses un stream de todos los logs. Guarda ID y signing
   key, y cambia `ALCHEMY_CUSTOM_WEBHOOK_ENABLED` a `true`.

El Custom Webhook es una señal de despertar, no la fuente de verdad: los
watchers vuelven a leer por el pool RPC antes de mutar D1. Los topics conocidos
se enrutan sólo al stream/shard afectado; un esquema desconocido usa fallback
conservador. En testnet
puede quedar apagado; sólo mientras exista un invoice activo habrá un fallback
acotado cada dos minutos. En mainnet la validación exige el Custom Webhook.

Consola Firebase (para Google, Custom Tokens, push y analytics): habilitar Google,
autorizar `app.parmelia.me`, generar una cuenta de servicio de mínimo privilegio,
generar la VAPID y habilitar GA4. El acceso por correo lo emite el Worker mediante
códigos de 6 dígitos; no se habilita el proveedor de enlaces por correo. Detalle en
[`docs/operations/integrations.md`](./docs/operations/integrations.md).

## 7. Desplegar el Worker manualmente (registra DO y consumers)

Todo el flujo se ejecuta desde la máquina del operador. No despliegues si falla
alguno de estos pasos:

```powershell
# 1. Validación completa local.
pnpm verify:all

# 2. Backup remoto cifrado y restore drill.
$env:D1_BACKUP_ENCRYPTION_KEY = "<32 bytes en hex o base64>"
$env:D1_BACKUP_ENCRYPTION_KEY_ID = "archivo-2026-07"
pnpm d1:backup

# 3. Revisar y aplicar migraciones antes del Worker.
pnpm --filter server exec wrangler d1 migrations list GATOPAGO_DB --remote
pnpm --filter server exec wrangler d1 migrations apply GATOPAGO_DB --remote

# 4. Sólo en la primera instalación: comprobar y crear las Queues declaradas.
pnpm --filter server exec wrangler queues list
# Si no existen:
# pnpm --filter server exec wrangler queues create parmelia-scheduled-jobs
# pnpm --filter server exec wrangler queues create parmelia-scheduled-jobs-dlq

# 5. Ejecutar los mismos guards de fuente/config y validar sin publicar.
pnpm --filter server cf-typegen:check
pnpm --filter server run deploy -- --dry-run

# 6. Desplegar la fuente local verificada. Wrangler registra también la
# migración v2 de RpcAdmissionController declarada en wrangler.jsonc.
# Wrangler ejecuta `forge build` automáticamente para regenerar los ABIs que
# consume `shared/index.ts`, incluso si `contracts/out` fue limpiado.
$releaseSha = git rev-parse HEAD
pnpm --filter server run deploy -- --keep-vars --strict --message "manual $releaseSha"

# 7. Exigir readiness saludable.
$health = Invoke-RestMethod -Uri "https://server.parmelia.workers.dev/health"
if ($health.status -ne "ok" -or $health.issueCount -ne 0) {
  throw "El Worker desplegado no está saludable"
}
```

Mueve el backup cifrado a almacenamiento protegido fuera del workspace. El
despliegue usa las credenciales locales de Wrangler y los secrets ya guardados
en Cloudflare; nunca copies sus valores a comandos, documentación o Git.

### Rollback del Worker

Si el healthcheck falla o aparece una degradación, identifica el version ID
anterior y revierte explícitamente. Las migraciones actuales son aditivas y
**no** se revierten con el Worker; no las deshagas a ciegas. Para daño de datos
usa primero el bookmark Time Travel o el backup cifrado pre-deploy descrito en
la sección 5.

```bash
cd server
pnpm exec wrangler versions list
pnpm exec wrangler rollback <VERSION_ID_ANTERIOR> --message "rollback <INCIDENTE>" --yes
```

## 8. Cliente

**Local** - `client/.env` (ya con `VITE_CHAIN_KEY=arbitrum-sepolia`). Añade las
de integraciones cuando las tengas:
```
VITE_SERVER_URL=https://server.parmelia.workers.dev
VITE_TURNSTILE_SITE_KEY=...        # site key de Turnstile (pública)
VITE_FIREBASE_VAPID_KEY=...        # VAPID pública (web push)
VITE_FIREBASE_MEASUREMENT_ID=...   # G-XXXX cuando habilites GA4
```
```bash
pnpm --filter client dev
```

**Producción (Vercel)** - `client/` está enlazado al proyecto existente
`parmelia` del team fijado en `.vercel/project.json` y es desplegable de forma autónoma. Su lockfile,
configuración de pnpm y `package.json` fijan pnpm 11 y Node 24. Las variables
`VITE_*` viven en el entorno Production del proyecto. Ejecuta desde `client/`:

```powershell
vercel login
pwsh -File scripts/deploy-phase2-frontends.ps1
```

Ese flujo actualiza `app.parmelia.me` sin relink del cliente y promueve también
el dashboard. `-PlanOnly` permite revisar el alcance sin autenticar ni mutar;
`-ConfigureOnly` configura proyectos/variables sin desplegar.

## 9. Smoke test (en orden)

```bash
pnpm --filter server test:unit           # 253 tests Node
pnpm --filter server test:worker-runtime # 22 tests workerd + D1 real
pnpm test:fork                            # 197 pasan; 6 forks vivos, 0 omitidos
pnpm --filter server exec wrangler tail server # dejar abierto para ver logs
```

En la app:
1. Login → Onboarding → crear cuenta (passkey). ✓ wallet creada + **5 USDC de bienvenida** (si falla, al relayer le falta USDC/ETH).
2. Crear link de cobro → pagarlo desde una segunda cuenta. ✓ ambos lados aparecen en Actividad/Extractos (ledger).
3. `/swap`: cotizar USDC/ETH. Nota: en Sepolia puede no haber liquidez v3/v4 ("sin ruta disponible" es esperado); el flujo completo se valida en One.
4. En `wrangler tail`, después de crear la wallet esperar
   `event_jobs_dispatched`, seguido por `indexer_run` y `event_job_completed`.
   `indexer_run` debe incluir `finalitySource` (`safe` o `confirmations`) y un
   `unconfirmedBlocks` acotado; un crecimiento sostenido indica RPC degradado.
5. Enviar USDC a la wallet desde una EOA externa. Con Address Activity aparece
   al llegar el webhook; sin él, abrir Home stale despierta el backfill y lo
   recupera. Esperar dos minutos sin actividad ya no es una prueba válida.
6. Contactos: copiar tu código, abrir `localhost:5173/?ref=CODIGO` en incógnito, crear cuenta → el contador sube.

## 10. Delta para Arbitrum One (cuando toque)

1. Exporta todas las direcciones de rol de §11 y ejecuta el mismo `forge script`
   con `--rpc-url https://arb1.arbitrum.io/rpc` y `--sender <DEPLOYER>`. Verifier,
   implementación y factory conservan direcciones CREATE2 si el bytecode no
   cambió; routers con argumentos de rol distintos tendrán direcciones distintas.
2. `CHAIN_KEY=arbitrum-one` en `wrangler.jsonc` + secrets de mainnet (RPC, claves fondeadas con ETH real).
3. El faucet queda apagado por defecto. Para activarlo deliberadamente configura `FAUCET_ENABLED=true` y `FAUCET_DAILY_BUDGET_USDC`; sin ambos no mueve USDC real.
4. Activar fees si quieres: `GATOPAGO_FEES_ENABLED=true`, `GATOPAGO_SWAP_FEE_BPS`, `GATOPAGO_TREASURY_ADDRESS`.
5. El bridge (`/depositar`) se activa solo en One; re-verificar las USDC externas contra Circle docs.
6. **Separar las claves de infra** - ver sección 11. Es el cambio más importante para mainnet.
7. Otros pendientes P1 antes de público real: rate limiting de zona, bundler gestionado (#13).

## 11. Consideraciones de seguridad para mainnet (separación de claves)

> **En testnet (Arbitrum Sepolia) se permite usar UNA sola EOA para todo**
> (deployer = relayer = faucet = paymaster signer = guardian, misma `PRIVATE_KEY`).
> Son fondos de prueba: el riesgo es cero y simplifica el setup. Lo de abajo
> **NO aplica al deploy de testnet** - es la lista para endurecer antes de mainnet.

### Por qué importa en mainnet

El broadcaster necesita autoridad temporal para fondear/configurar el Paymaster,
pero no debe conservarla. En Arbitrum One, `DeploymentRoles` falla cerrado si
broadcaster, owner final, treasury o firmantes colisionan. El script configura
el sponsor, inicia `transferOwnership` y deja pendiente la aceptación del owner
final; PaymentRouter y CrosschainRouter nacen directamente con roles separados.

Importante: **los fondos de los usuarios siguen a salvo** pase lo que pase -
moverlos exige su passkey. El daño máximo de una clave de infra comprometida es
gastar el gas/faucet, spamear, o *proponer* un recovery (mitigado por timelock de
48h + cancelación del usuario). Lo que protegemos aquí es el dinero del gas y la
disponibilidad del servicio, no la custodia.

### Setup mínimo de roles separados

| Clave | Rol | Dónde vive | Poder |
|---|---|---|---|
| **Deployer** (`wallet-0x75`) | Sólo broadcast inicial | EOA de despliegue, fuera del Worker | Despliega y configura antes del handoff |
| **Contract owner** | Owner final de Paymaster/routers | Safe/multisig o control frío | Admin, pausa, retiros y rotación |
| **Treasury** | Recibir fees | Custodia separada | Recibe fondos; no administra contratos |
| **Relayer** (nueva) | `PRIVATE_KEY` del worker: `handleOps`, crear cuentas y CCTP | Caliente, en el worker | Gasta ETH operativo |
| **Faucet** (nueva) | `FAUCET_PRIVATE_KEY`: transfiere fondos de bienvenida | Caliente, en el Worker sólo si se activa | Limitada a su ETH/USDC presupuestado |
| **Paymaster signer** (nueva) | `PAYMASTER_SIGNER_PRIVATE_KEY`: firma patrocinios | Caliente, en el worker | Solo firma (sin fondos) |
| **Invoice signer** (nueva) | `PAYMENT_ROUTER_SIGNER_PRIVATE_KEY` | Caliente, en el Worker | Autoriza invoices; no administra |
| **Recovery guardian** (nueva) | `RECOVERY_GUARDIAN_PRIVATE_KEY`: propone/cancela recovery | Secret separado; HSM/MPC recomendado | Recovery con timelock, sin mover fondos directamente |

Pasos:
1. Prepara direcciones distintas y expórtalas antes de simular/broadcast:

   ```bash
   export GATOPAGO_CONTRACT_OWNER=<SAFE_O_ADMIN_FRIO>
   export GATOPAGO_TREASURY=<TESORERIA>
   export GATOPAGO_PAYMASTER_SIGNER=<SIGNER_PAYMASTER>
   export GATOPAGO_PAYMENT_ROUTER_SIGNER=<SIGNER_INVOICES>
   ```

2. Ejecuta los scripts con `--sender <DEPLOYER>`. Omitir una variable o reutilizar
   una dirección en chain `42161` revierte antes del primer broadcast.
3. El owner final ejecuta `acceptOwnership()` sobre el Paymaster (desde Safe si
   corresponde). Hasta entonces el deployer sigue siendo owner actual; no des por
   terminado el despliegue mientras `pendingOwner()` sea distinto de cero.
4. Carga sólo relayer/faucet/paymaster/invoice/guardian en secrets del Worker. Deployer,
   owner y treasury nunca se exponen al runtime.

### Pendientes de hardening (código)

- **Guardian dedicado (#8):** implementado. Mainnet exige `RECOVERY_GUARDIAN_PRIVATE_KEY` distinta de `PRIVATE_KEY`; para producción de alto valor sigue siendo preferible un contrato multisig/MPC/HSM y aprobación humana.
- **Least-privilege (#7):** implementado. `FAUCET_PRIVATE_KEY` firma y reserva su
  propio nonce; mainnet rechaza su ausencia o colisión cuando el faucet está activo.
- **Depósito del paymaster:** el script deja 0.01 ETH; recargar según volumen real.
- **Mismo `foundry.toml`** (solc + optimizer) entre testnet y mainnet para que CREATE2 dé las mismas direcciones.

## 12. Universal Checkout v1: routers y testnets

Los scripts leen direcciones oficiales y codehashes desde
`contracts/script/NetworkDeploymentConfig.sol`. No aceptan overrides de USDC,
CCTP ni EntryPoint y no leen claves privadas: la firma se entrega con
`--account`/keystore. `PAYMENT_NETWORKS` conserva cada source flag apagado hasta
que exista deploy, verificación, manifest y smoke real. Las tres testnets ya
pasaron esos gates; las entradas mainnet permanecen apagadas.

### 12.1 Preflight y dry-run obligatorio

```powershell
cd contracts
$sender = "<DEPLOYER_ADDRESS>"

forge script script/Deploy.s.sol:DeployPaymentRouter `
  --rpc-url $env:ARBITRUM_SEPOLIA_RPC_URL --sender $sender -vv
forge script script/Deploy.s.sol:DeployCctpPaymentRouter `
  --rpc-url $env:BASE_SEPOLIA_RPC_URL --sender $sender -vv
forge script script/Deploy.s.sol:DeployCctpPaymentRouter `
  --rpc-url $env:AVALANCHE_FUJI_RPC_URL --sender $sender -vv
```

Cada simulación valida chain ID, codehash de USDC/CCTP, CREATE2 deployer,
capabilities Fast/Standard y dirección predicha. Base admite Fast/Standard;
Fuji solo Standard. La política comercial queda en `0` durante el piloto. El
script nuevo despliega los CCTP routers con un techo inmutable de 100 bps para
evitar otro cambio de bytecode si alguna excepción futura se aprueba; el techo
es capacidad, no una comisión activa.

### 12.2 Broadcast y verificación de source

Repite cada comando anterior con la cuenta Foundry y verificación Sourcify:

```powershell
$account = "<KEYSTORE_ACCOUNT>"
$passwordFile = "<ABSOLUTE_TEMP_PASSWORD_FILE_OUTSIDE_REPO>"

forge script script/Deploy.s.sol:DeployPaymentRouter `
  --rpc-url $env:ARBITRUM_SEPOLIA_RPC_URL `
  --account $account --password-file $passwordFile --sender $sender `
  --broadcast --verify --verifier sourcify
```

Usa `DeployCctpPaymentRouter` para Base Sepolia y Fuji. Usa además
`DeployCrosschainRouter` en Arbitrum Sepolia para reemplazar el outbound antiguo
por la versión con replay, allowlist de dominios y finality estricta. Nunca
agregues `--resume` sin comparar primero `run-latest.json`, la dirección
predicha y el código ya presente. El password file es temporal, vive fuera del
repositorio y se elimina al terminar; nunca se copia a un manifest o log.

Hay dos deployments distintos en Arbitrum y ambos escriben bajo
`broadcast/Deploy.s.sol/421614`. Conserva el `run-<timestamp>.json` de cada uno y
úsalo en su manifest; no permitas que un `run-latest.json` posterior reemplace la
evidencia que todavía no se procesó.

### 12.3 Manifest por contrato

Después de confirmar la verificación pública, genera el manifest desde la raíz:

```powershell
node scripts/write-contract-deployment-manifest.mjs `
  --broadcast contracts/broadcast/Deploy.s.sol/421614/run-<timestamp>.json `
  --rpc-url $env:ARBITRUM_SEPOLIA_RPC_URL `
  --output contracts/deployments/421614/payment-router-v2.json `
  --contract ParmeliaPaymentRouterV2 --chain-id 421614 `
  --owner $owner --treasury $treasury `
  --authorization-signer $authorizationSigner `
  --pause-guardian $pauseGuardian `
  --verification-url <EXPLORER_OR_SOURCIFY_URL>
```

El generador consulta el RPC y falla si no coinciden receipt, chain, runtime
bytecode, owner, treasury, signer, pause guardian o aceptación de ownership. El
schema versionado vive en `contracts/deployments/manifest.schema.json`.

Solo después de esos gates **y** de los smokes de §12.4 se rellenan las
direcciones y se activa `paymentSource` para las tres testnets en
`shared/networks.ts`. No se habilita ninguna mainnet en esta fase.

### 12.4 Smokes reales de cierre

Un broadcast no cierra la fase. Con `GATOPAGO_SMOKE_AMOUNT` omitido cada smoke
mueve `0.1 USDC` testnet y comprueba la configuración inmutable antes de firmar.
Ejecuta los cuatro rails, conservando el hash de cada transacción:

```powershell
cd contracts
$env:GATOPAGO_SMOKE_ROUTER = "<ARBITRUM_LOCAL_ROUTER>"
forge script script/SmokeUniversalCheckout.s.sol:SmokePaymentRouter `
  --rpc-url $env:ARBITRUM_SEPOLIA_RPC_URL `
  --account $account --password-file $passwordFile --sender $sender --broadcast -vv

$env:GATOPAGO_SMOKE_ROUTER = "<BASE_CCTP_ROUTER>"
forge script script/SmokeUniversalCheckout.s.sol:SmokeCctpPaymentRouter `
  --rpc-url $env:BASE_SEPOLIA_RPC_URL `
  --account $account --password-file $passwordFile --sender $sender --broadcast -vv

$env:GATOPAGO_SMOKE_ROUTER = "<FUJI_CCTP_ROUTER>"
forge script script/SmokeUniversalCheckout.s.sol:SmokeCctpPaymentRouter `
  --rpc-url $env:AVALANCHE_FUJI_RPC_URL `
  --account $account --password-file $passwordFile --sender $sender --broadcast -vv

$env:GATOPAGO_SMOKE_ROUTER = "<ARBITRUM_OUTBOUND_ROUTER>"
forge script script/SmokeUniversalCheckout.s.sol:SmokeCrosschainRouter `
  --rpc-url $env:ARBITRUM_SEPOLIA_RPC_URL `
  --account $account --password-file $passwordFile --sender $sender --broadcast -vv
```

Los dos primeros tipos de router deben terminar con `usedAttempt = true` y
`paidIntent = true`; el outbound endurecido debe terminar con `usedOpId = true`.
Los cuatro deben conservar saldo USDC cero. Los burns usan finality Standard y
`destinationCaller = bytes32(0)`. Verifica esos valores otra vez mediante RPC y
receipt después del broadcast: los asserts que corren durante `forge script`
prueban la simulación, no sustituyen la lectura posterior de la testnet.

### 12.5 Cierre de fase 1 en testnet (24-ago-2026)

| Rail | Router | Source tx | Destination tx |
|---|---|---|---|
| Arbitrum local | `0x64e0B48A4D360B235C3fEDe2431D79413aebb7A4` | `0x27c3261d…09fe0` | misma transacción |
| Base → Arbitrum | `0x961C08Bd5a11EFB7264B06d7f14a44FB4d9958Ba` | `0xe7bb8727…bc071` | `0x849df136…e3e2` |
| Fuji → Arbitrum | `0xd8289B87b155e8691Da192b12E12E2b592fE7D1E` | `0x8b692d55…ccea0` | `0x441bc801…268a` |
| Arbitrum → Fuji | `0xD089c3764a8F2E62eFDf280Eb2432c1dC647400c` | `0xa4741fd8…2364` | `0x7bb5b422…aa44` |

Los cuatro sources terminaron con receipt exitoso, IDs consumidos y saldo cero
en el router. Los tres mensajes CCTP v2 llegaron a `complete`, se ejecutó
`receiveMessage` en destino y `usedNonces` quedó en `1`. Los cuatro deployments
tienen `exact_match` en Sourcify. La evidencia completa y los hashes sin abreviar
están en `contracts/deployments/testnet-smoke-evidence.json`; las direcciones y
roles están en los cuatro manifests por contrato. Solo después de este cierre se
activaron Arbitrum Sepolia, Base Sepolia y Fuji en `PAYMENT_NETWORKS`. No se
desplegó ni habilitó ninguna mainnet.

### 12.6 Activación futura y acotada de comisiones

No hay que redeployar para cambiar una regla **si** el router ya tiene techo
suficiente. Sin embargo, los CCTP routers hoy desplegados en Base Sepolia y Fuji
tienen techo inmutable `0`: son correctos para el lanzamiento gratuito, pero
deben redeployarse antes de permitir cualquier fee positiva en esas rutas. Los
scripts locales ya preparan nuevos routers con cap `100`; esta edición no los
ha publicado ni ha cambiado manifests remotos.

Orden obligatorio si negocio aprueba una excepción de cobro:

1. Mantén `PAYMENT_FEE_POLICY_JSON` vacío mientras preparas infraestructura.
2. Para toda ruta cuyo manifest declare cap `0`, dry-run, despliega, verifica y
   ejecuta el smoke del router nuevo. Actualiza manifest y `shared/networks.ts`
   únicamente después de leer por RPC dirección, codehash, USDC, treasury,
   signer, pause state y cap.
3. Confirma que `0002_fee_policy_and_ledger.sql` figura aplicada en
   `d1_migrations` (no la reapliques), configura
   `PAYMENT_PLATFORM_FEE_RECIPIENT` y exige
   `PAYMENT_ROUTER_PREFLIGHT_ENABLED=true`.
4. Confirma `/health` y `/health/ops` verdes para **todas** las rutas habilitadas.
5. Activa primero una regla versionada canary, acotada por `merchantIds`, modo,
   chain, ruta y/o monto. Nunca estrenes una comisión con una regla global.
6. Comprueba quote, snapshot firmado, transferencias, ledger, dashboard y
   webhook. El comercio debe recibir siempre el neto del intent; la fee se suma
   al pagador y jamás se descuenta silenciosamente.
7. Para rollback elimina/deja vacío el documento de policy. Nuevas quotes vuelven
   a `free-default`; quotes positivas ya emitidas pueden reservarse solo hasta su
   expiración corta (2 min) y attempts firmados terminan con su snapshot original.
   Si el corte debe ser inmediato por incidente, deshabilita la source route o
   pausa el router y espera quote + authorization TTL antes de reabrir gratuito.

La App conserva además `GATOPAGO_FEES_ENABLED=false` como switch maestro para
swap/cross-chain personal y compatibilidad N-1. Los BPS aislados no cobran nada,
y la política canónica de merchant checkout vive solo en Payments para impedir
un doble cobro entre Workers.
