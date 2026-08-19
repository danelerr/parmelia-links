# Reauditoría técnica integral - GatoPago

**Fecha de corte:** 2026-07-13

**Estado:** informe autoritativo sobre el worktree auditado

**Precedencia:** reemplaza las conclusiones de cierre de
`CLAUDE_REVIEW_FABLE.md` y actualiza las mediciones de
`CODEX_PLAN_DE_IMPLEMENTACION_Y_MEJORAS.md`. Esos archivos se conservan como
historial, no como certificación vigente.

## Continuación de remediación - 2026-07-14

Esta sección tiene precedencia sobre la actualización del 13 de julio y cierra
varios límites que entonces seguían abiertos:

- Los secretos de webhook usan ahora `enc:v2:<key-id>` con AAD, keyring de
  claves previas y recifrado gradual compare-and-set. La clave anterior puede
  retirarse sin interrumpir entregas una vez terminada la migración.
- `runtimeConfig.ts` valida red, RPC, contratos, CORS, APP_URL, Turnstile,
  tesorería y keyring. Mainnet incompleta bloquea requests y cron con 503; las
  cuentas activas de firma deben ser distintas. `/health` expone sólo códigos.
- OpenAPI se parsea y compara en tests con las rutas reales registradas por
  Hono; un endpoint `/v1` no documentado o sobrante rompe CI. Redocly 2.37.0
  ejecuta además `recommended-strict` sobre OpenAPI 3.1, referencias, schemas,
  responses y `operationId` únicos como parte de `pnpm verify`.
- Gitleaks 8.30.1 escaneó los 31 commits. Ocho falsos positivos comprobados
  (direcciones públicas, ejemplos, Firebase web config y la clave pública de
  Anvil) quedaron allowlisted por fingerprint; el resultado final fue cero.
- Se añadieron tres fork smoke tests reales de Arbitrum Sepolia para GatoPago,
  EntryPoint, CCTP, Universal Router y Aave, incluyendo supply/withdraw y burn
  CCTP state-changing. Los tres pasaron contra el RPC público.
- Playwright ejecuta cliente/dashboard en desktop y Pixel 7: 12/12 pruebas pasan;
  los proyectos del dashboard ignoran por configuración los specs client-only.
  Login, link de pago y checkout cross-chain pasan reglas automatizadas WCAG
  2 A/AA, 2.1 AA y 2.2 AA, orden de teclado, foco visible y overflow. El gate
  queda en CI; la revisión manual con lector de pantalla sigue siendo externa.
- Node CI está fijado a 22.14.0, pnpm a 10.31.0, Foundry CI a v1.7.1 y Gitleaks
  a un binario con SHA-256 verificado.
- Semgrep no reporta hallazgos con las reglas `p/ci`. Slither bloquea cualquier
  hallazgo medio/alto nuevo y conserva una excepción exacta y revisada para el
  valor diagnóstico de `tryRecover` que no se usa después de validar su error.
- Actionlint 1.7.12, descargado con SHA-256 fijado, valida sintaxis, expresiones,
  acciones y scripts shell de todos los workflows como parte de análisis estático.
- Foundry lint no reporta advertencias altas, medias ni bajas y ese gate queda
  bloqueante en CI.
- Vitest Pool Workers ejecuta 10 pruebas dentro de `workerd` con D1 aislado:
  aplica `0001`-`0011`, comprueba STRICT/FK, health/auth/body limit, CORS,
  Web Crypto y el lease de cron. Un entorno test-only impide cargar secretos de
  `.dev.vars`; typegen y tipos de la suite también son gates de `pnpm verify`.
- `/pay/submit` persiste el broadcast y devuelve 202; el cron confirma
  `UserOperationEvent(success)`, liquida de forma idempotente y repara incluso
  un hand-off CCTP interrumpido después de enviar la transacción.
- `Bindings` deriva de `CloudflareBindings` generado y `wrangler types --check`
  bloquea drift. Gitleaks revisa tanto los 31 commits como el worktree actual.
- Los logs del Worker son JSON estructurado, validan el `requestId` y redactan
  credenciales, secretos y datos sensibles de URLs. Un gate estático impide
  reintroducir `console.*` fuera del logger central.
- El `requestId` se crea una vez por petición, se devuelve como
  `X-Request-Id` y correlaciona respuestas y logs. Se retiró el logger textual
  de Hono para no filtrar query strings ni mezclar formatos.
- El lease del cron tiene heartbeat owner-bound y los ocho jobs se esperan con
  `allSettled`; un fallo temprano ya no libera el lock mientras otros trabajos
  siguen en vuelo.
- El servidor tiene ESLint type-aware bloqueante para promesas flotantes o mal
  usadas. TypeScript también compila ahora las trece suites Node, no sólo `src`.
