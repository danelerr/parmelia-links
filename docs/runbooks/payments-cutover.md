# Runbook: corte App → Payments sin perder escrituras

**Fecha:** 25 de agosto de 2026  
**Estado:** procedimiento preparado; no ejecutado remotamente  
**Alcance:** mover el dominio de cobros desde App D1/App Queue hacia Payments
D1/Payments Queue sin doble escritura ni confirmaciones falsas.

## Invariante

En cada instante existe un solo dueño de las escrituras de pagos:

| Modo App | Lecturas de superficies extraídas | Escrituras de checkout | Runtime checkout legacy |
|---|---|---|---|
| `legacy` | App DB | App DB | Activo |
| `frozen` | App DB | Bloqueadas con `503` | Activo sólo para drenar |
| `payments` | Payments por Service Binding | Payments por Service Binding | Inerte |

Los archivos Wrangler avanzan juntos por estos únicos estados aceptados. Los
guards de ambos deploys rechazan cualquier combinación fuera de la tabla:

| Etapa | App mode | App sync | Payments bootstrap | Checksum runtime |
|---|---|---|---|---|
| `preprovision` | `legacy` | `false` | `true` | `pending` |
| `bootstrap` | `legacy` | `false` | `true` | `pending` |
| `frozen` | `frozen` | `false` | `true` | `pending` |
| `imported-bootstrap` | `frozen` | `false` | `true` | SHA-256 del artefacto |
| `target-active` | `frozen` | `false` | `false` | mismo SHA-256 |
| `syncing` | `frozen` | `true` | `false` | mismo SHA-256 |
| `cutover` | `payments` | `true` | `false` | mismo SHA-256 |

En `preprovision` el UUID de Payments todavía es el centinela; en `bootstrap`
ya es un UUID D1 real. No existe una etapa válida `legacy + bootstrap=false`,
porque permitiría dos dueños de escritura.

Las superficies congeladas por prefijo son `/links`, `/checkout`, `/v1` y
`/merchant`. `/pay` permanece en App porque también transporta operaciones
personales: en `frozen` se bloquean internamente sólo prepare/submit de links y
en `payments` ese subflujo reserva el attempt por RPC. `/crosschain` y su relayer
son personales y permanecen activos en los tres modos. Ocultar botones en
frontend no cuenta como freeze.

## Antes de abrir la ventana

> **Producción histórica del 25-08-2026:** su checksum sólo cubría IDs. No
> ejecutar un `UPDATE` para reemplazarlo. Seguir primero el
> [reemplazo semántico hacia una D1 nueva](./payments-semantic-recut.md); después
> este runbook vuelve a aplicar desde el estado `frozen`.

1. `pnpm verify:all`, `pnpm check:d1:restore` y
   `pnpm preflight:phase2:remote` deben terminar con evidencia entendida.
   `pnpm preflight:frontends:remote` inventaría, sin modificar, proyectos,
   aliases y nombres de variables Vercel.
2. Payments D1, Queue, DLQ, Durable Object, todas las migraciones descubiertas y
   secrets deben existir. `PAYMENTS_BOOTSTRAP_MODE=true` y
   `PAYMENT_LIVE_ENABLED=false` son obligatorios para el primer deploy.
3. El Worker remoto `gatopago-payments-api` debe existir en bootstrap antes de
   desplegar App con el Service Binding. Su `/health/live` responde, pero
   `/health` debe quedar degradado mientras bootstrap siga activo.
4. App debe tener aplicadas `0033` y `0034` antes de desplegar el código que las
   consume; `PAYMENTS_SYNC_ENABLED=false` mantiene el outbox sembrado inerte.
5. Guardar export cifrado de App DB y registrar las versiones actuales de ambos
   Workers. No borrar tablas ni versiones durante el soak.

## Cambio de modo

`PAYMENTS_CUTOVER_MODE` es una var no secreta en
`server/wrangler.jsonc`. Cambiarla exige revisión del diff y un deploy explícito:

```powershell
pnpm --filter server run deploy
```

