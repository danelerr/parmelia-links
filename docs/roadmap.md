# Roadmap técnico de GatoPago

**Última revisión:** 30 de agosto de 2026
**Estado:** Fase 3 App promovida; Google + Email Link, UX de llaves y Passkey Security v2 activos; aceptación WebAuthn manual y Fase 4 transaccional pendientes; API/Business continúan después
**Fuente inicial:** [auditoría técnica del 23 de agosto de 2026](./audits/2026-08-23.md)

Este archivo es la única lista de trabajo técnico. El corte de Fase 2.1 está en el
[registro del 26-08-2026](./operations/phase-2-1-live-readiness-2026-08-26.md) y
la promoción correctiva actual en el
[registro de Fase 3 del 28-08-2026](./operations/phase-3-release-readiness-2026-08-28.md).
Un testnet desplegado y sano no demuestra readiness de mainnet ni sustituye un
pago E2E con evidencia on-chain.

## P0 — Requiere acción operativa antes del despliegue

- [x] **Cerrar la promoción técnica de la App de consumo.** La
  infraestructura de la tercera revisión ya eliminó el lock global de attempts,
  endureció Turnstile y retiró Promises RPC globales; permanece desplegada con
  `PAYMENT_LIVE_ENABLED=false`. El 30-08 el alcance cambió: primero se cierra la
  App y API/Business/Dashboard continúan después. El candidato local reemplaza
  OTP por magic links nativos de Firebase, no usa Resend ni otro proveedor de
  correo y añade `0035_firebase_email_links.sql` para recovery de un solo uso.
  La matriz integral `pnpm verify:all` pasó sobre el árbol final. El commit
  `b976acb` tiene 6/6 checks verdes; backup/restore, `0035`, App Worker y App Web
  quedaron promovidos. Un enlace real abrió sesión y Firebase confirma una sola
  identidad verificada con Google y Email Link. El candidato inicializa Firebase
  Auth con persistencia local y resolver de redirect en una sola operación; el
  gate de frontend impide reintroducir la carrera `getAuth`/`setPersistence` que
  podía cerrar IndexedDB durante la recuperación de sesión. La UX de llaves y
  Passkey Security v2 fueron versionados, `0036` fue aplicada y App Worker/App
  Web quedaron promovidos desde `246d967`; el preflight remoto tiene 12/12
  checks listos. Sus ceremonias reales requieren autorización específica y gesto
  del usuario. Recovery/replay queda como drill de Fase 4,
  deteniéndose antes de proponer onchain. El smoke adversarial remoto de Payments conserva
  su evidencia histórica y no necesita repetirse para este cambio de App. El
  preflight `preflight:phase3-app:remote` ya delimita el estado sin mutar nada.
  El [runbook histórico de magic links](./runbooks/phase-3-app-magic-link-cutover.md)
  conserva el corte de `0035`; el
  [runbook Passkey v2](./runbooks/phase-3-app-passkey-v2-cutover.md) impide tocar
  Dashboard, Payments, DNS o secrets durante la promoción vigente.
- [x] **Cerrar la auditoría posterior a Fase 2.1.** El candidato exige
  prueba de wallet y capability por attempt; valida receipt/emisor/router/evento
  antes de persistir un hash; aplica CAS y expiración de `submitted`; no filtra
  autorizaciones activas; usa checksum semántico; reinicia checkout A→B; separa
  liveness/readiness con último health válido; y exige dos hosts RPC por chain.
  La segunda revisión endureció A→B mediante remount por identidad completa,
  corrigió los seis RPC del helper y eliminó el bypass documental del guard.
  El 26-08-2026 se versionó y promovió: `0006` está aplicada, los Workers y
  frontends fueron desplegados y los smokes remoto/adversarial pasan.
- [x] **Rehacer el corte con evidencia semántica.** El checksum del target
  histórico sólo cubría IDs y sus webhooks importados usan un key ID incompatible.
  No se actualiza el control in-place: congelar/drainar App, conservar ambos
  targets, crear otra D1 vacía, importar el manifest v4/checksum v2, exportar y
  verificar semánticamente el target antes de activar. Seguir el
  [runbook dedicado](./runbooks/payments-semantic-recut.md). El target activo es
  `gatopago-payments-semantic-20260826`; la D1 histórica permanece intacta.
