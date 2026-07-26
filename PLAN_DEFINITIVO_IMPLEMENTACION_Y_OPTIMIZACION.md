# Plan rector V2 de implementación y optimización de Parmelia

> Versión: 2.0  
> Fecha de corte: 2026-07-25  
> Estado: plan rector de ejecución  
> Alcance: cliente, dashboard, Worker, D1, indexadores, RPC, relayers, contratos,
> seguridad, observabilidad, CI/CD, testnet y salida controlada a Arbitrum One.

## 1. Propósito y precedencia

Este documento consolida la arquitectura y los pendientes vigentes de
`ARCHITECTURE.md`, `DEPLOY.md`, `MEJORAS_PENDIENTES.md`,
`CODEX_PLAN_DE_IMPLEMENTACION_Y_MEJORAS.md`,
`CODEX_REAUDITORIA_2026-07-13.md`, `CLAUDE_REVIEW_FABLE.md`,
`EVALUACION_TECNICA.md`, `CROSSCHAIN_DESIGN.md`, `DEFI_DESIGN.md` y
`contracts/AUDIT.md`.

Para trabajo futuro, este archivo define el orden, los criterios de aceptación y
los gates de promoción. Los documentos anteriores conservan valor como evidencia
histórica y diseño de detalle, pero no deben usarse aisladamente para decidir si
una tarea está terminada.

Las etiquetas de estado usadas aquí son:

- **Verificado:** existe evidencia local reproducible.
- **Implementado, no promovido:** el código está integrado, pero falta desplegar,
  configurar o probar contra el entorno real.
- **Operativo externo:** depende de consolas, proveedores, firmas o auditoría.
- **Planificado:** aún requiere cambios de código o infraestructura.
- **Opcional:** solo se activa al cumplirse un trigger de negocio o métrica.

### 1.1 Qué cambia en la versión 2

La versión 1 resolvía el problema inmediato de polling con snapshots, Queue y
Multicall. Esa solución sigue siendo una primera etapa válida, pero no es el
techo arquitectónico. Esta versión añade:

- Ingestión única por cadena y journal canónico de eventos.
- Proyecciones event-driven para ledger, balances, pagos y alertas.
- Reconciliación RPC híbrida según la semántica de cada activo.
- Snapshots y cursores vinculados a número **y hash** de bloque.
- Detección, rollback y replay ante reorganizaciones.
- Control plane RPC con prioridades, presupuestos y aislamiento de backfills.
- `GET /home` agregado, caché local versionada e invalidación push.
- Consistencia secuencial con D1 Sessions al habilitar read replicas.
- Escalones explícitos para 1.000, 10.000, 100.000 y más usuarios.
- Triggers medibles para introducir Durable Objects, Workflows, particionado o
  infraestructura de indexación propia.

El criterio no es desplegar la mayor cantidad posible de componentes. Es hacer
que el costo marginal de una vista de Home tienda a cero sin sacrificar
consistencia, auditabilidad ni capacidad de recuperación.

## 2. Resultado final buscado

Parmelia debe operar como una aplicación financiera no custodial en la que:

1. La blockchain sea la fuente final de verdad sobre fondos y ejecución.
2. Cada red se ingiera una vez y sus eventos se reutilicen para todas las vistas,
   usuarios y efectos derivados.
3. El journal canónico sea la evidencia durable de lo observado on-chain y D1
   contenga read models reproducibles para Home, historial, estados y dashboard.
4. Ninguna vista de uso frecuente genere polling RPC por usuario.
5. La carga blockchain se aproxime a:

   ```text
   actividad on-chain + reconciliación + backfill controlado
   ```

   y nunca a:

   ```text
   usuarios conectados × frecuencia de polling × activos
   ```

6. Toda operación de dinero exista de forma durable antes o inmediatamente
   después del broadcast y se concilie de forma idempotente.
7. Ningún receipt de bundle se interprete como éxito sin validar el
   `UserOperationEvent` correspondiente.
8. Indexadores, proyectores y consumidores puedan reintentar sin duplicar
   contabilidad, notificaciones ni webhooks.
9. Cada dato financiero indique el bloque canónico y nivel de consistencia que lo
   respalda.
10. Toda proyección se pueda reconstruir o revertir desde eventos y checkpoints.
11. Mainnet falle cerrado ante contratos, claves, orígenes, RPC o configuración
   incompletos.
12. El throughput no dependa del nonce de una sola EOA.
13. Cada release provenga de un artefacto CI verificable y tenga rollback
    probado.
14. Seguridad, rendimiento, costo y experiencia se midan con SLOs, no por
    percepción.

## 3. Línea base verificada

### 3.1 Evidencia reproducida el 2026-07-24

`pnpm verify` pasó localmente con:

- ESLint sin warnings en cliente, dashboard y servidor.
- Logs del servidor estructurados.
- OpenAPI válido.
- Tipos de Wrangler sincronizados.
- TypeScript del servidor y runtime Worker sin errores.
- 129 pruebas unitarias de servidor.
- 10 pruebas en runtime real de Workers.
- Build de cliente y dashboard correcto.
- Budget de bundles correcto.

Baseline de bundles gzip:

| Superficie | Chunks JS | Total gzip |
|---|---:|---:|
| Cliente | 52 | 337.501 bytes |
| Dashboard | 17 | 184.766 bytes |

Los límites actuales del gate son demasiado holgados: 600 KiB para cliente,
500 KiB para dashboard y 220 KiB por archivo. Deben estrecharse después de medir
la navegación real.

### 3.2 Capacidades ya implementadas

- React/Vite con rutas lazy, PWA, i18n, passkeys y FCM.
- Hono sobre Cloudflare Workers.
- D1 con ledger unificado, cursores, outbox, claims, leases y estados durables.
- Pagos ERC-4337 asíncronos con `202`, polling y reconciliación.
- Validación de `UserOperationEvent(success)` antes de contabilizar.
- Operaciones de cuenta firmadas y persistidas antes del broadcast.
- Indexador de depósitos ERC-20 externos.
- Watchers de `InvoicePaid` y `RecoveryProposed`.
- CCTP v2, swaps y ahorro Aave.
- Failover RPC mediante URLs separadas por coma.
- CI, análisis estático, pruebas de contratos, artefacto Worker verificable,
  backup D1, readiness y rollback.
- Guards fail-closed para mainnet y contratos sin desplegar.

### 3.3 Trabajo implementado pero aún no demostrado en entorno promovido

- Ejecutar el workflow `deploy-worker.yml` con environment y branch protection
  configurados.
- Promover cliente y dashboard.
- Confirmar migraciones remotas, readiness y smoke tests autenticados.
- Fondear gas del relayer en las redes destino requeridas.
- Revocar/rotar en GCP la service account Firebase retirada localmente.
- Confirmar account linking por mismo correo en Firebase.
- QA manual con lector de pantalla y dispositivos reales.

### 3.4 Bloqueos comprobables para mainnet

- Los contratos de `arbitrum-one` continúan con `TODO_DEPLOY`.
- No existe auditoría independiente final ni bug bounty.
- El guardian sigue dependiendo de una función operativa centralizada; para
  valor real debe migrar a multisig/MPC/HSM y separación efectiva de roles.
- No hay evidencia de rotación ensayada de todas las claves ni de kill switches
  operativos con alertas.
- Falta conocer y documentar proveedor, cuota y SLO del RPC de producción.
- El relayer propio continúa limitado por una EOA/nonce.

### 3.5 Cuello de botella nuevo y prioritario: Home/RPC

El cliente consulta `/user/balance` cada 10 segundos. En Arbitrum Sepolia esa
respuesta ejecuta aproximadamente:

1. `eth_getBalance` para ETH.
2. `balanceOf` para USDC.
3. `balanceOf` para aUSDC.

Home también consulta `/account/passkey` al montar, provocando seis lecturas de
contrato adicionales.

Con 1.000 usuarios simultáneos, el estado estable puede aproximarse a 300
llamadas RPC por segundo y el arranque puede añadir unas 6.000 lecturas de
seguridad. No existe aún:

- Snapshot durable de balances.
- Queue para refrescos.
- Multicall habilitado en el `PublicClient`.
- Batch de múltiples wallets.
- Dedupe global entre navegadores.
- Journal canónico con `block_hash` y checkpoints.
- Proyección incremental de balances desde eventos.
- Reconciliación por estrategia de activo.
- Rollback/replay probado ante reorg.
- Scheduler RPC consciente de prioridad y compute units.
- Endpoint BFF agregado para Home y caché local durable por usuario.

Este frente pasa a ser **P0 de escalabilidad**, aunque testnet funcional no esté
roto.

La métrica “requests RPC” por sí sola es insuficiente. Multicall puede reducir
round trips HTTP sin reducir en la misma proporción las sublecturas o compute
units facturadas por el proveedor. La optimización se considerará demostrada
solo midiendo ambos.

## 4. Invariantes no negociables

### 4.1 Dinero y contabilidad

- Una operación no entra al ledger hasta demostrar éxito on-chain.
- El ledger se escribe antes que notificaciones, webhooks y efectos secundarios.
- Payer y recipient se escriben en un único batch cuando corresponda.
- Toda escritura repetible tiene clave de idempotencia estable.
- Los importes ejecutados se obtienen de logs/deltas; una estimación debe quedar
  marcada explícitamente como `estimated`.
- No se borra estado terminal hasta vencer la ventana de soporte y consulta.
- Cada operación conserva `chainId`, hash, bloque, token, importe raw, decimales
  y fuente de medición suficientes para auditoría.
- Ninguna fila derivada de cadena se considera canónica sin `block_number` y
  `block_hash`.
- Toda corrección de una proyección conserva motivo, valor anterior, valor nuevo
  y evidencia de reconciliación.

### 4.2 Seguridad

- Cero claves privadas en Git, artefactos, logs, URLs o respuestas.
- Claves diferentes para relayer, faucet, paymaster, payment router y recovery.
- Mainnet no permite fallback entre roles.
- Contratos críticos pertenecen a multisig; cambios sensibles tienen timelock o
  procedimiento de doble aprobación.
- Turnstile, CORS, rate limits, límites financieros y contratos desplegados
  fallan cerrado.
- Ningún error RPC crudo llega al cliente.

### 4.3 Operación

- D1 es durable; memoria global o Cache API nunca son fuente financiera.
- No se guarda estado mutable de request, usuario, circuit breaker o cursor en
  variables globales del Worker.
