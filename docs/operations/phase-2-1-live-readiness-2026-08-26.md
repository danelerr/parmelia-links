# Cierre remoto corregido de Fase 2.1

**Corte:** 26 de agosto de 2026
**Alcance:** recut semántico App/Payments, hardening de checkout, RPC,
Workers, frontends y evidencia remota
**Estado:** infraestructura de testnet promovida y verificada;
`PAYMENT_LIVE_ENABLED=false`

## Veredicto

La remediación posterior a la auditoría está versionada, desplegada y comprobada
contra los servicios remotos. App y Payments conservan ownership físico separado,
el nuevo target Payments parte de una importación semánticamente verificada y el
dashboard ya no está detrás de Vercel SSO.

Esto **no habilita pagos reales ni mainnet**. La ejecución monetaria permanece
cerrada por `PAYMENT_LIVE_ENABLED=false`; no se movió dinero en este cierre y no
se desplegó ni redeployó ningún contrato. La siguiente fase debe producir
evidencia E2E transaccional controlada sobre testnet antes de considerar una
activación gradual.

GatoPago no integra Reown, WalletConnect ni otro proveedor de wallets. La cuenta
GatoPago sigue siendo la smart account propia; un pagador externo usa únicamente
un provider EIP-1193 ya inyectado por su extensión o por el navegador integrado
de su wallet. Sin provider, el checkout muestra una instrucción explícita y no
queda en estado de conexión.

## Evidencia de datos e infraestructura

| Gate | Resultado |
|---|---|
| App D1 | `parmeliadb`; conserva identidad, cuenta, actividad, indexación y CCTP personal. |
| Payments D1 activa | `gatopago-payments-semantic-20260826`, UUID `5e3d05a6-b72f-43c4-ac0f-8f0aa6947b1a`. |
| Payments D1 histórica | `gatopago-payments`, UUID `f0daaeb3-8df0-44d3-8b1f-a2f37461d50e`; se conservó intacta para auditoría/rollback. |
| Migraciones Payments | `0001`–`0006` aplicadas sobre la D1 nueva. |
| Snapshot semántico | Manifest v4/checksum v2: `5d3093e9b12288d7783832037b3bf06635591da1cf56df377ff4b4b6f3093a27`; 47 filas de negocio en el corte. |
| Contenido importado | 4 merchants, 21 links y 21 intents; 0 quotes, attempts, fees, API keys, webhooks, eventos o CCTP merchant. |
| Ownership CCTP | 7 operaciones personales permanecen en App; 0 fueron importadas a Payments. |
| Delta histórico | 3 merchants derivados por sync y una quote local expirada se clasificaron; permanecen sólo en la D1 histórica. |
| Integridad | Import data-only único sobre base vacía; export target verificado contra el manifest; `quick_check=ok` y 0 errores FK. |
| Backups | App congelada y Payments histórica se exportaron cifradas y se restauraron fuera del workspace antes del recut. |
| Colas | App conserva sus Queue/DLQ; Payments usa `gatopago-payment-jobs` y `gatopago-payment-jobs-dlq`. |
| Drain | 0 operaciones propiedad de Payments y 0 dead letters; los jobs personales de App no bloquean el cutover. |
| Sync | El outbox de cuentas se resembró idempotentemente porque el intento histórico ya lo había consumido; se drenaron 7 cuentas y Payments terminó con 7 merchants. |

## Evidencia desplegada

| Superficie | Resultado |
|---|---|
| App Worker | `server`; boundary v2, modo `payments`, sync activo, health `ok`; versión final del corte `e2243220-05ac-4319-9560-3bd4ab625e59`. |
| Payments Worker | `gatopago-payments-api`; bootstrap apagado, data cutover verificado y live payments apagados; versión final del corte `cbe822ef-ee0f-4667-8ee6-33dca199e186`. |
| RPC Payments | Dos hostnames independientes por Arbitrum Sepolia y Fuji; tres por Base Sepolia. El preflight usa Multicall3 y Payments respondió `30/30` health consecutivos. |
| App Web | `https://app.parmelia.me`, accesible anónimamente y con sesión GatoPago existente. |
| Dashboard | `https://dashboard.parmelia.me`, accesible anónimamente y muestra el login GatoPago; Vercel SSO está desactivado. |
| Checkout directo/proxy | Un link migrado resuelve directamente en Payments y mediante el proxy temporal de App. |
| Preflight remoto | `pnpm verify:remote-readonly` terminó con todos los gates Vercel/Cloudflare en `ready`. |
| Contratos/forks | 197 pruebas Foundry remotas, 0 fallos y 0 omisiones; incluye los forks públicos de las tres testnets. |

## Smokes de navegador

- En Chromium limpio, sin `window.ethereum`, un link pendiente mostró la
  instrucción para abrirlo en el navegador integrado de la wallet; no apareció
  spinner persistente ni transporte externo.
- Para la regresión A→B se retuvo deliberadamente la respuesta de B. Durante la
  espera, A ya no estaba visible, había pantalla de carga y había 0 botones de
  pago/conexión accionables. Al liberar B apareció su input de monto.
- En el navegador autenticado existente, App cargó Home, saldos y actividad.
- Dashboard respondió con su login propio, no con un redirect a `vercel.com`.

No se completó un pago de extremo a extremo ni se creó una API key/webhook real
durante estos smokes. Esa evidencia transaccional pertenece a Fase 4 y requiere
una ventana testnet controlada; el flag live permanece apagado.

## Fuente y secretos

El runtime promovido corresponde al commit `d54a71f70217ff2233f05ba631f934ba7f917f70`.
Las correcciones operativas/documentales posteriores no cambian los bundles ni
los Workers. La matriz CI debe quedar verde sobre el HEAD documental antes de
dar por cerrado este registro.

No se rotó ningún secreto. El helper reutilizó el material ya protegido con
DPAPI y comprobó que `wallet-0x75` coincide con el signer testnet desplegado;
ningún valor secreto se imprimió ni se escribió en el repositorio. La procedencia
y recuperación de cada nombre están en el
[inventario canónico](./worker-variables.md).

## Cómo seguimos

La Fase 3 queda promovida en sus componentes de hardening, checkout y operación.
La siguiente iteración es la **Fase 4: reconciliación y evidencia E2E real**:

1. ejecutar pagos controlados local y CCTP en las tres testnets;
2. capturar source tx, mensaje CCTP, destination tx, estado D1 y webhook;
3. inyectar fallos de RPC/Iris, crash de browser, tx no registrada, doble pago y
   sobrepago;
4. medir lag, reintentos y consumo antes de decidir si hace falta extraer otro
   consumer;
5. mantener mainnet y fees apagados hasta superar ese gate y una revisión
   contractual separada.