- [x] **Hacer públicos los frontends que son públicos.** Se desactivó Vercel SSO
  del dashboard y el preflight prueba una petición anónima sin aceptar redirects
  fuera del dominio. App y Dashboard muestran sus superficies GatoPago.
- [x] **Versionar la fuente desplegable.** Los guards de Workers y Vercel
  rechazan archivos relevantes dirty/untracked, HEAD sin upstream o HEAD distinto
  del commit publicado. El runtime promovido de Fase 3 corresponde al commit
  publicado `762c933`.

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
- [x] **Promover la autenticación passwordless de la App.** Las
  migraciones `0030_email_otp.sql`, `0031_webauthn_registration.sql` y
  `0032_recovery_step_up.sql` están aplicadas en producción. El candidato añade
  `0035_firebase_email_links.sql`, ya aplicada después del backup cifrado.
  Firebase tiene Google, Email Link y `app.parmelia.me` autorizados; App Worker y
  App Web están desplegados, el preflight remoto está verde y la recepción/
  consumo real abrió una sesión válida.
- [x] **Promover la frontera App/Payments (Cloudflare).** El primer corte del
  25-08-2026 se conservó como evidencia histórica. El 26-08-2026 se repitió sobre
  una D1 vacía con manifest v4/checksum semántico v2
  `5d3093e9b12288d7783832037b3bf06635591da1cf56df377ff4b4b6f3093a27`,
  migraciones `0001`–`0006`, export target verificado y D1 histórica intacta;
  el 28-08 se añadió `0007` sobre ese mismo target después de un backup cifrado
  y restore drill, sin rebaselinar el checksum histórico.
  App terminó en modo `payments`, sync drenado y ambos health/smokes verdes.
  Históricamente, el 25-08-2026 se
  crearon D1/Queue/DLQ Payments, se aplicaron migraciones, se cifró y restauró el
  backup App, se congeló y drenó el escritor anterior, se importó data-only una
  vez y se fijó el checksum
  `ffb10c840313390517ec88afe2590385f73bd4b7e500670340a9c979aac30bb9`.
  Payments se activó antes de cambiar App a `payments`; los outbox de sync están
  drenados, ambos health están verdes y los smokes directo/proxy pasan. App y
  Payments son ahora D1/Queues físicamente independientes con un solo escritor.
- [x] **Promoción física y acceso público de frontends (Vercel).** `parmelia` quedó `Ready` en
  `app.parmelia.me`; se creó y vinculó `gatopago-dashboard`, quedó `Ready` en
  `dashboard.parmelia.me`, y variables/aliases pasan el preflight remoto. Los
  dos dominios se comprobaron durante el corte. La auditoría posterior demostró
  que ese preflight no verificaba acceso anónimo; el 26-08-2026 se desactivó
  Vercel SSO, se redesplegaron ambos frontends y el preflight ya valida acceso
  anónimo real. El checkout sólo admite el provider EIP-1193 ya inyectado por una extensión
  o por el navegador integrado de la wallet, decisión deliberada que no se
  resolverá incorporando un proveedor externo. El smoke limpio confirma su
  fallback sin spinner y no existe Reown/WalletConnect en el código activo.
- [ ] **Decidir preparación contractual para fees CCTP.** El lanzamiento gratuito funciona con los routers Base/Fuji actuales (cap inmutable `0`). Solo si negocio quiere conservar la opción de una fee positiva, redeployar ambos con cap `100`, verificar, smokear y actualizar manifests/registry antes de cualquier policy. No activar una regla global como primer canary.

## P1 — Implementado localmente

