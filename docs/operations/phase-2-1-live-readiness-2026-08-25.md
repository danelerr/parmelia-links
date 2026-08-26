# Registro remoto y reapertura de Fase 2.1

> **Registro histórico, reemplazado:** conserva el estado observado el
> 25-08-2026. El cierre corregido y la evidencia vigente están en
> [Cierre remoto corregido de Fase 2.1](./phase-2-1-live-readiness-2026-08-26.md).

**Corte:** 25 de agosto de 2026  
**Alcance:** corte ejecutado en Cloudflare/Vercel y auditoría posterior  
**Modo:** registro histórico; remediación local posterior sin promoción

## Veredicto

La base de producción **ya está físicamente particionada**. App y Payments usan
D1 y Queues independientes; `server` está en `PAYMENTS_CUTOVER_MODE=payments`
y Payments es el único dueño de las nuevas escrituras merchant. Las tablas
legacy permanecen en App durante el soak para rollback/reconciliación, pero ya
no son la fuente activa de checkout.

La **Fase 2.1 fue reabierta y no está aprobada para manejar pagos reales**. El
corte físico terminó, pero la auditoría posterior encontró un bloqueo lógico de
attempts públicos, un checksum que sólo probaba IDs, un dashboard detrás de
Vercel SSO, estado contaminable entre links, health RPC frágil y despliegues
hechos desde código sin commit. También señaló que el checkout externo sólo usa
un provider EIP-1193 inyectado; posteriormente se confirmó que esa limitación es
la decisión de producto y no un defecto que deba resolverse con un tercero.

Hay remediaciones locales verificadas por `pnpm verify:all`, pero **ninguna está desplegada** en
este corte. GatoPago sigue siendo la wallet: smart account, passkey y ERC-4337 no
dependen de terceros. El checkout tampoco integra SDKs, relays ni proveedores de
wallets: un pagador externo usa el provider EIP-1193 ya expuesto por su extensión
o por el navegador integrado de su propia wallet.

Una segunda revisión encontró que el primer reset A→B ocurría demasiado tarde,
el helper de secrets sólo generaba redundancia RPC para Base, el checksum
histórico no tenía una ruta de sustitución auditable y una guía todavía permitía
publicar con `wrangler deploy` directo. Esos cuatro huecos también están
corregidos localmente; producción continúa sin cambios.

## Evidencia comprobada

| Gate | Resultado al corte |
|---|---|
| App Worker | `https://server.parmelia.workers.dev`; boundary v2, modo `payments`, sync activo y health `ok`. |
| Payments Worker | `https://gatopago-payments-api.parmelia.workers.dev`; bootstrap inactivo, health `ready` y `dataCutover=verified`. |
| App D1 | `parmeliadb`; conserva cuenta, autenticación, actividad y CCTP personal. |
| Payments D1 | `gatopago-payments`, UUID `f0daaeb3-8df0-44d3-8b1f-a2f37461d50e`; remotamente siguen aplicadas `0001`–`0005`. La `0006_checkout_attempt_access.sql` sólo existe localmente. |
| Colas Payments | `gatopago-payment-jobs` y `gatopago-payment-jobs-dlq` creadas. Las colas App existentes se conservaron. |
| Migraciones App | `0030`–`0034` aplicadas. |
| Dead letter App | La única fila `activity.payment_received` se reencoló condicionalmente y terminó `delivered`; quedan 0 dead y 0 trabajos activos. |
| Backup/restore | Dos exports App cifrados con AES-256-GCM y clave protegida por DPAPI; ambos se restauraron en aislamiento antes del corte. |
| Snapshot del corte | 4 merchants, 21 links y 21 intents; checksum `ffb10c840313390517ec88afe2590385f73bd4b7e500670340a9c979aac30bb9`. La auditoría determinó que ese checksum cubría listas de IDs, no todas las columnas, por lo que no prueba integridad semántica retroactiva. |
| Ownership CCTP | 7 operaciones personales permanecen en App; 0 se importaron a Payments. |
| Import | Data-only ejecutado una vez; control versión 1, igualdad del checksum histórico, `quick_check=ok` y 0 errores FK. El import histórico también etiquetó ciphertext de webhook como `legacy-cutover` aunque el keyring remoto usa `2026_08_phase2_1`; no se reetiqueta ni se altera esa D1. El candidato local genera manifest v4/checksum semántico v2, formato webhook `enc:v2` compatible y exige un nuevo target vacío. |
| Sync posterior | 7 comandos de cuenta drenados; 0 outbox activos/fallidos. Payments contiene 7 merchants después del sync. |
| Smoke Payments | Checkout migrado directo y por proxy App resuelven el mismo link/intent; una quote local de test se creó sólo en Payments. |
| Único escritor | App D1 no tiene tabla `payment_quotes`; Payments D1 contiene la quote posterior al corte. |
| Política económica | `free-default`, 0 bps. `PAYMENT_LIVE_ENABLED=false`; testnet habilitado. |
| Contratos | No se desplegó ni redeployó ningún contrato en esta ventana; se conservaron los routers testnet existentes. |
| Gate local del candidato corregido | `pnpm verify:all` terminó con exit 0 el 26-08-2026: App 253+22, Payments 51+19, Playwright 30/10, audit sin vulnerabilidades conocidas, split/restore semántico y Foundry 191/4. Es evidencia local; no demuestra promoción ni estado remoto. |
| Forks públicos | 197 pruebas pasan, 0 fallan y 0 se omiten en el gate remoto con RPC de las tres testnets. |
| Preflight Cloudflare | `pnpm preflight:phase2:remote` termina con todos los checks `ready`. |
| Cliente Vercel | Producción `Ready`: `https://parmelia-chleumfsc-danelerrs-projects.vercel.app`, alias `https://app.parmelia.me`. |
| Dashboard Vercel | Producción `Ready`: `https://gatopago-dashboard-1mlxiqokh-danelerrs-projects.vercel.app`, alias `https://dashboard.parmelia.me`. |
| Preflight frontends del corte | Sólo comprobó proyecto, variables y alias; no detectó el redirect anónimo a Vercel SSO. El preflight local ya rechaza redirects fuera del dominio. |
| Checkout remoto actual | Funciona con una wallet EIP-1193 inyectada o con el navegador integrado de esa wallet. En un navegador sin provider muestra instrucciones para abrir allí el link; no se incorpora un proveedor externo de conexión. |
| Dashboard remoto actual | `https://dashboard.parmelia.me` responde `302` hacia Vercel SSO antes de llegar al login GatoPago; no está públicamente utilizable por comercios. |
| Gate remoto compuesto | `pnpm verify:remote-readonly` pasó 197/197 forks, Vercel y todos los gates Cloudflare. |

