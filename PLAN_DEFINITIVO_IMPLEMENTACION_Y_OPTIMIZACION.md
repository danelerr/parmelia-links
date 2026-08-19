# Plan rector V3 de GatoPago

> Fecha de corte: 2026-07-26
>
> Estado: arquitectura promovida a Arbitrum Sepolia; Alchemy Notify permanece
> apagado hasta rotar la credencial expuesta y cargar sus secretos independientes
>
> Operación: despliegue manual; no depende de GitHub Actions

## 1. Decisión final

GatoPago usa una arquitectura dirigida por eventos, particionada y
provider-neutral:

```text
acción real / webhook firmado / fallback visible
                    │
                    v
       señal normalizada por partición
                    │
                    v
 Durable Object scheduler (job + shard)
                    │
                    v
          Queue at-least-once
                    │
                    v
 lector RPC canónico con presupuesto
                    │
                    v
 journal + checkpoint + proyecciones D1
                    │
                    v
       Home / historial / dashboard
```

Las siguientes invariantes no deben cambiar al sustituir proveedor, plan o
infraestructura:

1. La blockchain es la verdad final de fondos y ejecución.
2. Un webhook o stream sólo es una señal; nunca es verdad financiera.
3. El RPC vuelve a leer evidencia canónica antes de proyectar.
4. Cada stream tiene checkpoint por contrato o shard.
5. El cursor avanza únicamente después de persistir evidencia y proyección.
6. Queue es at-least-once; handlers, journal y proyecciones son idempotentes.
7. Home e historial leen D1 y no ejecutan RPC por usuario.
8. No existe polling global permanente.
9. Sin requests, estado pendiente ni eventos reales, no existe trabajo
   background.
10. Rango, prioridad y concurrencia son capacidades de configuración, no reglas
    codificadas para un free tier.

## 2. Qué se implementó

### 2.1 Ejecución bajo demanda

- Se eliminó el Cron Trigger y el handler `scheduled()`.
- `EventJobScheduler` usa un Durable Object distinto por
  `chain + job + partition`.
- Wakeups equivalentes de una misma partición se compactan.
- Shards independientes no comparten un singleton.
- La alarma desaparece cuando el objeto queda sin trabajo.
- Queue transporta un job por invocation y conserva retry/DLQ.
- Cada job usa lease D1 y programa continuación sólo si hay backlog o un bloque
  objetivo pendiente.

Consecuencia: cero usuarios no produce trabajo periódico. Una transacción,
outbox, retry o webhook sí puede producir trabajo aunque nadie tenga la app
abierta, porque existe estado real que conciliar.

### 2.2 Registro incremental y sharding

- La migración `0026_indexer_work_partitions.sql` añade un outbox transaccional
  de wallets nuevas/modificadas.
- El registro procesa únicamente esas filas; no carga todos los usuarios.
- Las wallets se asignan de forma estable a streams independientes:
  transferencias, UserOperations y recovery.
- Transferencias se particionan por token, dirección (`from`/`to`) y shard.
- UserOperations y recovery mantienen cursor por shard.
- PaymentRouter mantiene un stream global porque es un único contrato.
- Cada job tiene presupuesto configurable de llamadas y bloques; el resto se
  convierte en una continuación de la misma partición.

El límite lógico ya no es “16 filtros para todos los usuarios”. Aumentar usuarios
crea más shards y Queue puede procesarlos en paralelo dentro de los presupuestos
del proveedor y de la base.

### 2.3 Señales de proveedor

- Address Activity verifica HMAC, webhook ID, red, schema y delivery ID.
- El payload se reduce a `token + direction + wallet + targetBlock`.
- Se despiertan sólo las particiones afectadas.
- Toda actividad de una wallet registrada solicita además un balance Multicall
  deduplicado al bloque canónico indicado; así ETH nativo no depende de logs.
- El webhook no escribe ledger, journal ni balances directamente.
- Custom Webhook reconoce topics de `InvoicePaid` y `RecoveryProposed`.
- Router y recovery se despiertan por separado; recovery se dirige a los shards
  de las wallets encontradas.
- Un schema desconocido usa fallback conservador y queda visible en logs.

