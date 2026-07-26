# Auditoría de smart contracts — Parmelia

Revisión interna de seguridad del conjunto de contratos en `contracts/src`.
Enfoque principal: **seguridad de fondos** y **actualizabilidad** (la preocupación
declarada tras pérdidas previas en Base), más una revisión general.

- Fecha: 2026-06-16 · Actualizado: 2026-07-14 (tercera pasada: gate semántico
  append-only de storage layout, cobertura por contrato bloqueante, guardas de
  EntryPoint/implementation/sponsor cero, política mainnet fail-closed de roles
  de deploy, eventos de rotación y pruebas administrativas completas;
  segunda pasada: M-4 stake
  irrecuperable + L-4 encontrados y resueltos; L-1 y L-3 resueltos en código;
  test de upgrade M-3; solc pineado a 0.8.28; fuzz de conservación en ambos
  routers, tampering de digest/userOp, ciclo de stake; cap inicial de gas en el
  script de deploy)
- Alcance: 6 contratos (commit de trabajo actual, rama `main`)
- Solidity `0.8.28` (pineado), OpenZeppelin Contracts v5, Foundry (`via_ir`, optimizer on, runs 1.000.000)
- Estado de pruebas: **124/124 pasan** (`forge test`), incluyendo fuzz (256 runs por propiedad)
- Tamaños de bytecode (límite EIP-170 = 24.576):

| Contrato | Runtime (bytes) | Margen |
|---|---|---|
| AccountWebAuthnV2 | 15.690 | OK (64% del límite) |
| AccountFactoryV2 | 1.793 | OK |
| ParmeliaPaymaster | 5.307 | OK |
| ParmeliaPaymentRouter | 6.215 | OK |
| ParmeliaCrosschainRouter | 4.203 | OK |
| ERC7913WebAuthnVerifier | 5.196 | OK |

## Veredicto

No se encontraron vulnerabilidades **críticas** ni **altas**. El diseño está
construido sobre primitivas auditadas de OpenZeppelin v5 y sigue buenas prácticas
(checks-effects-interactions, ReentrancyGuard, Ownable2Step, timelock de recovery,
inicialización atómica). Los puntos a vigilar son de severidad **media** y giran
en torno a **gestión de claves** (claves compartidas del backend) y a la
**disciplina de layout de almacenamiento** en futuras actualizaciones.

La arquitectura V2 **previene estructuralmente** la pérdida de fondos tipo Base.
Ver la sección "Actualizabilidad y por qué ya no se pierden fondos".

### Resumen de hallazgos

| ID | Severidad | Contrato | Tema |
|---|---|---|---|
| M-1 | Media | AccountWebAuthnV2 | Guardian compartido (clave del backend) |
| M-2 | Media | Paymaster / Router / Account | Gestión de claves del backend (firmante/guardian) |
| M-3 | Media | AccountWebAuthnV2 | Disciplina de layout de almacenamiento en upgrades |
| M-4 | Media | ParmeliaPaymaster | Stake irrecuperable: `addStake` sin `unlockStake`/`withdrawStake` — resuelto en código, pendiente redeploy |
| L-1 | Baja | ParmeliaPaymaster | Sin tope on-chain de coste de gas por op — resuelto en código, pendiente redeploy |
| L-2 | Baja | ParmeliaPaymentRouter | Tokens fee-on-transfer / rebasing — política documentada en `setTokenSupported` |
| L-3 | Baja | AccountWebAuthnV2 | Griefing de recovery — resuelto en código, pendiente redeploy |
| L-4 | Baja | ParmeliaCrosschainRouter | `opId` cero no validado + `emergencyWithdraw` sin evento — resuelto en código |
| I-x | Info | Varios | Notas informativas (ver detalle) |

---

## 1. AccountWebAuthnV2.sol

Cuenta ERC-4337 (UUPS) con multi-passkey (MultiSignerERC7913), ejecución por
lotes ERC-7821 y recuperación por guardian con timelock de 48h.

### Aspectos correctos

- `_disableInitializers()` en el constructor de la implementación: la
  implementación no puede inicializarse ni secuestrarse directamente.
- `initialize(...)` con modificador `initializer`: solo se ejecuta una vez, y de
  forma **atómica** desde el constructor del proxy (ver factory) — sin ventana de
  front-running.
- `_authorizeUpgrade` con `onlyEntryPointOrSelf`: solo una operación firmada por un
  signer válido (passkey) puede actualizar la implementación. No hay owner externo
  con poder de upgrade.
