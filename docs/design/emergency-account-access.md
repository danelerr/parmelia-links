# Acceso de emergencia y soberanía de las cuentas GatoPago

**Fecha:** 24 de agosto de 2026<br>
**Estado de la decisión:** aceptada; implementación del cliente de rescate pendiente<br>
**Alcance:** cuentas `AccountWebAuthnV2`, passkeys WebAuthn y EntryPoint ERC-4337 v0.9<br>
**Nivel de evidencia:** código fuente y configuración local del repositorio; no constituye por sí solo una prueba E2E de producción

Este documento responde una pregunta de producto concreta:

> Si GatoPago desaparece, ¿el usuario puede seguir accediendo a su dinero y
> moverlo sin usar la aplicación o el backend de GatoPago?

La respuesta corta es:

> **Sí es técnicamente posible mover los fondos sin Firebase, D1, el backend, el
> relayer ni el paymaster de GatoPago, usando la passkey y la infraestructura
> pública de ERC-4337. No es posible hacerlo con una simple llamada directa a
> `execute` desde un explorador. Además, mientras la passkey sea el único signer,
> la ruta conserva una dependencia del RP ID/dominio WebAuthn.**

Por tanto, hoy existe una ruta técnica **condicional**, pero todavía no una salida
de emergencia terminada, probada y completamente independiente de GatoPago.

## 1. Dónde están realmente los fondos

La cuenta del usuario es una **smart contract wallet** desplegada en una dirección
propia. No es un saldo guardado en Firebase ni en D1.

| Activo | Dónde existe el saldo | Qué dirección tiene autoridad |
|---|---|---|
| ETH nativo | Balance nativo de la dirección de `AccountWebAuthnV2` | La smart account |
| USDC u otro ERC-20 | Mapping de balances del contrato del token | La smart account figura como titular |
| ERC-721 / ERC-1155 | Estado de propiedad del contrato NFT | La smart account figura como titular |
| Posición DeFi tokenizada | Contrato del protocolo o token de posición | La smart account |

La smart account no necesita mantener un mapping interno con todos los tokens.
Lo importante es que la dirección de la cuenta es la titular onchain y que sus
acciones están autorizadas por sus signers.

GatoPago no posee la clave privada P256 de la passkey. Sin embargo, el modelo
actual sí asigna una EOA del servidor como `guardian`. Ese guardian no puede
realizar un pago inmediato, pero puede proponer reemplazar todos los signers y,
después del timelock de 48 horas, ejecutar la recuperación. Por eso el modelo
actual debe describirse como **autocustodia con recuperación asistida y
timelock**, no como ausencia absoluta de autoridad de GatoPago.

## 2. Por qué no basta con “Write Contract”

`AccountWebAuthnV2` hereda el ejecutor ERC-7821. Su función `execute(mode,
executionData)` permite que la cuenta llame a un token, destinatario o protocolo,
pero el contrato autoriza como caller únicamente a:

1. El EntryPoint ERC-4337 canónico.
2. La propia smart account.

Una EOA cualquiera conectada a Arbiscan/Etherscan no pasa ese control de acceso.
El test `test_execute_onlyEntryPointOrSelf` comprueba expresamente el rechazo.

La ruta normal es:

```text
acción solicitada
  -> calldata ERC-7821 de AccountWebAuthnV2.execute(...)
  -> PackedUserOperation ERC-4337
  -> userOpHash del EntryPoint v0.9
  -> assertion WebAuthn sobre ese hash
  -> firma WebAuthn codificada dentro de la multifirma ERC-7913
  -> eth_sendUserOperation a un bundler
     o EntryPoint.handleOps(...) enviado por una EOA auxiliar
  -> validación de la passkey dentro de AccountWebAuthnV2
  -> ejecución del movimiento desde la smart account
```

Un explorador sí puede servir para:

- Leer balances, bytecode, signers, threshold, guardian y nonce.
- Inspeccionar la implementación y los eventos.
- Enviar un `handleOps` ya armado y firmado, si el explorador soporta correctamente
  el tuple de EntryPoint v0.9.

No puede por sí solo:

- Pedir una assertion a la passkey WebAuthn existente.
- Construir y explicar de manera segura el `callData`.
- Convertir la firma DER P256 al formato que valida el contrato.
- Resolver automáticamente gas, prefund, simulación y envío ERC-4337.

