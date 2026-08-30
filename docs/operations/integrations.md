# Integraciones - Runbook de configuración (Turnstile, login, correo, FCM, Analytics y Queues)

> Para cada integración: **Parte A** = pasos de consola; **Parte B** = secretos o
> variables que debe recibir el despliegue. La ausencia de una integración
> sensible degrada testnet y falla cerrado en mainnet.
>
> **Estado local verificado el 30-ago-2026:** la App de consumo usa Google y
> magic links nativos de Firebase. No usa Resend, SMTP, códigos de seis dígitos
> ni Cloudflare Email Service para autenticación. Turnstile, FCM, Analytics y
> Queues permanecen integrados. **Login con Apple está descartado.**
> Verificar que `VITE_FIREBASE_MEASUREMENT_ID` esté también en Vercel (no solo local).

---

## 1. Turnstile (anti-abuso en crear cuenta + faucet) - gratis

### Parte A - Consola de Cloudflare (~5 min)
1. Entra a https://dash.cloudflare.com → menú lateral **Turnstile** → **Add widget**.
2. Configura:
   - **Widget name:** `GatoPago`
   - **Hostnames:** `parmelia.me`, `www.parmelia.me` y `localhost` (para dev local).
   - **Widget mode:** **Managed** (invisible para humanos; desafía solo si sospecha - la mejor UX).
3. **Create** → te muestra dos valores:
   - **Site Key** (pública)
   - **Secret Key** (privada)

### Parte B - Qué entregar / configurar
```bash
# Secret en el worker (la pegas tú, nunca va al repo):
cd server && npx wrangler secret put TURNSTILE_SECRET_KEY

# Site key en el cliente:
#   client/.env            → VITE_TURNSTILE_SITE_KEY=<site key>
#   Vercel (env vars)      → VITE_TURNSTILE_SITE_KEY=<site key>
```
Me avisas "Turnstile listo" + me pasas la **site key** (la secret no - esa ya quedó en wrangler).

### Qué implemento yo después
- Cliente: widget de Turnstile en onboarding, faucet y solicitud de magic link; el token se renueva tras cada intento porque es de un solo uso.
- Server: verificación contra Siteverify. En testnet sin secret se permite desarrollo local; en mainnet la configuración incompleta falla cerrado.

---

## 2. Login por correo con magic link de Firebase

> El login de la App es Google o enlace de un solo uso. Firebase genera, envía
> y consume el enlace. GatoPago conserva Turnstile y rate limits en su Worker,
> pero no necesita contratar ni guardar credenciales de otro proveedor de correo.

### Parte A - Firebase
1. https://console.firebase.google.com → proyecto **proyecto-prueba-push-firebase**.
2. **Authentication → Sign-in method:** habilita Google y Email/Password con
   **Email link (passwordless sign-in)**. No hace falta permitir contraseñas.
3. **Authentication → Settings → Authorized domains:** verifica `app.parmelia.me`, `parmelia.me` y `localhost`.
4. **Authentication → Templates → Email address sign-in:** revisa nombre,
   idioma y remitente que Firebase permita configurar. El remitente efectivo es
   administrado por Firebase; no se agrega una API key de correo a GatoPago.
5. **Project settings → Service accounts:** conserva el JSON del Worker fuera
   del repo/OneDrive. Se usa para Admin API y recovery, no para enviar el link.

El 30-ago-2026 se verificó por API de configuración que Email está habilitado,
`passwordRequired=false`, Google está habilitado y `app.parmelia.me` pertenece a
los dominios autorizados. Un nuevo dominio como `app.gatopago.com` deberá
agregarse antes del cutover; comprarlo o alojar la SPA no lo autoriza solo.

### Parte B - Configuración del Worker

```powershell
cd server
pnpm exec wrangler secret put FIREBASE_SERVICE_ACCOUNT
pnpm exec wrangler secret put FIREBASE_WEB_API_KEY
pnpm exec wrangler secret put AUTH_CODE_PEPPER
```

`FIREBASE_SERVICE_ACCOUNT` es el JSON completo; `FIREBASE_WEB_API_KEY` es la
misma clave pública de la aplicación web, almacenada además en el Worker para
solicitar `EMAIL_SIGNIN`; `AUTH_CODE_PEPPER` debe ser aleatorio y tener al menos
32 caracteres, pues protege los challenges opacos de recovery. El navegador usa
la clave pública como `VITE_FIREBASE_API_KEY`; los otros dos valores nunca usan
prefijo `VITE_`.

La configuración pública versionada es:

`APP_URL=https://app.parmelia.me` es configuración pública versionada y debe ser
un origen HTTPS exacto también autorizado en Firebase. El comando
`node scripts/assert-app-remote-secrets.mjs` bloquea el deploy si falta alguno de
los tres nombres remotos; no lee ni imprime sus valores.

### Flujo implementado

1. El cliente resuelve Turnstile y llama `POST /auth/email-link/request`.
2. El Worker aplica quotas por IP/email/global y solicita `EMAIL_SIGNIN` al
   endpoint oficial `accounts:sendOobCode` de Firebase.
3. El cliente guarda localmente el correo, nunca lo incluye en la URL, y consume
   el link con `signInWithEmailLink`. Si lo abre en otro dispositivo, debe volver
   a escribir el correo.
