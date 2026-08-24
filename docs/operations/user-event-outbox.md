# Runbook: eventos muertos del outbox

Este procedimiento recupera un `user_event_outbox` atascado sin leer `uid` ni
`payload_json`. Un evento de este outbox es una notificación o invalidación de
UI; nunca decide la validez de un pago ni modifica el ledger.

## 1. Confirmar acceso y diagnosticar sin datos personales

Ejecutar desde la raíz del repositorio:

```powershell
pnpm --filter server exec wrangler d1 migrations list GATOPAGO_DB --remote
pnpm --filter server exec wrangler d1 execute GATOPAGO_DB --remote --command "SELECT id, event_type, attempt_count, last_error_code, created_at, updated_at FROM user_event_outbox WHERE status = 'dead' ORDER BY updated_at DESC;"
```

Si Cloudflare devuelve `7403`, detenerse: la sesión o token no pertenece a la
cuenta que posee la D1. No cambiar el `database_id` para sortear el error.

## 2. Corregir la causa antes de reintentar

- `TERMINAL_PUSH_NOT_CONFIGURED`: configurar `FCM_SERVICE_ACCOUNT` y comprobar
  que el proyecto coincide con `FIREBASE_PROJECT_ID`.
- `TERMINAL_PUSH_TRANSIENT` o `TERMINAL_DELIVERY_EXCEPTION`: revisar FCM y logs;
  reintentar únicamente cuando el proveedor vuelva a responder.
- `TERMINAL_UNSUPPORTED_EVENT_TYPE`: desplegar primero un consumidor que soporte
  ese `event_type`. No convertirlo en `delivered` para silenciar health.
- `TERMINAL_INVALID_PAYLOAD`: corregir el productor y crear un evento
  compensatorio válido. No editar el payload histórico.

## 3. Reencolar una sola fila de forma condicionada

Reemplazar `<ID>` y `<ERROR_CODE>` por los valores exactos obtenidos en el paso
1. La condición impide reabrir una fila que otro operador ya resolvió.

```powershell
pnpm --filter server exec wrangler d1 execute GATOPAGO_DB --remote --command "UPDATE user_event_outbox SET status = 'pending', attempt_count = 0, next_attempt_at = CURRENT_TIMESTAMP, lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = '<ID>' AND status = 'dead' AND last_error_code = '<ERROR_CODE>'; SELECT changes() AS requeued;"
```

`requeued` debe ser exactamente `1`. Cualquier otro resultado obliga a volver al
paso 1; no ampliar el `WHERE` ni reencolar todas las filas en bloque.

## 4. Despertar y verificar

Con la versión que incluye recuperación de jobs ya desplegada, consultar health
despierta de forma idempotente el scheduler cuando detecta trabajo pendiente:

```powershell
Invoke-RestMethod -Uri "https://server.parmelia.workers.dev/health"
```

Esperar a que el backoff termine y repetir solamente la consulta redactada del
paso 1. El cierre exige cero filas `dead` y `/health` con `warningCount` igual a
`0`. El detalle interno se consulta sólo por `/health/ops` con `X-Ops-Token`.

## Prohibiciones

- No consultar ni copiar `uid` o `payload_json` a tickets o terminales grabadas.
- No borrar filas ni marcarlas `delivered` manualmente.
- No reintentar antes de corregir la causa; el límite de 12 intentos existe para
  detener poison rows.
- No ejecutar este runbook contra producción desde una cuenta Cloudflare dudosa.