- JWKS, FCM, Turnstile, Iris y Across usan timeouts y JSON acotado; respuestas
  ignoradas se cancelan para liberar la conexión. El token OAuth de FCM queda
  restringido al endpoint oficial de Google.
- Se eliminó del disco un service-account JSON de Firebase que estaba ignorado
  por Git. La revocación/rotación de esa credencial en GCP sigue siendo una
  acción externa obligatoria; borrar el archivo no invalida la clave.
- Creación de cuenta, faucet y propose/execute/cancel de recovery ya no esperan
  receipts dentro del request. La transacción firmada se guarda antes del
  broadcast en `account_operations`, con lease de nonce por firmante, respuesta
  202, polling autenticado y reconciliador cron. La finalización D1 es
  idempotente y el faucet compensa claim/presupuesto ante revert.
- Todas las escrituras de la EOA operativa (`handleOps`, mints CCTP y
  cuenta/faucet/recovery) comparten un lease D1 por red+firmante. Una transacción
  raw aún `prepared` o `needs_review` conserva su reserva de nonce y bloquea
  nuevos envíos; sólo su reconciliador puede reemitirla.
- Readiness consulta D1: `/health` devuelve `signer_nonce_blocked` ante una
  reserva ambigua y `d1_unavailable` si no puede comprobarla, sin exponer
  hashes, nonces, IDs ni direcciones.
- CI compara semánticamente los snapshots de storage layout y sólo admite
  apéndices al final. También ejecuta cobertura Foundry por contrato con floors
  bloqueantes de líneas, branches y funciones.
- Los cinco contratos críticos superan 80% de branches: AccountWebAuthnV2
  88.24%; Factory, Paymaster, PaymentRouter y CrosschainRouter 100%. El
  paymaster rechaza un EntryPoint sin bytecode y el router cross-chain rechaza
  token/messenger sin bytecode; sus caminos de depósito, retiro, `postOp`, firma
  malformada y administración quedaron cubiertos.
- El preflight D1 captura bookmark Time Travel, exporta SQL remoto, exige una
  clave separada, cifra en streaming con AES-256-GCM, genera hashes/manifest y
  valida un restore aislado antes de conservar el backup. CI ejecuta el mismo
  ciclo con las once migraciones y una relación FK real.
- Los cuatro scripts de deploy comparten una política fail-closed: en Arbitrum
  One broadcaster, owner, treasury y firmantes requeridos deben ser no nulos y
  distintos. El Paymaster configura el sponsor, emite `SponsorSignerSet` e
  inicia el handoff `Ownable2Step`; el owner final debe aceptarlo explícitamente.
- El faucet usa `FAUCET_PRIVATE_KEY`, wallet client y lease de nonce propios. Si
  se activa en mainnet, runtime rechaza clave ausente o colisionada; el indexer
  excluye tanto relayer como faucet para no duplicar depósitos en el ledger.
- Indexer, watcher de invoices y watcher de recovery ya no avanzan el cursor
  hasta `latest`: usan `safe` cuando está próximo al tip y un buffer de 64
  bloques si el proveedor no lo soporta o lo entrega demasiado rezagado. Logs y
  pruebas cubren ambas rutas para reducir acreditaciones sobre reorgs someros.
- CI construye una sola vez el Worker, genera un manifest determinista con
  SHA-256 por archivo ligado al commit completo y publica `worker-<sha>`. El
  workflow manual de testnet sólo acepta un CI exitoso del mismo commit en
  `main`, verifica el artefacto, respalda/restaura D1, migra, despliega con
  `--no-bundle` y exige readiness saludable. Si el nuevo Worker queda unhealthy,
  revierte a la versión estable anterior y comprueba de nuevo `/health`, sin
  intentar deshacer automáticamente las migraciones D1.

Evidencia actual: `pnpm verify:all` OK (15 archivos / 129 tests Node + 10 runtime
Worker, restore D1 de 23 tablas), drill de artefacto con detección de tampering y
archivos extra, deploy `--no-bundle --dry-run` OK, `pnpm test:e2e` 12/12, `forge test` 124
unitarios + 3 fork reales, audit de
dependencias sin vulnerabilidades conocidas, Gitleaks y Semgrep sin hallazgos,
gate Slither medio/alto OK y dry-run Wrangler 4.107 OK.

Continúan como requisitos externos/operativos: revocar la credencial Firebase
retirada, proteger `main` y exigir aprobación del environment `worker-testnet`,
ejecutar el workflow de deploy (incluye backup y aplicación de `0011` en D1),
configurar las claves/vars reales, desplegar contratos mainnet (aún son
`TODO_DEPLOY`), sustituir guardian EOA por multisig/MPC/HSM para alto valor,
probar flujos completos autenticados con credenciales reales y obtener una
auditoría profesional independiente antes de manejar dinero real.

Deuda local residual de este frente: ninguna espera de receipt permanece en las
rutas HTTP de cuenta, faucet, recovery o pago. `crosschainRelayer` conserva una
espera dentro del job cron, fuera del ciclo de vida de un request.

