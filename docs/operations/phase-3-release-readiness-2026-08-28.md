# Readiness de Fase 3: estado vigente

**Corte original:** 28 de agosto de 2026

**Actualización:** 30 de agosto de 2026

**Estado:** la promoción técnica de la App en Fase 3 está completa; login real y
UID común Google/Email Link, UX centralizada y Passkey Security v2 están
desplegados. `0036_passkey_security_metadata.sql`, sus 20 evidencias semánticas
y los bindings WebAuthn están activos. Una ceremonia WebAuthn real sigue siendo
aceptación interactiva del usuario: requiere su sesión, gesto y autenticador y
no fue simulada por el agente. El recovery/replay real pasa a ser un drill
deliberado de Fase 4, no un segundo paso automático del login.

**Política monetaria:** `PAYMENT_LIVE_ENABLED=false`; fees y mainnet apagados

## Decisión de alcance del 30 de agosto

La prioridad inmediata es la **App de consumo**. API merchant, Dashboard y
Business continúan después. Esta iteración no cambia contratos, Payments Worker,
Dashboard, datos merchant ni la política de comisiones.

La App conserva dos formas de identidad:

1. Google mediante Firebase Auth.
2. Magic link nativo de Firebase mediante Email Link.

No se usa Resend, SMTP, Cloudflare Email Service ni un código de seis dígitos en
el login de consumo. Firebase genera, entrega y consume el enlace. La App Worker
sólo aplica Turnstile/rate limits y solicita `EMAIL_SIGNIN` al endpoint oficial
de Firebase.

## Estado de Firebase comprobado

La configuración remota se leyó sin modificarla:

- proyecto `proyecto-prueba-push-firebase`;
- Google habilitado;
- Email habilitado con `passwordRequired=false`, que permite passwordless Email
  Link sin exigir contraseñas;
- `app.parmelia.me`, `parmelia.me`, los dominios Firebase y `localhost` en la
  allowlist autorizada;
- MFA deshabilitado.

`app.gatopago.com` todavía no forma parte de este corte. Antes de migrar el
dominio deberá agregarse a Firebase y reflejarse en `APP_URL`, CORS, Vercel y
Turnstile. Comprar o gestionar el dominio en Cloudflare no mueve el frontend:
Vercel puede seguir alojándolo mediante registros DNS.

## Implementación promovida

- `/auth/email-link/request` valida Turnstile, aplica cuotas por IP/email/global
  y llama `accounts:sendOobCode` con `EMAIL_SIGNIN`.
- El navegador usa `signInWithEmailLink`; guarda el correo localmente, pero
  nunca lo coloca en la URL. En otro dispositivo solicita que se vuelva a
  escribir.
- Firebase Auth elige persistencia local y resolver de redirect dentro de
  `initializeAuth`, antes de iniciar cualquier recuperación. El gate de frontend
  prohíbe volver a `getAuth` seguido de `setPersistence`, carrera que podía cerrar
  IndexedDB durante el teardown o la recuperación de sesión.
- React Strict Mode no puede consumir dos veces el mismo link: el completion se
  deduplica por propósito, URL y correo. Si Firebase devuelve un error transitorio,
  la entrada rechazada se elimina y el mismo enlace todavía no consumido puede
  reintentarse.
- Recovery solicita un magic link separado con un challenge aleatorio de 256
  bits. El canje exige el mismo Firebase UID y un `auth_time` posterior a la
  emisión; después crea una prueba de step-up acotada y consumible una vez.
- El login normal no ofrece ni inicia recovery. Las operaciones monetarias sin
  llave utilizable y Home sin llave registrada enlazan a
  `Configuración → Seguridad`, único hub de llaves y recuperación.
- Un link de recovery consumido sólo confirma identidad y deja la prueba en
  memoria de sesión. WebAuthn y las mutaciones de recovery esperan un nuevo gesto
  explícito; abrir el correo no crea una llave ni modifica la cuenta.
- La migración `0035_firebase_email_links.sql` crea el registro STRICT de
  challenges e invalida códigos legacy activos al efectuar el cutover.