- Jobs asíncronos son at-least-once e idempotentes.
- El cursor avanza solo después de persistir todos los efectos necesarios.
- Un evento se journaliza antes de proyectarse; una proyección nunca adelanta su
  watermark por encima del último evento durable.
- Toda cola tiene DLQ, métricas de edad y procedimiento de replay.
- Cron es una red de reparación, no el único mecanismo de baja latencia cuando
  exista un stream operativo.
- Toda migración usa estrategia expand/contract, backup y restore drill.
- Todo release tiene artefacto, commit, migraciones, readiness y rollback.

### 4.4 Producto

- La UI distingue dato confirmado, pendiente, estimado, viejo y no disponible.
- No se promete historial completo de ETH nativo mientras no exista indexación
  de traces.
- Los estados de pago sobreviven refresh, cierre del navegador y retry.
- La caché local está versionada por `uid + chainId`, contiene solo el mínimo
  necesario, se limpia al cerrar sesión y nunca almacena tokens de sesión.
- La UI muestra el último dato verificado durante una caída y no presenta
  indisponibilidad RPC como saldo cero.
- Accesibilidad WCAG 2.2 AA forma parte del gate, no de una revisión posterior.

### 4.5 Eficiencia y complejidad

- Una lectura de Home no llama a la blockchain directa ni indirectamente en el
  camino crítico.
- Un mismo evento on-chain se obtiene una vez por cadena y se distribuye a todos
  sus consumidores.
- Las llamadas críticas de pago no compiten en la misma cola o presupuesto con
  balances, indexación histórica o backfills.
- El batching se ajusta por calldata, latencia, error rate y compute units; no por
  un número fijo asumido.
- Quorum y hedged requests se reservan para decisiones críticas. Duplicar cada
  lectura eleva costo y puede empeorar una congestión.
- Durable Objects, Workflows, nuevas bases o nodos propios se añaden únicamente
  al activarse un trigger medido y con plan de salida.

## 5. SLOs y presupuestos objetivo

Estos objetivos deben medirse primero en testnet y luego convertirse en alertas:

| Área | SLO / presupuesto |
|---|---|
| Disponibilidad API autenticada | ≥ 99,9% mensual, excluyendo mantenimiento anunciado |
| `GET /home` con read model caliente | p95 ≤ 200 ms y p99 ≤ 500 ms |
| `GET /user/balance` con snapshot caliente | p95 ≤ 200 ms |
| `GET /user/transactions` | p95 ≤ 200 ms para primera página |
| Error 5xx Worker | < 0,5% en ventanas de 15 min |
| RPC `429` | 0 sostenidos; alerta ante cualquier ráfaga >1% |
| RPC atribuible a vistas de Home | 0 después del bootstrap; también 0 con 1.000 pestañas activas |
| Snapshot de balance activo | p95 de antigüedad ≤ 60 s para activos que requieren reconciliación |
| Proyección por evento soportado | visible p95 ≤ 15 s desde detección del evento |
| Lag del journal canónico | p95 ≤ 30 s con stream; cron de reparación ≤ 2 min |
| Balance tras operación Parmelia confirmada | visible ≤ 10 s después de confirmación |
| Indexer externo | lag ≤ 2 ticks normales; alerta > 5 min o > 10.000 bloques |
| Queue de balances | edad p95 ≤ 30 s; DLQ = 0 |
| Drift de proyección exacta | 0; cualquier diferencia abre incidente y reparación auditada |
| Recuperación de reorg soportado | RTO ≤ 5 min, 0 ledger/push duplicado |
| Read-your-writes D1 | 100% en flujos mutables mediante sesión/bookmark o lectura primaria |
| Pago aceptado | respuesta `202` p95 ≤ 2 s, excluyendo interacción passkey |
| Pago varado | 0 filas `submitted` por encima del TTL operativo sin alerta |
| Ledger | 0 duplicados y 0 pares internos parcialmente escritos |
| Webhooks | ≥ 99,9% entregados dentro del periodo de reintentos |
| Core Web Vitals | LCP p75 ≤ 2,5 s; INP p75 ≤ 200 ms; CLS p75 ≤ 0,1 |
| Bundle cliente | mantener total gzip ≤ 360 KiB inicialmente |
| Bundle dashboard | mantener total gzip ≤ 200 KiB inicialmente |
| Chunk individual inicial | ≤ 90 KiB gzip, con excepciones justificadas |
| Seguridad de dependencias | 0 critical/high sin waiver firmado y fecha de expiración |
| Contratos críticos | branch coverage ≥ 80% y fork tests verdes |
| RPO D1 | ≤ 24 h inicial; reducir según volumen/TVL |
| RTO Worker | ≤ 30 min con rollback ensayado |

Los números deben revisarse después de 30 días de tráfico real. Un SLO no se
relaja para esconder una regresión; se ajusta con evidencia de negocio y costo.

Los SLO de proyección miden desde que el proveedor entrega el bloque o evento,
no desde su timestamp nominal. Se deben reportar por separado latencia de red,
proveedor, journal, proyector y entrega al cliente.

## 6. Arquitectura objetivo

```text
                                      BLOCKCHAIN
                                          │
                  ┌───────────────────────┼────────────────────────┐
                  │                       │                        │
             head/log stream       receipts críticos       reconcile/backfill
                  │                       │                        │
                  └───────────────────────┼────────────────────────┘
                                          ▼
                              RPC control plane por chain
                         prioridades · cuotas · health · failover
                                          │
                                          ▼
                              Ingestor único e idempotente
                                          │
                         ┌────────────────┴────────────────┐
                         ▼                                 ▼
                chain_blocks/checkpoints          chain_events journal
               número + hash + parent hash         evento crudo canónico
                         │                                 │
                         └────────────────┬────────────────┘
                                          ▼
                                      Proyectores
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
             ledger/operaciones    balance projections    outbox/alertas
                    │                     │                     │
                    └─────────────────────┼─────────────────────┘
                                          ▼
                             D1 primary + read replicas
                                          │
                                          ▼
                          BFF autenticado `GET /home`
                              ETag · session bookmark
                                          │
                                          ▼
                        SWR + IndexedDB versionado por usuario
                                          ▲
                                          │ invalidación, no datos financieros
                                  FCM / WebSocket opcional

Acciones firmadas:

Cliente ─► API ─► operación durable D1 ─► bundler/relayer ─► blockchain
                   │                                             │
                   └──────── estado pendiente          mismo ingestor/journal
```

Principios centrales:

1. **Las vistas leen read models; nunca RPC.**
2. **La cadena se ingiere una vez; los eventos se proyectan muchas veces.**
3. **Queue y cron transportan o reparan trabajo; no son fuente de verdad.**
4. **El mismo journal cierra tanto operaciones iniciadas por Parmelia como
   actividad externa.**
5. **RPC sigue siendo obligatorio para conectarse a la cadena, pero queda fuera
   del costo marginal de abrir Home.**

### 6.1 Autoridad de cada capa

| Capa | Autoridad | Puede reconstruirse |
|---|---|---|
| Blockchain canónica | Ejecución y fondos finales | No aplica |
| `chain_blocks` + `chain_events` | Lo observado y aceptado como canónico | Sí, reingiriendo |
| Ledger | Contabilidad y semántica Parmelia | Sí, proyectando journal + operaciones |
| Balance projection/snapshot | Lectura rápida de activos | Sí |
| D1 read replica | Copia de lectura con consistencia de sesión | Sí |
| SWR/IndexedDB | Experiencia inmediata y offline | Sí; nunca autoridad |

Una corrección manual nunca muta silenciosamente el journal. Crea un evento de
reparación auditado o reconstruye la proyección desde un checkpoint conocido.

### 6.2 Modelo de consistencia por bloque

Todo dato derivado de blockchain lleva:

- `chain_id`.
- `block_number`.
- `block_hash`.
- `observed_at`.
- `consistency_level`: `optimistic`, `safe` o `finalized`.
- `projection_version`.

Reglas:

- Un batch Multicall se ejecuta con un `blockNumber` explícito y después se
  valida que el hash siga siendo canónico.
- Una respuesta con varios activos incluye el bloque individual de cada activo y
  `consistentThroughBlock`, igual al menor watermark seguro del conjunto.
- La UI no llama “actual” a una mezcla de bloques sin exponer ese watermark.
- Datos `optimistic` mejoran latencia, pero no autorizan settlement ni decisiones
  irreversibles.
- Ledger y webhooks financieros esperan el nivel de confirmación definido por
  cadena y riesgo.

### 6.3 Estrategia híbrida por activo

No existe un único algoritmo correcto para todos los balances:

| Activo | Estrategia primaria | Reconciliación |
|---|---|---|
| USDC soportado | Deltas de eventos `Transfer` canónicos | Muestreo + barrido periódico |
| aUSDC/Aave | Balance escalado por usuario + índice normalizado global de la reserva | `balanceOf` por lote y ante cambio de versión |
| ETH nativo | Operaciones conocidas + stream de transacciones/traces si está contratado | `eth_getBalance` fijado por bloque |
| Token desconocido | `rpc_only` hasta implementar proyector validado | Obligatoria |

Para aUSDC se debe validar la versión exacta del contrato desplegado. Cuando
exponga la semántica esperada, Parmelia guarda el balance escalado y consulta el
índice normalizado una vez por reserva/cadena/bloque, en vez de ejecutar
`balanceOf` por cada usuario para mostrar el interés acumulado. La aritmética,
redondeo y resultados se contrastan contra `balanceOf` antes de promoverse.

Cada activo tiene configuración versionada:

```text
asset_id
projection_strategy = event_exact | protocol_derived | events_plus_rpc | rpc_only
finality_policy
reconcile_interval
max_staleness
contract_version
```

Cambiar la estrategia requiere ADR, dual-run y comparación de drift.

### 6.4 Camino de lectura de Home

1. El cliente muestra inmediatamente el último snapshot permitido de IndexedDB.
2. SWR deduplica una única solicitud autenticada a `GET /home`.
3. El Worker lee perfil, balance view, actividad y alertas desde D1 sin RPC.
4. Lecturas independientes se inician en paralelo o se agrupan con `D1.batch`;
   no se crean waterfalls.
5. `ETag`/`If-None-Match` evita transferir un payload sin cambios.
6. La respuesta actualiza SWR e IndexedDB de forma atómica por versión.
7. Confirmaciones, eventos externos, focus y reconnect invalidan la key.
8. Si push no está disponible, un safety refresh con jitter ocurre solo cuando
   la vista está visible, online y excede `maxStaleness`; consulta D1, no RPC.