## Actualización post-remediación - 2026-07-13

Las secciones siguientes conservan la evidencia y los hallazgos del baseline
previo a las correcciones. Esta actualización tiene precedencia sobre su estado:

- **P1-01/P1-02:** corregidos con claim persistente por link, liquidación
  link+intent+outbox en `D1.batch()`, IDs deterministas e índice único de fanout.
- **P1-03/P1-04:** corregidos con validación completa MessageV2/BurnMessageV2,
  selección del mensaje exacto, reconciliación `usedNonces` e historial de mints.
- **P1-05:** corregido; mainnet falla cerrado sin flag y presupuesto diario,
  y los límites monetarios fallan cerrado ante D1.
- **P1-06:** mitigado con guardian dedicado obligatorio y rate limits. Para
  mainnet de alto valor sigue pendiente sustituir la EOA individual por
  multisig/MPC/HSM y una auditoría operacional independiente.
- **P1-07:** corregido; el deadline no supera `expiresAt` y el watcher valida la
  hora del bloque.
- Webhooks nuevos guardan secretos AES-GCM, el cron migra secretos legados,
  las URLs bloquean protocolos/hosts privados inseguros y no siguen redirects.
- Dependencias actualizadas: `pnpm audit --prod` reporta **0 vulnerabilidades
  conocidas**. Node mínimo: 20.19.0.
- UI: focus visible, focus trap/inert en diálogos, sin `autoFocus` móvil y
  vendors separados con presupuesto de bundle bloqueante.

Evidencia posterior: `pnpm verify` OK (87 tests Worker), 10 migraciones D1
aplicadas sobre una base limpia, dry-run Wrangler 4.110 OK, `forge build --sizes`
OK y 80/80 pruebas Solidity OK. Continúan fuera de alcance: QA visual con
navegador, fork tests de integraciones reales, escaneo histórico especializado
de secretos y auditoría profesional independiente previa a mainnet.

> Por tanto, el texto desde "Veredicto ejecutivo" describe el baseline que
> motivó la remediación, no el estado actual de implementación.

## 1. Veredicto ejecutivo

**No está listo para mainnet ni para coordinar dinero real sin otra pasada de
correcciones y validación.** La base es mejor que la descrita en auditorías
antiguas: lint, TypeScript, 80 pruebas del Worker y 80 pruebas Foundry pasan; los
tamaños de bytecode están bajo EIP-170 y no encontré un exploit crítico directo
en los contratos revisados. Sin embargo, siguen abiertos bloqueos de
arquitectura en la capa de aplicación:

1. El claim evita repetir un `userOpHash`, pero no evita que dos pagadores
   distintos paguen simultáneamente el mismo link.
2. El cambio de estado de un pago y la creación del evento/webhook no forman una
   transacción lógica; todavía se pueden perder o duplicar eventos.
3. La validación y reconciliación CCTP v2 no comprueban todos los campos que
   vinculan el mensaje con la operación y pueden perder el hash de un mint ya
   exitoso.
4. El faucet se activa por red sin una política explícita de testnet y su rate
   limiter D1 falla abierto.
5. Todas las cuentas comparten como guardian a la misma EOA que relaya y fondea;
   una sola clave compromete la recuperación de toda la base de usuarios.
6. `pnpm audit --prod` reporta **53 vulnerabilidades**: 1 crítica, 17 altas,
   32 moderadas y 3 bajas.

**Testnet:** utilizable de forma condicionada para pruebas controladas, con
fondos limitados y monitorización. **Mainnet:** bloqueado hasta cerrar P1,
actualizar dependencias, instalar CI y obtener una auditoría profesional
independiente de contratos y operación.

## 2. Alcance y método

Se revisaron el cliente React, dashboard React, Worker Hono/Cloudflare, D1 y sus
migraciones, API pública y OpenAPI, lógica WebAuthn/AA, contratos Solidity,
scripts de despliegue, CCTP, Aave, Uniswap, service worker, configuración,
dependencias, documentación, secretos e historial Git.

La revisión combinó lectura manual, búsqueda estática, compilación, pruebas,
cobertura, bytecode, lint de Forge, auditoría de dependencias y contraste con
fuentes oficiales actuales. No se modificó código de producto durante esta
reauditoría.

### 2.1 Evidencia ejecutada