La documentación es necesaria, pero **la documentación no sustituye al software
que habla con la passkey**.

## 3. Flujo de rescate sin backend de GatoPago

Un cliente independiente puede implementar el flujo usando solamente datos
públicos y una passkey del usuario.

### 3.1 Precondiciones

El usuario o cliente de rescate necesita:

1. Dirección de la smart account.
2. `chainId`, RPC y dirección exacta del EntryPoint.
3. ABI de la cuenta, EntryPoint y tokens que se quieran mover.
4. Lista onchain de signers y threshold.
5. RP ID con el que fue creada la passkey.
6. Acceso a la passkey en el dispositivo o proveedor sincronizado.
7. Una ruta de gas independiente.

No necesita:

- Firebase Auth.
- La base D1.
- El API `/pay/prepare` o `/pay/submit`.
- El paymaster de GatoPago.
- La clave del relayer de GatoPago.
- La clave del guardian para una operación normal firmada por la passkey.

### 3.2 Lecturas iniciales

Antes de firmar, el cliente debe comprobar al menos:

- Que `eth_getCode(account)` no esté vacío.
- Que la cuenta use el EntryPoint v0.9 esperado.
- `getSigners(0, type(uint64).max)`.
- `threshold()`.
- `guardian()` y cualquier recovery pendiente.
- `EntryPoint.getNonce(account, 0)`.
- Balance nativo, depósito en EntryPoint y balances de tokens.
- Implementación UUPS/codehash reconocido para no aplicar una ABI incorrecta.

Ejemplos de lecturas con Foundry Cast, sustituyendo los placeholders:

```powershell
cast code <ACCOUNT> --rpc-url <RPC_URL>
cast balance <ACCOUNT> --rpc-url <RPC_URL>
cast call <ACCOUNT> "getSigners(uint64,uint64)(bytes[])" 0 18446744073709551615 --rpc-url <RPC_URL>
cast call <ACCOUNT> "threshold()(uint64)" --rpc-url <RPC_URL>
cast call <ACCOUNT> "guardian()(address)" --rpc-url <RPC_URL>
cast call <ENTRYPOINT> "getNonce(address,uint192)(uint256)" <ACCOUNT> 0 --rpc-url <RPC_URL>
cast call <USDC> "balanceOf(address)(uint256)" <ACCOUNT> --rpc-url <RPC_URL>
cast call <ENTRYPOINT> "balanceOf(address)(uint256)" <ACCOUNT> --rpc-url <RPC_URL>
```

Estas llamadas son de solo lectura. No exponen ni solicitan claves.

### 3.3 Construcción de la acción

Para mover activos, el cliente codifica un batch ERC-7821:

- ETH: `target = destinatario`, `value = monto`, `callData = 0x`.
- ERC-20: `target = token`, `value = 0`, `callData =
  token.transfer(destinatario, monto)`.
- Posiciones DeFi: llamada explícita y previamente allowlisted al protocolo, o
  transferencia del token de posición si el protocolo lo permite.

El batch se envuelve en `AccountWebAuthnV2.execute(mode, executionData)`. El
`mode` actual es batch call con ejecución atómica. El cliente de rescate debe
mostrar antes de firmar, en lenguaje humano:

- Red y chain ID.
- Cuenta de origen.
- Destinatario.
- Token y contrato del token.
- Monto y decimales.
- Cada target y selector del batch.
- Gas máximo y mecanismo que lo paga.

No debe aceptar calldata opaco proporcionado por un servidor.

### 3.4 Construcción del `PackedUserOperation`

Para una cuenta ya desplegada:

- `sender`: dirección de la smart account.
- `nonce`: leído del EntryPoint.
- `initCode`: `0x`.
- `callData`: el `execute` ERC-7821 anterior.
- Límites y precios de gas: estimados contra un bundler compatible o simulados.
- `paymasterAndData`: `0x` para no depender del paymaster de GatoPago.
- `signature`: inicialmente `0x` o una dummy signature válida para estimación.

El hash definitivo debe obtenerse con `EntryPoint.getUserOpHash(userOp)` o
recomputarse con el dominio EIP-712 exacto de EntryPoint v0.9 y compararse con el
resultado onchain. Ningún campo puede cambiar después de pedir la firma.