- Sin `selfdestruct` ni `delegatecall` a destinos arbitrarios. La ejecución ERC-7821
  está restringida a EntryPoint o a la propia cuenta.
- Recovery con timelock de 48h + `cancelRecovery` (veto del dueño) + eventos.
- Orden cuidadoso en `executeRecovery`: añade nuevos signers, fija threshold y luego
  elimina los antiguos, evitando caer por debajo del threshold durante la transición.
- `ERC721Holder` / `ERC1155Holder`: la cuenta puede recibir NFTs sin que queden
  bloqueados.

### M-1 (Media) — Guardian compartido entre todas las cuentas

Si el backend usa **una sola EOA como guardian de todas las cuentas**, una fuga de
esa clave permite al atacante llamar `proposeRecovery` sobre cualquier cuenta y, tras
48h, `executeRecovery` para reemplazar los signers y tomar el control de los fondos.

Mitigaciones ya presentes: timelock de 48h, `cancelRecovery` (el dueño puede vetar),
y eventos `RecoveryProposed` que se pueden vigilar.

Recomendaciones:
- ✅ **Implementado:** notificación push ante `RecoveryProposed` vía
  `runRecoveryWatcher` (`server/src/services/indexer.ts`, despertado por un
  Custom Webhook y verificado por RPC). Es la defensa
  práctica clave: el usuario se entera y puede cancelar dentro de la ventana de 48h.
- Usar una clave de guardian **dedicada y en frío** (HSM/cold), distinta de las
  claves calientes que firman paymaster y router (que están en línea constantemente).
- Considerar guardian **opt-in** o por-usuario en vez de uno global. `initialize`
  ya admite `guardian_ = address(0)` para desactivarlo.
- Documentar el procedimiento de respuesta ante incidente (rotar guardian vía
  `setGuardian` en una UserOp).

### L-3 (Baja) — Griefing de recovery — RESUELTO EN CÓDIGO (2026-07-02, pendiente redeploy)

Hallazgo original: `RecoveryAlreadyProposed` impide proponer una nueva recovery
mientras haya una pendiente, y una propuesta malformada (threshold 0, threshold >
count, duplicados) solo revertía dentro de `executeRecovery` — 48h después, para
un usuario que por definición perdió su passkey y NO puede ejecutar
`cancelRecovery`. Es decir: peor que una molestia, podía dejar la recovery
inutilizable de forma permanente para el caso real de uso.

Resolución implementada:
- `proposeRecovery` valida la propuesta al proponer: signers no vacíos (1..32),
  threshold en rango (1..count), sin duplicados, cada signer con al menos 20
  bytes (`InvalidRecoveryProposal`). El orden de checks se corrigió
  (`NoGuardianSet` ahora es alcanzable).
- `guardianCancelRecovery()`: el guardian puede cancelar su propia propuesta
  (p. ej. un signer que ya existe, que `_addSigners` rechazaría en execute).
  No otorga poder extra: solo puede re-proponer, reiniciando el timelock de 48h.
- `setGuardian` cancela cualquier propuesta pendiente: una recovery propuesta
  bajo la autoridad del guardian anterior no sobrevive a su rotación/remoción.

Cubierto por 11 tests nuevos (validación negativa, cancel del guardian,
rotación). NOTA: rige on-chain recién tras el redeploy de la implementación.

### Informativo

- I-1: `executeRecovery` es **permissionless** tras el timelock. Es correcto: los
  signers pendientes quedaron fijados al proponer y el dueño tuvo 48h para cancelar.
- I-2: El salt de la cuenta deriva de `initData` (incluye guardian). Cambiar el
  guardian se hace **siempre** con `setGuardian`, nunca redeployando. La dirección de
  la wallet almacenada en D1 es la fuente de verdad; no recomputar.

---

## 2. AccountFactoryV2.sol

Factory CREATE2 que despliega `ERC1967Proxy` apuntando a la implementación
AccountWebAuthnV2.

### Aspectos correctos

- **Inicialización atómica**: el `initialize` se ejecuta dentro del constructor del
  proxy (`new ERC1967Proxy{salt}(IMPLEMENTATION, initData)`). No hay ventana entre
  deploy e init donde un tercero pueda secuestrar la cuenta.
- **Idempotente**: si `predicted.code.length > 0`, devuelve la cuenta existente. No se
  puede re-inicializar ni "pisar" una cuenta ya creada.
- **Determinista**: `salt = keccak256(initData)`. Mismas entradas → misma dirección,
  para siempre. Esto es lo que evita que los fondos queden "huérfanos".