- Las rutas OTP legacy permanecen temporalmente sólo para Dashboard/Business.
  No son llamadas por la App y se retirarán cuando ese producto tenga su propia
  decisión de autenticación.
- El envío opcional de alertas por el binding `EMAIL` ya no bloquea el outbox:
  FCM continúa aunque esa alerta falle.
- Passkey Security v2 fija un RP ID explícito y una allowlist WebAuthn propia;
  persiste metadata informativa de la ceremonia; expone opciones integradas y
  de llave física; y sólo usa Signal API cuando D1 coincide uno a uno con todos
  los signers onchain. Su diseño y orden de publicación están en
  [`passkey-security-v2.md`](../design/passkey-security-v2.md).

## Secrets y proveedores

No hay ningún Secret nuevo:

| Nombre existente | Uso en esta iteración |
|---|---|
| `FIREBASE_WEB_API_KEY` | Solicitar `EMAIL_SIGNIN` desde App Worker; es el mismo identificador público usado por la SPA |
| `FIREBASE_SERVICE_ACCOUNT` | Consultar por Admin API el correo verificado del UID durante recovery |
| `AUTH_CODE_PEPPER` | HMAC de challenges opacos y pruebas de recovery |
| `TURNSTILE_SECRET_KEY` | Verificar token, action y hostname antes de solicitar un link público |

`APP_URL=https://app.parmelia.me` es configuración pública versionada, no un
Secret. `AUTH_EMAIL_FROM` y el binding Cloudflare `EMAIL` son opcionales para
alertas/compatibilidad legacy y no forman parte del camino crítico de login.

Los nombres `AUTH_EMAIL_PROVIDER`, `AUTH_EMAIL_TIMEOUT_MS` y `RESEND_API_KEY`
fueron retirados de código, plantillas, typegen, guards y runbooks de la App. No
se debe crear una cuenta Resend, tocar SPF/DKIM ni mover DNS para este flujo.

## Evidencia local nueva

- Árbol local actual: `pnpm verify:all` terminó con exit `0` después del delta
  UX y Passkey Security v2.
- TypeScript de App Worker y runtime Worker: verde.
- App Worker: 265 unitarias y 26 de runtime aprobadas.
- Payments Worker, sin cambios funcionales en esta iteración: 52 unitarias y 23
  de runtime aprobadas.
- Unitarias dirigidas de hardening/correo legacy: 48/48.
- Runtime App Worker: 26/26, incluyendo solicitud Firebase, ruta HTTP pública,
  migración `0035`, canje único, rechazo de replay y prueba de que un Turnstile
  inválido no consume la cuota global ni la cuota de una dirección víctima.
- Cliente: build y lint verdes.
- Las pruebas móviles dirigidas de login y Seguridad pasaron después del cambio
  de inicialización Firebase, sin reproducir `Database is closing`; el contrato
  queda cubierto además por `check:frontend-deploy-config`.
- Playwright actual: 60 aprobadas y 40 omisiones deliberadas por
  proyecto/dispositivo. La selección App escritorio/móvil ejecutó 36 y omitió 2
  pruebas exclusivas del Dashboard en el corte previo; la matriz ampliada añade
  información/opciones de passkey, llave física, retorno same-origin, Signal API
  fail-closed y persistencia de diálogos ante mutaciones fallidas.
  El login de App en escritorio/móvil cubre solicitud de magic link, ausencia de
  input OTP, persistencia segura del correo, apertura cross-device, Turnstile con
  timeout/retry, forma realista del action link (`oobCode` fuera y estado dentro
  de `continueUrl`), reintento tras fallo transitorio y consumo real del protocolo
  SDK con endpoints Firebase simulados.
- Guard de deploy de App: verde y confirma que no requiere `RESEND_API_KEY`.
- Backup/restore D1 (60 tablas), split semántico, artefacto de release, storage
  layout, cobertura y límites de bundle: verdes.
- Foundry final: 191 pruebas aprobadas y 4 forks omitidos por no inyectar RPC en
  la corrida local; lint y límites de bytecode verdes.