Para escalar Address Activity:

- `INDEXER_WALLET_SHARD_SIZE` está acotado a 500.
- Un webhook administra 200 shards: máximo 100.000 direcciones.
- `ALCHEMY_ADDRESS_WEBHOOKS_JSON` permite varios slots.
- Agregar un slot no cambia el algoritmo ni la API.
- El bootstrap remoto persiste cursor y avanza cinco páginas por job; en régimen
  normal un espejo D1 produce diffs indexados de hasta 500 altas/bajas. El costo
  de agregar una wallet no crece con el total ya suscrito.

### 2.4 Pool RPC sin dependencia de plan

`RPC_PROVIDER_CAPABILITIES` describe por posición:

```json
{
  "indexer": [
    {
      "id": "managed",
      "priority": 0,
      "maxConcurrency": 4,
      "maxLogRange": 10
    },
    {
      "id": "public",
      "priority": 1,
      "maxConcurrency": 2,
      "maxLogRange": 2000
    }
  ]
}
```

El pool:

- elige únicamente endpoints capaces de servir el span;
- respeta prioridad;
- hace failover sólo entre endpoints elegibles;
- reduce el rango adaptativamente si sólo queda capacidad menor;
- nunca detecta el plan por hostname;
- conserva `RPC_INDEXER_MAX_BLOCK_RANGE` sólo como compatibilidad.

El mismo diseño admite RPC público, Alchemy, Infura, QuickNode, dRPC, un nodo
propio o una combinación. Subir de plan modifica capacidades, no código.

### 2.5 Control distribuido de RPC

Cada transporte tiene:

- semáforo local;
- `RpcAdmissionController` global por endpoint/lane;
- leases con expiración para recuperarse de Workers terminados;
- circuit breaker persistente;
- enfriamiento inmediato ante `429`;
- lanes separadas para broadcast, ingestión, reconciliación y backfill;
- logs por alias/método, sin URL ni API key.

Esto evita que el autoscaling de Workers multiplique accidentalmente la
concurrencia contra el mismo endpoint. Al ampliar cuota se cambia
`maxConcurrency`.

### 2.6 Una sola ruta canónica

La duplicación anterior —webhook proyectando por un lado y poller por otro— fue
eliminada:

```text
push, fallback o acción -> señal -> lector RPC -> journal -> proyectores
```

Todas las fuentes comparten la misma idempotencia, evidencia, política de reorg
y checkpoint.

## 3. Decisión sobre WebSocket

No se implementa un WebSocket RPC saliente dentro del Worker.

Razones:

1. Los WebSockets salientes no usan la hibernación de conexiones servidor de
   Durable Objects; mantienen el proceso activo y generan costo en reposo.
2. `newHeads` sólo reemplaza el wakeup. GatoPago todavía necesita
   `eth_getLogs`, evidencia de bloque, checkpoint y reparación de huecos.
3. Suscribirse a todos los `Transfer` de un token procesa tráfico ajeno.
4. Suscribirse por shard multiplica sockets y filtros al crecer.
5. Un socket puede perder mensajes; por tanto no sustituye reconciliación.
6. Mantener un adaptador sin usar contradice el objetivo de cero código muerto.

WebSocket se incorpora sólo si una medición demuestra que el push HTTP no
cumple el SLO. En ese caso vive en un colector apropiado para conexiones
salientes de larga duración y emite la misma señal particionada. No cambia
journal, Queue, indexador, D1 ni endpoints de producto.

Trigger mínimo para ese colector:

- p95 de detección incumple el SLO durante una ventana sostenida;
- webhooks no ofrecen filtros/cobertura requeridos;
- el proveedor documenta replay/resume o se conserva backfill RPC;
- el costo total es menor que HTTP push + reconciliación;
- existe operación de reconnect, lag, alertas y despliegue propio.

## 4. Comportamiento por escala

### Reposo

- 0 alarmas sin jobs.
- 0 mensajes Queue sin jobs.
- 0 RPC de mantenimiento.
- D1 sólo recibe health/requests externos.

### Usuarios concurrentes en Home

- Las respuestas leen snapshots D1.
- ETag puede devolver `304`.
- Una snapshot faltante crea una fila deduplicada.
- Mil Homes no crean mil lecturas RPC.