- Constructor exige que la implementación sea un contrato (`code.length > 0`).

### Informativo

- I-3: `createAccount` es permissionless. Si un atacante hace front-run para desplegar
  la cuenta de un usuario, simplemente despliega **la misma** cuenta que el usuario
  iba a obtener (no controla la passkey). Sin impacto. Es el comportamiento estándar
  de los factories 4337.

---

## 3. ParmeliaPaymaster.sol

Paymaster verificador que patrocina gas para UserOperations firmadas por el backend,
con ventana `[validAfter, validUntil]` firmada.

### Aspectos correctos

- El digest firmado incluye `chainid`, `address(this)`, `sender`, `nonce`, hash de
  `initCode`, hash de `callData`, límites de gas, `preVerificationGas`, `gasFees`,
  hash de la config del paymaster, `validAfter` y `validUntil`. Esto bloquea: replay
  entre cadenas, replay entre paymasters, manipulación de campos de la op, y
  reutilización (por el nonce). La ventana temporal limita una op firmada y no
  enviada.
- `Ownable2Step`: transferencia de propiedad en dos pasos (evita enviar el control a
  una dirección equivocada).
- `setSponsorSigner`, `withdrawTo`, `addStake` bajo `onlyOwner`.
- `SponsorSignerSet` deja toda rotación del firmante indexable; el deploy mainnet
  configura el signer y abre el handoff `Ownable2Step` antes de finalizar.

### L-1 (Baja) — Sin tope on-chain de coste por operación — RESUELTO EN CÓDIGO (2026-07-02, pendiente redeploy)

Hallazgo original: el paymaster patrocinaba el gas sin límite máximo de coste por
op a nivel de contrato; el control recaía solo en la firma del backend. Si la
clave `sponsorSigner` se filtra, un atacante podría drenar el depósito del
paymaster patrocinando operaciones enormes.

Resolución implementada:
- `maxSponsoredGasCost` (owner-settable via `setMaxSponsoredGasCost`, 0 =
  sin tope): `validatePaymasterUserOp` rechaza cualquier op cuyo `maxCost`
  supere el tope, aunque la firma del sponsor sea válida. Defensa en
  profundidad ante fuga del firmante; setear un valor tras el deploy.
- Además, un mismatch de firma ahora DEVUELVE `SIG_VALIDATION_FAILED`
  (authorizer = address(1)) en vez de revertir, como recomienda la spec
  ERC-4337 (los bundlers distinguen firma inválida de paymaster roto). Los
  problemas estructurales (datos faltantes, tope excedido) siguen revirtiendo.

Cubierto por tests nuevos. NOTA: rige on-chain recién tras el redeploy.
Mitigaciones operativas vigentes mientras tanto: depósito acotado,
monitorización y rotación del firmante. Ver también M-2.

### M-4 (Media) — Stake irrecuperable en el EntryPoint — RESUELTO EN CÓDIGO (2026-07-02, pendiente redeploy)

Hallazgo: el paymaster exponía `addStake` (y `withdrawTo` para el **depósito**),
pero NO `unlockStake()` ni `withdrawStake()` del EntryPoint. Como el stake se
acredita a `address(paymaster)` y solo el propio contrato puede pedir su
desbloqueo/retiro, cualquier ETH stakeado quedaba **bloqueado para siempre**
(puerta de una sola dirección). Impacto acotado a fondos del operador (no de
usuarios), pero es pérdida permanente y el script de deploy stakea en cada
despliegue.

Resolución: `unlockStake()` y `withdrawStake(address payable)` bajo `onlyOwner`,
con test del ciclo completo (`test_stakeLifecycleForwardsToEntryPoint`).
NOTA: el paymaster desplegado hoy (`0x31f3…`) tiene este defecto: su stake de
testnet (0.001 ETH) es irrecuperable. Asumirlo como coste hundido y no stakear
más en esa instancia; el próximo deploy usa el contrato corregido.

### Informativo

- I-4: `sponsorSigner` se inicializa igual al `initialOwner`. Para producción,
  separar: firmante caliente (firma constantemente) distinto del owner frío (controla
  retiros/stake). Ya está recogido en `DEPLOY.md` §11.
- I-5: `postOp` es no-op (gas 100% patrocinado). Es el punto de integración para un
  futuro modelo de cobro (p. ej. comisión en USDC); documentado en el código.
- I-6: Firma EIP-191 sobre `abi.encode` (no EIP-712). Como la firma la genera el
  backend (no un wallet de usuario), no se pierde legibilidad; es seguro porque
  chainid y dirección del contrato van dentro del digest.