La matriz integral demuestra la coherencia del candidato. La promoción y la
evidencia real se documentan a continuación por separado.

## Promoción App del 30 de agosto

- Fuente publicada: `b976acb8058bc2b45099016b322644e09b069495`.
- GitHub: 6/6 checks verdes (`Quality`, navegador/accesibilidad, Secret scan,
  Semgrep, Slither y CodeQL).
- Backup previo a `0035`:
  `parmeliadb-pre-0035-20260830-185759.sql.enc`, formato
  `GATOPAGO_D1_BACKUP_V1`, 59 tablas, `quick_check=ok`, 0 errores FK y manifest
  bajo `%LOCALAPPDATA%\\GatoPago\\phase-2-1\\backups`.
- `0035_firebase_email_links.sql` fue la única migración pendiente y quedó
  aplicada. La cola terminó vacía, sus dos índices y tabla STRICT existen,
  `quick_check=ok` y quedaron 0 códigos legacy activos.
- App Worker: `6e8ce042-c76a-4fe1-b5d5-e0efe6988547`, 100 % del tráfico,
  mensaje `phase3 app magic links b976acb`. Rollback previo:
  `196e4123-1b15-4503-a72d-5b67b896f9c8`.
- App Web: `parmelia-7t1eguai2-danelerrs-projects.vercel.app`, deployment
  `dpl_JAUzm9PNGE3EnkZ8foZfJcWY5ndT`, `READY` y alias
  `https://app.parmelia.me`. Rollback previo:
  `parmelia-jog4fr6u0-danelerrs-projects.vercel.app`.
- `preflight:phase3-app:remote --json` quedó `ready=true` a las
  `2026-08-30T19:08:31Z`, sin pendientes.
- El usuario consumió un magic link real y abrió una sesión App autenticada. La
  lectura administrativa de Firebase registró una única cuenta verificada con
  proveedores `google.com` y `password` bajo el mismo UID; sólo se conserva un
  hash redactado del identificador, nunca el UID ni el link.
- App health pasó 12/12 lecturas consecutivas con 0 warnings; App D1 registró 0
  dead letters, 0 trabajos activos y 0 operaciones de cuenta activas.
- Payments, Dashboard, contratos, DNS y secrets no fueron desplegados ni
  modificados; `PAYMENT_LIVE_ENABLED=false` permanece intacto.

## Delta UX y Passkey v2 promovidos

Después de observar la sesión real se retiró la redundancia entre login y
recovery:

- el login ya no muestra “perdiste tu llave” ni guarda una intención que redirija
  automáticamente a recovery;
- `Configuración → Seguridad` concentra llaves, respaldo y recuperación;
- pagar, enviar, swap, cross-chain y Earn comparten la misma guía accionable si
  WebAuthn no encuentra una llave utilizable;
- Home muestra el mismo camino cuando el modelo no contiene una llave registrada;
- consumir un magic link de recovery muestra la prueba confirmada, pero no abre
  el prompt del sistema ni inicia una operación hasta pulsar el CTA explícito.

El delta fue versionado y promovido junto con Passkey Security v2. No cambió
Payments, Dashboard, contratos, DNS, secrets ni la política monetaria.

## Promoción App Passkey Security v2 del 30 de agosto

- Candidato de seguridad: `e3b195c12c7b3855ad5c5fba5e193ef721738e44`;
  clasificación de AAGUID públicos: `96b44d4541cb011448be64323355e0a2bd31ecb6`;
  guard definitivo de despliegue: `246d967923f81eca910ff11dc6c138d16df5c891`.
- Los 6 checks GitHub del commit desplegable quedaron verdes: Quality,
  navegador/accesibilidad, Secret scan, Semgrep, Slither y CodeQL. La matriz
  local final pasó con 265+26 pruebas App Worker, 52+23 Payments, 60 Playwright
  aprobadas/40 omisiones deliberadas, audit sin CVE conocidas, restore D1 de 60
  tablas y 191 Foundry aprobadas/4 forks omitidos sin RPC local.