No se realiza polling fijo normal. La caché local:

- Usa esquema y key versionados.
- Se particiona por `uid + chainId`.
- Guarda únicamente datos de presentación y su evidencia de bloque.
- No guarda bearer tokens, firmas, secretos ni respuestas completas innecesarias.
- Se limpia en logout, cambio de cuenta y cambio incompatible de esquema.

### 6.5 Camino de escritura

1. Autenticar, autorizar e idempotently persistir la intención.
2. Simular y enviar por la lane RPC/bundler crítica.
3. Guardar `userOpHash`/`txHash` y responder `202`.
4. El watcher acelera la búsqueda del receipt, pero el ingestor lo confirma en el
   journal común.
5. El proyector actualiza operación, ledger y balances en un batch durable.
6. Outbox, webhook y push nacen después del commit financiero.
7. El cliente invalida `home` y recibe la nueva `stateVersion`.

No existe un segundo settlement especial para “eventos del indexer”: todo termina
en las mismas funciones idempotentes.

### 6.6 RPC control plane

Cada llamada declara:

```text
chainId · lane · method · deadline · retryBudget · consistency · costEstimate
```

Lanes mínimas:

| Prioridad | Lane | Ejemplos |
|---:|---|---|
| P0 | `critical-write` | simulación, broadcast, receipt de pago |
| P1 | `canonical-ingest` | head, hash, logs nuevos |
| P2 | `active-reconcile` | balance tras operación, seguridad |
| P3 | `maintenance` | muestreo, reparación |
| P4 | `backfill` | historia y traces |

El control plane implementa:

- Endpoints separados para lectura, escritura y archive/backfill.
- Concurrencia y token bucket por proveedor/lane.
- Deadlines, timeout, backoff exponencial con jitter y retry budget.
- Circuit breaker con estado durable o coordinado; nunca estado mutable global
  del Worker.
- Health score y failover por método/cadena.
- Batch adaptativo por bytes, subcalls, latencia, error rate y compute units.
- Quorum de proveedores solo para head/hash/finality o decisiones de alto valor.
- Admission control: un backfill se pausa antes de afectar pagos.
- Modo degradado: servir último dato verificado y bloquear escrituras inseguras.

Si se separa como Worker propio, la API lo llama mediante Service Binding, no por
HTTP público. La coordinación estricta de cuotas puede usar Durable Objects
particionados por `chainId + provider + lane`; jamás un singleton global.

### 6.7 D1 primary, replicas y sesiones

D1 sigue siendo apropiado mientras cumpla las métricas. Al habilitar global read
replication:

- Lecturas normales de Home usan `withSession("first-unconstrained")`.
- Después de una mutación, el flujo usa el bookmark previo o
  `withSession("first-primary")`.
- El Worker devuelve el bookmark opaco al cliente y acepta el último bookmark
  válido en la siguiente lectura para garantizar consistencia secuencial.
- Se observan `served_by_region` y `served_by_primary`.
- El bookmark no reemplaza autenticación, autorización ni `stateVersion`.

No se activa replicación sin pruebas multi-región y un test explícito de
read-your-writes.

### 6.8 Entrega de cambios al cliente

Orden de preferencia:

1. Mutación local seguida de invalidación SWR.
2. FCM ya disponible, con payload de invalidación y versión; nunca saldo/PII.
3. Focus/reconnect.
4. Safety refresh adaptativo con jitter.
5. WebSocket hibernable con Durable Objects si el SLO de latencia lo exige.

WebSocket es opcional. Solo se activa si FCM y revalidación por eventos no
alcanzan el SLO medido. Los objetos se particionan por usuario/tenant/bucket, las
conexiones restauran metadata mínima tras hibernación y el socket nunca se vuelve
fuente financiera.

### 6.9 Escalones de capacidad

Los escalones se activan por métrica, no por calendario:

| Escala | Arquitectura mínima | Trigger para siguiente escalón |
|---|---|---|
| Hasta 1.000 concurrentes | Snapshot D1, `GET /home`, Queue, Multicall, invalidación FCM, cron de reparación | RPC/CU, lag o p95 fuera de SLO en load test |
| 1.000–10.000 | Journal canónico, proyectores híbridos, RPC lanes, ingestor de baja latencia, D1 Sessions/replicas | Consumer >70% presupuesto, lag >30 s o contención D1 |
| 10.000–100.000 | Ingestor/RPC service separado, Queues por chain/lane, push particionado, backfill aislado, proyecciones versionadas | Límites/costo sostenidos o hot partitions |
| Más de 100.000 o multi-chain alto | Partición por chain/account bucket, bases/read models separados, stream/indexador administrado o nodo dedicado según TCO | Decisión ADR con benchmark y costo operativo |

Ningún escalón obliga Kubernetes, Kafka o nodo propio. Se incorporan solo si la
alternativa administrada no cumple costo, control, retención o latencia.

### 6.10 Modelo cuantitativo de carga

Modelo actual aproximado:

```text
RPC/s = usuarios_en_Home / intervalo_polling × lecturas_por_balance
      = 1.000 / 10 × 3
      = 300 RPC/s
```

Modelo V2:

```text
RPC/CU = ingestión_de_bloques_y_eventos
       + receipts_de_operaciones
       + reconciliaciones_por_política
       + backfill_limitado
```

Consecuencias:

- Cero usuarios: ingestor y reparación mínima continúan; Home no genera carga.
- 1.000 usuarios abriendo a la vez: hay un spike de Worker/D1 controlable y
  cacheable, pero **cero RPC atribuible a esas vistas**.
- 100.000 usuarios mirando sin actividad on-chain: aumenta el read path, no la
  lectura blockchain.
- 10.000 transferencias reales: aumenta ingestión/proyección aunque nadie tenga
  Home abierto, que es la relación correcta.

Los capacity tests deben comprobar esta independencia con dos ejes separados:
sesiones concurrentes y eventos on-chain por segundo.

## 7. Fases de ejecución obligatorias

Las fases son secuenciales por dependencia, pero los workstreams internos pueden
ejecutarse en paralelo cuando no comparten esquema o contratos.

## Fase 0 — Verdad operacional y promoción de la base actual

Objetivo: obtener un baseline desplegado, observable y recuperable antes de
introducir nueva infraestructura.

### OP-01 — Ordenar y promover el estado actual

Acciones:

- Separar el worktree actual en commits revisables sin descartar cambios del
  usuario.
- Confirmar que `main` representa exactamente el artefacto que se desea promover.
- Configurar branch protection: CI requerido, aprobación y prohibición de push
  directo.
- Configurar environments `worker-testnet` y futuro `worker-production`.
- Ejecutar `deploy-worker.yml` contra el mismo SHA aprobado.
- Promover cliente y dashboard desde el mismo release manifest.

Aceptación:

- GitHub muestra checks obligatorios verdes.
- El Worker desplegado reporta readiness sin issues.
- El artefacto desplegado prueba el SHA esperado.
- Cliente, dashboard, Worker y esquema D1 aparecen en un release manifest único.
- Rollback automático queda ensayado y documentado.

### OP-02 — Cerrar operaciones externas pendientes

Acciones:

- Revocar/rotar en GCP la service account retirada del workspace.
- Confirmar account linking de Firebase por mismo email.
- Validar Turnstile y reglas de zona en el dominio real.
- Fondear con mínimos controlados todas las EOAs/relayers requeridas.
- Registrar proveedor, hostname sanitizado, plan, cuota y soporte del RPC.
- Configurar al menos un RPC dedicado y un respaldo independiente.

Aceptación:

- Evidencia de revocación y rotación con fecha/owner.
- Login Google y magic link convergen en la misma cuenta cuando corresponde.
- Test de caída del RPC primario usa el respaldo sin falso éxito.
- Alertas de balance bajo funcionan para relayer, faucet y paymaster.

### OP-03 — Smoke tests funcionales en testnet

Ejecutar y conservar evidencia de:

- Onboarding y creación de smart account.
- Faucet.
- Pago interno.
- Link de pago externo.
- Swap.
- Depósito y retiro de ahorro.
- CCTP inbound y outbound.
- Recovery: propose, cancel y execute.
- Webhook firmado, retry y replay.
- Push en dispositivo real.

Gate: ninguna fase de mainnet comienza si un movimiento de dinero carece de smoke
test exitoso sobre el artefacto promovido.

## Fase 1 — Rediseño definitivo de balances y tráfico RPC

Objetivo: que abrir o mantener Home no genere ninguna llamada RPC atribuible al
usuario, y que la carga de cadena dependa de actividad real y reconciliación.

Orden interno obligatorio:

1. Medir y cortar polling.
2. Crear BFF, caché y snapshots por bloque.
3. Introducir journal/proyecciones en dual-run.
4. Activar reconciliación, push y control plane.
5. Demostrar 1k, 10k y 100k mediante pruebas antes de activar cada escalón.

### BAL-01 — Instrumentar antes de cambiar

Agregar métricas estructuradas:

- Método lógico: balance, receipt, logs, block, simulation, contract read.
- Endpoint identificado por alias, nunca URL o API key.
- Latencia, status, timeout, retry, failover y `429`.
- Ruta solicitante y job de origen.
- Cantidad de calls agrupadas por Multicall.
- Número de subcalls, bytes de calldata/respuesta y compute units si el proveedor
  los expone.
- Lane, deadline, retry budget y motivo de cada retry.
- Head observado, watermark del journal y watermark de cada proyector.
- Snapshot hit/miss/stale y edad.

Aceptación:

- Dashboard de RPC requests/s, subcalls/s, CU, p50/p95/p99, error rate y uso por
  endpoint/lane.
- Alertas de `429`, timeout y failover continuo.
- Costo atribuible a `home_view`, evento, reconciliación y backfill identificable.
- Logs no exponen secretos.

### RPC-01 — Control plane mínimo antes de añadir carga

Crear una única abstracción de acceso RPC para todos los jobs y rutas. Ningún
feature nuevo instancia un `PublicClient` aislado sin registrarlo allí.

Debe incluir:

- Aliases de providers, nunca URLs en logs.
- Lanes `critical-write`, `canonical-ingest`, `active-reconcile`,
  `maintenance` y `backfill`.
- Timeout, retry budget y backoff con jitter por método.
- Concurrencia máxima por provider/lane.
- Circuit breaker durable o coordinado.
- Separación read/write/archive cuando el proveedor lo permita.
- Failover con health score, sin retry infinito.
- Quorum selectivo para hash/finality de alto riesgo.
- Admission control que pause backfills antes de degradar pagos.

