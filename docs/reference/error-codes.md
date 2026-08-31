# Contrato de errores de la API

> Referencia de los códigos de error de la API de GatoPago. Fuente de verdad en
> código: [`shared/errors.ts`](../../shared/errors.ts) (`ERR` + `ERROR_HTTP_STATUS`).
> El test `server/test/errors.test.ts` impide que un código quede sin status.
> Fecha: julio 2026. Relacionado: [`ARCHITECTURE.md`](../../ARCHITECTURE.md) y
> [diseño de la API](../design/api.md).

## Forma de la respuesta

Toda respuesta de error devuelve el mismo sobre, con un status HTTP que sigue
semántica REST:

```json
{
  "error": "Saldo USDC insuficiente (tienes 1.20 USDC)",
  "error_code": "INSUFFICIENT_BALANCE",
  "requestId": "a1b2c3d4"
}
```

- **`error_code`** — código estable e independiente del idioma. **Es el contrato.**
- **`error`** — mensaje humano (español), para logs y compatibilidad. El cliente
  **no lo parsea**; solo lo usa como respaldo si no reconoce el código.
- **`requestId`** — id de correlación para encontrar la línea de log en soporte.

El cliente mapea `error_code → t("err." + code)` y muestra el texto en el idioma
activo (ver `client/src/locales/{es,en}.json`, sección `err`). Una respuesta sin
`error_code` no rompe nada: el cliente cae al texto del server.

## Convención de status HTTP (RFC 9110)

| Status | Significado | Cuándo |
|--------|-------------|--------|
| **400** Bad Request | Entrada inválida, faltante o malformada; regla de negocio que impide cumplir una petición bien formada. |
| **401** Unauthorized | Credenciales ausentes/inválidas. Tanto la API `/v1` (clave `sk_`) como el middleware de Firebase-JWT de la app devuelven `UNAUTHENTICATED` (la app lo mapea a "sesión expirada"); la API M2M distingue además `INVALID_API_KEY`. |
| **403** Forbidden | El llamante es conocido pero no tiene permiso, o falló una compuerta (ej. captcha). |
| **404** Not Found | El recurso direccionado no existe. |
| **409** Conflict | La petición choca con el estado actual del recurso. |
| **413** Content Too Large | El cuerpo supera el límite global aceptado. |
| **429** Too Many Requests | Se agotó un límite de abuso o presupuesto temporal. |
| **500** Internal Server Error | Falla inesperada de nuestro lado o revert on-chain. |
| **503** Service Unavailable | Configuración incompleta o dependencia temporalmente no disponible. |

> No usamos aún 402/422: las violaciones de regla de negocio (ej.
> `INSUFFICIENT_BALANCE`) van como **400** por compatibilidad amplia con proxies
> y herramientas (422 sería la opción REST más estricta).

## Catálogo de códigos

### 400 — Bad Request

| Código | Significado |
|--------|-------------|
| `MISSING_PASSKEY_DATA` | Faltan `credentialId`/`qx`/`qy` de la passkey. |
| `INVALID_CALLDATA` | `callData` no es un hex válido. |
| `INVALID_WALLET` | Dirección de destino no es una `0x…` válida. |
| `INVALID_AMOUNT` | Monto no numérico, ≤ 0, o inválido para los decimales del token. |
| `UNSUPPORTED_CURRENCY` | Moneda fuera de la whitelist de la red. |
| `INVALID_USERNAME` | Username fuera de `^[a-z0-9_-]{3,30}$`. |
| `INVALID_CURSOR` | Cursor opaco de paginación ausente, alterado o malformado. |
| `INVALID_EMAIL` | El correo de acceso no tiene un formato válido. |
| `AUTH_CODE_INVALID` | Compatibilidad Business: el código legacy es incorrecto, expiró o agotó sus intentos. La App de consumo usa magic links. |
| `WEBAUTHN_REGISTRATION_INVALID` | La ceremonia de alta no coincide con challenge, origen, RP, algoritmo o clave esperados. |
| `INVALID_PROFILE` | `displayName`/`socialUrl` fuera del formato aceptado (largo, allowlist de redes). |
| `USERNAME_RESERVED` | Username en la lista de reservados (rutas, traps). |
| `INVALID_TOKEN` | Token de push inválido. |
| `UNSUPPORTED_TOKEN` | Token de swap fuera de la whitelist. |
| `SAME_TOKEN` | `tokenIn === tokenOut` en un swap. |
| `SLIPPAGE_OUT_OF_RANGE` | Slippage fuera de `[1, MAX]`. |
| `QUOTE_MISSING` | Falta `quoteId` al preparar un swap. |
| `MISSING_CONTACT` | Falta el id del contacto a borrar. |
| `CANNOT_ADD_SELF` | Intentar agregarse a sí mismo como contacto. |
| `INSUFFICIENT_BALANCE` | Saldo del token insuficiente para el pago/swap (regla de negocio). |
| `SWAPS_DISABLED` | Swaps no habilitados en la red activa. |
| `BRIDGE_DISABLED` | Cross-chain no habilitado (solo mainnet). |
| `EARN_DISABLED` | Ahorro (Aave) no habilitado en la red activa, pausado (`EARN_PAUSED`) o el reserve no admite la operación. |
| `BRIDGE_INVALID_REQUEST` | Cotización de puente inválida (red no soportada, monto fuera de rango). |
| `UNSUPPORTED_CHAIN` | Red origen/destino no soportada para cross-chain. |
| `INVALID_RECIPIENT` | Dirección de destino cross-chain inválida. |
| `CROSSCHAIN_UNAVAILABLE` | La ruta cross-chain existe pero no se puede ofrecer ahora (gas del relayer no verificado/insuficiente o ruta deshabilitada). Reintentable. |
| `MISSING_SIGNATURE_DATA` | Falta el payload de firma WebAuthn en `/pay/submit`. |
| `INVALID_TX_HASH` | Hash de transacción malformado (registro inbound cross-chain). |
| `NO_WALLET` | La acción requiere una cuenta y el usuario no la tiene. *(En `GET /user/balance` el mismo caso devuelve **404** por ser lookup de recurso.)* |
| `METADATA_TOO_LARGE` | `metadata` del payment intent supera 8 KB. *(API `/v1`)* |
| `INVALID_EXPIRY` | `expires_in` fuera de 60..86400 s. *(API `/v1`)* |
| `ROUTER_DISABLED` | PaymentRouter no desplegado / moneda no soportada para pago on-chain (Flow B). *(API `/v1`)* |
| `SANDBOX_ONLY` | `simulate_payment` solo con claves `test`. *(API `/v1`)* |
| `INVALID_WEBHOOK_URL` | URL de webhook no es `https://` (`http://localhost` permitido en test). *(API merchant)* |