---

## 4. ParmeliaPaymentRouter.sol (Flujo B)

Rail de pago abierto y **no custodio**: cualquier wallet externa paga una invoice;
los fondos van directos al merchant, con una comisión al treasury en la misma
transacción. Autorizado por firma del backend.

### Aspectos correctos

- **No custodio**: `safeTransferFrom(payer → merchant, amount - fee)` y
  `safeTransferFrom(payer → treasury, fee)`. El router nunca retiene fondos.
- **Checks-effects-interactions**: `invoicePaid[invoiceId] = true` se fija **antes**
  de las transferencias. Combinado con `nonReentrant`, la reentrada está cubierta dos
  veces (un reintento revertiría con `InvoiceAlreadyPaid`).
- `invoiceDigest` liga `chainid`, dirección del router, `invoiceId`, `token`,
  `amount`, `merchant`, `feeBps`, `deadline`: nada se puede manipular ni replayear
  entre cadenas/routers; `deadline` caduca autorizaciones viejas.
- **`MAX_FEE_BPS = 100` (1%)**: tope duro aplicado en el contrato aunque el backend
  firme una comisión mayor. Protege al pagador.
- `Pausable` (parada de emergencia) + `Ownable2Step`.
- Whitelist de tokens con mínimo por token controlada por el owner.

### Nota sobre compromiso de `invoiceSigner` (impacto limitado)

Si la clave `invoiceSigner` se filtra, el atacante puede **forjar autorizaciones**,
pero para que se muevan fondos **alguien tiene que pagar** (los fondos salen de
`msg.sender`, que debe haber dado approval y llamar). No puede extraer fondos de
usuarios arbitrarios. El peor caso es marcar invoices como pagadas con fondos
propios: sin vector de robo. El diseño no custodio acota el radio de impacto. Aun así,
tratar la clave con el mismo rigor (M-2). El `runRouterWatcher` del indexer revalida
merchant/token/amount contra la intent almacenada antes de marcar como pagada: buena
defensa en profundidad.

### L-2 (Baja) — Tokens fee-on-transfer / rebasing

Con un token que cobra comisión en transfer, el merchant recibiría menos de
`amount - fee`. Como `supportedTokens` es una whitelist del owner (USDC/WBTC,
ERC-20 estándar), no aplica en la práctica. La política (solo ERC-20 estándar,
nunca fee-on-transfer/rebasing, y por qué el contrato no mide deltas de balance
a propósito) quedó documentada en el natspec de `setTokenSupported` — el punto
exacto donde un futuro owner tomaría la decisión.

### Informativo

- I-7: `emergencyWithdraw` (onlyOwner) puede sacar cualquier token del router a
  cualquier dirección. Como el router no retiene fondos en el flujo normal, solo
  recupera transferencias enviadas por error. Es un poder de centralización, pero no
  toca fondos de usuarios (no hay fondos agrupados aquí). Claramente etiquetado.

---

## 5. ERC7913WebAuthnVerifier.sol

Wrapper fino (cuerpo vacío) sobre el `ERC7913WebAuthnVerifier` de OpenZeppelin.
Stateless, se despliega una vez por cadena. Sin lógica propia: hereda la auditoría de
OZ. Verifica aserciones WebAuthn (P256) usando el precompilado RIP-7212 cuando está
disponible, con fallback en Solidity.

### Informativo

- I-8: El verificador de OZ es relativamente reciente en la v5.x. Fijar la versión
  exacta de OpenZeppelin (lockfile) y revisar el changelog de OZ ante cualquier
  actualización, dado que la verificación de firmas es crítica.

---

## Actualizabilidad y por qué ya no se pierden fondos

Contexto: en Base se perdieron fondos porque un **redeploy** del contrato cambió las
direcciones derivadas por CREATE2 y los saldos quedaron en las direcciones viejas; y
una **migración de cadena** deja los fondos en la cadena anterior. La V2 está diseñada
para que eso no vuelva a pasar:

1. **Las actualizaciones son in-place (UUPS).** Se actualiza la **implementación**; el
   **proxy** (donde viven los saldos) conserva su dirección y su almacenamiento. Un
   upgrade nunca mueve fondos.
2. **El factory es determinista e idempotente.** Misma `initData` → misma dirección,
   siempre. Y la dirección de cada wallet está **almacenada en D1**: la fuente de
   verdad es ese registro, no un recálculo. No se debe "migrar" redeployando.