### Crecimiento de wallets

- Registro incremental O(wallets cambiadas), no O(total de usuarios).
- Más wallets crean más shards.
- Más shards se procesan con Queue dentro de `max_concurrency`.
- Aumentar `max_concurrency` requiere primero ampliar RPC/D1 y observar p95.

### Crecimiento de proveedor

- Más rango reduce número de requests por backfill.
- Más concurrencia aumenta partitions simultáneas.
- Otro endpoint añade capacidad/failover por configuración.
- Otro webhook añade 100.000 direcciones por slot.

### Más allá de una D1

D1 sigue siendo hoy la principal frontera física. No se añade multi-D1,
Postgres/Kafka o Kubernetes sin tráfico que lo justifique. Las identidades
`chain + stream + shard`, el journal y los checkpoints ya forman la frontera de
particionado que permite migrar sin cambiar semántica.

Introducir partición física cuando se sostenga alguna condición:

- p95 de escrituras/queries incumple SLO después de índices y batching;
- límites documentados de una D1 quedan por encima de 60–70 %;
- una partición caliente bloquea shards independientes;
- restore/replay excede el RTO acordado;
- el costo de operación de la alternativa es aceptado.

La primera división será por `chain + shard`, no por usuario arbitrario.

## 5. Qué depende de recursos y qué no

| Elemento | Plan gratuito | Plan mayor | ¿cambia arquitectura? |
|---|---|---|---|
| rango `eth_getLogs` | valor bajo por endpoint | valor mayor | No |
| concurrencia RPC | presupuesto bajo | ampliar capacidad | No |
| Queue operations | puede agotar cuota diaria | ampliar plan | No |
| Queue concurrency | conservadora | aumentar gradualmente | No |
| Address Activity | uno o pocos slots | varios slots/provider | No |
| D1 | volumen inicial | réplicas o partición física | Sólo almacenamiento, no semántica |
| WebSocket | no necesario | opcional por SLO | Sólo adaptador de señales |
| nodo propio | no | opcional por TCO/SLO | No |

La arquitectura no elimina límites comerciales: los convierte en knobs
explícitos y observables.

## 6. Límites conocidos

1. Una sola D1 es una frontera de throughput y recuperación.
2. Queue cobra/limita operaciones; un evento real puede producir varias
   particiones.
3. El RPC público no ofrece SLO contractual.
4. El relayer propio conserva riesgo de throughput por nonce; bundler compatible
   con EntryPoint v0.9 es la salida prevista.
5. ETH nativo externo no produce `Transfer`; requiere traces o estrategia
   separada si el producto promete ese historial.
6. El Custom Webhook y Address Activity siguen siendo servicios externos; el
   checkpoint RPC es la reparación.
7. Aumentar límites sin pruebas puede trasladar el cuello a D1 o al proveedor.

Ninguno justifica un componente ocioso hoy. Todos tienen frontera y trigger.

## 7. Configuración de promoción

Antes de desplegar:

1. Rotar cualquier key expuesta en capturas, chats o terminal.
2. Cargar `RPC_*_URLS` como secrets.
3. Cargar `RPC_PROVIDER_CAPABILITIES` con una entrada por URL/rol configurado.
4. Ejecutar `pnpm check:rpc-indexer`.
5. Aplicar `0026_indexer_work_partitions.sql` a D1 remota.
6. Ejecutar `pnpm --filter server cf-typegen:check`.
7. Ejecutar tests, typecheck y dry-run de Wrangler.
8. Desplegar; Wrangler registra `RpcAdmissionController` mediante la migración
   Durable Object `v2_rpc_admission`.
9. Verificar `/health`, logs y checkpoints.
10. Habilitar Alchemy después de sincronizar direcciones y hacer smoke test.

El despliegue es manual. No se agregan workflows de GitHub.

Promoción del 2026-07-26:

- migración D1 `0026_indexer_work_partitions.sql` aplicada;
- Worker `f7dcd25a-6720-4063-9711-7d1fd186a1cd` desplegado;
- `/health` respondió `200 / ok`;
- Cron Trigger eliminado;
- sólo `parmelia-scheduled-jobs` conserva productor y consumidor;
- `parmelia-balance-refresh` y su DLQ fueron eliminadas después de comprobar
  que las seis solicitudes históricas estaban `completed`;