Los backups cifrados y sus manifests están fuera de OneDrive bajo
`%LOCALAPPDATA%\GatoPago\phase-2-1\backups`. Las claves generadas de Payments y
el token operativo están protegidos con DPAPI CurrentUser; no se creó ni
versionó un archivo plaintext de Payments durante el corte. Sí continúan
existiendo credenciales anteriores en archivos locales ignorados dentro del
checkout de OneDrive (`server/.dev.vars`, `contracts/.env` y caches Vercel), tal
como registra el
[`inventario canónico`](./worker-variables.md). Después de verificar import y
restore se eliminó el directorio temporal `cutover-work-20260825-171809` (6
archivos, incluidos los SQL/SQLite en claro); permanecen 2 backups `.enc`.

## Trabajo necesario para un nuevo cierre

El device login nuevo reemplazó la sesión CLI anterior; el token que apareció
accidentalmente en una salida ya estaba revocado. El helper quedó reproducible:
usa `--scope`, entrega valores por stdin, marca las variables `VITE_*` como
configuración pública y publica `dist/` en ambos proyectos.

Antes de una nueva promoción se debe: versionar y revisar el árbol exacto;
congelar App y rehacer el import hacia una D1 Payments nueva con manifest v4;
aplicar allí la migración `0006`; quitar Vercel SSO del dashboard o declararlo
explícitamente interno; configurar dos RPC independientes por chain; ejecutar
CI/E2E; desplegar Payments antes que los frontends; y repetir smokes anónimos y
adversariales. No se requiere ningún identificador, secret o cuenta de un
proveedor de wallets.

El candidato local exige firma del payer y capability por attempt, no filtra la
autorización de otro visitante, sólo persiste un hash tras verificar receipt,
emisor, router y evento, expira `submitted` sin evidencia y usa compare-and-set.
La identidad completa de la ruta remonta `PayPage`, por lo que A deja de existir
antes de que B responda, incluso si B termina en 404. Liveness/readiness usa un
último health RPC válido de hasta cinco minutos sin usarlo para autorizar dinero.
El helper de secrets prueba HTTPS, hostname y `eth_chainId` sobre dos proveedores
para cada chain antes de subir nada. El gate final registró App 253+22, Payments
51+19, Playwright 30/10, audit sin vulnerabilidades conocidas, D1 semántico y
Foundry 191/4. Todo permanece **pendiente de commit, CI y despliegue**.

El orden transaccional, los aborts y el rollback están en el
[runbook de cutover](../runbooks/payments-cutover.md).
La sustitución de la evidencia histórica se define separadamente en el
[reemplazo semántico](../runbooks/payments-semantic-recut.md).