### 401 — Unauthorized

| Código | Significado |
|--------|-------------|
| `UNAUTHENTICATED` | Falta/expiró la credencial: header `Authorization: Bearer sk_…` en `/v1`, o sesión Firebase en la app. |
| `INVALID_API_KEY` | Formato inválido, clave inexistente o revocada. *(API `/v1`)* |

### 403/413/503 — Forbidden, Content Too Large y Service Unavailable

| Código | Significado |
|--------|-------------|
| `HUMAN_VERIFY_FAILED` | Verificación Turnstile fallida. |
| `QUOTE_WRONG_ACCOUNT` | La cotización no pertenece a la cuenta del llamante. |
| `WRONG_ACCOUNT` | El recurso direccionado (p. ej. un pago preparado) pertenece a otra cuenta. |
| `FAUCET_DISABLED` | El faucet está deshabilitado para la red activa. |
| `AUTH_ACCOUNT_DISABLED` | Firebase marca la cuenta como deshabilitada. |
| `STEP_UP_REQUIRED` | La operación sensible necesita un proof de código de correo. |
| `STEP_UP_INVALID` | El proof de seguridad expiró, ya fue consumido o no pertenece al usuario. |
| `STEP_UP_UNAVAILABLE` | La cuenta no tiene un correo Firebase verificado para confirmar la operación. |
| `PAYLOAD_TOO_LARGE` | El cuerpo de la solicitud supera 64 KiB. |
| `SERVICE_UNAVAILABLE` | La configuración del despliegue está incompleta; reintentar cuando el servicio esté listo. |
| `BUNDLER_UNAVAILABLE` | Los endpoints ERC-4337 configurados no están disponibles temporalmente. |
| `BUNDLER_ENTRYPOINT_UNSUPPORTED` | Ningún bundler configurado anuncia el EntryPoint v0.9 de GatoPago. |

### 404 — Not Found

| Código | Significado |
|--------|-------------|
| `LINK_NOT_FOUND` | Link de cobro inexistente. |
| `USER_NOT_FOUND` | Usuario inexistente. |
| `QUOTE_NOT_FOUND` | Cotización inexistente. |
| `INTENT_NOT_FOUND` | Payment intent / operación cross-chain inexistente. |
| `EVENT_NOT_FOUND` | Evento inexistente. *(API `/v1`)* |
| `OPERATION_NOT_FOUND` | Operación durable de cuenta inexistente. |
| `PASSKEY_NOT_FOUND` | La passkey no existe o no pertenece a la cuenta. |
| `PENDING_NOT_FOUND` | El UserOp preparado a enviar no existe (expiró o nunca se preparó). |
| `NO_ROUTE` | No hay ruta de swap para el par. *(En `/swap/prepare` se devuelve como **409** cuando una ruta ya cotizada desapareció.)* |

### 409 — Conflict

