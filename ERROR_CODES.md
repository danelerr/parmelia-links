# Contrato de errores de la API

> Referencia de los códigos de error de la API de Parmelia. Fuente de verdad en
> código: [`shared/errors.ts`](shared/errors.ts) (`ERR` + `ERROR_HTTP_STATUS`).
> El test `server/test/errors.test.ts` impide que un código quede sin status.
> Fecha: junio 2026. Relacionado: `ARCHITECTURE.md`, `API_DESIGN.md`.

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
| **401** Unauthorized | Credenciales ausentes/ inválidas en la API `/v1` (clave `sk_`). El middleware de Firebase-JWT de la app devuelve un 401 sin código (la app muestra "sesión expirada"); la API M2M sí devuelve código. |
| **403** Forbidden | El llamante es conocido pero no tiene permiso, o falló una compuerta (ej. captcha). |
| **404** Not Found | El recurso direccionado no existe. |
| **409** Conflict | La petición choca con el estado actual del recurso. |
| **500** Internal Server Error | Falla inesperada de nuestro lado o revert on-chain. |

> No usamos aún 402/422/429: las violaciones de regla de negocio (ej.
> `INSUFFICIENT_BALANCE`) van como **400** por compatibilidad amplia con proxies
> y herramientas (422 sería la opción REST más estricta); el rate-limiting se
> aplica en el borde (Cloudflare), no por ruta.

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
| `NO_WALLET` | La acción requiere una cuenta y el usuario no la tiene. *(En `GET /user/balance` el mismo caso devuelve **404** por ser lookup de recurso.)* |
| `METADATA_TOO_LARGE` | `metadata` del payment intent supera 8 KB. *(API `/v1`)* |
| `INVALID_EXPIRY` | `expires_in` fuera de 60..86400 s. *(API `/v1`)* |
| `ROUTER_DISABLED` | PaymentRouter no desplegado / moneda no soportada para pago on-chain (Flow B). *(API `/v1`)* |
| `SANDBOX_ONLY` | `simulate_payment` solo con claves `test`. *(API `/v1`)* |
| `INVALID_WEBHOOK_URL` | URL de webhook no es `https://` (`http://localhost` permitido en test). *(API merchant)* |

### 401 — Unauthorized *(API `/v1`, claves `sk_`)*

| Código | Significado |
|--------|-------------|
| `UNAUTHENTICATED` | Falta el header `Authorization: Bearer sk_…`. |
| `INVALID_API_KEY` | Formato inválido, clave inexistente o revocada. |

### 403 — Forbidden

| Código | Significado |
|--------|-------------|
| `HUMAN_VERIFY_FAILED` | Verificación Turnstile fallida. |
| `QUOTE_WRONG_ACCOUNT` | La cotización no pertenece a la cuenta del llamante. |

### 404 — Not Found

| Código | Significado |
|--------|-------------|
| `LINK_NOT_FOUND` | Link de cobro inexistente. |
| `USER_NOT_FOUND` | Usuario inexistente. |
| `QUOTE_NOT_FOUND` | Cotización inexistente. |
| `INTENT_NOT_FOUND` | Payment intent inexistente. *(API `/v1`)* |
| `EVENT_NOT_FOUND` | Evento inexistente. *(API `/v1`)* |
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
| `QUOTE_USED` | La cotización ya fue consumida. |
| `QUOTE_EXPIRED` | La cotización venció (60 s). |
| `QUOTE_WRONG_NETWORK` | La cotización es de otra red. |
| `PRICE_MOVED` | El precio se movió bajo el piso de slippage; recotizar. |
| `INTENT_NOT_PAYABLE` | El intent no está `awaiting_payment` (ya pagado/cancelado/expirado). *(API `/v1`)* |

### 500 — Internal Server Error

| Código | Significado |
|--------|-------------|
| `SERVER_ERROR` | Falla inesperada genérica (incluye el handler global). |
| `PAYMENT_FAILED` | Falla genérica al enviar el pago. |
| `TX_REVERTED` | La transacción on-chain hizo revert. |
| `INSUFFICIENT_GAS` | El relayer/cuenta no pudo cubrir el gas (AA21/AA95). |
| `QUOTE_FAILED` | Falla al cotizar un swap. |
| `SWAP_PREPARE_FAILED` | Falla al preparar el UserOp del swap. |
| `BRIDGE_QUOTE_FAILED` | Falla al cotizar el puente. |
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