No usar un valor distinto de `legacy`, `frozen` o `payments`. Un typo falla
cerrado como `frozen` y aparece como configuración inválida en health.

## Secuencia

### 1. Crear el target oscuro

- Aplicar todas las migraciones de `payments-worker/migrations/` sobre una D1
  Payments sin datos de negocio.
- Desplegar primero `gatopago-payments-api` con
  `PAYMENTS_BOOTSTRAP_MODE=true`. En este modo rechaza HTTP/RPC mutante, reintenta
  Queue y no ejecuta Cron.
- Comprobar `/health/live`: `bootstrapActive=true` y
  `bootstrapConfigValid=true`. Un `/health` `503/degraded` es correcto aquí.
- Confirmar por consulta read-only que `payment_migration_control` está pristine
  y todas las tablas de negocio están vacías.

### 2. Preparar App compatible en legacy

- Aplicar `0033` y `0034` a App.
- Mantener `PAYMENTS_CUTOVER_MODE=legacy` y `PAYMENTS_SYNC_ENABLED=false`.
- Desplegar App sólo ahora, cuando el target del Service Binding ya existe.
- Comprobar `/health/live`: `paymentsBoundaryVersion=1`,
  `paymentsCutoverMode=legacy` y `paymentsSyncEnabled=false`. El binding RPC ya
  está configurado, pero la versión efectiva permanece en 1 hasta que Payments
  sea el dueño; exigir 2 en legacy produciría un falso negativo.
- Crear y leer un intent de prueba en el flujo anterior.

### 3. Congelar

- Cambiar sólo `PAYMENTS_CUTOVER_MODE=frozen`, conservar
  `PAYMENTS_SYNC_ENABLED=false` y desplegar App.
- Verificar una escritura inocua/controlada: debe responder `503`,
  `SERVICE_UNAVAILABLE`, `payments_cutover_mode=frozen` y `Retry-After: 60`.
- Verificar un `GET` conocido: debe seguir leyendo App DB.
- Confirmar que Home, cuenta, login y operaciones no pertenecientes a pagos
  siguen disponibles.

### 4. Drenar

Los runners legacy siguen activos en `frozen` para terminar trabajo aceptado
antes del bloqueo. Consultar App D1 de forma read-only hasta obtener cero:

```sql
SELECT
  (SELECT COUNT(*) FROM payment_reconcile_requests
    WHERE status IN ('pending','processing','failed')) AS payment_reconcile_active,
  (SELECT COUNT(*) FROM webhook_deliveries
    WHERE status IN ('pending','processing')) AS webhook_delivery_active;
```

Las filas de `crosschain_operations` no forman parte de este cero: pertenecen a
App y el relayer continúa procesándolas durante y después del corte.
Tampoco bloquean el snapshot `balance_refresh_requests`, `account_operations`,
el indexador ni sus outboxes: son trabajo personal que permanece en App y puede
recrearse de forma autónoma. El preflight informa su salud por separado, pero
`app-drain` suma exclusivamente conciliaciones de pago y entregas webhook.

Revisar además backlog/DLQ de App Queue. Un estado `dead`, `needs_support` o
fallido no se ignora: se documenta y se resuelve o se aborta el corte.

Capturar un watermark después del drenaje:

```sql
SELECT
  (SELECT COUNT(*) FROM payment_intents) AS intents,
  (SELECT COUNT(*) FROM payment_links) AS links,
  (SELECT COUNT(*) FROM events) AS events,
  (SELECT COUNT(*) FROM webhook_deliveries) AS deliveries,
  (SELECT MAX(updated_at) FROM payment_intents) AS intent_watermark;
```

### 5. Copiar y validar

- Exportar App DB después del watermark.
- Ejecutar `split-payments-d1.mjs` y verificar manifest, checksum, FK,
  `quick_check` y que las operaciones CCTP personales sigan sólo en App. El
  manifest debe ser versión 4/checksum semántico v2; una evidencia histórica
  basada sólo en IDs no es promocionable.
- Importar el SQL data-only una sola vez en Payments DB ya migrada mientras el
  Worker continúa en bootstrap.