### 3.5 Firma con la passkey

El challenge WebAuthn es exactamente los 32 bytes de `userOpHash`.

El cliente llama a `navigator.credentials.get()` con:

- El RP ID original.
- `userVerification: "required"`.
- El credential ID si está disponible; si no, puede solicitar una credential
  discoverable del mismo RP ID.

La respuesta contiene `authenticatorData`, `clientDataJSON` y una firma DER. El
cliente debe:

1. Extraer `r` y `s`.
2. Normalizar `s` a low-s para P256.
3. Encontrar los índices exactos de `"challenge"` y `"type"` en
   `clientDataJSON`.
4. Codificar la estructura interna:

```solidity
abi.encode(
    bytes32 r,
    bytes32 s,
    uint256 challengeIndex,
    uint256 typeIndex,
    bytes authenticatorData,
    string clientDataJSON
)
```

5. Obtener del contrato el signer registrado exacto:
   `verifierAddress || qx || qy`.
6. Codificar la multifirma exterior:

```solidity
abi.encode(
    bytes[] signers,
    bytes[] signatures
)
```

Si el threshold es mayor que uno, hay que reunir suficientes assertions y
ordenar los signers por su identificador `keccak256`, conservando la
correspondencia entre cada signer y su firma.

En una cuenta con varias passkeys, una assertion no vuelve a revelar `qx/qy`.
Por eso el kit de recuperación debe incluir la asociación no secreta entre
credential ID, signer onchain y RP ID. Como fallback técnico puede simularse la
firma contra cada signer registrado, pero no debe ser la experiencia principal.

### 3.6 Gas y envío

Hay tres rutas que no dependen económicamente de GatoPago:

1. **Prefund desde la propia cuenta:** la smart account mantiene ETH suficiente
   y cubre el `missingAccountFunds` solicitado por EntryPoint.
2. **Depósito externo:** cualquier EOA auxiliar deposita ETH para la cuenta con
   `EntryPoint.depositTo(account)` y luego un bundler o esa EOA envía
   `handleOps`. La EOA auxiliar paga gas, pero no adquiere autoridad sobre los
   fondos; la passkey sigue autorizando la acción.
3. **Paymaster independiente:** un tercero patrocina la operación sin utilizar
   las claves ni políticas de GatoPago.

Después de firmar, el cliente puede:

- Enviar `eth_sendUserOperation` a un bundler público compatible con el
  EntryPoint v0.9; o
- Conectar una EOA auxiliar y llamar directamente a
  `EntryPoint.handleOps([userOp], beneficiary)`.

El resultado debe decidirse leyendo el `UserOperationEvent` correspondiente y
exigiendo `success = true`. Que la transacción exterior esté minada no demuestra
por sí solo que la llamada interna de la cuenta haya funcionado.

## 4. El límite decisivo: RP ID y dominio

La clave privada de una passkey estándar permanece dentro del autenticador. El
navegador no la exporta. Al crear y usar la credential, el cliente actual elige
un RP ID a partir de `VITE_APP_URL` o del hostname actual.

WebAuthn exige que el origen que llama a `navigator.credentials.get()` esté
dentro del alcance del RP ID. Por ejemplo, una credential creada para
`app.parmelia.me` puede ser solicitada desde `app.parmelia.me` y, sujeto a las
reglas del navegador, desde un subdominio como `rescue.app.parmelia.me` usando
`rpId = app.parmelia.me`. No puede solicitarse normalmente desde:

- Un archivo abierto con `file://`.
- `localhost`.
- Un dominio arbitrario.
- Un sibling como `recovery.parmelia.me` sin configurar Related Origins.
- Una URL preview de Vercel diferente al RP ID original.

El verificador onchain de OpenZeppelin comprueba challenge, tipo, presencia,
user verification y firma P256. Intencionadamente no compara el origin ni el
`rpIdHash` contra un dominio almacenado onchain. Esto hace al contrato
criptográficamente independiente del dominio, pero **no hace que el sistema
operativo o navegador entregue la passkey desde cualquier origen**.

