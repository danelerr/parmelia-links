# Readiness de Fase 3: estado vigente

**Corte original:** 28 de agosto de 2026

**Actualización:** 30 de agosto de 2026

**Estado:** la infraestructura de Fase 3 está promovida; la nueva iteración de
autenticación de la App está verificada localmente y aún no está desplegada

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

## Implementación local actual

- `/auth/email-link/request` valida Turnstile, aplica cuotas por IP/email/global
  y llama `accounts:sendOobCode` con `EMAIL_SIGNIN`.
- El navegador usa `signInWithEmailLink`; guarda el correo localmente, pero
  nunca lo coloca en la URL. En otro dispositivo solicita que se vuelva a
  escribir.
- React Strict Mode no puede consumir dos veces el mismo link: el completion se
  deduplica por propósito, URL y correo. Si Firebase devuelve un error transitorio,
  la entrada rechazada se elimina y el mismo enlace todavía no consumido puede
  reintentarse.
- Recovery solicita un magic link separado con un challenge aleatorio de 256
  bits. El canje exige el mismo Firebase UID y un `auth_time` posterior a la
  emisión; después crea una prueba de step-up acotada y consumible una vez.
- La migración `0035_firebase_email_links.sql` crea el registro STRICT de
  challenges e invalida códigos legacy activos al efectuar el cutover.
- Las rutas OTP legacy permanecen temporalmente sólo para Dashboard/Business.
  No son llamadas por la App y se retirarán cuando ese producto tenga su propia
  decisión de autenticación.
- El envío opcional de alertas por el binding `EMAIL` ya no bloquea el outbox:
  FCM continúa aunque esa alerta falle.

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

- `pnpm verify:all`: exit `0` sobre el árbol final del 30-08.
- TypeScript de App Worker y runtime Worker: verde.
- App Worker: 260 unitarias y 26 de runtime aprobadas.
- Payments Worker, sin cambios funcionales en esta iteración: 52 unitarias y 23
  de runtime aprobadas.
- Unitarias dirigidas de hardening/correo legacy: 48/48.
- Runtime App Worker: 26/26, incluyendo solicitud Firebase, ruta HTTP pública,
  migración `0035`, canje único, rechazo de replay y prueba de que un Turnstile
  inválido no consume la cuota global ni la cuota de una dirección víctima.
- Cliente: build y lint verdes.
- Playwright: 46 aprobadas y 26 omisiones deliberadas por proyecto/dispositivo.
  El login de App en escritorio/móvil cubre solicitud de magic link, ausencia de
  input OTP, persistencia segura del correo, apertura cross-device, Turnstile con
  timeout/retry, forma realista del action link (`oobCode` fuera y estado dentro
  de `continueUrl`), reintento tras fallo transitorio y consumo real del protocolo
  SDK con endpoints Firebase simulados.
- Guard de deploy de App: verde y confirma que no requiere `RESEND_API_KEY`.
- Backup/restore D1, split semántico, artefacto de release, storage layout,
  cobertura y límites de bundle: verdes.
- Foundry final: 191 pruebas aprobadas y 4 forks omitidos por no inyectar RPC en
  la corrida local; lint y límites de bytecode verdes.

La matriz integral demuestra la coherencia del candidato local. No demuestra que
un email real llegó ni que la versión desplegada cambió.

## Preflight remoto App-only

`pnpm preflight:phase3-app:remote --json` comprueba, sin mutar estado remoto ni
usar un buzón real, fuente publicable, nombres de secrets App, presencia de
`0035`, health, acceso público, CSP necesaria para Google, ruta desplegada,
Vercel y Firebase. Su guard estático es `pnpm check:phase3-app-preflight`.

El 30-08 el resultado fue el esperado para el candidato todavía local:

- listos: nombres de secrets, health App Worker, App pública, configuración
  Vercel y Firebase Google/passwordless;
- pendientes: `published-source`, `app-migration-0035`,
  `app-google-auth-csp` y `deployed-email-link-route`.

El smoke anónimo con navegador real confirmó por qué la CSP es un gate: el
deployment vigente bloquea `https://apis.google.com` y Firebase no puede abrir
el popup de Google. La fuente local ya permite ese origen y el preflight ahora
rechaza automáticamente una publicación que vuelva a omitirlo.

La secuencia autorizable y el rollback están en el
[runbook App-only](../runbooks/phase-3-app-magic-link-cutover.md). El deploy web
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

## Gates abiertos antes de declarar la App 100 % cerrada

1. Versionar el árbol exacto y obtener CI/security verdes.
2. Backup y restore drill de App D1; aplicar `0035` antes del nuevo Worker.
3. Desplegar **sólo App Worker y App Web** desde esa versión. No desplegar
   Payments, Dashboard ni contratos en esta iteración.
4. Verificar producción anónima: Google sin error CSP, Turnstile, solicitud del
   link, recepción en un buzón expresamente autorizado, consumo y mismo Firebase
   UID al alternar Google/Email Link.
5. Probar recovery real: solicitud, reautenticación, canje del challenge y
   rechazo de replay; las operaciones monetarias/onchain continúan en Fase 4.
6. Confirmar health/readiness, cero dead letters nuevas y rollback practicable.

Hasta completar esos gates, la frase correcta es: **candidato local de App
verificado; producción todavía ejecuta la autenticación anterior**.