- Comparar IDs, conteos, checksum y watermark antes de desactivar bootstrap y
  habilitar las escrituras de Payments. Exportar además el target remoto y
  ejecutar `--verify-target-sql` contra el mismo manifest; IDs/conteos solos no
  prueban contenido.
- Copiar el checksum SHA-256 exacto del manifest a
  `PAYMENTS_DATA_CUTOVER_CHECKSUM`, mantener App en `frozen` y Payments en
  bootstrap, y desplegar Payments una vez. `/health` continúa degradado por
  bootstrap, pero `checks.dataCutover` debe ser `verified`.

### 6. Activar Payments todavía oscuro

- Sólo después de verificar el checksum, cambiar explícitamente
  `PAYMENTS_BOOTSTRAP_MODE=false` y desplegar Payments. El guard rechaza
  `pending`, un checksum malformado o una combinación que reabra App legacy.
- `/health` debe estar ready y `checks.dataCutover=verified`. HTTP/RPC mutante,
  Queue y Cron consultan el mismo control D1 y fallan cerrados si el registro se
  pierde o diverge del checksum configurado.
- `/health/ops` debe exponer y explicar `activeAttempts`, `pendingWebhooks`,
  `pendingOutbox`, `activeJobLeases`, reorgs y fee evidence.
- Probar directamente un checkout migrado y un intent `sk_test_` idempotente.
- No cambiar App a `payments` mientras este gate falle.

### 7. Habilitar y drenar sync con App congelada

- Mantener App en `frozen`, cambiar `PAYMENTS_SYNC_ENABLED=true` y desplegar.
- Drenar `payment_account_sync_outbox` y
  `payment_execution_sync_outbox`; los commands son versionados e idempotentes.
- Comprobar health de ambos Workers y que Payments no creó duplicados respecto
  del artefacto importado.
- No habilitar sync en `legacy`: esa combinación es inválida y health falla
  cerrado.

### 8. Cambiar el dueño

- Cambiar App a `PAYMENTS_CUTOVER_MODE=payments`, conservar
  `PAYMENTS_SYNC_ENABLED=true` y desplegar.
- `/health/live` debe mostrar `paymentsBoundaryVersion=2`.
- Repetir por App el mismo checkout y comprobar que coincide con Payments.
- Crear un intent test nuevo y verificar `payment.created`, outbox, Queue y
  webhook. Confirmar que App DB no recibió una nueva fila merchant.
- Sólo después actualizar URLs de frontend y ejecutar smokes autenticados.

Desde `syncing`, el preflight ya no exige que los conteos actuales de Payments
sean idénticos al snapshot: los cobros nuevos deben hacerlos crecer. Sí exige que
el checksum base permanezca fijado en config y control D1, además de
`quick_check`, foreign keys, health y smokes. Antes de esa etapa, los conteos del
import inicial todavía deben coincidir exactamente.

Los comandos `pnpm --filter payments-worker run deploy` y
`pnpm --filter server run deploy` ejecutan guards locales antes de Wrangler. El
segundo también rechaza el UUID centinela para impedir que App publique un
Service Binding hacia un target todavía inexistente.

## Abort y rollback

- Mientras Payments siga en bootstrap y antes de una escritura nueva allí,
  volver App a `legacy` con sync apagado es reversible porque App DB conserva el
  estado anterior.
- Si falla la importación, no reutilizar una D1 parcialmente poblada: conservar
  la evidencia, crear/restaurar un target limpio y repetir desde el artefacto
  verificado.
- Después de una escritura nueva en Payments: volver directamente a `legacy`
  causaría divergencia. Primero congelar, exportar la diferencia y decidir una
  reconciliación explícita hacia delante. Nunca fusionar dos D1 automáticamente.
- No borrar Payments DB, App tables, Queue, DLQ, backups ni versiones durante
  el soak.

## Cierre del soak

Cuando el periodo acordado no tenga divergencia, DLQ, reorgs abiertos ni
backlog inexplicado, se puede planificar una tarea separada para eliminar los
handlers y tablas legacy. Esa limpieza no forma parte del corte inicial.
