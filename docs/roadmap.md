# Roadmap técnico de GatoPago

**Última revisión:** 26 de agosto de 2026
**Estado:** Fase 2.1 físicamente promovida, reabierta por auditoría; remediación local pendiente de commit y despliegue
**Fuente inicial:** [auditoría técnica del 23 de agosto de 2026](./audits/2026-08-23.md)

Este archivo es la única lista de trabajo técnico. Un cambio local no demuestra que producción esté corregida: los puntos marcados como **local** todavía requieren commit, ejecución remota de CI y despliegue autorizado antes de validarse en los dominios reales.

## P0 — Requiere acción operativa antes del despliegue

- [ ] **Cerrar la auditoría posterior a Fase 2.1.** El candidato local exige
  prueba de wallet y capability por attempt; valida receipt/emisor/router/evento
  antes de persistir un hash; aplica CAS y expiración de `submitted`; no filtra
  autorizaciones activas; usa checksum semántico; reinicia checkout A→B; separa
  liveness/readiness con último health válido; y exige dos hosts RPC por chain.
  La segunda revisión endureció A→B mediante remount por identidad completa,
  corrigió los seis RPC del helper y eliminó el bypass documental del guard.
  Todavía faltan verificación integral del último delta, commit, CI, migración
  `0006`, despliegue y smoke remoto.
- [ ] **Rehacer el corte con evidencia semántica.** El checksum del target
  histórico sólo cubría IDs y sus webhooks importados usan un key ID incompatible.
  No se actualiza el control in-place: congelar/drainar App, conservar ambos
  targets, crear otra D1 vacía, importar el manifest v4/checksum v2, exportar y
  verificar semánticamente el target antes de activar. Seguir el
  [runbook dedicado](./runbooks/payments-semantic-recut.md).
- [ ] **Hacer públicos los frontends que son públicos.** Dashboard sigue detrás
  de Vercel SSO. El preflight local ahora sigue redirects manualmente y lo
  rechazará. Quitar esa protección o declarar el dashboard interno antes de
  prometer acceso B2B.
- [ ] **Versionar la fuente desplegable.** Los nuevos guards de Workers y Vercel
  rechazan archivos relevantes dirty/untracked, HEAD sin upstream o HEAD distinto
  del commit publicado. El árbol actual todavía está sin commit, por lo que un
  deploy se bloquea deliberadamente.

