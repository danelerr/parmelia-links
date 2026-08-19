# RPC e indexación: operación y escala

## Decisión vigente

GatoPago necesita RPC para leer y escribir en Arbitrum, pero las vistas de la
aplicación no reconstruyen estado desde la cadena. Home, historial y dashboard
leen proyecciones D1. La cadena se procesa una vez mediante trabajos
compartidos, particionados e idempotentes.

```text
señal HTTP firmada ─┐
acción del dominio ─┼─> scheduler por partición ─> Queue ─> RPC canónico
barrido de seguridad ─┘                                │
                                                       v
                                      journal/checkpoint + proyecciones D1
```

Una señal de proveedor sólo dice “hay algo que verificar”. Nunca crea por sí
misma una transacción, saldo o asiento contable. El RPC y la evidencia de bloque
son la fuente canónica.

## Proveedores heterogéneos

`RPC_INDEXER_URLS` admite varios endpoints. Sus límites se describen, por
posición, en `RPC_PROVIDER_CAPABILITIES`; el código no reconoce planes por
hostname ni contiene reglas especiales para un proveedor.

Ejemplo:

```dotenv
RPC_INDEXER_URLS=https://managed.example/<SECRET>,https://public.example/rpc
RPC_PROVIDER_CAPABILITIES={"indexer":[{"id":"managed","priority":0,"maxConcurrency":4,"maxLogRange":10},{"id":"public","priority":1,"maxConcurrency":2,"maxLogRange":2000}]}
```

Para un span de 2.000 bloques se elige únicamente un endpoint que declare
capacidad suficiente. Para un span de 10 bloques se intenta por prioridad. Si
un endpoint falla de forma transitoria, se prueba otro elegible; si sólo queda
uno con rango menor, el scanner divide la ventana y continúa desde el mismo
checkpoint.

`RPC_INDEXER_MAX_BLOCK_RANGE` queda como compatibilidad cuando no existe el
documento de capacidades. No debe usarse para expresar dos planes distintos.

El rango es inclusivo:

```text
fromBlock=100, toBlock=109   -> 10 bloques
fromBlock=100, toBlock=2099  -> 2.000 bloques
```

Es una consulta `eth_getLogs`, no 2.000 requests ni 2.000 transacciones.

## Control de carga

Cada endpoint declara `maxConcurrency`. GatoPago aplica dos límites:

1. un semáforo local evita competencia innecesaria dentro de una instancia;
2. `RpcAdmissionController`, un Durable Object por endpoint y lane, impone el
   límite entre todas las instancias del Worker.

Los permisos son leases con vencimiento. Si un Worker muere, la capacidad se
recupera sola. Las lanes separan broadcast crítico, ingestión canónica,
reconciliación activa y backfill. Un `429` abre inmediatamente el circuit
breaker de ese endpoint; timeouts/fallos de red requieren fallos consecutivos.

Subir de plan no requiere modificar el indexador: se actualizan rango,
concurrencia y prioridad, se ejecuta la sonda y se despliega la configuración.

## Particiones y reposo

- El registro incremental asigna sólo wallets nuevas o modificadas a shards
  estables; ningún job carga la tabla completa de usuarios.
- Transferencias se separan por token, dirección (`from`/`to`) y shard.
- UserOperations y recovery tienen checkpoint por shard.
- Router tiene un stream global porque es un único contrato.
- Cada job tiene presupuesto de llamadas y bloques; si no alcanza el objetivo,
  publica una continuación sobre la misma partición.
- Una wallet nueva activa exclusivamente sus particiones.
- Con wallets activas, una única alarma `indexer_safety_sweep` compara
  periódicamente el head `safe` con los checkpoints y agenda sólo streams
  atrasados. `INDEXER_SAFETY_SWEEP_SECONDS` admite 60–86400 segundos y vale
  3600 por defecto.
- Con cero wallets activas la alarma se elimina: no hay mensajes Queue ni
  lecturas RPC de mantenimiento. Que no haya usuarios conectados no detiene la
  detección de depósitos de wallets ya registradas.

`INDEXER_WALLET_SHARD_SIZE` está acotado a 500. Cada webhook Address Activity
posee 200 shards, por lo que nunca supera 100.000 direcciones. Para más wallets
se añade otra entrada a `ALCHEMY_ADDRESS_WEBHOOKS_JSON`; el algoritmo no cambia.
La primera sincronización pagina como máximo cinco páginas remotas por job y
persiste el cursor en D1. Después compara asignaciones contra un espejo local
indexado y aplica como máximo 500 altas/bajas por PATCH; no vuelve a enumerar
las 100.000 direcciones en cada cambio.

## Webhooks y WebSocket