| Código | Significado |
|--------|-------------|
| `ACCOUNT_EXISTS` | Ya existe una cuenta para este usuario. |
| `USERNAME_TAKEN` | El username ya está en uso por otra cuenta. |
| `LINK_ALREADY_PAID` | El link de cobro ya fue pagado. |
| `FAUCET_ALREADY_CLAIMED` | El faucet de prueba ya fue canjeado. |
| `RECOVERY_IN_PROGRESS` | Ya hay una recuperación de cuenta en curso. |
| `RECOVERY_NONE` | No hay recuperación pendiente para ejecutar. |
| `RECOVERY_NOT_READY` | El timelock de la recuperación aún no venció. |
| `RECOVERY_SIGNER_MISMATCH` | La credencial enviada a `/account/recovery/execute` no coincide con el signer propuesto on-chain. |
| `QUOTE_USED` | La cotización ya fue consumida. |
| `QUOTE_EXPIRED` | La cotización venció (60 s). |
| `QUOTE_WRONG_NETWORK` | La cotización es de otra red. |
| `PRICE_MOVED` | El precio se movió bajo el piso de slippage; recotizar. |
| `INTENT_NOT_PAYABLE` | El intent no está pagable (ya pagado/cancelado/**expirado** — `expires_at` se aplica en pago, autorización on-chain y simulate). |
| `TX_ALREADY_REGISTERED` | El tx de burn ya está registrado en otra operación cross-chain. |
| `PAYMENT_IN_PROGRESS` | El mismo pago preparado ya fue enviado (request duplicado; el claim atómico bloquea el doble submit). |
| `LAST_PASSKEY` | No se puede quitar el último signer WebAuthn activo. |
| `PASSKEY_NOT_ACTIVE` | La credencial existe en el registro pero no coincide con un signer onchain activo. |
| `PASSKEY_VERIFICATION_FAILED` | No se pudo confirmar una passkey activa con el challenge WebAuthn vigente. |
| `PASSKEY_ALREADY_REGISTERED` | El credential ID ya está registrado. |

### 429 — Too Many Requests

| Código | Significado |
|--------|-------------|
| `RATE_LIMITED` | Límite del rate limiter in-Worker (ventana fija en D1) en endpoints públicos/sensibles: `/account/create` (por IP), `/account/fund` (por usuario), `/crosschain/inbound/{prepare,register}` (por IP). Defensa en profundidad detrás de Turnstile; las reglas de zona de Cloudflare siguen siendo la capa fuerte. |

### 500 — Internal Server Error

| Código | Significado |
|--------|-------------|
| `SERVER_ERROR` | Falla inesperada genérica (incluye el handler global). |
| `PAYMENT_FAILED` | Falla genérica al enviar el pago. |
| `TX_REVERTED` | La transacción on-chain hizo revert. |
| `INSUFFICIENT_GAS` | El relayer/cuenta no pudo cubrir el gas (AA21/AA95). |
| `PAYMASTER_REJECTED` | El paymaster rechazó la operación (firmante/config, AA33/AA34). |
| `PAYMASTER_DEPOSIT_LOW` | Depósito insuficiente del paymaster en el EntryPoint (AA31). |
| `CONTRACT_NOT_DEPLOYED` | La red activa tiene placeholders `TODO_DEPLOY` (config incompleta; guard fail-closed). |
| `QUOTE_FAILED` | Falla al cotizar un swap. |
| `SWAP_PREPARE_FAILED` | Falla al preparar el UserOp del swap. |
| `BRIDGE_QUOTE_FAILED` | Falla al cotizar el puente. |
| `CROSSCHAIN_PREPARE_FAILED` | Falla al preparar el envío/cobro cross-chain. |
| `PASSKEY_MISMATCH` | La firma de la passkey no coincide con la wallet (AA24). |

## Helper de respuesta (API `/v1` + merchant)

La superficie de la API usa `apiError(c, ERR.X, "mensaje", extra?)`
(`server/src/services/apiError.ts`): toma el status de `ERROR_HTTP_STATUS`,
adjunta `requestId` siempre y serializa el sobre. Así status y código **no pueden
desincronizarse** y todo error de la API lleva `requestId`. Las rutas internas de
la app (pay/account/swap/…) aún escriben `c.json({ … }, status)` a mano; pueden
migrarse al helper de forma incremental.

## Cómo agregar un código

1. Añádelo a `ERR` en `shared/errors.ts`, en el grupo HTTP que corresponda.
2. Añade su status en `ERROR_HTTP_STATUS` (el test `errors.test.ts` lo exige).
3. Úsalo: en la API, `apiError(c, ERR.X, "mensaje")`; en rutas internas,
   `c.json({ error, error_code: ERR.X, requestId }, ERROR_HTTP_STATUS.X)`.
4. Si el código lo puede ver el **cliente de la app**, agrega la clave `err.X` en
   `client/src/locales/{es,en}.json`. Los códigos **solo de `/v1`** (consumidos por
   comercios externos) **no** necesitan locale: el cliente cae al texto del server.
5. Documenta la fila aquí.