- Por instrucción explícita del usuario no se creó un segundo backup cifrado
  manual antes de `0036`. La migración fue aditiva y Wrangler registró el backup
  automático de D1; esta excepción se conserva aquí y no cambia la recomendación
  general del runbook.
- `0036_passkey_security_metadata.sql` quedó aplicada; no hay migraciones App
  pendientes. El guard remoto verificó 36 migraciones y 20 elementos semánticos
  del esquema, además de los 7 nombres de secrets requeridos sin leer valores.
- Un comando documentado con un separador extra hizo que el primer supuesto
  `dry-run` publicara la versión intermedia
  `5a7849e4-53f7-47f9-ab78-cb2b07a03fb9`. La fuente era el candidato correcto y
  estaba autorizada, pero se corrigió el entrypoint para rechazar esa sintaxis.
  El nuevo ensayo terminó con `--dry-run: exiting now` y demostró que el ID
  activo no cambió.
- App Worker definitivo:
  `a2ea1d70-0553-48fd-8501-201bfe7e5143`, 100 % del tráfico, mensaje
  `phase3 passkey-v2 246d967923f81eca910ff11dc6c138d16df5c891`.
  Rollback inmediato: `5a7849e4-53f7-47f9-ab78-cb2b07a03fb9`; baseline anterior
  a Passkey v2: `6e8ce042-c76a-4fe1-b5d5-e0efe6988547`.
- App Web definitiva:
  `parmelia-4ezj8lobg-danelerrs-projects.vercel.app`, deployment
  `dpl_9kr3Si4kjH57KndiMJWUCvcL9X5X`, `READY` y alias
  `https://app.parmelia.me`. Rollback anterior:
  `parmelia-7t1eguai2-danelerrs-projects.vercel.app` /
  `dpl_JAUzm9PNGE3EnkZ8foZfJcWY5ndT`.
- El preflight App-only quedó `ready=true` a
  `2026-08-30T23:15:14.550Z`, con 12 checks `ready`, cero pendientes y ninguna
  mutación o buzón real durante esa verificación.
- Tres lecturas inmediatas del health devolvieron `status=ok` e `issueCount=0`.
  La consulta D1 redactada confirmó 0 dead letters, 0 outbox App/Payments activos,
  0 operaciones de cuenta activas y 0 fallas de refresh/indexer/reorg.
- En Chromium limpio, producción mostró Google y Email Link sin errores propios.
  Turnstile no emitió token bajo automatización, pero a los 15 segundos presentó
  error visible y `Intentar de nuevo`; el retry reinició el widget. Los únicos
  errores de consola procedían del iframe de Turnstile.
- HTML y `sw.js` respondieron 200 y revalidan; los assets usan caché inmutable.
  El chunk productivo `Security-kytAM-xN.js` contiene selección de autenticador,
  Signal API y retorno same-origin. Computer Use no pudo conectarse al helper de
  Windows, por lo que no se atribuye una inspección autenticada de la sesión del
  usuario ni una ceremonia biométrica que no ocurrió.
- Payments, Dashboard, contratos, DNS y secrets no fueron desplegados ni
  modificados. `PAYMENT_LIVE_ENABLED=false` permanece intacto.

## Preflight remoto App-only

`pnpm preflight:phase3-app:remote --json` comprueba, sin mutar estado remoto ni
usar un buzón real, fuente publicable, nombres de secrets App, presencia de
`0035` y `0036`, health, acceso público, CSP necesaria para Google, ruta
desplegada, Vercel y Firebase. También descubre todas las versiones Worker con
tráfico y exige en cada una los valores públicos exactos de `PASSKEY_RP_ID` y
`PASSKEY_ALLOWED_ORIGINS`. Su guard estático es
`pnpm check:phase3-app-preflight`.

El 30-08, después de la promoción histórica de magic links, la versión anterior
del preflight quedó `ready`:
fuente publicada, nombres de secrets, `0035`, health App Worker, App pública,
CSP Google, ruta Email Link, Vercel y Firebase. El despliegue corrige la CSP
anterior que bloqueaba `https://apis.google.com`; el preflight rechaza una
regresión que vuelva a omitirla.

