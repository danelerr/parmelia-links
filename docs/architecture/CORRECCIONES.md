# Correcciones aplicadas a la arquitectura de Payments

**Fecha:** 25 de agosto de 2026  
**Alcance:** código, pruebas, gates, runbook, diagramas y auditoría posterior  
**Estado remoto:** base promovida; correcciones posteriores sólo locales

Este documento explica por qué se hizo cada corrección. La regla fue evitar dos
extremos: no dejar riesgos reales detrás de diagramas bonitos y no crear una
arquitectura genérica para proveedores que todavía no existen.

## 1. Reentrega segura de Queue

Antes, `claimJob` trataba igual un job completado y otro con lease vigente. El
consumer hacía `ack` en ambos casos. Si una invocación caía después de adquirir
el lease pero antes de terminar, la reentrega podía confirmarse y el trabajo se
perdía.

Ahora el claim devuelve tres estados: `claimed`, `completed` o `leased`. Sólo
`completed` se confirma; `leased` se reprograma hasta que expire el lease. La
prueba de runtime inserta exactamente el estado dejado por una caída, verifica
que no existe `ack`, vence el lease y comprueba que la siguiente entrega termina.

## 2. Finalización de job y outbox en el mismo batch

Antes, marcar el job `completed` y marcar su outbox `completed` eran dos
escrituras. Una caída entre ambas dejaba un outbox `enqueued` sin recuperación
limpia. Ahora las dos actualizaciones pertenecen al mismo batch D1. Una
reentrega de un job ya completado también repara idempotentemente el outbox.

## 3. `payment.created` es un contrato real

La API y los diagramas prometían `payment.created`, pero crear un intent sólo
insertaba `payment_intents` y `payment_links`. La creación ahora confirma en un
solo batch: intent, link, evento determinístico, outbox y deliveries de endpoints
suscritos. El replay con la misma `Idempotency-Key` devuelve el intent existente
sin duplicar evento, outbox ni delivery.

No se añadió una migración: las tablas, FKs e índices únicos necesarios ya
existen en `payments-worker/migrations/0001_payments_schema.sql`.

## 4. Modo live bloqueado por capacidad de backend

La configuración actual usa Arbitrum Sepolia, Base Sepolia y Fuji; las entradas
mainnet del manifest no tienen routers activos. Sin embargo, Dashboard permitía
crear claves y webhooks live y afirmaba que moverían dinero real.

Se añadió `PAYMENT_LIVE_ENABLED=false` y una capacidad calculada en el Worker.
Para habilitar live no basta el flag: el settlement debe ser mainnet y debe
existir al menos una ruta mainnet habilitada con router desplegado. Merchant API
rechaza keys/webhooks live con `503`; `/v1` vuelve a verificarlo al crear el
intent. Dashboard consulta `/merchant/capabilities` y deshabilita los selectores,
pero esa UI sólo informa: la seguridad sigue en backend.

## 5. Corte `legacy | frozen | payments`

Un cambio directo de proxy deja una carrera entre la última escritura App y el
snapshot. Se agregó un control explícito:

- `legacy`: App atiende la implementación previa;
- `frozen`: los GET siguen disponibles y las escrituras de checkout responden 503;
- `payments`: las superficies extraídas usan el Service Binding.

Un valor inválido falla cerrado como `frozen`. Liveness, readiness y ops
publican el modo efectivo. Durante `legacy` y `frozen`, los runners legacy de
checkout siguen activos para drenar trabajos ya aceptados; en `payments` quedan
inertes. Esto es código temporal de migración, no boilerplate permanente. El
procedimiento y el rollback están en `docs/runbooks/payments-cutover.md`.

## 6. Frontera personal frente a checkout

La primera versión del cutover era demasiado amplia: congelaba todo `/pay` y
delegaba todo `/crosschain`. Eso habría roto transferencias directas, Earn,
UserOperations y CCTP personal al cambiar a `payments`; además, el destino sólo
tenía handlers 410 para esas rutas.

La frontera ahora sigue el dominio, no un prefijo conveniente:

- App conserva `/pay` y `/crosschain` en todos los modos;
- sólo el prepare de un link almacenado reserva un attempt en Payments por RPC;
- `frozen` bloquea prepare/submit de links, pero no una operación personal;
- un pending legacy creado antes del switch se rechaza al llegar a `payments`,
  evitando liquidarlo contra la D1 equivocada;
- un attempt de Payments tampoco puede enviarse después de volver a `legacy`;
  se debe congelar y reconciliar hacia delante;