| Comprobación | Resultado |
|---|---|
| `pnpm lint` | OK, cero warnings en client y dashboard |
| `pnpm --filter server test` | OK, 8 archivos / 80 tests |
| `pnpm --filter server exec tsc --noEmit` | OK |
| `pnpm --filter client build` | OK; main 522.70 kB / 169.16 kB gzip; warning de chunk >500 kB |
| `pnpm --filter dashboard build` | OK; main 382.43 kB / 123.67 kB gzip |
| `forge test` | OK, 80 tests |
| `forge build --sizes` | OK; Account 15,690 B, Paymaster 5,301 B, PaymentRouter 6,215 B, CrosschainRouter 4,210 B |
| `forge lint` | Sin error bloqueante; notas de estilo/assembly y casts en tests |
| `forge coverage --ir-minimum --report summary` | OK; total 68.65% líneas, 55.38% branches, 75.76% funciones |
| `pnpm audit --prod` | **FAIL:** 53 vulnerabilidades (1 crítica / 17 altas / 32 moderadas / 3 bajas) |
| `pnpm outdated -r` | Varias dependencias directas y de toolchain desactualizadas |
| Superficie OpenAPI vs. `/v1` | Coincide a alto nivel; no existe contract test automatizado |
| Direcciones Aave/CCTP/EntryPoint | Contrastadas con registros oficiales actuales |
| Búsqueda básica de secretos | Sin private keys/secretos de servidor detectados en el árbol actual; Firebase client config aparece en historial |

Cobertura total incluyendo `script/Deploy.s.sol`: 68.65% líneas, 55.38%
branches y 75.76% funciones. Por contrato fuente: Account 91.67% líneas / 88.24%
branches; Factory 84.21% / 33.33%; Paymaster 73.08% / 66.67%; PaymentRouter
81.13% / 42.11%; CrosschainRouter 93.75% / 66.67%. Foundry advierte que
`--ir-minimum` puede producir mapeos de fuente inexactos; sin esa opción la
cobertura falla por `stack too deep` en P256 de OpenZeppelin.

### 2.2 Límites de esta pasada

- Slither, Semgrep y Gitleaks no están instalados. La búsqueda de secretos no
  equivale a un escaneo histórico exhaustivo con reglas especializadas.
- No fue posible ejecutar QA visual/interactiva: los servidores Vite iniciaron,
  pero el controlador reportó que no había backend de navegador disponible. La
  auditoría de UI de esta pasada es estática.
- No se ejecutaron fork tests contra despliegues reales de Aave, CCTP,
  EntryPoint, Universal Router ni PaymentRouter.
- Esta revisión de contratos no sustituye una auditoría independiente ni un
  programa de bug bounty antes de mainnet.

## 3. Bloqueos P1

### P1-01 - El mismo link puede recibir dos pagos on-chain

**Evidencia:** `server/src/routes/pay.routes.ts:334` relee el link; el claim de
`server/src/routes/pay.routes.ts:495` y `server/src/services/storage.ts:518` sólo
serializa por `userOpHash`. El compare-and-set final de
`server/src/services/storage.ts:408` impide sobrescribir el registro, pero ocurre
después de que el dinero se movió.

**Impacto:** dos pagadores con UserOperations diferentes pueden observar
`pending`, ambos emitir una transferencia válida y sólo uno ganar
`markPaymentLinkPaid`. El segundo pago queda económicamente ejecutado pero sin
atribución correcta. La afirmación de cierre anterior era incorrecta.

**Corrección requerida:** claim/lease atómico a nivel de link antes del
broadcast (`pending -> paying`, owner, expiración), con compensación sólo si no
hubo broadcast; o hacer obligatorio `ParmeliaPaymentRouter` y su replay guard
on-chain para links. No basta otro read previo.

**Aceptación:** test concurrente con dos usuarios, dos `userOpHash` y el mismo
`linkId`; exactamente una llamada llega a `handleOps`, la otra recibe 409 y no
mueve fondos. Añadir reconciliación de leases vencidos.

### P1-02 - Estado de pago, outbox y fanout no son atómicos

**Evidencia:** `server/src/services/settlement.ts:89-98` degrada a `void p` sin
`waitUntil`; el link/intent se marca pagado en `settlement.ts:232-245` y el evento
se difiere después en `settlement.ts:248-269`. `emitEvent` crea primero un evento
aleatorio y luego deliveries secuenciales (`server/src/services/webhooks.ts:53-92`),
captura cualquier error y devuelve `null`. El watcher hace lo inverso, evento
antes del estado (`server/src/services/indexer.ts:238-261`), por lo que un retry
genera otro ID. El cron sí usa `ctx.waitUntil`, pero los efectos internos siguen
sin una unidad transaccional.

**Impacto:** crash/fallo D1 puede dejar un pago confirmado sin webhook, un
evento sin todos sus deliveries o varios `payment.paid` para el mismo objeto. La
deduplicación se delega al consumidor sin una clave estable. Además,
`webhook_endpoints.secret` se almacena en texto utilizable
(`server/migrations/0002_api.sql:57`, `server/src/services/storage.ts:1418`), no
“sólo como hash” como decía el documento anterior.