Aceptación:

- Una caída del endpoint de backfill no afecta receipts ni broadcast.
- Un `429` reduce concurrencia y no produce retry storm.
- Ambos endpoints críticos caídos activan modo degradado y fail-closed para
  escrituras que no puedan verificarse.
- Ningún estado de usuario/provider vive mutable en scope global del Worker.

### BAL-02 — Cortar el polling agresivo

Cliente:

- Eliminar `refreshInterval: 10000` de balances.
- Revalidar en mount, focus, reconnect y eventos de negocio.
- Eliminar polling fijo de historial y balances.
- Añadir safety refresh con jitter únicamente si la vista está visible, online,
  el canal push no está operativo y el dato excede `maxStaleness`.
- El safety refresh consulta el read model D1; nunca dispara RPC síncrono.
- Quitar `/account/passkey` de Home. Usar estado D1 o cargarlo solo en Seguridad.
- Persistir el último modelo mínimo en IndexedDB con schema versionado por
  `uid + chainId`; limpiar en logout/cambio de cuenta.
- Compartir una key SWR canónica para dedupe entre componentes.

Aceptación:

- Una pestaña inactiva genera cero consultas periódicas.
- Cien componentes o mounts concurrentes comparten una sola solicitud lógica.
- Un pago confirmado invalida balance e historial inmediatamente.
- Home conserva último dato y muestra su antigüedad si refrescar falla.
- Ningún token, firma, header de autorización o perfil completo se guarda en
  IndexedDB/localStorage.
- Tests de SWR verifican mount/focus/reconnect/mutation.

### HOME-01 — Crear el BFF agregado de Home

Agregar `GET /home` autenticado y versionado. Debe devolver en una sola respuesta:

- Identidad mínima de presentación.
- Cuenta y red seleccionada.
- Balance view con evidencia por bloque.
- Estado de seguridad ya proyectado.
- Primera página de actividad.
- Operaciones pendientes y alertas accionables.
- `stateVersion`, `ETag`, `observedAt` y `consistentThroughBlock`.

Implementación:

- Iniciar en paralelo lecturas independientes; usar `D1.batch` donde reduzca
  round trips y mantenga semántica.
- Soportar `If-None-Match` y respuesta `304`.
- Generar ETag después de autenticar y scopearlo a `uid + stateVersion`; nunca
  compartir la respuesta en CDN/cache pública (`Cache-Control` privado).
- Mantener endpoints existentes durante migración y comparar respuestas.
- No esconder errores parciales: cada sección incluye estado
  `fresh | stale | unavailable`.
- Limitar payload; detalles históricos siguen paginados.

Aceptación:

- Cero RPC en el handler, incluyendo misses.
- Una navegación fría ejecuta una única solicitud de datos de Home.
- p95/p99 cumplen el SLO con 1k sesiones.
- Un fallo de actividad no convierte el balance válido en error global.
- Reutilizar un ETag de otro usuario no filtra existencia, versión ni datos.
- OpenAPI, contract tests y compatibilidad de rollout quedan cubiertos.

### BAL-03 — Habilitar Multicall

Servidor:

- Activar `batch.multicall` en los `PublicClient` compatibles.
- Usar Multicall explícito para USDC, aUSDC, tokens adicionales y estado de
  seguridad.
- Obtener primero un bloque objetivo y fijar todas las sublecturas de ese batch al
  mismo `blockNumber`.
- Resolver y persistir el `blockHash`; descartar/reintentar el resultado si deja
  de pertenecer a la cadena canónica antes del commit.
- Incluir ETH mediante una llamada compatible a Multicall3 o, si se mantiene
  `eth_getBalance`, documentar que el balance completo consume como máximo dos
  requests.
- Ajustar `batchSize` dinámicamente por bytes, subcalls, latencia, CU y límite de
  ambos proveedores.
- No agrupar escrituras ni simulaciones de semántica diferente.

Aceptación:

- Las seis lecturas de passkey se resuelven en una sola llamada agrupada.
- Un balance individual usa una o máximo dos llamadas RPC.
- Todos los activos de una reconciliación declaran el mismo bloque/hash.
- Resultados parciales/reverts se manejan sin convertir valores desconocidos en
  cero.
- Tests cubren provider sin Multicall, calldata límite, bloque reorged, resultado
  parcial y fallback.
- Métricas separan request HTTP, subcalls y CU; no se declara ahorro basándose
  únicamente en requests.

### BAL-04 — Crear snapshots durables

Nueva migración expand-only, sugerida como `0012_balance_snapshots.sql`:

```sql
CREATE TABLE balance_snapshots (
  uid                  TEXT NOT NULL,
  account_address      TEXT NOT NULL,
  chain_id             INTEGER NOT NULL,
  asset                TEXT NOT NULL,
  balance_raw          TEXT NOT NULL,
  decimals             INTEGER NOT NULL,
  block_number         INTEGER NOT NULL,
  block_hash           TEXT NOT NULL,
  consistency_level    TEXT NOT NULL,
  projection_strategy  TEXT NOT NULL,
  projection_version   INTEGER NOT NULL,
  observed_at          TEXT NOT NULL,
  reconciled_at        TEXT,
  source               TEXT NOT NULL,
  PRIMARY KEY (chain_id, account_address, asset),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_balance_snapshots_age
  ON balance_snapshots(chain_id, observed_at);

CREATE INDEX idx_balance_snapshots_uid
  ON balance_snapshots(uid, chain_id);
```

Agregar una tabla o claim equivalente para deduplicar refreshes por
`account_address + chain_id`, y una tabla versionada de políticas de activo.

Reglas:

- Guardar raw integer y decimales, no solo string de UI.
- Normalizar la address para identidad sin perder la forma de presentación.
- Upsert idempotente solo si el bloque nuevo es posterior o si coincide en número
  **y hash**.
- Un bloque con el mismo número y distinto hash dispara flujo de reorg; nunca
  sobreescribe silenciosamente.
- Conservar `observed_at`, `reconciled_at`, bloque/hash, estrategia, versión y
  fuente.
- Calcular `consistentThroughBlock` como el menor watermark seguro del conjunto.
- D1 es read model; no sustituye la verdad on-chain.

Aceptación:

- Migración probada sobre copia con rollback/restore.
- Upserts fuera de orden no retroceden el snapshot.
- Conflicto de hash se detecta y crea métrica/alerta.
- Usuario eliminado limpia snapshots por FK.
- Tests de concurrencia y reintento.
- Un cambio de algoritmo incrementa `projection_version` y permite dual-read.

### CHAIN-01 — Crear la base mínima del journal canónico

Antes de activar una proyección de balance, introducir de forma expand-only:

- `chain_blocks`: cadena, número, hash, parent hash, nivel de consistencia y
  estado canónico.
- `chain_events`: identidad universal, posición, address, tópicos/payload
  normalizado, bloque/hash y estado canónico.
- `projection_watermarks`: proyector, versión, bloque/hash aplicado y checkpoint.
- `balance_projection_deltas`: evento, cuenta, activo y delta reversible cuando
  la estrategia lo permita.

La definición detallada y el sharding se completan en Fase 3, pero este mínimo es
dependencia de cualquier balance event-driven.

Aceptación:

- Insertar el mismo log dos veces produce un solo evento.
- Journalizar y avanzar checkpoint ocurre en una frontera durable definida.
- El proyector puede morir entre evento y snapshot y reanudar sin duplicar delta.
- Existe prueba de reconstrucción de una cuenta desde checkpoint + eventos.

### BAL-05 — Servir stale-while-revalidate desde D1

La sección de balances de `GET /home` y el endpoint de compatibilidad
`GET /user/balance` deben:

1. Autenticar.
2. Leer snapshots.
3. Responder inmediatamente si existen.
4. Marcar cada activo `fresh`, `stale`, `estimated` o `unavailable`.
5. Encolar refresh si faltan o están viejos.
6. No esperar RPC en el camino caliente.
7. Entregar bloque, hash abreviado/oculto de UI, nivel de consistencia, estrategia
   y `stateVersion`.

Contrato sugerido:

```json
{
  "tokens": { "ETH": "0.04", "USDC": "125.50" },
  "savings": "20.00",
  "status": "fresh",
  "observedAt": "2026-07-25T12:30:00.000Z",
  "blockNumber": "123456789",
  "blockHash": "0x…",
  "consistencyLevel": "safe",
  "consistentThroughBlock": "123456789",
  "stateVersion": "bal_01J…",
  "refreshing": false
}
```

Ni siquiera el primer acceso sin snapshot usa RPC síncrono en Home. Debe devolver
`unavailable + refreshing`, encolar un bootstrap con dedupe y publicar la nueva
versión al terminar. Durante la migración puede existir un feature flag de
fallback síncrono sólo en testnet; producción lo mantiene apagado.

Para que ese estado sea excepcional:

- Crear/precalentar el snapshot al terminar onboarding o account provisioning.
- Ejecutar backfill de snapshots antes de activar el endpoint para usuarios
  existentes.
- Reparar faltantes en background antes del rollout, no durante un spike de Home.

### BAL-06 — Queue y consumidor batch

Agregar:

- Producer binding `BALANCE_REFRESH_QUEUE`.
- Consumer con batch inicial de 25, ajustable hasta 100.
- DLQ.
- `max_batch_timeout` corto para usuarios activos.
- Límite explícito de concurrencia acorde a la cuota RPC.
- Handler tipado y `wrangler types` en CI.
- Mensajes con schema version, idempotency key, motivo, prioridad y
  `notBeforeBlock` opcional.
- Payloads plain/serializables; importes y bloques grandes viajan como strings.
  Nunca enviar `Request`, `Response`, `Error` o instancias de clases.

El consumidor:

1. Deduplica wallets.
2. Agrupa por `chainId`.
3. Descarta trabajo ya satisfecho por un snapshot/proyección más nuevo.
4. Obtiene un bloque objetivo canónico.
5. Divide por límite de calldata/CU.
6. Ejecuta Multicall fijado a ese bloque.
7. Escribe snapshots y watermark en batch D1.
8. Hace ack individual; sólo reintenta los mensajes fallidos.
9. Envía fallas agotadas a DLQ con causa normalizada.

Queues entrega al menos una vez: toda escritura debe ser idempotente.
`max_batch_size` y `max_batch_timeout` se validan contra el schema actual de
Wrangler y límites vigentes antes de desplegar; no se asume que sean constantes.