- `crosschain_relayer` permanece activo en App;
- el split D1 no convierte CCTP personal en intents sintéticos de comercio.

Payments mantiene su propia tabla CCTP únicamente para attempts de Universal
Checkout. Se eliminó su ruta HTTP `/crosschain`, que era engañosa y podía
interceptar una funcionalidad cuyo dueño real es App. El drill deja tres filas
personales en App y exige cero importadas en Payments.

## 7. Job fantasma eliminado

`payments-worker` aceptaba el mensaje `webhook_key_rotation`, pero su runner no
hacía nada y lo confirmaba como exitoso. Eso es peor que rechazarlo: el equipo
de operación podía creer que una rotación ocurrió. Se quitó del contrato de
Queue de Payments y el parser ahora lo rechaza. La rotación legacy que sí está implementada sigue
en App mientras se drena ese dominio.

## 8. Frontera de persistencia comprobable

Los diagramas decían que repositorios eran la única frontera SQL, pero había SQL
directo en middleware, Queue, reconciliación e entrypoint. Se introdujeron stores
funcionales pequeños para jobs, outbox, rate limit, health y chain journal. No se
añadieron clases, contenedores DI ni interfaces de una sola implementación.

El gate `check:backend-boundaries` falla si `PAYMENTS_DB.prepare/batch/exec`
aparece fuera de `repositories/` o `stores/`. Así la afirmación arquitectónica
deja de depender de disciplina manual.

## 9. Rail on-chain aislado sin abstracción universal

Circle estaba importado directamente desde el motor de quotes y la
reconciliación. Su cliente de fees/attestations vive ahora bajo
`payments-worker/src/rails/onchain/`; servicios de dominio consumen esa frontera.
Se conserva el invariante actual: USDC y rutas `local | cctp_fast |
cctp_standard`.

No se crearon `PayinProvider`, `PayoutProvider` o `CardProvider` vacíos. El
diagrama objetivo muestra dónde aparecerán, pero el primer puerto se extraerá
del contrato real del primer proveedor. Esto mantiene extensibilidad sin clases
ni adapters especulativos.

## 10. Cron descrito como recuperación

Payments ya tenía un Cron cada minuto, mientras la documentación afirmaba que
no existía ningún Cron. La documentación ahora distingue: App no tiene Cron;
Payments usa uno sólo para recuperar outbox y watchers activos. Queue y el
Durable Object siguen siendo transporte/scheduler primario.

## 11. Inputs, selectores y modales apilados

Con la fuente real cargada, la prueba de navegador reprodujo dos portales de
diálogo coexistiendo. Cada instancia intentaba volver inerte el resto del body;
una capa que ya no era la superior podía seguir bloqueando clicks, foco y texto,
incluidos nombre y red social en Perfil y el selector anidado.

`useDialog` ahora mantiene una pila mínima ordenada por `z-index` y montaje.
Sólo el modal superior es interactivo, conserva/restaura el estado `inert` y
`aria-hidden` previo, coordina el scroll lock y devuelve el foco al cerrar un
selector anidado. No se añadió un framework de modales ni un store global. La
prueba E2E escribe en ambos inputs y abre/cierra el selector real.

## 12. Pruebas visuales con la misma fuente que producción

El workspace aislado de `client/` hacía que Vite rechazara los archivos de fuente
ubicados en el store pnpm de la raíz. Las pruebas caían silenciosamente a otra
tipografía y no reproducían las dimensiones que disparaban el solapamiento.
`server.fs.allow` permite únicamente la raíz exacta del repositorio. Así el E2E
valida el layout real sin abrir acceso arbitrario al sistema de archivos.

## 13. Diagramas corregidos

Los diagramas ahora reflejan que:

- Checkout es una ruta de App Web, no un contenedor desplegable;
- productores publican en Queue y Queue entrega al Job Runtime;
- la wallet llama al router, no el Authorization Service;
- Iris entrega una attestation y el relayer llama `receiveMessage` on-chain;
- fee evidence es idempotente, pero la transición económica + evento + outbox
  es el batch atómico;
- live/mainnet está deshabilitado;
- el corte incluye freeze, drain, watermark y rollback condicionado;
- `/pay` y `/crosschain` personales permanecen en App durante el corte;
- el split no duplica CCTP personal en Payments;
- proveedores futuros aparecen en gris y no como funcionalidad existente.

La secuencia extensa se dividió entre creación/ejecución y
reconciliación/webhook. Hay diez diagramas numerados.

## 14. Drift de SVG bloqueado en CI