**Corrección requerida:** transición de dominio + fila de outbox determinista
en un `D1.batch()` transaccional; índice único por
`(merchant_id, mode, type, object_id)` o `dedupe_key`; fanout reanudable e
idempotente; nunca usar Promises flotantes. Para HMAC, cifrar secretos en reposo
con KEK gestionada y AES-GCM/versionado de claves, o adoptar un esquema de firma
que no requiera recuperar el secreto compartido.

**Aceptación:** fault-injection después de cada statement y tests concurrentes
demuestran: un único evento lógico, todos los endpoints terminan en delivery
reintentable y ningún pago confirmado queda sin outbox.

### P1-03 - Validación CCTP v2 incompleta

**Evidencia:** `validateCctpMessage` sólo comprueba domains, `mintRecipient` e
importe (`server/src/services/crosschainRelayer.ts:187-208`). No valida versiones,
`sender`, `recipient`, `destinationCaller`, finality, `burnToken`,
`messageSender`, `maxFee`, `feeExecuted` ni expiración. `fetchAttestation` toma el
primer mensaje completo de una transacción (`crosschainRelayer.ts:103-116`), no
el que corresponde a la operación.

**Impacto:** MessageTransmitter transporta mensajes genéricos. Un mensaje
atestado pero dirigido a otro contrato, emitido por otro sender/token o con
semántica distinta puede consumir gas, contaminar el estado de soporte o
vincular la operación al mensaje equivocado. Una transacción con varios mensajes
puede aparcar una operación legítima.

**Corrección requerida:** parseador estructurado con longitud exacta y validación
de todos los campos de MessageV2/BurnMessageV2 contra el registro de cadenas y la
operación. Seleccionar entre todos los mensajes del tx por nonce/campos esperados.

**Aceptación:** corpus adversarial que altere individualmente cada campo y
multi-message tx; sólo el mensaje exacto pasa. Verificar fixtures contra Circle.

### P1-04 - Un retry CCTP puede perder el hash que sí minteó

**Evidencia:** si `getTransactionReceipt(destinationTxHash)` lanza, el código
considera “pending/not found” equivalentes, reenvía `receiveMessage` y sobrescribe
el hash (`server/src/services/crosschainRelayer.ts:270-297`). CCTP consume el
nonce una sola vez.

**Impacto:** el primer mint puede confirmarse después; el segundo revierte por
nonce usado y su hash reemplaza al exitoso. La operación puede quedar
`recoverable`/`needs_support` aunque el usuario ya recibió fondos.

**Corrección requerida:** historial de intentos, no reenviar una tx pendiente,
distinguir dropped/replaced/reverted y reconciliar por nonce/evento
`MessageReceived` antes de cualquier retry. “Nonce already used” debe disparar
reconciliación, no otro envío.

**Aceptación:** tests para receipt pendiente, RPC 404 transitorio, replacement,
primer mint tardío y segundo revertido; todos convergen a `completed` con el hash
on-chain correcto.

### P1-05 - Faucet real sin gate de red y rate limiter fail-open

**Evidencia:** creación de cuenta y `/account/fund` transfieren 5 USDC sin
comprobar `isTestnet` (`server/src/routes/account.routes.ts:143-170,309-364`). El
rate limiter declara y ejecuta fail-open ante error D1
(`server/src/services/storage.ts:584-615`). Turnstile y claim por usuario reducen
abuso, pero no fijan presupuesto global ni impiden altas masivas.

**Impacto:** al completar el despliegue de contratos de mainnet, el faucet se
activa implícitamente con USDC real. Una degradación D1 elimina uno de los gates
y una granja de identidades/IP puede drenar el treasury.

**Corrección requerida:** faucet deshabilitado por defecto cuando `!isTestnet`,
feature flag explícita, allowlist/cupo global diario, circuit breaker y alertas.
Los límites de rutas que mueven dinero deben fallar cerrado o usar un servicio de
rate limiting con disponibilidad separada.

**Aceptación:** mainnet sin flag siempre devuelve `FAUCET_DISABLED`; falla D1 no
transfiere; tests de presupuesto global y concurrencia prueban que nunca se
supera el cupo.

### P1-06 - Guardian global y clave de recuperación con blast radius total

**Evidencia:** cada cuenta usa `serverAccount.address` como guardian
(`server/src/routes/account.routes.ts:58-61`). `PRIVATE_KEY` sirve además para
relayer y faucet (`server/src/services/keys.ts:4`, `server/README.md:52`). Los
endpoints de propose/execute recovery dependen de la sesión Firebase y no tienen
rate limit específico (`account.routes.ts:375-472`).

**Impacto:** comprometer una sola EOA permite proponer recuperación sobre todas
las wallets. El timelock de 48 h ayuda a detectar, pero no elimina un takeover
masivo; una sesión Firebase robada puede iniciar el flujo que firma el guardian
del servidor.

**Corrección requerida:** separar rol/clave de recovery; Safe/multisig, MPC/HSM o
AccessManager con políticas, límites y aprobación humana para mainnet; guardianes
por usuario o recuperación social; rate limits, auditoría inmutable y alertas
multicanal.