Address Activity y el Custom Webhook son aceleradores HTTP firmados. El primero
se convierte en señales exactas de token/dirección/shard y en una solicitud
deduplicada de balance para la wallet afectada. Esa lectura puntual cubre ETH
nativo, que no emite `Transfer`; la proyección ERC-20 continúa viniendo del
journal canónico. El segundo inspecciona topics conocidos y despierta sólo
router o los shards de recovery implicados; si el esquema del proveedor cambia,
usa un fallback conservador sin aceptar el payload como verdad financiera.

No se mantiene un WebSocket RPC saliente dentro del Worker:

- una conexión saliente no usa la hibernación de WebSockets servidor de Durable
  Objects y mantiene cómputo activo;
- `newHeads` sólo reemplazaría la señal de despertar: todavía habría que ejecutar
  `eth_getLogs` y reconciliar checkpoints;
- una suscripción amplia a `Transfer` ingiere tráfico ajeno a GatoPago, mientras
  que una suscripción por shard multiplica conexiones y filtros;
- deja de cumplirse el reposo real cuando no hay trabajo.

Si un proveedor futuro ofrece un stream que mejora costo o latencia, debe vivir
en un colector de larga duración apropiado para conexiones salientes y publicar
la misma señal particionada. Journal, checkpoints, Queue, RPC canónico, D1 y la
API no cambian.

## Sonda previa a promoción

La sonda no imprime URLs ni API keys y prueba cada endpoint con su propio
`maxLogRange` declarado:

```powershell
$env:CHAIN_KEY = "arbitrum-sepolia"
$env:RPC_INDEXER_URLS = "<ENDPOINT_1>,<ENDPOINT_2>"
$env:RPC_PROVIDER_CAPABILITIES = '{"indexer":[...]}'
pnpm check:rpc-indexer
```

No ejecutar una sonda de producción desde un shell que guarde secrets en
historial. Una URL con API key se carga con `wrangler secret put`; si apareció
en una captura, chat o log, se rota.

## Alchemy Address Activity

Credenciales distintas:

- URL/API key Node: dentro de los secrets `RPC_*_URLS`;
- signing key: valida `X-Alchemy-Signature`;
- Notify auth token: sincroniza el conjunto de wallets;
- `ALCHEMY_ADDRESS_WEBHOOKS_JSON`: IDs, network y signing keys de cada slot.

La recepción es:

1. body acotado por el Worker;
2. HMAC sobre los bytes exactos;
3. validación de webhook ID, red y schema;
4. dedupe de delivery;
5. normalización a particiones y bloque objetivo;
6. reconciliación de balances de las wallets registradas, no de contrapartes
   ajenas, una vez que el head canónico alcanza el bloque señalado;
7. lectura canónica por el pool RPC;
8. journal/proyección idempotente y avance del checkpoint.

## Despliegue

1. Rotar cualquier credencial expuesta.
2. Aplicar migraciones D1, incluida `0027_indexer_consistency.sql`.
3. Cargar URLs/capacidades y credenciales mediante secrets.
4. Ejecutar `pnpm check:rpc-indexer`.
5. Ejecutar `pnpm --filter server cf-typegen:check`, tests y dry-run de Wrangler.
6. Desplegar el Worker.
7. Consultar `/health` una vez: además de validar D1/bindings, arma el primer
   `indexer_safety_sweep` para wallets que ya existían antes del despliegue.
8. Habilitar webhooks sólo después de validar health y sincronización.
9. Probar depósito, duplicado de webhook y recuperación desde checkpoint.

## Observabilidad y respuesta

Logs esperados, sin URLs:

- `rpc_request_completed` / `rpc_request_failed`;
- `rpc_request_rejected_distributed_admission`;
- `rpc_request_rejected_circuit_open`;
- `indexer_run` y watchers por `partition`;
- `indexer_safety_sweep`;
- `chain_reorg_recovered` / `chain_reorg_replay_schedule_failed`;
- `alchemy_webhook_signal_processed`;
- `alchemy_webhook_addresses_synced`.

| Falla | Respuesta |
|---|---|
| endpoint gestionado cae | fallback elegible y circuit breaker |
| endpoint de rango amplio cae | scanner reduce el span hasta otro proveedor elegible |
| webhook cae | el barrido autónomo retoma sólo checkpoints atrasados |
| webhook se duplica | delivery ID y evento canónico deduplican |
| Queue reintenta | lease D1 e idempotencia hacen inerte la duplicación |
| Worker muere durante RPC | lease de admisión expira; checkpoint no confirmado no avanza |
| reorg | el epoch chain-wide invalida la rama, retrocede todos los streams y un outbox durable los reproduce |

Cambiar proveedor o plan es configuración. Cambiar de HTTP push a stream es
cambiar solamente el adaptador de señales. Cambiar de D1 a una persistencia
particionada, cuando las métricas lo exijan, conserva las identidades de
partición, el journal y la semántica de los jobs.