`docs:architecture:check` renderiza en una carpeta temporal, compara hashes con
los SVG versionados y no escribe en el workspace. `verify` y `verify:ci` lo
ejecutan, por lo que modificar PlantUML sin regenerar su SVG hace fallar el gate.

## 15. Bootstrap, sync y preflight fallan cerrado

El primer deploy de Payments arranca con `PAYMENTS_BOOTSTRAP_MODE=true`: health
permanece disponible, pero HTTP/RPC mutante se rechaza, Queue reintenta y Cron no
ejecuta trabajo económico. App, por su parte, deja
`PAYMENTS_SYNC_ENABLED=false` hasta que el import haya sido verificado. Después
del freeze, el SHA-256 del manifest se fija en
`PAYMENTS_DATA_CUTOVER_CHECKSUM`; incluso con bootstrap apagado, Payments vuelve
a leer `payment_migration_control` y bloquea HTTP/RPC/Queue/Cron si source,
target y configuración no coinciden. Un valor ausente o inválido nunca activa
accidentalmente el corte.

App y Payments tienen guards previos a Wrangler. Ambos validan la misma máquina
de estados de un solo escritor; App además rechaza el UUID centinela para no
publicar el caller antes de que exista el target del Service Binding.

El preflight remoto es únicamente de lectura y descubre todas las migraciones de
Payments. Verifica ownership, target vacío o importado de forma completa, Queue,
Service Binding target→caller, checksum runtime y flags bootstrap/sync. El drill
local cubre import data-only, checksum, rechazo de replay y restauración
independiente de ambas D1.

## 16. Relayer CCTP recuperable y contabilidad real

Cada mint guarda nonce, firmante, nonce EVM y transacción raw antes del broadcast.
Un lease por `signer + chain` serializa ocho ejecuciones concurrentes; después de
una caída se reenvía exactamente la misma transacción o se recupera desde
`usedNonces`, receipt y eventos. Settlement usa el monto realmente acuñado y
propaga fee y sobrepago a ledger, API y webhook sin duplicar el efecto económico.

## 17. Webhooks y creación de intents resistentes a concurrencia

Las deliveries vencidas se reclaman otra vez, el evento conserva identidad
estable y cada envío incluye timestamp, event ID, delivery ID y firma
`v1=<hex>`. Los secretos usan AES-GCM versionado con `secret_key_id`; un keyring
anterior permite leer y rotar por compare-and-swap sin invalidar endpoints.
Crear dos intents simultáneos con la misma `Idempotency-Key` devuelve el mismo
recurso y no produce un `500` por conflicto único.

## 18. Checkout público y montos definidos por quien paga

`/checkout/:linkId` se puede pagar sin cuenta GatoPago desde una wallet externa
que exponga EIP-1193 en su extensión o navegador integrado. La red es la
ubicación del USDC del pagador, no una decisión del
merchant. El cliente simula saldo, allowance y gas; intenta EIP-2612 y, si la
wallet no lo soporta, usa autorización exacta más pago. El hash se persiste antes
del registro HTTP y, si ese registro falla, una recarga vuelve a registrar el
mismo hash sin volver a transmitir la operación.

Los links de monto abierto usan `amount_mode=payer_defined`. El primer attempt
activo fija temporalmente el monto y los attempts concurrentes no pueden cambiar
la obligación; una cancelación o expiración libera la reserva. La migración
`0005_payer_defined_amounts.sql` hace explícita esta semántica.

## 19. Qué se evitó deliberadamente

- No se habilitó mainnet ni se cambió una dirección de contrato.
- No se creó un Worker por frontend ni un Worker por proveedor.
- No se añadió doble escritura entre D1.
- No se borraron handlers/tablas legacy antes del soak.
- No se creó una migración sin cambio de schema.
- No se hizo deploy, commit, push ni mutación remota.

## 20. Evidencia local exigida

Resultados ejecutados sobre este árbol de trabajo:

| Gate | Resultado |
|---|---|
| `pnpm verify` | Pasa: lint, typecheck, OpenAPI, fronteras, query plans, Knip, ciclos, unit/runtime, builds y budgets. |
| Server | 253 unit tests + 22 runtime tests, todos pasan. |
| Payments | 51 unit tests + 19 runtime tests, incluidos payer proof, capabilities, CAS, expiración y evidencia onchain adversarial. |
| Playwright | 28 pasan; 10 se omiten por la matriz configurada. Incluye checkout externo, caída de registro y recuperación tras recarga en escritorio y móvil. |
| `pnpm audit:prod` | Cero vulnerabilidades conocidas por el advisory DB de pnpm. |
| D1 | Backup/restore de 59 tablas y split App/Payments con FK, checksum semántico de todas las columnas, rechazo de mutación de contenido, replay guard y restores independientes. |
| Release | Artifact drill, detección de manipulación y archivos extra pasan. |
| Foundry | Coverage: 187 pruebas instrumentadas pasan y 4 forks se omiten sin RPC; el gate final ejecuta 191 pruebas y omite esos mismos 4 forks. Sizes, storage layout y lint pasan. |
| Diagramas | 10 SVG reproducibles con PlantUML fijado y revisados visualmente. |

Límites de esta evidencia:

- `pnpm test:fork` usa endpoints públicos de Arbitrum Sepolia, Base Sepolia y
  Avalanche Fuji y valida sus chain IDs antes de ejecutar; para CI o mayor
  estabilidad se pueden sobrescribir `ARBITRUM_SEPOLIA_RPC_URL`,
  `BASE_SEPOLIA_RPC_URL` y `AVALANCHE_FUJI_RPC_URL`;
- Foundry avisa que los directorios vendorizados no conservan metadata `.git`.
  Los paquetes declaran las versiones fijadas (forge-std 1.16.2 y OpenZeppelin
  5.7.0), pero el checkout local no puede demostrar sus commits mediante Git;
- una auditoría de dependencias sin hallazgos no demuestra ausencia absoluta de
  vulnerabilidades, y ninguna prueba local sustituye un smoke autenticado en
  producción ni una auditoría externa de contratos.

## 21. Remediación de la auditoría posterior

El checkout público ya no confía en que una dirección o hash escritos por el
navegador sean verdaderos. La quote liga un hash de capability; la wallet
cotizada firma un mensaje exacto; y el attempt guarda sólo el hash de esa
capability. Lectura, registro y cancelación requieren el valor aleatorio. Antes
de persistir un source hash, Payments consulta su propio RPC y verifica receipt
exitoso, `from`, `to`, router y `PaymentSettled`/`CctpPaymentBurned` contra el
attempt firmado. Un receipt pendiente no cambia D1 y un conflicto no revela la
autorización del attempt ganador.

La migración `0006_checkout_attempt_access.sql` añade esos compromisos y un
índice para expirar `submitted` sin evidencia. El drill D1 ahora hashea todas
las columnas, con tipos canónicos y orden estable, y demuestra que alterar el
contenido conservando IDs hace fallar la verificación.

La salud RPC conserva por hasta cinco minutos una observación pública válida y
la marca `degraded`, pero nunca la usa para firmar/autorizaciones. El preflight
exige dos hostnames RPC por chain. El helper operativo construye y prueba dos
proveedores reales para las tres testnets antes del upload. El checkout remonta
toda `PayPage` por identidad de ruta, no sólo el hijo cuando llega el nuevo
`link.id`; A desaparece mientras B carga y también cuando B termina en 404. El
preflight Vercel comprueba acceso HTTP anónimo, incluidos redirects externos.

El checkout no integra SDKs ni relays de conexión remota. La compatibilidad con
wallets externas queda limitada a una interfaz EIP-1193 ya expuesta por el
navegador o a abrir el link dentro del navegador propio de la wallet. App,
Dashboard, Workers, passkeys y smart accounts no requieren un proveedor de
wallets.

Finalmente, los comandos de deploy ahora rechazan cambios relevantes
dirty/untracked y un HEAD sin publicar en su upstream. El árbol actual debe
versionarse antes de cualquier nueva promoción; este documento no autoriza ese
commit ni un deploy. `DEPLOY.md` usa esos entrypoints también para dry-run y
publicación; un gate estático impide reintroducir `wrangler deploy` directo.

El checksum histórico no se puede promover cambiando el valor de control. El
importador ahora produce manifest v4/checksum semántico v2, normaliza de forma
criptográficamente verificable la representación AES-GCM aleatoria y cifra
webhooks con el formato `enc:v2:<key-id>` consumido por Payments. El preflight
exporta el target pre-activación y ejecuta `--verify-target-sql`. Producción debe
seguir el runbook de reemplazo hacia una D1 nueva; la D1 histórica queda intacta
como evidencia/rollback.

`pnpm verify:all` terminó en verde después de estas correcciones: App 253+22,
Payments 51+19, Playwright 30/10, audit sin vulnerabilidades conocidas,
split/restore semántico y 191 pruebas Foundry finales con 4 forks omitidos por
ausencia de RPC.