- el registro inicial de seis wallets quedó durable y se drenará cuando se
  restablezca la cuota diaria de Queue;
- `ALCHEMY_WEBHOOK_ENABLED` y `ALCHEMY_CUSTOM_WEBHOOK_ENABLED` siguen en
  `false`; no se promocionó una API key publicada en chat.

## 8. Gates de aceptación

### Código local

- TypeScript del Worker y runtime sin errores.
- Tests unitarios y workerd verdes.
- Config/typegen sincronizados.
- Wrangler dry-run verde.
- Script RPC prueba cada endpoint a su propio máximo.
- Ninguna URL/API key aparece en logs.

### Testnet

- nueva wallet crea asignaciones sin escanear todos los usuarios;
- webhook duplicado produce un solo efecto;
- provider grande caído reduce rango y usa otro endpoint;
- `429` abre circuit breaker;
- dos instancias no exceden admisión global;
- muerte antes de checkpoint repite sin duplicar;
- reorg revierte y reproduce;
- Queue vacía permanece vacía en reposo;
- 1.000 Homes mantienen cero RPC en request path.

### Producción

- contratos Arbitrum One desplegados y auditados;
- cuotas/SLO del proveedor documentados;
- D1/Queue/RPC con al menos 2× de headroom inicial;
- alertas de lag, 429, circuit open, DLQ, drift y D1;
- backup/restore y rollback ensayados;
- keys por rol y guardian con custodia adecuada;
- rollout gradual con kill switches.

## 9. Observabilidad necesaria

Métricas mínimas:

- jobs creados, compactados, continuados y fallidos por partición;
- Queue backlog, operaciones, retries y DLQ;
- llamadas RPC por proveedor/lane/método;
- rango solicitado/servido y reducción adaptativa;
- rechazos de admisión y circuit breaker;
- lag por checkpoint;
- eventos journal/proyección y dedupe;
- drift de balance;
- D1 rows read/write, p95 y errores;
- costo por evento, operación y Home.

Alertas:

- lag canónico > SLO;
- todos los endpoints críticos abiertos;
- `429` sostenido;
- DLQ > 0;
- registry outbox atascado;
- subscription sync fallida;
- reorg fuera de ventana;
- D1 no disponible;
- signer nonce bloqueado.

## 10. Backlog condicionado

No son tareas pendientes automáticas:

| Capacidad | Trigger |
|---|---|
| colector WebSocket | push incumple SLO y TCO/replay están demostrados |
| proveedor archive dedicado | backfill compite con pagos o falta retención |
| más webhooks Address Activity | siguiente slot de shards existe |
| mayor Queue concurrency | RPC/D1 tienen headroom medido |
| D1 read replicas/Sessions | tráfico multi-región y latencia lo justifican |
| múltiples D1/Postgres | límites físicos o RTO medidos |
| ingestor separado | blast radius, CPU o cadence exigen aislamiento |
| bundler | proveedor demuestra EntryPoint v0.9 y supera canary |
| nodo propio | TCO/SLO/independencia superan servicio gestionado |
| traces | soporte de ETH nativo externo es requisito de producto |

## 11. Definition of Done

Una mejora de arquitectura sólo se considera terminada cuando tiene:

1. invariante y ownership claros;
2. configuración validada;
3. idempotencia y retry;
4. presupuesto de recursos;
5. tests de éxito y falla;
6. observabilidad sin secrets;
7. runbook;
8. migración compatible;
9. rollback/replay;
10. evidencia en el entorno promovido.

“Compila” no significa “está operando”. “Puede escalar” significa que la
frontera, el knob y el trigger están definidos y probados; no que se hayan
comprado recursos o desplegado componentes ociosos.

## 12. Referencias

- [Arquitectura](ARCHITECTURE.md)
- [Deploy manual](DEPLOY.md)
- [Runbook RPC/indexación](docs/runbooks/rpc-operations.md)
- [Runbook capacidad Home](docs/runbooks/home-capacity.md)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