Además, el alta actual solicita `authenticatorAttachment: "platform"`. No se
puede asumir que una CLI CTAP para una llave USB tenga acceso a las passkeys de
iCloud, Google Password Manager, Windows Hello o el enclave del teléfono. Una
ruta CTAP de bajo nivel puede ser investigada para authenticators externos, pero
no forma parte de la garantía para las cuentas actuales.

Consecuencias:

- Si cae el backend pero conservamos el RP ID y la passkey, el rescate
  independiente es viable.
- Si desaparece el frontend normal pero existe un cliente estático en un origen
  válido, el rescate es viable.
- Una PWA instalada y cacheada puede ayudar durante una caída, pero el cache
  puede ser eliminado y no sirve como garantía permanente ni para todos los
  dispositivos.
- Si se pierde definitivamente el dominio/RP ID y la única autoridad es una
  passkey de plataforma, no existe una salida WebAuthn portable garantizada.

Unos términos y condiciones pueden revelar esta dependencia; no pueden
eliminarla técnicamente.

## 5. Decisión arquitectónica

Se adopta una estrategia de dos capas.

### Capa A — rescate independiente con la passkey existente

Crear un cliente de rescate pequeño, open source y reproducible que:

- No use Firebase, D1 ni APIs de GatoPago.
- Lea toda la configuración crítica onchain o desde un manifest versionado.
- Construya y decodifique localmente la operación.
- Use la passkey desde un origen válido para el RP ID.
- Soporte envío por bundler público y `handleOps` mediante EOA auxiliar.
- Soporte prefund externo con `depositTo`.
- Empiece con retiro de ETH y ERC-20 allowlisted hacia una dirección externa.
- Verifique `UserOperationEvent.success` y presente evidencia exportable.
- No cargue JavaScript remoto ni analítica.
- Se distribuya con código fuente, build reproducible, checksums y una copia
  estática de emergencia.

Para las credentials actuales con RP ID `app.parmelia.me`, el origen de
continuidad recomendado es `rescue.app.parmelia.me`. El dominio debe mantenerse
separado del deploy normal, con acceso y renovación protegidos. La herramienta
debe poder quedar instalada como PWA, pero la PWA no es la única copia.

Esta capa demuestra independencia del backend, relayer y paymaster. **No
demuestra independencia del dominio.**

### Capa B — signer de salida controlado por el usuario

Antes de prometer supervivencia total de GatoPago, añadir un signer alternativo
que no dependa de WebAuthn ni del RP ID:

- Wallet externa o hardware wallet del usuario.
- Safe/contrato ERC-1271 controlado por el usuario.
- Clave fría de recuperación generada localmente y nunca enviada al backend.

`MultiSignerERC7913` ya admite signers ECDSA de 20 bytes y ERC-1271, y
`AccountWebAuthnV2.addSigners` permite incorporarlos mediante una UserOperation
firmada por la passkey actual. El producto todavía debe implementar:

1. Prueba de posesión antes de registrar el signer.
2. Una operación real de ensayo después de registrarlo.
3. Exportación del manifest de recuperación.
4. Soporte del signer alternativo en el cliente de rescate.
5. Opción de reemplazar o eliminar el guardian de GatoPago.

Con threshold 1, una configuración passkey + signer frío permite que cualquiera
de las dos llaves recupere la cuenta. Esto mejora disponibilidad, pero convierte
la pérdida de la clave fría en un riesgo directo; el onboarding debe explicar el
tradeoff y favorecer hardware o almacenamiento offline.

### Decisiones rechazadas

- **“Publicar el ABI y que usen Etherscan”:** insuficiente; no genera ni codifica
  la assertion WebAuthn/UserOperation.
- **“La PWA cacheada siempre funcionará”:** no es una garantía de recuperación.
- **“El guardian del servidor demuestra autocustodia”:** es recuperación
  asistida, no independencia de GatoPago.
- **“La passkey se puede exportar como seed”:** falso para WebAuthn estándar.
- **“Importar la dirección en MetaMask”:** una smart account no se convierte en
  una EOA ni obtiene una private key por importarla como watch-only.
- **“Actualizar la implementación durante el rescate”:** fuera de alcance y de
  riesgo excesivo; el rescate debe minimizar llamadas y no realizar upgrades.

## 6. Manifest de recuperación

Cada cuenta debe poder exportar un JSON no secreto, versionado y verificable:

```json
{
  "format": "gatopago-recovery-v1",
  "chainId": 421614,
  "account": "0x...",
  "entryPoint": "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
  "accountImplementation": "0x...",
  "accountCodeHash": "0x...",
  "rpId": "app.parmelia.me",
  "signers": [
    {
      "type": "webauthn-p256",
      "credentialId": "base64url...",
      "erc7913Signer": "0x<verifier><qx><qy>"
    }
  ],
  "threshold": 1,
  "guardian": "0x...",
  "contracts": {
    "usdc": "0x..."
  }
}
```

El manifest no contiene una clave privada. Debe regenerarse al añadir o quitar
signers, cambiar threshold, cambiar guardian o actualizar la implementación.
Todos sus valores críticos deben revalidarse onchain al abrirlo; nunca se trata
como fuente de autorización.

Passkey Security v2 desplegado añade `rp_id` al esquema canónico
`passkeys` y `expected_rp_id` a cada ceremonia mediante la migración `0036`.
También devuelve el RP ID fijado por el Worker en registro y firma, en lugar de
derivarlo del host del frontend. Todavía falta añadir `rp_id` al manifest
exportable del cliente de rescate; D1 no debe ser su única fuente de continuidad.

## 7. Qué se puede prometer al usuario

### Mensaje correcto hoy

> Tus fondos están en una smart account en blockchain y no en una base de datos
> de GatoPago. Para moverlos se necesita una firma válida de tu passkey o el
> proceso de recuperación con timelock. Técnicamente se puede construir una
> operación ERC-4337 sin nuestro backend, pero el cliente de rescate independiente
> todavía no está publicado y la passkey conserva una dependencia de su dominio
> WebAuthn. No afirmamos todavía que puedas recuperar la cuenta desde cualquier
> wallet si GatoPago y el dominio desaparecen por completo.

### Mensaje permitido después de completar ambas capas

> Tu passkey sirve para el uso diario y tienes además un signer de recuperación
> controlado únicamente por ti. Si GatoPago desaparece, puedes usar la herramienta
> abierta de rescate para operar la misma cuenta o mover todos tus activos sin
> Firebase, nuestro backend, relayer, paymaster ni dominio.

Los términos y condiciones deben describir por separado:

- Propiedad onchain de los activos.
- Autoridad inmediata de los signers.
- Autoridad diferida del guardian y timelock.
- Dependencia del RP ID para passkeys.
- Estado real del cliente de rescate y del signer alternativo.
- Riesgo de perder todas las credenciales de recuperación.

No se debe usar una cláusula legal para afirmar una capacidad que todavía no ha
sido probada técnicamente.

## 8. Plan de implementación y prueba de desaparición

### P0 — antes de una promesa fuerte de autocustodia/mainnet

1. **Candidato local completo:** fijar y registrar el RP ID canónico para toda
   passkey nueva; bloquear altas en previews u orígenes fuera de la allowlist
   WebAuthn. Falta publicación y prueba real.
2. **Parcial:** `rp_id` ya está en el registro canónico local; falta incorporarlo
   al manifest exportable y probar la restauración independiente.
3. Construir el cliente de rescate independiente y reproducible.
4. Implementar gas por prefund externo y envío por al menos dos transportes.
5. Añadir el signer de salida EOA/ERC-1271 y prueba de posesión.
6. Permitir guardian propio u `address(0)` después de verificar el signer de
   salida.
7. Actualizar mensajes de producto, README, arquitectura y términos para reflejar
   exactamente el trust model.
8. Publicar direcciones, bytecode verificado, ABIs, hashes de release y manual.

### Prueba de aceptación obligatoria

El ejercicio debe ejecutarse con fondos de prueba y guardar evidencia:

1. Deshabilitar Firebase y todos los endpoints de GatoPago.
2. No usar el paymaster ni la EOA relayer de GatoPago.
3. Abrir el cliente de rescate desde el origen de continuidad.
4. Leer cuenta, implementation, signers, threshold y balances solamente por RPC.
5. Financiar el prefund desde una EOA externa.
6. Mover ETH y USDC mediante una UserOperation firmada por la passkey.
7. Repetir con una cuenta multi-passkey y comprobar la resolución del signer.
8. Repetir desde un dispositivo con una passkey sincronizada.
9. Comprobar `UserOperationEvent.success` y los balances finales.
10. Simular pérdida total del dominio y repetir usando solamente el signer
    alternativo.