La versión endurecida previa al corte, ejecutada en modo read-only a
`2026-08-30T22:22:57Z`, refleja el estado vigente con `ready=false`,
`remoteMutationPerformed=false` y exactamente cuatro pendientes: fuente local
aún no publicada, `0036` no aplicada, su esquema semántico ausente y bindings
WebAuthn ausentes en la versión Worker activa
`6e8ce042-c76a-4fe1-b5d5-e0efe6988547`. El gate semántico comprueba 13 columnas,
6 restricciones y el índice parcial; pasó sobre una D1 temporal con toda la
cadena de migraciones. No es una regresión del corte de magic links: es el
bloqueo esperado que evita atribuir el candidato Passkey v2 a producción antes
de promoverlo completo.

Después del corte, el mismo preflight quedó `ready=true` a
`2026-08-30T23:15:14.550Z`: `0035`/`0036`, esquema Passkey v2, bindings exactos
en la única versión con tráfico, health, App pública, CSP, ruta Email Link,
Vercel y Firebase pasaron sin pendientes.

La evidencia histórica está en el
[runbook de magic links](../runbooks/phase-3-app-magic-link-cutover.md). La
promoción vigente de `0036` y Passkey v2 está en el
[runbook Passkey v2](../runbooks/phase-3-app-passkey-v2-cutover.md). El deploy web
dedicado rechaza fuente no publicada y no puede tocar Dashboard, Payments,
variables Vercel ni proyectos.

## Infraestructura de Fase 3 ya promovida

Se conservan como evidencia histórica:

- Payments permite attempts concurrentes y settlement CAS; `0007` está aplicada.
- Turnstile falla visiblemente y permite retry.
- Payments no comparte Promises RPC pendientes entre requests.
- Dashboard es público y no está detrás de Vercel SSO.
- Los dos Workers, las D1 separadas, Queues/DLQ, checksum semántico y smokes de
  frontera permanecen desplegados.
- Reown/WalletConnect siguen ausentes; checkout externo consume sólo un provider
  EIP-1193 que ya exista en el navegador.

Nada de esa evidencia autoriza `PAYMENT_LIVE_ENABLED=true` ni sustituye Fase 4.

## Gates de promoción y aceptación

1. [x] Versionar el árbol exacto y obtener CI/security verdes.
2. [x] Backup y restore drill de App D1; aplicar `0035` antes del nuevo Worker.
3. [x] Desplegar **sólo App Worker y App Web** desde esa versión.
4. [x] Verificar Turnstile, CSP Google, recepción/consumo real y UID único entre
   Google/Email Link.
5. [x] Versionar y promover el delta UX App. El bundle productivo contiene la
   guía única a Seguridad, el recovery explícito y retorno same-origin; la matriz
   de navegador cubre esos comportamientos sin mutaciones reales.
6. [x] Confirmar health/readiness, cero dead letters nuevas y rollback
   identificable.
7. [x] Aplicar sólo `0036`, obtener `app-passkey-schema-0036=ready`, desplegar el
   candidato Passkey v2 y obtener `app-webauthn-bindings=ready` sobre todas las
   versiones con tráfico. El usuario descartó expresamente el backup manual
   adicional y esa excepción está registrada arriba.
8. [ ] En Fase 4, ejecutar deliberadamente el drill recovery/replay completo y
   detenerse antes de una mutación onchain salvo autorización separada.
9. [ ] Aceptación manual: en una sesión autenticada, abrir Seguridad y completar
   al menos una ceremonia con el autenticador del usuario. Crear, renombrar o
   revocar una llave requiere autorización separada y gesto físico.

Los gates 5 y 7 cierran la promoción técnica de Fase 3. El gate 8 pertenece a
Fase 4 y no debe confundirse con esa promoción. El gate 9 no es trabajo remoto
del agente: es la aceptación WebAuthn real del usuario y no se declara ejecutada
hasta observar su autenticador.