3. **No hay `selfdestruct`** en ningún contrato.
4. **El router es no custodio**: no existen fondos agrupados que perder.

Formas en que *todavía* se podrían perder fondos (y cómo evitarlas):

- **Migración de cadena**: los fondos quedan en la cadena origen. No es un bug de
  contrato, es una decisión de despliegue. Nunca "migrar" redeployando; usar un
  bridge.
- **M-3 (Media) — Upgrade con layout de almacenamiento roto.** TODO el layout es
  almacenamiento secuencial clásico: tanto las variables propias de
  AccountWebAuthnV2 (`guardian`, `recoveryExecutableAfter`, `_pendingSigners`,
  `_pendingThreshold`) como las de los mixins heredados — verificado en el
  código de OZ v5: `MultiSignerERC7913` declara `EnumerableSet.BytesSet private
  _signers` plano, SIN namespacing ERC-7201 (corrección a una versión anterior
  de este documento que afirmaba lo contrario). Consecuencia: la regla de
  **solo añadir al final** aplica a toda la cadena de herencia, y actualizar la
  versión de OpenZeppelin también puede mover slots de las bases. Estado:
  - ✅ **Test de ruta de upgrade añadido** (2026-07-02):
    `test_upgrade_preservesStateWithAppendedStorage` despliega el proxy V2,
    establece estado (signers, guardian, recovery en curso), actualiza a un V3
    mock que solo añade storage, y afirma que todos los slots V2 sobreviven y
    que la variable nueva funciona sin pisarlos.
  - ✅ **Storage-layout diff en CI:** `pnpm check:contracts:storage` compara los
    snapshots versionados con `forge inspect`, normaliza IDs inestables del AST
    y sólo acepta entradas nuevas al final; movimientos, cambios de offset o
    mutaciones de tipos/structs bloquean el build.
  - Opcional: migrar las variables propias a un struct namespaced (ERC-7201) o
    añadir un `__gap`, para máxima robustez.
- **Compromiso de claves** (guardian/firmantes): ver M-1 y M-2.

---

## M-2 (Media, transversal) — Gestión de claves del backend

El backend tiene tres roles de firma: `sponsorSigner` (paymaster), `invoiceSigner`
(router) y `guardian` (cuentas). La superficie de riesgo real del sistema es la
custodia de estas claves. Recomendaciones para mainnet:

- **Claves distintas por rol** y separación caliente/frío (firmantes en línea ≠ owner
  que controla fondos/retiros). `DeploymentRoles` lo hace bloqueante para chain
  42161 y cubre todas las colisiones en tests; recogido en `DEPLOY.md` §11.
- Almacenar firmantes en HSM/KMS; nunca en el repositorio ni en variables planas
  compartidas.
- **Playbook de rotación** documentado: `setSponsorSigner`, `setInvoiceSigner`,
  `setGuardian`, y transferencia de owner en dos pasos.
- **Monitorización** de eventos `RecoveryProposed`, `InvoicePaid`, depósito del
  paymaster en el EntryPoint, con alertas.

---

## Recomendaciones generales

- ✅ Versión exacta del compilador fijada (`solc = "0.8.28"` en `foundry.toml`);
  mantener también el lockfile de OpenZeppelin para builds reproducibles y
  direcciones CREATE2 estables.
- Mantener `optimizer_runs` **fijo** (ya documentado en `foundry.toml`): cambiarlo
  altera el bytecode y, por tanto, las direcciones derivadas.
- ✅ Batería de tests ampliada (2026-07-02): fuzz de conservación de fondos en
  ambos routers (merchant+treasury == amount; el router nunca retiene saldo),
  tampering de cada término del digest de invoice (incl. replay cross-chain vía
  `vm.chainId`), tampering de cada campo del UserOp firmado por el paymaster,
  ciclo completo de stake, casos negativos de recovery y el test de ruta de
  upgrade (M-3).
- Para escalar TVL real en mainnet: **auditoría externa** y/o programa de bug bounty
  antes de aumentar los límites de fondos.

## Conclusión

El conjunto es sólido y conservador: se apoya en primitivas auditadas de OZ v5, no
custodia fondos en el rail de pagos, y la actualizabilidad UUPS + factory determinista
**elimina** la causa raíz de las pérdidas previas en Base. El trabajo pendiente es
operativo más que de código: gestión de claves disciplinada (M-1, M-2), chequeos de
layout en CI antes de cualquier upgrade (M-3), y —antes de escalar fondos en
mainnet— una auditoría externa.