Fallback: si Queue no está disponible durante la primera promoción, usar
`balance_refresh_requests` drenado por cron. Este fallback no reemplaza el
objetivo de Queue; evita bloquear la migración.

### BAL-07 — Invalidación por eventos

Invalidar/proyectar wallets afectadas cuando:

- `settlePayment()` confirma payer/recipient.
- Se confirma faucet.
- Termina swap o Earn.
- Se detecta depósito externo.
- CCTP completa mint/burn.
- Se cambia signer/guardian/recovery.

La invalidación ocurre después de la escritura financiera durable. La outbox es
durable; Queue transporta el trabajo y `ctx.waitUntil()` sólo puede acelerar una
promesa controlada, nunca sustituir la outbox. Debe:

- Crear una outbox row idempotente con `uid`, dominio afectado y `stateVersion`.
- Actualizar primero el read model y luego emitir FCM.
- Enviar sólo invalidación/versión; nunca saldo, PII o evidencia sensible.
- Hacer que foreground y service worker muten la misma key SWR.
- Deduplicar eventos repetidos y colapsar versiones obsoletas.

Si push falla, focus/reconnect y safety refresh reparan. WebSocket hibernable se
evalúa únicamente si la latencia medida no cumple el SLO.

### BAL-08 — Proyección híbrida por activo

Implementar en dual-run, sin sustituir snapshots RPC hasta demostrar equivalencia.

**USDC**

- Ingerir `Transfer` entrante y saliente del contrato allowlisted.
- Aplicar deltas raw incluyendo mint/burn y self-transfer.
- Rechazar eventos de otra address aunque compartan firma.
- Persistir delta reversible ligado a la identidad del log.

**aUSDC**

- Verificar ABI, proxy/implementation y versión exacta de Aave desplegada.
- Si la semántica coincide, mantener balance escalado por cuenta desde los
  eventos Aave suficientes; si el evento no permite exactitud, consultar
  `scaledBalanceOf` sólo para las cuentas afectadas.
- Leer el índice normalizado una vez por reserva/cadena/bloque y derivar el
  balance mostrado con aritmética y redondeo idénticos al contrato.
- Ante upgrade, evento desconocido o divergencia, cambiar a
  `events_plus_rpc`/`rpc_only` y alertar.

**ETH**

- Proyectar operaciones originadas por Parmelia que tengan receipt y costo de gas
  verificables.
- Si se contrata stream de traces, incorporar transferencias internas con
  identidad/dedupe propia.
- Sin traces, mantener `rpc_only` para exactitud y no prometer historial completo.

Aceptación:

- Dual-run por al menos el volumen/ventana acordado con drift cero para USDC.
- aUSDC derivado coincide con `balanceOf` dentro de la regla exacta de redondeo
  documentada; cualquier diferencia desactiva la promoción.
- Un evento repetido, fuera de orden o reorged no altera dos veces el balance.
- La política de cada activo puede degradarse sin desplegar cliente nuevo.

### BAL-09 — Reconciliador y detector de drift

RPC deja de ser el refresco primario y se convierte en auditor.

Prioridad de reconciliación:

1. Operación Parmelia recién confirmada.
2. Evento que el proyector no comprende.
3. Cuenta activa con activo `rpc_only` y snapshot vencido.
4. Muestreo continuo de proyecciones exactas.
5. Barrido completo de baja prioridad.

Reglas:

- Agrupar por cadena/activo y fijar todas las lecturas a un bloque/hash.
- No refrescar indiscriminadamente todas las wallets cada minuto.
- Comparar valor proyectado, valor on-chain y watermark.
- Drift esperado por estrategia tiene tolerancia explícita; dinero raw exacto no
  usa tolerancias visuales.
- Corregir mediante evento auditado o replay, nunca con overwrite silencioso.
- Escalar frecuencia según actividad, valor y error histórico; añadir jitter.

Aceptación:

- Métricas `reconcile_checked`, `drift_raw`, `correction_reason` y costo/CU.
- Un mismatch USDC exacto abre incidente y congela esa versión de proyector.
- Barrido puede pausarse sin afectar pagos/ingestión.
- Se puede reconstruir una cuenta y obtener el mismo resultado reconciliado.

### D1-01 — Read replicas y consistencia de sesión

No habilitar por moda. Activar global read replication al medir usuarios
multi-región o presión de lectura que la justifique.

Implementación:

- `withSession("first-unconstrained")` para Home sin mutación previa.
- Bookmark anterior o `withSession("first-primary")` para read-your-writes.
- Propagar bookmark opaco en header dedicado y conservar `stateVersion` como
  semántica de aplicación.
- Instrumentar `served_by_region` y `served_by_primary`.
- Mantener escrituras y decisiones críticas con consistencia explícita.

Aceptación:

- Suite multi-región demuestra lectura secuencial después de pago/configuración.
- Cliente sin bookmark sigue funcionando.
- Bookmark inválido no rompe auth ni permite acceder a otro usuario.
- Rollback documentado para desactivar replicas sin perder datos.

### SCALE-01 — Load, capacity y chaos tests

Crear escenarios reproducibles de 1.000, 10.000 y 100.000 sesiones virtuales,
separando vistas de Home de actividad on-chain:

- Ramp-up gradual y spike simultáneo.
- Home abierto 15 minutos.
- Storm de focus/reconnect y expiración de ETag.
- Pago de una fracción de usuarios.
- Depósitos externos y eventos por bloque.
- RPC primario con `429`, timeout y caída.
- Redelivery de Queue.
- Reorg a distintas profundidades dentro de la ventana soportada.
- Backfill activo mientras ocurren pagos.
- Read replica atrasada y bookmark previo.

Gate:

- p95 de balance ≤ 200 ms con snapshot caliente.
- Cero RPC atribuible a abrir o mantener Home, también después de cache miss.
- Requests/CU RPC crecen con eventos y reconciliaciones, no con sesiones.
- Dedupe, ETag y caché evitan requests redundantes medibles.
- Cero `429` sostenidos.
- Snapshot p95 ≤ 60 s.
- Cero datos cruzados entre usuarios.
- Cero pérdida/duplicación tras reorg, retry o muerte entre journal y proyección.
- Cada escalón cumple presupuesto de Worker CPU, D1 rows, Queue, RPC CU y costo.
- No se promueve el escalón siguiente sin informe reproducible y capacidad
  mínima 2× sobre el pico esperado.

## Fase 2 — Throughput de pagos y eliminación del nonce único

### PAY-01 — Abstracción de envío ERC-4337

Crear interfaz interna:

```ts
interface UserOperationTransport {
  estimate(...): Promise<...>;
  send(...): Promise<{ userOpHash: Hex }>;
  receipt(...): Promise<... | null>;
}
```

Implementaciones:

- `SelfHandleOpsTransport` para testnet/emergencia controlada.
- `BundlerTransport` para producción.

No duplicar settlement: ambos caminos terminan en el mismo reconciliador y
`settlePayment()`.

### PAY-02 — Seleccionar bundler con prueba, no marketing

Evaluar al menos dos proveedores por:

- EntryPoint v0.9.
- Paymaster externo propio.
- Arbitrum One/Sepolia.
- `eth_estimateUserOperationGas`.
- Cuota, rate limits, SLA y soporte.
- Latencia regional.
- Idempotencia y consulta de receipts.
- Exportación de métricas.
- Failover y política ante provider divergence.

Gate: prueba de carga y fallo controlado antes de elegir. La decisión queda en un
ADR con costo y exit strategy.

### PAY-03 — Integrar bundler detrás de feature flag

- `RELAYER_MODE=self|bundler`.
- Rollout testnet 10% → 50% → 100%.
- Comparar estimación, costo, latencia y failure codes.
- Mantener el paymaster y validaciones actuales.
- Eliminar `preVerificationGas` fijo cuando el bundler lo estime.
- Normalizar errores del bundler a `ERR.*`.

Aceptación:

- 100 submits concurrentes sin colisión de nonce.
- Reintento del cliente no duplica UserOperation.
- Cambio de bundler no cambia ledger ni API pública.
- Falla del bundler produce `pending` recuperable o error estable, nunca falso
  éxito.

### PAY-04 — Acelerar reconciliación

- Queue de operaciones emitida tras broadcast.
- Consumer consulta receipt/evento con backoff.
- Cron permanece como red de reparación.
- D1 sigue siendo la máquina de estados.
- Aplicar el mismo patrón a account operations cuando la evidencia muestre
  latencia relevante.

## Fase 3 — Escalar indexador, ledger y consultas

Objetivo: observar cada bloque/evento relevante una vez por cadena, conservar
evidencia canónica y alimentar todos los read models con proyectores
reproducibles.

### IDX-01 — Sharding de wallets

El filtro `to: walletAddresses` no debe crecer sin límite.

- Definir tamaño de shard configurable y probado con el RPC, inicialmente
  200–500 wallets.
- Usar shards versionados y cursores independientes o procesar todos los shards
  de una ventana antes de avanzar el cursor global.
- Nunca cambiar la asignación de shards sin backfill/dual-read controlado.
- Registrar calls, logs, duración y lag por shard.

Aceptación:

- 10.000 wallets simuladas sin exceder tamaño de request.
- Falla de un shard no pierde eventos ni bloquea permanentemente a los demás.
- Re-scan no duplica ledger/push.

### IDX-02 — Dedupe universal de eventos

Crear `chain_events` con identidad y evidencia suficiente:

```text
chain_id
tx_hash
log_index
event_kind
block_number
block_hash
transaction_index
contract_address
topic0
payload_raw/normalizado
canonical
observed_at
```

Clave única:

```text
chain_id + tx_hash + log_index + event_kind
```

Usarlo para:

- Depósitos.
- Recovery.
- InvoicePaid.
- Transferencias de activos soportados.
- Receipts/UserOperationEvent.
- Cambios relevantes de Aave.
- Eventos futuros.

Notificaciones y outbox nacen únicamente después de insertar el evento por
primera vez. Esto cierra el riesgo de push duplicado si el cursor falla después
de notificar.

No confiar sólo en `tx_hash`: un evento puede desaparecer por reorg. `canonical`
y `block_hash` forman parte de su ciclo de vida y nunca se eliminan antes de la
retención de auditoría.

### IDX-03 — Checkpoints, detección de reorg y rollback

Crear `chain_blocks`/checkpoints con:

```text
chain_id + stream
block_number
block_hash
parent_hash
consistency_level
canonical
projected_through
updated_at
```