4. Recovery solicita `/auth/step-up/email-link/request`. El link lleva sólo un
   challenge aleatorio; después de reautenticar, el Worker exige UID y
   `auth_time` recientes y lo canjea una vez por un proof limitado a recovery.

La tabla `auth_email_link_challenges` sólo conserva HMAC, UID, acción, TTL y
estado de consumo. La migración `0035_firebase_email_links.sql` invalida códigos
legacy activos al hacer el corte de la App. Las rutas numéricas se conservan de
forma temporal únicamente para el Dashboard/Business y no son parte del login
de consumo.

---

## 3. FCM - Push "Te pagaron" (Firebase Cloud Messaging)

### Parte A - Consola de Firebase (~5 min)
1. Firebase console → ⚙️ **Project settings → Cloud Messaging**.
2. Sección **Web configuration → Web Push certificates → Generate key pair** → copia la **clave VAPID** (pública).
3. ⚙️ **Project settings → Service accounts → Generate new private key** → descarga el JSON (contiene `client_email` y `private_key`). **Guárdalo seguro, no lo subas al repo.**
4. Verifica que la **Firebase Cloud Messaging API (V1)** esté habilitada (en proyectos actuales lo está por defecto; si no: link a Google Cloud Console que aparece ahí mismo).

### Parte B - Qué entregar / configurar
```bash
# El JSON del service account, minificado a UNA línea, como secret del worker:
cd server && npx wrangler secret put FCM_SERVICE_ACCOUNT
# (pega el JSON completo en una línea cuando lo pida)

# La clave VAPID en el cliente:
#   client/.env + Vercel → VITE_FIREBASE_VAPID_KEY=<vapid key>
```

### Qué implemento yo después
- **D1:** tabla `push_tokens` (migración 0004, una fila por dispositivo; `ON CONFLICT` mueve el token si el navegador inicia con otra cuenta). Multi-dispositivo real.
- **Cliente:** prompt de opt-in ("Activar avisos de pagos" - el permiso del navegador exige gesto del usuario), `getToken()` con la VAPID key sobre nuestro service worker existente, y registro del token en el server. Handler de `push` en `sw.js` que muestra la notificación y abre la app al tocarla.
- **Server:** `services/push.ts` - token OAuth2 firmado con el service account (con `jose`, ya en uso) → `POST fcm.googleapis.com/v1/.../messages:send`. `notifyUser` hace fan-out a todos los dispositivos del usuario y poda solo los tokens muertos (404). **Gatillos:** confirmación del pago/cobro interno, Address Activity o backfill bajo demanda (depósito externo) y el watcher dirigido por Custom Webhook ante `RecoveryProposed`. Fallos de push = silenciosos, jamás bloquean un pago.
- Nota iOS: en iPhone el push web **solo funciona con la PWA instalada** (limitación de Apple, iOS 16.4+). Android/desktop: funciona en el navegador normal.

---

## 4. Analytics - qué podemos hacer

**Recomendación: GA4 vía Firebase (gratis, 1 paso de consola).**
- **Tu parte:** Firebase console → ⚙️ Project settings → **Integrations → Google Analytics → Enable** (crea/vincula la propiedad GA4). Avísame cuando esté.
- **Mi parte:** `firebase/analytics` en el cliente + eventos del funnel: `sign_up`, `wallet_created`, `link_created`, `payment_sent`, `payment_received`, `swap_completed`, `invite_shared`. Con eso ves dónde se cae la gente (¿crean cuenta pero no cobran? ¿cotizan swap pero no confirman?).
- **Alternativa server-side** (después): Workers Analytics Engine para métricas de negocio (pagos/día, volumen) escritas desde el propio Worker - sin JS de tracking. Verificar disponibilidad en el plan antes de comprometerse.
- Lo que NO haría: meter un tercero más (Mixpanel/Amplitude) - GA4 cubre el 90% gratis y ya estamos en Firebase.

## 5. Queues - estado actual

El Worker ya declara `SCHEDULED_JOBS_QUEUE`, su DLQ y un Durable Object
particionado. Los requests registran primero el estado durable en D1; la Queue
despierta reconciliación, liquidación, webhooks, notificaciones y alertas de
seguridad. No se usa GitHub Actions como runtime: Actions sirve como CI efímero,
no ofrece latencia, disponibilidad ni semántica de reintento para tráfico de la app.

Antes de desplegar confirma que ambas queues existen y que el plan de Cloudflare
las admite. La ausencia de la infraestructura remota no queda probada por el
código local.

---

## Orden sugerido de ejecución

1. Aplicar todas las migraciones D1 hasta `0035_firebase_email_links.sql` antes
   de desplegar el App Worker que consulta la nueva tabla.
2. Validar Turnstile, `APP_URL`, Google, Email Link y los tres secretos ya
   existentes de Firebase/challenges. No crear una credencial de correo externa.
3. Validar FCM (VAPID + service account) y GA4 si se mantiene Analytics.
4. Confirmar Queue, DLQ y migraciones del Durable Object.
5. Ejecutar `pnpm verify:all`, el guard remoto, dry-run del Worker y pruebas
   reales de envío, recepción y consumo del magic link antes de producción.