- [x] **Magic links de Firebase implementados para la App.** Turnstile y cuotas protegen la solicitud; Firebase envía/consume el enlace, el correo no aparece en la URL y otro dispositivo debe confirmarlo. El login nunca inicia recovery ni crea una passkey. Recovery usa challenge opaco, UID + `auth_time` reciente y proof acotado de un solo uso sólo después de elegirlo explícitamente en `Configuración → Seguridad`. Las rutas OTP quedan sólo como compatibilidad temporal Business.
- [x] **UX de acceso a llaves centralizada y promovida.** Home sin llave registrada y los flujos pagar/enviar/swap/cross-chain/Earn sin llave utilizable muestran un único camino hacia `Configuración → Seguridad`. Consumir un link de recovery sólo confirma identidad y espera un CTA; no abre WebAuthn ni muta la cuenta automáticamente. El bundle productivo y la matriz de navegador verifican este contrato; la aceptación WebAuthn real requiere gesto del usuario.
- [x] **CI reproducible en Node 24/Linux.** Node 24, pnpm congelado, Foundry, verificación integral, E2E y scanners están versionados; las Actions usan commits inmutables y se ejecutan sobre cada HEAD publicado.
- [x] **Cabeceras y health separado.** CSP y cabeceras defensivas están declaradas; `/health/live` es mínimo, `/health` expone sólo estado agregado y `/health/ops` requiere el token operativo. Los health remotos pasan y Payments sostuvo 30/30 lecturas consecutivas tras el ajuste RPC/Multicall3.
- [x] **Caché y service worker.** Chunks con hash son inmutables; HTML/manifest/SW se revalidan; las escrituras de Cache Storage se esperan y las rutas de Firebase Auth no se interceptan. El gate automatizado cubre instalación, fetch, invalidación y notificaciones.
- [x] **PWA y formulario de perfil.** La PWA usa únicamente la cara original de Meli en PNG, expone instalación desde navegador y conserva instrucciones para iOS. El perfil memoiza el modelo inicial para que nombre y red social no se reinicien durante la escritura; el selector de red usa estado controlado estable.
- [x] **Passkeys y recovery endurecidos.** Registro y verificación son server-bound con `@simplewebauthn/server`; las credenciales se pueden listar, renombrar y revocar. Recovery exige step-up, no consume el desafío en el preflight y lo consume atómicamente al proponer la recuperación.
- [x] **Passkey Security v2 promovido.** El Worker fija RP ID y
  allowlist WebAuthn separados de CORS, cada UserOperation devuelve el RP ID,
  `0036` persiste AAGUID/BE/BS/tipo/proveedor sólo como metadata, la UI distingue
  incertidumbre y ofrece llave física bajo divulgación progresiva. Signal API
  recibe el inventario únicamente cuando D1 y signers onchain coinciden uno a
  uno; el retorno a una operación valida mismo origen. Está activo en App Worker
  `a2ea1d70-0553-48fd-8501-201bfe7e5143` y App Web
  `parmelia-4ezj8lobg-danelerrs-projects.vercel.app`.
- [x] **Gates de promoción Passkey v2 promovidos.** El deploy del
  Worker rechaza cambios accidentales de RP/orígenes y cualquier migración App
  local pendiente; además verifica 13 columnas, 6 restricciones y el índice
  parcial de `0036`. El preflight remoto comprueba `0035`, `0036`, ese esquema
  semántico y los bindings WebAuthn exactos en todas las versiones con tráfico.
- [x] **Economía extensible sin cambiar la política gratuita.** Payments usa `free-default` cuando no hay policy, reglas versionadas/acotadas con máximo 100 bps, snapshots inmutables, ledger separado de plataforma/red, desglose API/webhook/dashboard y preflight on-chain obligatorio antes de una comisión positiva.
- [x] **Paymaster reemplazable sin migrar cuentas.** App abstrae Parmelia, ERC-7677 y self-funded; todo fallback reconstruye/reestima antes de la firma, mainnet fija el contrato externo esperado y D1/health conservan provider + dirección exacta para drenar rotaciones.
- [x] **Frontera Payments escalable promovida.** RPC App→Payments usa una única interfaz versionada compartida; health de App no consulta tablas de Payments; reintentos diferidos se compactan por partición en Durable Object con fallback Queue; el cutover descubre todas las migraciones, exige índices críticos y once planes de consulta hot-path se validan automáticamente. La máquina de estados terminó en `cutover`, el checksum runtime coincide con el control D1 y la separación física por dominio está desplegada. No equivale a sharding horizontal ni sustituye pruebas de carga.
- [x] **Hardening 3A promovido.** Queue/Wrangler, bootstrap/sync, preflight,
  recuperación y nonces CCTP, monto realmente acuñado, webhooks at-least-once,
  rotación de claves e idempotencia concurrente tienen migraciones y pruebas de
  runtime. Los preflights Cloudflare y los smokes directo/proxy pasan sobre los
  Workers promovidos.