**Aceptación:** ninguna clave individual puede reemplazar signers; pruebas de
compromiso de Firebase, relayer y un aprobador aislado no completan recovery.

### P1-07 - Una autorización router puede vivir más que el intent

**Evidencia:** `/v1` comprueba que el intent no esté vencido antes de autorizar
(`server/src/routes/v1.routes.ts:238-246`), pero
`buildRouterAuthorization` fija siempre `now + 3600 s`
(`server/src/services/paymentRouter.ts:83`) y el watcher sólo filtra por status
(`server/src/services/indexer.ts:215-216`).

**Impacto:** un intent con segundos de vigencia recibe una firma pagable durante
una hora. El pago on-chain puede ocurrir después de `expiresAt` y aun ser
aceptado/atribuido por el watcher.

**Corrección requerida:** `deadline = min(expiresAt, now + authWindow)` y aplicar
la misma política de expiry en autorización, contrato/watcher y API.

**Aceptación:** un intent que vence en 60 s produce deadline <=60 s; eventos
posteriores a la expiración siguen una política explícita y probada.

### P1-08 - Dependencias de producción vulnerables

**Evidencia:** `pnpm audit --prod` falla con 53 hallazgos. Rutas principales:

| Paquete instalado | Riesgo máximo | Piso que cubre los advisories observados |
|---|---:|---:|
| `protobufjs 7.5.4` vía Firebase/Firestore/grpc | crítica | `>=7.6.3` |
| `@grpc/grpc-js 1.9.15` | alta | `>=1.9.16` |
| `hono 4.12.5` | alta | `>=4.12.25` |
| `react-router 7.13.1` | alta | `>=7.15.1` |
| `vite 7.3.1` | alta | `>=7.3.5` |
| `picomatch 4.0.3` | alta | `>=4.0.4` |
| `ws 8.18.x` | alta | `>=8.21.0` |
| `esbuild 0.27.3` | baja | `>=0.28.1` |

No se observaron imports de Firestore ni `protobuf/grpc` en los bundles
entregados, por lo que el crítico de `protobufjs` parece pertenecer a la cadena
de instalación de Firebase y no al código cargado del navegador. Sigue siendo
un riesgo de supply chain y no autoriza ignorarlo.

**Corrección requerida:** actualizar directas, regenerar lockfile y usar
overrides sólo cuando la compatibilidad esté probada. Firebase 12.16 actualiza
su árbol, pero sus rangos no garantizan por sí solos todas las versiones mínimas:
repetir audit/why/build/tests después del lock update. No ejecutar `audit fix`
ciego sobre una aplicación financiera.

**Aceptación:** `pnpm audit --prod` sin critical/high; excepciones moderadas
documentadas con exposición, owner, vencimiento y compensación.

### P1-09 - No hay CI ni release gates reproducibles

**Evidencia:** no existe `.github/`; el `lint` raíz omite server, `test` no
compila ambos frontends y no hay comando agregado de verify
(`package.json:4-17`). Tampoco hay gates de audit, typegen, OpenAPI, migraciones,
coverage, bytecode o bundle.

**Impacto:** una release puede saltarse precisamente las verificaciones que hoy
detectan vulnerabilidades y regresiones financieras.

**Corrección requerida:** CI con install frozen, lint completo, typecheck,
Vitest, Forge test/size/coverage, builds, audit, typegen diff, migraciones en D1
temporal, OpenAPI contract tests y presupuestos de bundle. Fijar Node/pnpm/Foundry.

**Aceptación:** branch protection impide merge/deploy si falla cualquier gate;
el deploy consume artefactos del commit ya verificado.

## 4. Hallazgos P2

