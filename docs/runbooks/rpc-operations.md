# Runbook RPC e indexación

## Decisión operativa

Parmelia siempre necesita RPC para hablar con Arbitrum, pero ninguna vista de
Home consulta RPC. La cadena se lee en procesos compartidos y los usuarios leen
proyecciones D1.

```text
Alchemy Free ── lecturas puntuales / broadcast / webhook push
                         │
                         ▼
                    Worker + D1
                         ▲
                         │
RPC público Arbitrum ── journal, reconciliación y rangos eth_getLogs
```

No colocar Alchemy Free y el RPC público dentro de la misma lista del rol
`INDEXER`. Viem reintenta la misma petición contra el siguiente endpoint; no
reduce automáticamente un rango de 2.000 a 10 bloques.

## Qué significan 10 y 2.000

El rango es inclusivo:

```text
fromBlock=100, toBlock=109   → 10 bloques
fromBlock=100, toBlock=2099  → 2.000 bloques
```

No significa “leer 2.000 transacciones” ni “hacer 2.000 requests”. Es una sola
consulta `eth_getLogs` que pide los logs allowlisted dentro de esa ventana.
Parmelia usa un techo, no un tamaño rígido:

1. Intenta hasta `RPC_INDEXER_MAX_BLOCK_RANGE`.
2. Si el proveedor rechaza el volumen/rango, divide el span.
3. Si la respuesta es pequeña y estable, vuelve a crecer gradualmente.
4. Persiste eventos y el checkpoint antes de avanzar.
5. Si el job muere, retoma desde el último checkpoint guardado.

Configuración para Alchemy Free + Arbitrum Sepolia:

```dotenv
RPC_READ_URLS=https://arb-sepolia.g.alchemy.com/v2/<KEY_ROTADA>
RPC_WRITE_URLS=https://arb-sepolia.g.alchemy.com/v2/<KEY_ROTADA>
RPC_INDEXER_URLS=https://sepolia-rollup.arbitrum.io/rpc
RPC_ARCHIVE_URLS=https://sepolia-rollup.arbitrum.io/rpc
RPC_INDEXER_MIN_BLOCK_RANGE=10
RPC_INDEXER_MAX_BLOCK_RANGE=2000
```

Antes de promover un endpoint o cambiar el máximo, ejecutar una sonda real que
no imprime URLs ni API keys:

```powershell
$env:CHAIN_KEY = "arbitrum-sepolia"
$env:RPC_INDEXER_URLS = "https://sepolia-rollup.arbitrum.io/rpc"
$env:RPC_INDEXER_MAX_BLOCK_RANGE = "2000"
pnpm check:rpc-indexer
```

La sonda exige que **cada** endpoint configurado acepte el rango inclusivo
completo. Para probar Alchemy Free de forma aislada, usar máximo `10`; no
colocarlo junto al endpoint público en la misma lista.

Una URL con API key es secret. No se agrega a Git, `wrangler.jsonc`, logs,
capturas ni tickets.

## Alchemy Address Activity

Alchemy se usa como acelerador de eventos, no como garantía única:

1. Address Activity envía una entrega firmada a `/ingest/alchemy`.
2. El Worker verifica HMAC sobre el body exacto, `webhookId`, red y allowlist.
3. Un RPC `INDEXER` no-Alchemy verifica de forma independiente bloque y hash.
4. El evento entra al journal canónico y a sus proyecciones idempotentes.
5. El poller repara cualquier entrega perdida desde el checkpoint.

Credenciales diferentes:

- API key del Node RPC: vive dentro de `RPC_READ_URLS`/`RPC_WRITE_URLS`.
- Webhook signing key: valida `X-Alchemy-Signature`.
- Notify auth token: administra las direcciones del webhook con
  `X-Alchemy-Token`.

Nunca reutilizar conceptualmente una como si fuera otra.

## Promoción segura

1. Rotar primero cualquier API key expuesta.
2. Crear/configurar el webhook y obtener su signing key y Notify token.
3. Cargar secrets con `wrangler secret put`.
4. Aplicar todas las migraciones remotas antes del Worker compatible.
5. Desplegar canary/preview desde un artefacto CI aprobado.
6. Consultar `/health`; no debe exponer URLs ni keys.
7. Ejecutar un depósito pequeño y confirmar journal, ledger y Home.
8. Mantener `ALCHEMY_WEBHOOK_ENABLED=false` hasta verificar el endpoint y las
   direcciones sincronizadas.
9. Habilitarlo y comprobar doble entrega webhook + poller sin duplicados.

## Logs esperados

Buscar eventos estructurados, no strings con URLs:

- `rpc_request_completed`: `provider`, `role`, `lane`, `method`, `durationMs`.
- `rpc_request_failed`: error normalizado y rol, sin endpoint secreto.
- `indexer_run`: calls, retries, rango usado, logs y lag.
- `user_operation_watch_run`: UserOperations proyectadas y checkpoint.
- `alchemy_webhook_processed`: eventos normalizados.
- `rpc_request_rejected_circuit_open`: endpoint temporalmente enfriado.

`GET /health` añade un resumen sin PII de colas y checkpoints. Los warnings
`payment_reconcile_dead`, `user_event_outbox_dead`, `balance_refresh_failed`,
`canonical_stream_missing:*` y `canonical_stream_stale:*` requieren revisar el
job correspondiente; no se “resuelven” borrando filas sin reconstruir primero
la evidencia on-chain.

En Request Logs de Alchemy, la configuración correcta muestra lecturas
puntuales (`eth_call`, receipts, gas, broadcast) y no ventanas históricas del
indexador. Si aparece un `eth_getLogs`, su span nunca puede superar 10 mientras
Alchemy Free sea parte de ese rol.

Cloudflare no permite recuperar el valor de un secret ya cargado. Para saber qué
endpoint está activo sin revelarlo:

- `/health` expone sólo aliases (`alchemy`, `arbitrum-public-sepolia`, etc.).
- Los logs RPC incluyen alias y rol.
- `wrangler secret list` confirma nombres, no valores.
- Si se necesita conocer la URL exacta, se rota y vuelve a cargar desde el
  gestor de secretos; no se imprime el valor existente.

## Respuesta ante fallos

| Falla | Comportamiento |
|---|---|
| Alchemy read cae | Circuit breaker y fallback de lecturas puntuales si existe |
| RPC público indexer devuelve 429 | Se enfría el endpoint; el checkpoint no avanza y el cron repara |
| Webhook Alchemy cae | El poller recupera los bloques faltantes |
| Webhook duplica entrega | Delivery id + identidad canónica del log deduplican |
| Ambos roles críticos caen | `/health` degrada/falla cerrado; Home conserva último snapshot, nunca muestra cero inventado |
| Reorg | Se marca la rama no canónica, se revierten proyecciones y se reingiere |

## Señal para cambiar de plan/proveedor

Evaluar un endpoint dedicado de indexación/archive si se sostiene cualquiera de
estas condiciones:

- `429` > 1 %;
- lag del journal > 5 minutos;
- uso > 60 % de la cuota;
- backfill amenaza la lane de pagos;
- el endpoint público incumple el SLO o no ofrece soporte operativo.

La migración consiste en cambiar sólo `RPC_INDEXER_URLS`/`RPC_ARCHIVE_URLS` por
un proveedor cuyo plan documente el rango configurado. No se cambia Home ni la
semántica del journal.