- [x] **Checkout público 3B endurecido y promovido.** El link consulta Payments
  directamente, acepta una wallet externa EIP-1193 sin login, mantiene saldo
  GatoPago como método opcional, simula, intenta EIP-2612 y cae a
  `approve + pay`, registra el source hash inmediatamente y reanuda el attempt
  tras refresh. El attempt requiere firma del payer y una capability aleatoria
  guardada sólo en `sessionStorage`; un hash reportado no se acepta hasta que el
  backend verifica receipt, sender, router y evento. No se carga un SDK o relay
  externo de conexión. El E2E local cubre teclado, wallet injected, fallback de permit,
  registro, caída HTTP, recarga, re-registro del mismo hash y reconciliación a
  `paid`. El smoke remoto A→B retuvo B y demostró 0 acciones disponibles mientras
  cargaba; el fallback sin provider también se verificó en Chromium limpio. La
  tercera revisión detectó que la firma aún tomaba un lock global; `0007` lo
  elimina y el delta ya está desplegado en Payments versión
  `9f65035e-4ba4-4b4e-bdac-54a21cff8f24`.
- [x] **Gates 3C revalidados y promovidos después de la tercera auditoría.**
  `pnpm verify` y `pnpm test:e2e` pasan en el delta local actual con 260+26
  pruebas App, 52+23 Payments y 52 E2E aprobadas/32 omisiones deliberadas de
  matriz, además de 11 diagramas, OpenAPI y límites de bundle. El candidato
  promovido anterior también pasó `verify:all`, audit sin vulnerabilidades
  conocidas, split/restore semántico, storage, coverage y 191 pruebas Foundry
  finales aprobadas/4 forks omitidos sin RPC. Esto conserva evidencia local
  reproducible; el gate remoto añade 197/197 Foundry con forks, preflights
  Vercel/Cloudflare y smokes de checkout.
  La prueba adversarial A→B pasa en escritorio y móvil. El ensayo compuesto
  cubre bootstrap/sync, freeze y
  compatibilidad N/N-1, import data-only sobre base vacía, checksum, rechazo de
  replay y restores independientes. La evidencia remota histórica ejecutó 197
  pruebas sin omisiones, incluidas 6 forks vivas. La D1 de reemplazo, la
  migración `0006`, los Workers y ambos frontends de aquel corte fueron
  promovidos. El 28-08 se repitió esa matriz sobre `762c933`, se aplicó `0007`,
  se desplegaron Payments/App y ambos frontends, y los preflights remotos pasaron.
  El smoke remoto controlado confirmó dos pagadores concurrentes, cancelación
  merchant sin monopolio y limpieza sin errores FK. Turnstile dejó de esperar
  indefinidamente en el Dashboard real. El nuevo flujo App de magic links pasa
  pruebas unitarias, runtime y navegador dirigidas y su guard confirma que no
  existe dependencia Resend. La matriz integral final pasó. El 30-08 se publicó
  `b976acb`, se respaldó App D1, se aplicó sólo `0035`, se desplegaron sólo App
  Worker/App Web y el preflight remoto quedó completamente verde. La CSP Google
  está corregida y el enlace real fue recibido/consumido bajo el mismo UID
  vinculado a Google. La observación real produjo el delta UX de llaves descrito
  arriba quedó publicado. `0036`, Worker/Web y el preflight de 12 checks están
  verdes; la consulta redactada confirma 0 dead letters y 0 trabajos activos.
  Recovery/replay real
  será un drill deliberado de Fase 4, junto con pagos testnet reales, evidencia
  monetaria completa y fault injection.

## P2 — Mantenibilidad y cobertura