En cada avance:

1. Leer el hash del último checkpoint local.
2. Compararlo con el proveedor canónico según política de quorum/finality.
3. Verificar continuidad por `parent_hash`.
4. Si diverge, buscar el ancestro común dentro de la ventana soportada.
5. Marcar bloques/eventos huérfanos como no canónicos.
6. Revertir deltas o reconstruir proyecciones desde el checkpoint anterior.
7. Ingerir la rama nueva y reanudar.
8. Emitir efectos externos sólo una vez desde el estado canónico.

Políticas:

- Mantener ventana mayor que la profundidad de confirmación usada.
- Conservar headers individuales dentro de la ventana de reorg y compactar
  historia finalizada en checkpoints; no guardar indefinidamente cada bloque de
  una L2 rápida sin necesidad.
- Si no aparece ancestro dentro de la ventana, detener el stream, alertar y
  requerir backfill verificado; nunca continuar a ciegas.
- Ledger settled/finalized no se revierte silenciosamente: entra en estado de
  incidente/compensación según riesgo.
- Guardar métricas de profundidad, tiempo de recuperación y filas afectadas.

Aceptación:

- Tests de reorg de 1, N y fuera de ventana.
- Rollback + replay deja exactamente el mismo resultado que un indexado limpio.
- Push, ledger, webhooks y balances no se duplican.
- Cursor nunca apunta a un hash huérfano.

### IDX-04 — Ingestión continua con cron de reparación

Introducir una interfaz de fuente:

```text
ChainSource
  ├── RpcLogPoller
  ├── ProviderWebhook/ManagedStream
  ├── DurableSubscriber opcional
  └── ArchiveBackfill
```

Reglas:

- Webhook/stream reduce latencia, pero no es fuente exclusiva.
- Un Worker de request no asume un proceso ni socket saliente permanente. Si se
  usa WebSocket RPC outbound, vive en un componente diseñado para ello, reconecta
  y acepta que no puede usar hibernación como un WebSocket servidor.
- Poller/cron compara watermarks y rellena huecos.
- Cada entrega se normaliza en el mismo journal antes de proyectar.
- Un provider webhook no se confía sin verificar chain, address, block hash y
  posición.
- Si el stream cae, el cron recupera desde el último checkpoint, no desde “ahora”.
- Si se divide en Workers, usar Queue/Service Binding, no HTTP público interno.

Aceptación:

- Desconectar el stream por 10 minutos y reconectar recupera todos los eventos.
- Doble entrega stream + poller produce un solo journal row.
- Latencia y completitud se miden de forma independiente.

### IDX-05 — Orden y timestamp exactos

- Guardar `block_number`, `transaction_index` y `log_index`.
- Guardar siempre `block_hash`.
- No usar `new Date()` como sustituto silencioso del timestamp histórico.
- Obtener timestamps en batch/caché o enriquecer asíncronamente.
- Ordenar por posición on-chain y usar fecha solo para presentación.

### IDX-06 — Backfill operable

Crear comando soportado:

```text
indexer backfill --chain --event --from --to --dry-run
```

Requisitos:

- Rango explícito.
- Estimación de calls.
- Checkpoint.
- Rate limit.
- Lane RPC `backfill` y endpoint archive separado.
- Resume.
- Métricas.
- Escrituras idempotentes.
- Modo dry-run.
- Verificación de hashes/checkpoints al terminar.

El backfill automático de 5.000 bloques se conserva solo como protección de
primer arranque, no como herramienta de recuperación histórica.

### IDX-07 — Historial paginado

Reemplazar el límite fijo de 200 por cursor estable:

```text
GET /user/transactions?limit=50&before=<opaque_cursor>
```

- Cursor basado en orden estable, no offset.
- Máximo de página.
- `nextCursor`.
- Compatibilidad temporal con la respuesta actual.
- Índice adecuado por `uid + block/order/id`.

### IDX-08 — ETH nativo: decisión explícita

El ledger actual no descubre depósitos externos de ETH.

Opciones:

1. Declarar USDC como único depósito soportado y mostrar esa limitación.
2. Integrar un proveedor de traces/indexación para ETH.
3. Ejecutar infraestructura propia solo cuando volumen/negocio lo justifique.

Gate: no afirmar “historial completo” hasta implementar la opción 2 o 3.

### IDX-09 — Proyectores versionados y reconstrucción

Cada proyector declara:

- Nombre y versión.
- Tipos de evento soportados.
- Esquema de salida.
- Watermark bloque/hash.
- Estrategia de rollback.
- Checksum/configuración de contratos.

Herramientas requeridas:

```text
projector rebuild --name --chain --from-checkpoint --dry-run
projector compare --version-a --version-b --sample
projector promote --version --feature-flag
```

Aceptación:

- Nueva versión corre en shadow/dual-write sin afectar lecturas.
- Comparador entrega diferencias raw y causa.
- Promoción y rollback no requieren reingestar desde génesis.
- Reconstrucción sobre fixture canónico es determinista.

## Fase 4 — Integridad de datos y API

### DATA-01 — Canonicalizar importes on-chain

Agregar de forma compatible:

- `amount_raw`.
- `decimals`.
- `chain_id`.
- `block_number`.
- `block_hash`.
- `transaction_index`.
- `log_index`.
- `consistency_level`.
- `projection_version`.

Mantener `amount` humano durante la transición. Nuevas escrituras guardan ambos;
backfill verifica equivalencia. No reconstruir históricos ambiguos sin marcar
procedencia.

### DATA-02 — Evolución D1 segura

- Solo migraciones incrementales.
- Nada de `DROP` destructivo en producción.
- Expand → deploy compatible → backfill → contract.
- Backup cifrado antes de migrar.
- Restore drill sobre copia.
- Índices revisados con `EXPLAIN QUERY PLAN`.
- Presupuesto de tamaño/latencia y alertas.
- Backfill resumible con watermark y verificación de conteos/checksums.
- Prueba de D1 Sessions/bookmarks si read replication está activa.

No migrar de D1 por intuición. Definir trigger:

- p95 sostenido fuera de SLO.
- Contención/escrituras no resolubles con schema.
- Tamaño/costo/retención incompatible.
- Necesidad real de consultas o transacciones que D1 no soporte.
- Hot partitions o write contention demostrada tras optimizar índices/batches.

Si se activa un trigger, evaluar en orden:

1. Índices/query shape y reducción de filas leídas.
2. Read replication + Sessions.
3. Separar journal histórico de read models calientes.
4. Particionar por cadena o account bucket.
5. Migrar sólo el workload que excede D1, no toda la plataforma.

### DATA-03 — Contrato API y SDK

- Mantener `error_code` canónico.
- Versionar cambios incompatibles.
- OpenAPI como fuente de SDK.
- Idempotency-Key obligatorio en endpoints merchant mutables.
- Cursor pagination en payments/events/webhooks.
- `GET /home` con `ETag`, `stateVersion` y contrato de estados parciales.
- Header de bookmark opaco documentado cuando D1 replicas esté activo.
- Request body limits antes de parsear.
- Redacción uniforme de errores y PII.

### DATA-04 — Retención y privacidad

Definir:

- Qué datos son financieros, operativos, autenticación o analytics.
- Retención por tabla.
- Exportación del usuario.
- Borrado compatible con obligaciones contables.
- Minimización de metadata on-chain y off-chain.
- Acceso del equipo y auditoría.

## Fase 5 — Seguridad y contratos para fondos reales

### SEC-01 — Recovery de alto valor

- Sustituir guardian EOA global por multisig/MPC/HSM.
- Separar autorización humana de ejecución automatizada.
- Límites por usuario y por día.
- Alertas al proponer, cancelar y ejecutar.
- Runbook de guardian comprometido.
- Simulación de pérdida de una clave/firmante.

Gate: ninguna cuenta mainnet de valor material depende de una sola clave caliente.

### SEC-02 — Ownership y roles

- Owners de Factory, Paymaster, PaymentRouter y CrosschainRouter en multisig.
- Timelock para cambios no urgentes.
- Pausa de emergencia separada de upgrade/configuración.
- Inventario de roles, owners y addresses firmado.
- `transferOwnership` y aceptación verificadas on-chain.

### SEC-03 — Despliegue V2 en Arbitrum One

- Compilar con toolchain pineado.
- Revisar storage layouts.
- Ejecutar unit, fuzz, invariant y fork tests.
- Desplegar determinísticamente.
- Verificar bytecode y constructor args.
- Configurar tokens/router/paymaster.
- Probar `unlockStake`/`withdrawStake`, caps, recovery y permit.
- Reemplazar `TODO_DEPLOY` únicamente después de verificar.

### SEC-04 — Claves, fondos y límites

- Rotación ensayada de cada rol.
- RPC/API credentials con owner y fecha de expiración.
- Presupuesto diario de faucet y relayers.
- Alertas de paymaster deposit/stake.
- Límite de pérdida máxima por incidente.
- Kill switches probados.
- Secret scanning en historial y worktree.

### SEC-05 — Auditoría independiente y bug bounty

Alcance mínimo:

- Smart accounts y recovery.
- Paymaster.
- PaymentRouter.
- CrosschainRouter/CCTP.
- Backend settlement/reconciliation.
- Webhooks/API keys.
- Migraciones financieras.

Todos los findings critical/high deben cerrarse o tener waiver público interno,
owner y fecha. Después: bug bounty con límites de TVL progresivos.

### SEC-06 — Seguridad web/plataforma

- CSP y headers.
- CORS exacto.
- Turnstile y rate limiting de zona.
- SSRF en webhooks: URL parsing, HTTPS live, redirects controlados y revalidación.
- Firebase account linking.
- Protección anti-abuso en endpoints públicos.
- Revisión de service worker para que jamás cachee API/auth.

## Fase 6 — Frontend y dashboard al nivel de producto financiero

### FE-01 — Modelo único de estado asíncrono

Unificar hooks para:

- Preparar.
- Firmar.
- Enviar.
- Poll/subscribe.
- Confirmar/fallar.
- Reintentar.
- Recuperar operación después de reload.

No duplicar máquinas de estado por página. El estado durable del backend domina.
SWR comparte keys por recurso/usuario para deduplicar mounts; ninguna pantalla
implementa un segundo `setInterval` para “asegurar” frescura.

### FE-02 — Performance medida

- Añadir bundle visualizer en CI como artefacto.
- Reducir límites a 360 KiB cliente, 200 KiB dashboard y 90 KiB por chunk, con
  baseline aprobado.