- [x] **Cerrar el componente local de Fase 3 antes de cualquier promoción.** El alcance y
  los criterios de aceptación canónicos están en [Fase 3 del plan de checkout
  universal](./design/universal-checkout-multichain.md#fase-3-hardening): contrato
  Queue/Wrangler, recovery y nonces CCTP, contabilidad del monto acuñado,
  leases/firmas/rotación de webhooks, idempotencia concurrente, bootstrap/cutover
  fail-closed, checkout público y documentación operativa coherente. El gate
  integral local, el split/restore D1 y los E2E pasan; esto cierra sólo el código
  y el ensayo local, no la promoción remota ni readiness de mainnet.
- [ ] **Secretos locales (externo).** Seguir el
  [inventario canónico](./operations/worker-variables.md): sacar credenciales
  operativas de OneDrive, eliminar los OIDC locales después de su expiración,
  revocar/rotar la API key de Etherscan expuesta el 25-08-2026, confirmar la
  revocación del service account Firebase histórico y conservar únicamente
  archivos `.example` sin valores. Ninguna rotación remota forma parte del
  cambio documental local.
- [x] **`user_event_outbox_dead` (producción).** El 25-08-2026 la única fila
  `activity.payment_received` con 12 intentos y causa
  `TERMINAL_PUSH_NOT_CONFIGURED` se reencoló condicionalmente. El Worker la
  entregó de forma válida a cero dispositivos; quedan 0 dead, 0 activos y
  `/health=ok`.
- [x] **Infraestructura de autenticación de seis dígitos activada.** Las
  migraciones `0030_email_otp.sql`, `0031_webauthn_registration.sql` y
  `0032_recovery_step_up.sql` están aplicadas en producción; el binding y los
  nombres de secrets requeridos están presentes. El smoke de recepción de OTP y
  sesión en navegador real sigue abierto dentro de “Flujos reales autenticados”.
- [x] **Promover la frontera App/Payments (Cloudflare).** El 25-08-2026 se
  crearon D1/Queue/DLQ Payments, se aplicaron migraciones, se cifró y restauró el
  backup App, se congeló y drenó el escritor anterior, se importó data-only una
  vez y se fijó el checksum
  `ffb10c840313390517ec88afe2590385f73bd4b7e500670340a9c979aac30bb9`.
  Payments se activó antes de cambiar App a `payments`; los outbox de sync están
  drenados, ambos health están verdes y los smokes directo/proxy pasan. App y
  Payments son ahora D1/Queues físicamente independientes con un solo escritor.
- [x] **Promoción física histórica de frontends (Vercel).** `parmelia` quedó `Ready` en
  `app.parmelia.me`; se creó y vinculó `gatopago-dashboard`, quedó `Ready` en
  `dashboard.parmelia.me`, y variables/aliases pasan el preflight remoto. Los
  dos dominios se comprobaron durante el corte. La auditoría posterior demostró
  que ese preflight no verificaba acceso anónimo: Dashboard redirige a Vercel
  SSO. El checkout sólo admite el provider EIP-1193 ya inyectado por una extensión
  o por el navegador integrado de la wallet, decisión deliberada que no se
  resolverá incorporando un proveedor externo. Este check histórico no cierra
  la funcionalidad pública.
- [ ] **Decidir preparación contractual para fees CCTP.** El lanzamiento gratuito funciona con los routers Base/Fuji actuales (cap inmutable `0`). Solo si negocio quiere conservar la opción de una fee positiva, redeployar ambos con cap `100`, verificar, smokear y actualizar manifests/registry antes de cualquier policy. No activar una regla global como primer canary.

## P1 — Implementado localmente

- [x] **Código de seis dígitos, sin enlaces de acceso.** El Worker genera y verifica OTP de un solo uso, entrega un Firebase Custom Token y el cliente inicia sesión con `signInWithCustomToken`. Los códigos se almacenan con hash, caducidad, límite de intentos y consumo atómico; Turnstile protege solicitud y verificación.
- [x] **CI reproducible en Node 24/Linux.** Node 24, pnpm congelado, Foundry, verificación integral, E2E y scanners están versionados; las Actions usan commits inmutables. Falta la primera ejecución remota porque aún no se ha hecho commit ni push.
- [x] **Cabeceras y health separado.** CSP y cabeceras defensivas están declaradas; `/health/live` es mínimo, `/health` expone solo estado agregado y `/health/ops` requiere el token operativo. Falta validar las respuestas del dominio real tras el deploy.
- [x] **Caché y service worker.** Chunks con hash son inmutables; HTML/manifest/SW se revalidan; las escrituras de Cache Storage se esperan y las rutas de Firebase Auth no se interceptan. El gate automatizado cubre instalación, fetch, invalidación y notificaciones.
- [x] **PWA y formulario de perfil.** La PWA usa únicamente la cara original de Meli en PNG, expone instalación desde navegador y conserva instrucciones para iOS. El perfil memoiza el modelo inicial para que nombre y red social no se reinicien durante la escritura; el selector de red usa estado controlado estable.
- [x] **Passkeys y recovery endurecidos.** Registro y verificación son server-bound con `@simplewebauthn/server`; las credenciales se pueden listar, renombrar y revocar. Recovery exige step-up, no consume el desafío en el preflight y lo consume atómicamente al proponer la recuperación.
- [x] **Economía extensible sin cambiar la política gratuita.** Payments usa `free-default` cuando no hay policy, reglas versionadas/acotadas con máximo 100 bps, snapshots inmutables, ledger separado de plataforma/red, desglose API/webhook/dashboard y preflight on-chain obligatorio antes de una comisión positiva.
- [x] **Paymaster reemplazable sin migrar cuentas.** App abstrae Parmelia, ERC-7677 y self-funded; todo fallback reconstruye/reestima antes de la firma, mainnet fija el contrato externo esperado y D1/health conservan provider + dirección exacta para drenar rotaciones.
- [x] **Frontera Payments escalable promovida.** RPC App→Payments usa una única interfaz versionada compartida; health de App no consulta tablas de Payments; reintentos diferidos se compactan por partición en Durable Object con fallback Queue; el cutover descubre todas las migraciones, exige índices críticos y diez planes de consulta hot-path se validan automáticamente. La máquina de estados terminó en `cutover`, el checksum runtime coincide con el control D1 y la separación física por dominio está desplegada. No equivale a sharding horizontal ni sustituye pruebas de carga.
- [x] **Hardening 3A cerrado localmente.** Queue/Wrangler, bootstrap/sync, preflight,
  recuperación y nonces CCTP, monto realmente acuñado, webhooks at-least-once,
  rotación de claves e idempotencia concurrente tienen migraciones y pruebas de
  runtime. Esto no sustituye el simulacro ni el despliegue remoto de 3C.
- [x] **Checkout público 3B endurecido localmente.** El link consulta Payments
  directamente, acepta una wallet externa EIP-1193 sin login, mantiene saldo
  GatoPago como método opcional, simula, intenta EIP-2612 y cae a
  `approve + pay`, registra el source hash inmediatamente y reanuda el attempt
  tras refresh. El attempt requiere firma del payer y una capability aleatoria
  guardada sólo en `sessionStorage`; un hash reportado no se acepta hasta que el
  backend verifica receipt, sender, router y evento. No se carga un SDK o relay
  externo de conexión. El E2E local cubre teclado, wallet injected, fallback de permit,
  registro, caída HTTP, recarga, re-registro del mismo hash y reconciliación a
  `paid`; falta evidencia contra los Workers promovidos y las tres testnets
  desplegadas.
- [x] **Gates locales 3C revalidados después de la segunda auditoría.**
  `pnpm verify:all` pasa con 253+22 pruebas App, 51+19 Payments, 30 E2E
  aprobadas/10 omisiones de matriz, audit sin vulnerabilidades conocidas,
  split/restore semántico, 10 diagramas, OpenAPI, bundle, storage, coverage y
  191 pruebas Foundry finales aprobadas/4 forks omitidos sin RPC. Esto cierra
  sólo evidencia local, no commit ni promoción.
  La prueba adversarial A→B pasa en escritorio y móvil. El ensayo compuesto
  cubre bootstrap/sync, freeze y
  compatibilidad N/N-1, import data-only sobre base vacía, checksum, rechazo de
  replay y restores independientes. La evidencia remota histórica ejecutó 197
  pruebas sin omisiones, incluidas 6 forks vivas, pero corresponde al artefacto
  anterior a estas remediaciones. La D1 de reemplazo, la migración `0006`, los
  Workers y ambos frontends permanecen pendientes de promoción.

## P2 — Mantenibilidad y cobertura

- [x] **Reducir hotspots por dominio.** `storage.ts` bajó de 3.159 a menos de 1.000 líneas y delega ledger, merchants/webhooks, passkeys, cross-chain, leases, cursores, operaciones de cuenta y features de usuario. `indexer.ts` bajó de 1.664 a menos de 750 líneas al separar los tres watchers. `ScanQR.tsx` y `PayPage.tsx` quedaron por debajo de 700 líneas mediante extracción de lógica y vistas.
- [x] **Unificar lógica sensible.** Esquemas EIP-712 y autorizaciones de pago viven en `shared`; los fixtures de TypeScript/Solidity comprueban la misma codificación. Los watchers comparten ventanas, finality, journal, reorg guards y cursores; el outbox permanece en la misma transacción que el cambio de estado correspondiente.
- [x] **Eliminar código muerto y deuda de efectos React.** Knip y el gate de ciclos pasan; `react-hooks/set-state-in-effect` es error, no warning. Se retiraron dependencias, assets PWA y exports sin consumidores solo después de comprobar su uso.
- [ ] **Flujos reales autenticados (producción).** Localmente hay E2E para OTP, perfil, selector de red, PWA, accesibilidad y rutas principales. Aún falta evidencia contra cuentas, APIs y chains reales de envío, swap, cross-chain, webhooks y recovery después del despliegue; un build local no cubre este punto.

## P3 — Rendimiento, dependencias y mainnet

- [ ] **Core Web Vitals de producción.** `sileo` se eliminó, Analytics/Firebase Analytics se cargan de forma diferida y existen presupuestos gzip por chunk y por aplicación. Falta medir LCP, INP y CLS antes/después en producción con tráfico o sesiones representativas.
- [x] **Dependencias compatibles actualizadas.** El lockfile usa las versiones actuales compatibles con Node 24. Permanecen intencionalmente `@types/node` 24 (runtime Node 24) y TypeScript 6 (TypeScript 7 excede actualmente el peer soportado por `typescript-eslint`); se revisarán como migraciones separadas.
- [ ] **Gate de mainnet.** Siguen siendo obligatorios: cero `TODO_DEPLOY`, claves/roles segregados, KMS/MPC o arquitectura equivalente, direcciones verificadas, fork tests con RPC reales, simulacro de rollback y revisión externa independiente. No hay autorización para desplegar contratos ni promover configuración mainnet.

## Evidencia mínima para cerrar producción

1. Commit y push revisados; CI y security workflows verdes en GitHub.
2. Backup D1 cifrado y restore drill verificado antes de aplicar migraciones.
3. Migraciones App `0030`–`0034` y todas las migraciones Payments descubiertas
   en `payments-worker/migrations/` (actualmente `0001`–`0006`) aplicadas en su
   orden, con health operativo sin dead letters ni operaciones activas en
   contratos retirados.
4. Manifest v4/checksum semántico v2 sobre una D1 Payments nueva, seguido de
   export y `--verify-target-sql`; el checksum histórico no se modifica.
5. Deploy desde un commit publicado y limpio, target Payments antes de clientes,
   seguido de smoke autenticado y smoke anónimo sin redirect externo.
6. Validación de OTP recibido por email, Firebase Custom Token, perfil, red, passkeys, pagos y webhooks en el entorno desplegado.
7. Evidencia de CSP/caché/PWA y Core Web Vitals desde los dominios reales.

## Regla de actualización

Cada tarea cerrada debe registrar fecha, evidencia y entorno. Si un audit descubre trabajo adicional, se añade aquí; no se crea otro backlog paralelo ni se confunde una prueba local con validación de producción.
