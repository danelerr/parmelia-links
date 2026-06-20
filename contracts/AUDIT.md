# Auditoría de smart contracts — Parmelia

Revisión interna de seguridad del conjunto de contratos en `contracts/src`.
Enfoque principal: **seguridad de fondos** y **actualizabilidad** (la preocupación
declarada tras pérdidas previas en Base), más una revisión general.

- Fecha: 2026-06-16
- Alcance: 5 contratos (commit de trabajo actual, rama `main`)
- Solidity `^0.8.27`, OpenZeppelin Contracts v5, Foundry (`via_ir`, optimizer on, runs 1.000.000)
- Estado de pruebas: **43/43 pasan** (`forge test`)
- Tamaños de bytecode (límite EIP-170 = 24.576):

| Contrato | Runtime (bytes) | Margen |
|---|---|---|
| AccountWebAuthnV2 | 15.393 | OK (62% del límite) |
| AccountFactoryV2 | 1.793 | OK |
| ParmeliaPaymaster | 4.513 | OK |
| ParmeliaPaymentRouter | 5.668 | OK |
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
| L-1 | Baja | ParmeliaPaymaster | Sin tope on-chain de coste de gas por op |
| L-2 | Baja | ParmeliaPaymentRouter | Tokens fee-on-transfer / rebasing |
| L-3 | Baja | AccountWebAuthnV2 | Griefing de recovery (propuesta inválida bloquea) |
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
  `runRecoveryWatcher` (`server/src/services/indexer.ts`, en el cron). Es la defensa
  práctica clave: el usuario se entera y puede cancelar dentro de la ventana de 48h.
- Usar una clave de guardian **dedicada y en frío** (HSM/cold), distinta de las
  claves calientes que firman paymaster y router (que están en línea constantemente).
- Considerar guardian **opt-in** o por-usuario en vez de uno global. `initialize`
  ya admite `guardian_ = address(0)` para desactivarlo.
- Documentar el procedimiento de respuesta ante incidente (rotar guardian vía
  `setGuardian` en una UserOp).

### L-3 (Baja) — Griefing de recovery

`RecoveryAlreadyProposed` impide proponer una nueva recovery mientras haya una
pendiente. Un guardian malicioso podría proponer signers inválidos (p. ej. threshold
0, que `MultiSignerERC7913` rechaza), dejando la propuesta atascada hasta que el dueño
ejecute `cancelRecovery`. Impacto: molestia (el usuario gasta una operación en
cancelar), no robo. El peor caso (toma de control) ya está cubierto por el timelock +
cancel. Aceptable.

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

### L-1 (Baja) — Sin tope on-chain de coste por operación

El paymaster patrocina el gas en su totalidad sin un límite máximo de coste por op a
nivel de contrato; el control recae en la firma del backend. Si la clave
`sponsorSigner` se filtra, un atacante podría drenar el depósito del paymaster en el
EntryPoint patrocinando operaciones. Mitigaciones: mantener el depósito acotado,
monitorizar, y rotar el firmante. Como defensa en profundidad, se podría añadir un
tope de coste de gas on-chain. Ver también M-2.

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
ERC-20 estándar), no aplica en la práctica. Recomendación: no listar tokens con
fee-on-transfer/rebasing.

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
- **M-3 (Media) — Upgrade con layout de almacenamiento roto.** Las variables propias
  de AccountWebAuthnV2 (`guardian`, `recoveryExecutableAfter`, `_pendingSigners`,
  `_pendingThreshold`) usan almacenamiento secuencial clásico (los mixins de OZ v5 sí
  usan almacenamiento namespaced ERC-7201, así que no colisionan entre sí). En un
  futuro V3 la regla es **solo añadir** variables nuevas al final; nunca reordenar,
  insertar entre medias ni cambiar tipos. Recomendaciones:
  - Añadir un chequeo de **storage-layout diff en CI** (`forge inspect <C> storage-layout`
    o el plugin de upgrades de OZ) antes de cada upgrade.
  - Añadir un test de ruta de upgrade: desplegar proxy V2 → upgrade a V3 → afirmar que
    saldos y signers se preservan.
  - Opcional: migrar las variables propias a un struct namespaced (ERC-7201) o añadir
    un `__gap`, para máxima robustez.
- **Compromiso de claves** (guardian/firmantes): ver M-1 y M-2.

---

## M-2 (Media, transversal) — Gestión de claves del backend

El backend tiene tres roles de firma: `sponsorSigner` (paymaster), `invoiceSigner`
(router) y `guardian` (cuentas). La superficie de riesgo real del sistema es la
custodia de estas claves. Recomendaciones para mainnet:

- **Claves distintas por rol** y separación caliente/frío (firmantes en línea ≠ owner
  que controla fondos/retiros). Recogido en `DEPLOY.md` §11.
- Almacenar firmantes en HSM/KMS; nunca en el repositorio ni en variables planas
  compartidas.
- **Playbook de rotación** documentado: `setSponsorSigner`, `setInvoiceSigner`,
  `setGuardian`, y transferencia de owner en dos pasos.
- **Monitorización** de eventos `RecoveryProposed`, `InvoicePaid`, depósito del
  paymaster en el EntryPoint, con alertas.

---

## Recomendaciones generales

- Fijar versión exacta del compilador (`0.8.28`) y lockfile de OpenZeppelin para
  builds reproducibles y direcciones CREATE2 estables.
- Mantener `optimizer_runs` **fijo** (ya documentado en `foundry.toml`): cambiarlo
  altera el bytecode y, por tanto, las direcciones derivadas.
- Ampliar la batería de tests: fuzzing de montos/comisiones en el router, tests de
  invariantes (el router nunca debe quedar con saldo), y el test de ruta de upgrade
  (M-3).
- Para escalar TVL real en mainnet: **auditoría externa** y/o programa de bug bounty
  antes de aumentar los límites de fondos.

## Conclusión

El conjunto es sólido y conservador: se apoya en primitivas auditadas de OZ v5, no
custodia fondos en el rail de pagos, y la actualizabilidad UUPS + factory determinista
**elimina** la causa raíz de las pérdidas previas en Base. El trabajo pendiente es
operativo más que de código: gestión de claves disciplinada (M-1, M-2), chequeos de
layout en CI antes de cualquier upgrade (M-3), y —antes de escalar fondos en
mainnet— una auditoría externa.