- Lazy-load de features pesadas y Firebase cuando sea viable.
- Evitar imports barrel que arrastren módulos.
- Iniciar fetches independientes en paralelo; evitar waterfalls entre perfil,
  balance y actividad usando `GET /home`.
- Diferir analytics y terceros no críticos hasta después de interacción/hydration.
- Medir Web Vitals reales por ruta/dispositivo.
- Mantener `jsQR` como fallback dinámico.
- No optimizar locales hasta que cantidad/tamaño lo justifique.

### FE-03 — Tests de cliente

Agregar Vitest + Testing Library para:

- Parsing/formatos monetarios.
- Errores `ERR.*`.
- Estados `pending/confirmed/failed`.
- SWR invalidation.
- ETag/`304`, `stateVersion` y respuesta parcialmente stale.
- Migración, partición y limpieza de IndexedDB.
- Dedupe de focus/reconnect/push simultáneos.
- Formularios de monto.
- WebAuthn adapters con mocks.
- Redirecciones y recuperación de sesión.

Playwright conserva:

- Smoke autenticado.
- Money flows.
- Accesibilidad.
- Mobile/desktop.
- Offline/PWA.

### FE-04 — Accesibilidad manual

Gate adicional a axe:

- VoiceOver iOS/macOS.
- TalkBack Android.
- Navegación solo teclado.
- Zoom 200–400%.
- Reduced motion.
- Diálogos, focus trap, retorno de foco e `inert`.
- Errores y cambios de estado anunciados.

### FE-05 — Experiencia de dato financiero

- Mostrar “actualizado hace X”.
- Distinguir estimado/ejecutado.
- Mostrar red y token.
- Copiar explorer link seguro.
- Conservar comprobante.
- Mostrar soporte/retry cuando una operación queda recuperable.
- Nunca convertir fallo RPC en saldo cero.

### FE-06 — Home instantáneo, privado y coherente

- Pintar snapshot local permitido sin bloquear el shell.
- Revalidar una sola key agregada y actualizar secciones con estado explícito.
- Mostrar `actualizado hace X`, red y nivel confirmado sin exponer hashes técnicos
  innecesarios.
- Aplicar push como invalidación; volver a obtener datos autenticados.
- Rechazar cache rows cuyo `uid`, `chainId`, schema o versión no correspondan.
- Borrar datos locales en logout y ofrecer limpieza desde ajustes.
- Service worker nunca cachea respuestas API/auth en Cache Storage.
- Operaciones optimistas sólo afectan presentación; saldo disponible para gastar
  proviene del read model confirmado.

Aceptación:

- Home muestra el último estado en menos de 100 ms desde IndexedDB en dispositivo
  objetivo, sin declarar que es nuevo antes de revalidar.
- Dos tabs comparten invalidación sin crear polling duplicado.
- Logout/login con otro usuario no muestra ni un frame de datos anteriores.
- Offline muestra estado viejo claramente y bloquea acciones que requieran
  validación online.

### DASH-01 — Operabilidad merchant

- Paginación real.
- Replay de webhooks autorizado y auditado.
- Rotación de secrets.
- Estado de delivery y último error redactado.
- Separación sandbox/live.
- Exportación CSV asíncrona para datasets grandes.
- Alertas de integración.

## Fase 7 — Observabilidad, SRE y costo

### OBS-01 — Telemetría end-to-end

Correlacionar:

```text
requestId → uid/merchant anonimizado → userOpHash → txHash
→ ledger/event/outbox/webhook
```

Nunca incluir secretos, firma WebAuthn, raw transaction o PII innecesaria.

### OBS-02 — Dashboards obligatorios

1. **RPC:** requests, subcalls, bytes, CU, lane, latencia, `429`, failover.
2. **Pagos:** prepared/submitting/submitted/confirmed/failed y edad.
3. **Indexer:** head, journal/projection watermarks, lag, hashes, reorgs, shards y
   backfill.
4. **Queues:** depth, oldest, retries, DLQ.
5. **D1:** rows read/written, latencia, tamaño, errores, región/primary y bookmark.
6. **Relayers:** ETH, nonce, pending txs.
7. **Paymaster:** deposit, stake, gasto y rechazos.
8. **Webhooks:** success, retries, latency, disabled endpoints.
9. **Frontend:** Web Vitals, JS errors, cache hit, `304`, dedupe e invalidación.
10. **Seguridad:** rate limits, Turnstile, recovery y cambios administrativos.
11. **Proyecciones:** versión, throughput, drift, replay y correcciones.
12. **Push:** invalidaciones, dedupe, latencia y fallback.

### OBS-03 — Alertas accionables

Cada alerta incluye:

- Severidad.
- Owner.
- Query/umbral.
- Runbook.
- Acción de mitigación.
- Condición de cierre.

Evitar alertas sin owner o sin acción.

### OBS-04 — Cost model

Medir por 1.000 usuarios activos:

- Worker requests.
- D1 rows read/written.
- Queue operations.
- RPC requests/CU.
- Eventos on-chain ingeridos y proyectados.
- Reconciliaciones por estrategia de activo.
- Firebase push/auth.
- Bundler/paymaster gas.
- CCTP fees.

Revisar costo por usuario activo, pago confirmado y merchant activo.
Añadir escenarios de 10.000 y 100.000 usuarios. El informe separa:

```text
costo de vistas
costo de actividad on-chain
costo de seguridad/reconciliación
costo de historia/backfill
```

El KPI principal de la V2 es `RPC/CU atribuible a vistas = 0`. El costo marginal
de una vista puede incluir Worker/D1, pero debe reducirse con ETag, dedupe y
replicas sin esconder rows read.

### OBS-05 — Capacity ledger y triggers arquitectónicos

Mantener por componente:

- Límite documentado.
- Uso normal, pico y headroom.
- Owner.
- Métrica/alerta.
- Acción automática de degradación.
- Trigger y ADR para el siguiente escalón.

Triggers iniciales a calibrar:

| Componente | Trigger de evaluación |
|---|---|
| RPC provider | >60% cuota sostenida, >1% `429` o costo/CU fuera de presupuesto |
| Ingestor | CPU/duración >70% del presupuesto o lag p95 >30 s |
| Queue | oldest message >SLO o retries sostenidos |
| D1 | p95 >200 ms, rows read desproporcionadas o contención demostrada |
| Push | entrega p95 fuera de SLO o tasa de pérdida no reparada |
| Backfill | amenaza lane crítica o TCO supera endpoint archive dedicado |

No esperar al límite duro: iniciar ADR con headroom aún disponible.

## Fase 8 — Release engineering, QA y resiliencia

### QA-01 — Gates por PR

Obligatorios:

```powershell
pnpm verify
pnpm audit:prod
pnpm test:e2e
pnpm check:release-artifact
pnpm check:d1:restore
pnpm check:contracts:storage
pnpm check:contracts:coverage
Set-Location contracts
forge build --sizes
forge lint --severity high med low --deny warnings
forge test
```

Además:

- Semgrep.
- Slither.
- Gitleaks historia + worktree.
- Actionlint.
- Typegen drift.
- OpenAPI lint.
- Bundle budgets.

### QA-02 — Chaos tests financieros

Simular:

- RPC primario caído.
- Ambos RPC caídos.
- Receipt temporalmente no encontrado.
- Queue redelivery.
- Worker muerto después del broadcast.
- Ingestor muerto después de journalizar y antes de proyectar.
- Proyector muerto después de aplicar delta y antes de avanzar watermark.
- D1 falla antes/después de cada transición.
- Cursor no avanzado.
- Reorg de un bloque, profundidad normal y fuera de ventana soportada.
- Mismo block number con hash distinto.
- Webhook lento/redirect/SSRF.
- Bundler devuelve error ambiguo.
- CCTP attestation tardía y mint revertido.
- Nonce ocupado.
- Backfill saturando provider mientras entra un pago.
- Push perdido, duplicado y fuera de orden.
- Read replica atrasada y bookmark inválido.
- Proyector aUSDC con índice/versión de contrato incompatible.

Aceptación: dinero nunca se contabiliza dos veces, nunca se pierde el handle de
recuperación, una rama huérfana no permanece proyectada y todo estado ambiguo
queda visible/alertado.

### QA-03 — Matriz de ambientes

Separar:

- Local.
- Test runtime Worker.
- Arbitrum Sepolia staging.
- Producción Arbitrum One.

Bindings, secrets, D1, URLs, Firebase projects, analytics, RPC y contratos no se
comparten accidentalmente. Nunca desplegar el Worker root si solo se pretenden
environments explícitos.

### QA-04 — Release gradual

- Artefacto único.
- Backup.
- Migraciones expand-only.
- Canary.
- Readiness.
- Smoke sintético.
- Observación.
- Promoción.
- Rollback Worker.
- Procedimiento específico cuando la migración no es reversible.

## Fase 9 — Salida controlada a Arbitrum One

### MAIN-01 — Gate previo

Todos deben estar completos:

- [ ] Fases 0–8 P0/P1 cerradas con evidencia.
- [ ] Contratos mainnet desplegados y verificados.
- [ ] Auditoría independiente sin critical/high abiertos.
- [ ] Owners/guardian en multisig/MPC/HSM.
- [ ] Bundler y RPC dedicados con fallback probado.
- [ ] Paymaster fondeado con caps.
- [ ] Relayers con gas y límites.
- [ ] Secrets rotados.
- [ ] Branch protection y environments activos.
- [ ] Backup/restore/rollback ensayados.
- [ ] Load y chaos tests verdes.
- [ ] `RPC/CU atribuible a vistas de Home = 0` demostrado bajo carga.
- [ ] Journal, proyectores, reorg rollback y replay demostrados.
- [ ] Dual-run/reconciliación sin drift no explicado para activos promovidos.
- [ ] Modo degradado RPC y aislamiento de backfill ensayados.
- [ ] Read-your-writes probado en cada topología D1 habilitada.
- [ ] QA manual dispositivos/lectores de pantalla.
- [ ] Legal, privacidad y soporte listos para la jurisdicción objetivo.

### MAIN-02 — Lanzamiento progresivo

1. Activar mainnet con allowlist interna.
2. Límites diarios y TVL mínimos.
3. Pagos internos pequeños.
4. Links externos.
5. Swap/Earn.
6. Cross-chain.
7. Apertura gradual por cohortes.

Cada etapa exige una ventana de observación y métricas verdes. No habilitar todas
las features el mismo día.

### MAIN-03 — Respuesta a incidentes