- [x] **Reducir hotspots por dominio.** `storage.ts` bajó de 3.159 a menos de 1.000 líneas y delega ledger, merchants/webhooks, passkeys, cross-chain, leases, cursores, operaciones de cuenta y features de usuario. `indexer.ts` bajó de 1.664 a menos de 750 líneas al separar los tres watchers. `ScanQR.tsx` y `PayPage.tsx` quedaron por debajo de 700 líneas mediante extracción de lógica y vistas.
- [x] **Unificar lógica sensible.** Esquemas EIP-712 y autorizaciones de pago viven en `shared`; los fixtures de TypeScript/Solidity comprueban la misma codificación. Los watchers comparten ventanas, finality, journal, reorg guards y cursores; el outbox permanece en la misma transacción que el cambio de estado correspondiente.
- [x] **Eliminar código muerto y deuda de efectos React.** Knip y el gate de ciclos pasan; `react-hooks/set-state-in-effect` es error, no warning. Se retiraron dependencias, assets PWA y exports sin consumidores solo después de comprobar su uso.
- [ ] **Aceptación autenticada y Fase 4 (producción).** El magic link real ya fue recibido/consumido y comparte UID con Google; `0036` y la UX centralizada están promovidas. Falta que el usuario complete una ceremonia WebAuthn real bajo autorización específica. Recovery/replay deliberado, perfil, red, envío, swap, cross-chain y webhooks reales pertenecen a Fase 4 cuando requieran cuentas, APIs, chains u operaciones monetarias.
	- [ ] **Remediación Passkey v2.1:** el candidato elimina la falsa ausencia basada en `localStorage`, agrega comprobación WebAuthn firmada y anti-replay (`0037`), compatibilidad segura para retiro durante el rollout, limpieza de llaves reemplazadas por recovery y reparación del hint tras retiro. La ventana App-only está autorizada y en ejecución; sólo se cerrará después de migrar, publicar Worker/Web y verificar producción. La ceremonia comprobar/agregar/quitar/recuperar en iPhone requiere el gesto del usuario.
- [ ] **Migración de RP ID antes de cambiar el dominio App.** Google Auth no sincroniza passkeys: Google Password Manager/iCloud lo hacen según el dispositivo. El candidato ya evita derivar RP ID del host y conserva explícitamente `app.parmelia.me`, pero eso no migra credenciales. Antes de usar `app.gatopago.com` se necesita coexistencia, registro y firma con llaves nuevas, cobertura medible y rollback. DNS por sí solo no migra WebAuthn.

## P3 — Rendimiento, dependencias y mainnet

- [ ] **Core Web Vitals de producción.** `sileo` se eliminó, Analytics/Firebase Analytics se cargan de forma diferida y existen presupuestos gzip por chunk y por aplicación. Falta medir LCP, INP y CLS antes/después en producción con tráfico o sesiones representativas.
- [x] **Dependencias compatibles actualizadas.** El lockfile usa las versiones actuales compatibles con Node 24. Permanecen intencionalmente `@types/node` 24 (runtime Node 24) y TypeScript 6 (TypeScript 7 excede actualmente el peer soportado por `typescript-eslint`); se revisarán como migraciones separadas.
- [ ] **Gate de mainnet.** Siguen siendo obligatorios: cero `TODO_DEPLOY`, claves/roles segregados, KMS/MPC o arquitectura equivalente, direcciones verificadas, fork tests con RPC reales, simulacro de rollback y revisión externa independiente. No hay autorización para desplegar contratos ni promover configuración mainnet.

## Evidencia mínima para cerrar producción

1. Commit y push revisados; CI y security workflows verdes en GitHub.
2. Backup D1 cifrado y restore drill verificado antes de aplicar migraciones.
3. Migraciones App `0030`–`0036` y todas las migraciones Payments descubiertas
   en `payments-worker/migrations/` (actualmente `0001`–`0007`) aplicadas en su
   orden, con health operativo sin dead letters ni operaciones activas en
   contratos retirados.
4. Manifest v4/checksum semántico v2 sobre una D1 Payments nueva, seguido de
   export y `--verify-target-sql`; el checksum histórico no se modifica.
5. Deploy desde un commit publicado y limpio, target Payments antes de clientes,
   seguido de smoke autenticado y smoke anónimo sin redirect externo.
6. Validación de magic link recibido/consumido y mismo Firebase UID con Google;
   además, publicar y comprobar que el login no dispara recovery y que la falta
   de llave conduce a `Configuración → Seguridad`. Recovery deliberado, perfil,
   red, passkeys, pagos y webhooks reales continúan como evidencia de Fase 4
   cuando impliquen operaciones sensibles/monetarias/on-chain.
7. Evidencia de CSP/caché/PWA y Core Web Vitals desde los dominios reales.

## Regla de actualización

Cada tarea cerrada debe registrar fecha, evidencia y entorno. Si un audit descubre trabajo adicional, se añade aquí; no se crea otro backlog paralelo ni se confunde una prueba local con validación de producción.