La capa A queda probada solo si pasan los pasos 1–9. La afirmación de
independencia total queda probada únicamente si también pasa el paso 10.

## 9. Estado actual verificable en el repositorio

| Capacidad | Estado actual |
|---|---|
| Fondos asociados a una smart account onchain | Implementado en el modelo de cuenta |
| Lectura directa desde RPC/explorador | Posible |
| Llamada externa directa a `execute` | Rechazada por diseño |
| Ejecución por EntryPoint con firma WebAuthn | Implementada en la aplicación/backend actuales |
| UserOperation sin backend de GatoPago | Técnicamente viable; cliente público de rescate pendiente |
| Uso de passkey desde cualquier dominio | No; limitado por RP ID/WebAuthn |
| Supervivencia a caída de backend conservando dominio | Diseñable con la capa A; falta prueba E2E |
| Supervivencia a pérdida total de dominio con passkey actual | No garantizada |
| Signer EOA/ERC-1271 alternativo | Soportado por la base ERC-7913; flujo de producto pendiente |
| Guardian del servidor con timelock | Implementado; recuperación asistida, no salida independiente |
| Contratos de Arbitrum One | Marcados `TODO_DEPLOY` en la configuración actual |

No debe confundirse un frontend publicado como “producción” con una cuenta
mainnet operativa. La configuración compartida actual conserva direcciones
`TODO_DEPLOY` para Arbitrum One; cualquier afirmación de disponibilidad requiere
verificación de red, bytecode y una prueba de rescate fechada.

## 10. Evidencia técnica y estándares

Código relevante:

- [`AccountWebAuthnV2.sol`](../../contracts/src/AccountWebAuthnV2.sol): signers,
  guardian, recovery y autorización del ejecutor.
- [`Account.sol`](../../contracts/lib/openzeppelin-contracts/contracts/account/Account.sol):
  validación exclusiva a través del EntryPoint.
- [`draft-ERC7821.sol`](../../contracts/lib/openzeppelin-contracts/contracts/account/extensions/draft-ERC7821.sol):
  `execute` y control del executor.
- [`WebAuthn.sol`](../../contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/WebAuthn.sol):
  verificaciones onchain y omisiones explícitas de origin/RP ID.
- [`MultiSignerERC7913.sol`](../../contracts/lib/openzeppelin-contracts/contracts/utils/cryptography/signers/MultiSignerERC7913.sol):
  formato de signers, threshold y multifirma.
- [`webauthn.ts`](../../client/src/lib/webauthn.ts): RP ID, alta de passkey y
  generación de assertions.
- [`eip712.ts`](../../client/src/lib/eip712.ts): recomputación local del digest
  que firma la passkey.
- [`userOp.ts`](../../server/src/services/userOp.ts): construcción del batch,
  PackedUserOperation y hash EIP-712.
- [`pay.routes.ts`](../../server/src/routes/pay.routes.ts): codificación WebAuthn
  interna y multifirma ERC-7913 exterior.
- [`userOperationTransport.ts`](../../server/src/services/userOperationTransport.ts):
  envío por bundler o `handleOps` propio.
- [`EntryPointAbi.ts`](../../shared/EntryPointAbi.ts): ABI de EntryPoint v0.9.
- [`networks.ts`](../../shared/networks.ts): red y direcciones canónicas activas.
- [`AccountWebAuthnV2.t.sol`](../../contracts/test/AccountWebAuthnV2.t.sol):
  controles de acceso y recovery.

Estándares y documentación primaria:

- [ERC-4337 — Account Abstraction](https://eips.ethereum.org/EIPS/eip-4337)
- [ERC-7769 — JSON-RPC para ERC-4337](https://eips.ethereum.org/EIPS/eip-7769)
- [ERC-7913 — Signature Verifiers](https://eips.ethereum.org/EIPS/eip-7913)
- [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)
- [OpenZeppelin Smart Accounts](https://docs.openzeppelin.com/contracts/5.x/accounts)
- [OpenZeppelin Multisig Account](https://docs.openzeppelin.com/contracts/5.x/multisig)