Runbooks mínimos:

- Relayer comprometido.
- Guardian comprometido.
- Paymaster drenando gas.
- RPC divergente.
- Bundler caído.
- D1 inconsistente.
- Indexer atrasado.
- CCTP atascado.
- Webhook secret filtrado.
- Firebase service account filtrada.
- Contrato pausado/upgraded.

Ejecutar tabletop y drill técnico antes de retirar límites iniciales.

## 8. Backlog posterior al PMF

No bloquear mainnet inicial con estos frentes, salvo que negocio cambie:

- App nativa enfocada en merchant.
- Multi-red adicional por demanda real.
- Pagos multi-activo/cross-chain más allá de USDC.
- Social recovery plural por usuario.
- Rescate automatizado de depósitos en red equivocada.
- Indexación de ETH nativo mediante traces.
- R2 para avatares/archivos.
- EIP-7702.
- Compresión de calldata solo si métricas prueban el techo.

Cada propuesta requiere ADR con problema, métricas, alternativas, costo, riesgo y
rollback.

### 8.1 Capacidades condicionadas y su trigger

| Capacidad | Introducir cuando | No introducir sólo porque |
|---|---|---|
| Durable Objects + WebSocket hibernable | FCM/focus no cumple latencia o se necesita presencia foreground medible | “WebSocket parece más realtime” |
| Cloudflare Workflows | CCTP/recovery u otro flujo multi-hora acumula complejidad de retries/esperas que la máquina D1 ya no opera bien | Existe el producto en Cloudflare |
| Provider de traces | El producto promete depósitos/historial ETH completo o soporte exige trazabilidad interna | Se quieren más datos sin caso de uso |
| Endpoint archive dedicado | Backfill compite por cuota/latencia con tráfico crítico | El RPC actual todavía tiene headroom |
| Ingestor Worker separado | CPU, duración, release cadence o blast radius justifican aislamiento | Se desea “microservicios” |
| Durable Object para rate limit | Hace falta coordinación estricta entre isolates y Queue concurrency no basta | Para guardar cache financiera |
| D1 read replication | Hay tráfico multi-región/presión de lectura y Sessions pasa pruebas | Antes de medir latencia real |
| Partición/múltiples D1 | Hot partitions/límites demostrados tras optimizar schema/query | Por una cifra teórica de usuarios |
| Nodo propio/archive | TCO, independencia o retención supera claramente proveedor administrado y existe equipo on-call | Como símbolo de descentralización |
| Kafka/Kubernetes | Throughput, retención o portabilidad lo requieren y Cloudflare primitives ya no cumplen | Para anticipar una escala no medida |

Workflows no reemplaza el journal ni el ledger. Durable Objects no reemplaza D1.
Un nodo propio no elimina la necesidad de control de concurrencia, observabilidad
o reorg handling.

## 9. Orden global de prioridad

| Orden | IDs | Resultado |
|---:|---|---|
| 1 | OP-01..03 | Baseline promovido y verdad operacional |
| 2 | BAL-01..07, HOME-01, RPC-01 | Cese inmediato de polling y read path sin RPC |
| 3 | CHAIN-01, BAL-08..09, IDX-02..05 | Journal, proyecciones, reconciliación y reorg |
| 4 | SCALE-01, D1-01, OBS-05 | Escala demostrada con triggers y consistencia |
| 5 | PAY-01..04 | Throughput sin cuello de botella de nonce |
| 6 | IDX-01..09 | Indexación e historial escalables y reconstruibles |
| 7 | DATA-01..04 | Datos financieros canónicos y API estable |
| 8 | SEC-01..06 | Preparación real para fondos mainnet |
| 9 | FE/DASH | UX, bundles, testing y merchant operable |
| 10 | OBS/QA | SLOs, alertas, chaos y releases |
| 11 | MAIN-01..03 | Lanzamiento gradual Arbitrum One |

El rediseño BAL no debe esperar al bundler. El bundler no debe esperar a mainnet.
La auditoría externa se contrata mientras se terminan BAL/PAY/IDX, pero se ejecuta
sobre un commit congelado después de los cambios críticos.

La ola rápida `BAL-01..07 + HOME-01` reduce riesgo de capacidad inmediatamente.
La ola estructural `CHAIN-01 + BAL-08..09 + IDX-02..05` elimina el costo RPC por
usuario de forma sostenible. No se debe confundir terminar la primera con
completar la arquitectura V2.

### 9.1 Ruta crítica y gates

| Milestone | Entrega | Gate para avanzar |
|---|---|---|
| M0 — Baseline | Estado actual promovido y medido | OP-01..03 verdes |
| M1 — Contener carga | Polling eliminado, SWR dedupe, passkey fuera de Home | Cero polling en tabs activas/inactivas |
| M2 — Lectura V2 | `/home`, snapshots por bloque, Queue/Multicall | Cero RPC en handler y prueba de carga 1k |
| M3 — Datos canónicos | Journal/checkpoints, proyector USDC, recuperación de reorg | Dual-run y replay determinista |
| M4 — Activos híbridos | aUSDC derivado validado, política ETH, reconciliador | Informe de drift y fallback por activo |
| M5 — Control de escala | RPC lanes, stream+cron, D1 Sessions/replicas si aplica | 10k y aislamiento de fallos verdes |
| M6 — Preparación hiperescala | Sharding/partición sólo si trigger activo | 100k virtual, margen 2× y TCO aprobado |
| M7 — Mainnet | Seguridad/auditoría/rollout | MAIN-01 completo |

M1 y M2 no esperan a terminar todos los proyectores. M3/M4 corren en shadow hasta
probar exactitud. M6 es capacidad preparada, no autorización automática para
añadir infraestructura.

## 10. Definition of Done por tarea

Una tarea solo puede marcarse terminada cuando existe:

1. Código/configuración revisados.
2. Migración compatible, si aplica.
3. Tests unitarios y de integración.
4. Test de failure/retry.
5. Métricas y alertas.
6. Documentación/runbook.
7. Evidencia en staging.
8. Criterios de aceptación medidos.
9. Rollback o compensación.
10. Promoción del artefacto correcto.
11. Para datos on-chain: fixture con bloque/hash, reorg y replay.
12. Para cambios de escala: requests, subcalls, CU, CPU, D1 rows, costo y
    headroom antes/después.
13. Para proyectores: dual-run, drift report y versión promovida.

“Implementado localmente”, “compila”, “hay un TODO resuelto” o “funcionó una vez”
no equivale a producción terminada.

## 11. Registro de decisiones obligatorio

Crear ADRs al menos para:

- ADR-001: journal canónico + D1 snapshots/proyecciones + Queue.
- ADR-002: proveedor y estrategia de bundler.
- ADR-003: proveedores RPC, control plane y separación read/write/archive.
- ADR-004: guardian multisig/MPC/HSM.
- ADR-005: sharding del indexer.
- ADR-006: soporte o no de ETH nativo externo.
- ADR-007: estrategia de ambientes y release.
- ADR-008: límites iniciales y rollout mainnet.
- ADR-009: política de consistencia/finality y ventana de reorg por red.
- ADR-010: estrategia de proyección y reconciliación por activo.
- ADR-011: BFF `/home`, `stateVersion`, ETag y caché IndexedDB.
- ADR-012: D1 read replication, Sessions y propagación de bookmarks.
- ADR-013: push FCM frente a WebSocket/Durable Objects.
- ADR-014: estrategia de stream, cron de reparación y backfill archive.
- ADR-015: particionado de journal/read models al superar D1.
- ADR-016: derivación aUSDC, contrato/índice y reglas de redondeo.
- ADR-017: triggers/TCO para provider administrado frente a nodo propio.

Cada ADR debe incluir contexto, decisión, alternativas, consecuencias, métricas y
plan de salida.

## 12. Referencias técnicas actuales

- [Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Queues: batching, retries y delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare D1 global read replication y Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Cloudflare Durable Objects WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [viem Public Client y batching Multicall](https://viem.sh/docs/clients/public)
- [viem multicall](https://viem.sh/docs/contract/multicall)
- [SWR automatic revalidation](https://swr.vercel.app/docs/revalidation)
- [SWR performance y deduplication](https://swr.vercel.app/docs/advanced/performance)
- [Aave V3 AToken: balance escalado por índice normalizado](https://github.com/aave/aave-v3-core/blob/master/contracts/protocol/tokenization/AToken.sol)

Nota de plataforma verificada al corte: Wrangler 4.107.0 expone configuración de
Queues y la versión publicada de `@cloudflare/workers-types` consultada fue
`5.20260724.1`. Revalidar documentación y tipos al iniciar cada fase; no copiar
APIs de este plan sin verificar la versión instalada.

## 13. Mantenimiento de este plan

- Actualizar estado solo con enlaces a evidencia.
- Registrar fecha y autor de cada cambio.
- Revisar semanalmente durante implementación y antes de cada release.
- Mover tareas cerradas a una sección de changelog, no borrarlas.
- Añadir nuevos frentes únicamente con prioridad, owner, aceptación y dependencia.
- Si código y documento discrepan, detener promoción, comprobar el runtime y
  corregir ambos.

El plan se considera completado cuando Parmelia cumple los gates de MAIN-01,
opera el rollout MAIN-02 dentro de los SLOs durante la ventana acordada y el
equipo demuestra los drills MAIN-03. La optimización V2 sólo se considera
completada si además:

- Las vistas de Home aportan cero RPC/CU bajo 1k/10k.
- Journal, rollback/replay y proyectores pasan fixtures canónicos.
- Cada activo promovido tiene estrategia y reconciliación sin drift no explicado.
- El siguiente escalón de capacidad conserva al menos 2× de headroom.
- El costo se reporta por vista, evento, operación y reconciliación.

### 13.1 Changelog

**2.0 — 2026-07-25**

- Sustituye la arquitectura de refresco principalmente RPC por ingestión única,
  journal canónico y proyecciones híbridas.
- Añade consistencia por bloque/hash, reorg rollback y replay.
- Añade BFF `/home`, IndexedDB versionado, ETag e invalidación push.
- Añade RPC control plane, D1 Sessions/replicas y aislamiento de backfill.
- Añade estrategia específica para USDC, aUSDC y ETH.
- Añade escalones de capacidad, triggers anti-sobreingeniería y gates
  1k/10k/100k.

**1.0 — 2026-07-24**

- Consolidó baseline, snapshots D1, Queue/Multicall, bundler, seguridad, QA y
  lanzamiento controlado.