| ID | Hallazgo y evidencia | Acción recomendada |
|---|---|---|
| P2-01 | Carrera de `Idempotency-Key`: el link se inserta antes que el intent y el perdedor devuelve el ganador dejando un link huérfano (`server/src/routes/v1.routes.ts:138-181`). | Crear ambos en `D1.batch()` o eliminar compensatoriamente el link del perdedor. Test concurrente. |
| P2-02 | Sandbox puede emitir dos `payment.paid`: `markPaymentIntentPaid` no devuelve `didWrite` (`storage.ts:1378-1384`) y simulate siempre emite (`v1.routes.ts:267-280`). | Devolver CAS boolean y emitir sólo para el ganador. |
| P2-03 | El lock cron no tiene token de ownership: una ejecución vieja puede liberar la lease adquirida por otra (`storage.ts:766-792`). | Lease ID aleatorio, CAS al liberar y heartbeat/renovación. |
| P2-04 | Tipos Worker escritos a mano (`middlewares/auth.ts:7-46`) mientras `cf-typegen` genera `CloudflareBindings`; no hay drift gate. | Usar exclusivamente tipos generados y ejecutar `wrangler types` en CI. |
| P2-05 | `compatibility_date` quedó en 2026-03-16 y observability sólo activa logs, no traces (`server/wrangler.jsonc:5,27-32`). | Actualización periódica probada; habilitar traces y métricas/alertas. |
| P2-06 | 25 lecturas `c.req.json()` sin límite global previo; el Hono instalado además tiene advisory de `bodyLimit`. | Actualizar Hono y rechazar por tamaño antes de leer; límites por ruta. |
| P2-07 | Swap valida la mejor ruta fresca pero construye la ruta vieja (`swap.routes.ts:257-289`); además recalcula fee/treasury en prepare. | Revalidar exactamente la ruta guardada y congelar términos económicos; cualquier cambio exige nueva quote. |
| P2-08 | Ledger de swap acredita `amountOutEstimated` (`settlement.ts:125-133`) y withdraw max usa balance al preparar (`earn.routes.ts:157-159`). | Parsear logs/receipts o deltas on-chain; registrar importes ejecutados, no estimaciones. |
| P2-09 | `/pay/submit` devuelve mensajes RPC/`FailedOp` crudos (`pay.routes.ts:679-681`). | Códigos estables al cliente; detalle sólo en log con redacción. |
| P2-10 | CORS refleja cualquier origen si falta config, incluso en mainnet (`index.ts:29-49`). | Config requerida y fail-closed en entornos desplegados. |
| P2-11 | Webhook URL usa regex, admite localhost sin ligar a modo/entorno y `fetch` sigue redirects (`merchant.routes.ts:91-110`, `webhooks.ts:114`). | Parser `URL`, HTTPS en live, localhost sólo test/local, política de redirects y revalidación del destino. |
| P2-12 | Branch coverage débil: PaymentRouter 42.11%, Factory 33.33%; no hay fork/integration tests. | Cubrir errores/límites y añadir forks versionados contra protocolos/despliegues reales. |
| P2-13 | CSS elimina todo focus visible (`client/src/index.css:181-182`, `dashboard/src/index.css:103-105`); `useDialog` no hace focus trap/inert (`client/src/hooks/useDialog.ts:13`); persiste `autoFocus` móvil. | Restaurar indicador AA, trap de foco, `inert`, orden de tab y tests teclado/screen reader. |
| P2-14 | Bundle client main 169.16 kB gzip y 522.70 kB minificado, por encima del warning Vite; no hay budget. | Analizar imports, lazy routes y fijar budgets CI por entry/chunk. |
| P2-15 | `engines.node >=18` contradice Vite 7, que exige Node 20.19+ o 22.12+ (`package.json:15-17`). | Fijar una línea LTS compatible en engines, CI, Volta/Corepack y documentación. |
| P2-16 | Documentación de baseline está obsoleta: 54 vs 80 tests, 162.4 vs 169.16 kB gzip, Account 15,393 vs 15,690 B; varias remediaciones fueron declaradas cerradas sin test de aceptación. | Generar métricas en CI y enlazar artefactos, no copiar números manualmente. |

## 5. Hallazgos P3 y deuda operativa

- `InvoicePaid` usa IDs aleatorios de evento y el cursor se actualiza al final;
  una falla de cursor puede duplicar eventos. Se resuelve junto con P1-02.
- La indexación por listas de wallets/topics no tiene estrategia documentada de
  escalado, reorg profundo o proveedor degradado.
- El ABI manual de `getReserveData` es anterior al shape actual de Aave v3. Los
  campos consumidos están antes de la inserción nueva y no se observó fallo, pero
  debe importarse la interfaz oficial y probarse en fork.
- OpenAPI no tiene validación automática de request/response ni detección de
  drift. Añadir contract tests y lint de schema.
- Varias imágenes de perfil no declaran `width`/`height`; formularios mantienen
  inconsistencias de `name`, `autocomplete`, `spellCheck` y placeholders.
- El service worker, push, recuperación y CCTP necesitan runbooks de incidentes,
  SLOs y ejercicios de restauración, no sólo documentación de deploy feliz.

## 6. Correcciones a afirmaciones anteriores

| Afirmación histórica | Estado verificado 2026-07-13 |
|---|---|
| “Doble cobro de link corregido con re-check + mark CAS” | **No cerrado.** Evita overwrite, no dos transferencias con UserOps diferentes. |
| “Outbox/reconciliador cierra la contabilidad post-chain” | **Parcial.** Repara ledger, pero evento/outbox puede perderse o duplicarse. |
| “Secretos de webhook guardados sólo como hash” | **Falso para webhooks.** API keys sí usan hash; HMAC secrets están en texto en D1. |
| “Validación CCTP recipient/domain/amount suficiente” | **Insuficiente.** Faltan campos críticos de header y burn body. |
| “Ninguna guarda de seguridad fail-open en mainnet” | **Falso.** `rateLimitConsume` falla abierto y protege rutas de gasto. |
| “Errores crudos sanitizados” | **No cerrado.** `/pay/submit` aún retorna `msg`. |
| “`:focus-visible` global” | **Existe selector, pero borra el indicador.** Incumple su objetivo. |
| “La distancia restante es operación, no arquitectura” | **No vigente.** Exactly-once, outbox, CCTP y guardian requieren cambios de arquitectura. |

## 7. Tecnologías y estándares verificados

Las recomendaciones se contrastaron con fuentes primarias, no con memoria del
modelo:

- [Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): Promises siempre awaited/`waitUntil`, límite de JSON antes de leer, tipos generados, compatibility date actual y observabilidad.
- [Cloudflare D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch): secuencia transaccional con rollback ante fallo.
- [Circle CCTP Technical Guide](https://developers.circle.com/cctp/references/technical-guide), [contract addresses](https://developers.circle.com/cctp/references/contract-addresses) y [retry de mint](https://developers.circle.com/cctp/howtos/retry-failed-mint): layouts, dominios, contratos y semántica one-time del nonce.
- [OpenZeppelin Account Abstraction](https://docs.openzeppelin.com/contracts/5.x/account-abstraction) y [EntryPoint releases](https://github.com/eth-infinitism/account-abstraction/releases): la implementación instalada usa el EntryPoint v0.9 canónico; no se detectó mismatch aquí.
- [Aave Address Book](https://github.com/aave-dao/aave-address-book): Pool y aUSDC de Arbitrum/Arbitrum Sepolia coinciden con el registro oficial actual.
- [Vite 7 guide](https://vite.dev/guide/) y [anuncio Vite 7](https://vite.dev/blog/announcing-vite7): Node 20.19+ o 22.12+; Node 18 no es baseline válido.
- [WCAG 2.2, SC 2.4.7](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible): todo control operable por teclado debe mostrar el foco.
- [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md): no eliminar outline sin reemplazo visible, diálogos con manejo completo de foco y dimensiones de imágenes.
- Advisories principales: [protobufjs RCE](https://github.com/advisories/GHSA-xq3m-2v4x-88gg), [React Router](https://github.com/advisories/GHSA-49rj-9fvp-4h2h), [Vite file read](https://github.com/advisories/GHSA-p9ff-h696-f583), [Hono CORS](https://github.com/advisories/GHSA-88fw-hqm2-52qc) y [ws DoS](https://github.com/advisories/GHSA-96hv-2xvq-fx4p).

No recomiendo migrar majors sólo por novedad. Primero se deben aplicar los
patches mínimos seguros, medir, y después evaluar Vite 8/TypeScript 7 u otros
majors en ramas separadas con pruebas y bundle diff.

## 8. Gates obligatorios antes de mainnet

- [x] P1-01 exactly-once por link con test de dos pagadores.
- [x] P1-02 transición + outbox atómicos, dedupe estable y secretos cifrados.
- [x] P1-03/P1-04 validación y reconciliación CCTP completas con fixtures/forks.
- [x] P1-05 faucet explícitamente desactivado o presupuestado en mainnet.
- [ ] P1-06 recovery sin guardian EOA global y con separación real de funciones.
- [x] P1-07 deadline del router ligado al expiry del intent.
- [x] Cero critical/high en `pnpm audit --prod` o waiver formal de exposición nula.
- [x] Worker desplegable sólo desde un artefacto CI verificado del mismo commit.
- [ ] Branch protection bloqueante y aprobación del environment configuradas en GitHub.
- [x] Fork tests para EntryPoint, Aave, CCTP, Universal Router y PaymentRouter.
- [x] Cobertura de branches de contratos críticos >=80% o excepciones justificadas.
- [x] QA automatizado de teclado/overflow/WCAG 2.2 AA en desktop y móvil.
- [ ] QA manual con lector de pantalla y dispositivos reales.
- [ ] Secrets en HSM/KMS, rotación ensayada, presupuestos, alertas y kill switches.
- [x] Migraciones ensayadas con backup/restore y plan de rollback.
- [ ] Auditoría independiente de contratos + backend y bug bounty previo al TVL.

## 9. Orden de implementación recomendado

1. **Contención inmediata:** desactivar faucet mainnet, bloquear release por audit,
   parchear dependencias y fijar Node/toolchain.
2. **Correctitud de dinero:** claim de link, outbox transaccional, importes reales
   del ledger y expiry de router.
3. **Cross-chain/recovery:** CCTP completo, historial de mint attempts y guardian
   con separación de funciones.
4. **Plataforma:** CI, tipos Worker, body limits, observabilidad, leases con owner,
   OpenAPI/fork tests.
5. **Producto:** accesibilidad, bundle budgets y QA visual automatizada.

Cada corrección debe cerrar el test de aceptación indicado. Cambiar el comentario
o añadir otro read previo no constituye cierre.
