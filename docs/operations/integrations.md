# Integraciones - Runbook de configuración (Turnstile, login, correo, FCM, Analytics y Queues)

> Para cada integración: **Parte A** = pasos de consola; **Parte B** = secretos o
> variables que debe recibir el despliegue. La ausencia de una integración
> sensible degrada testnet y falla cerrado en mainnet.
>
> **Código del 24-ago-2026; verificar consola antes de operar:** Turnstile,
> acceso con código de 6 dígitos, FCM, Analytics, Queues y Email Sending están
> integrados. Este documento no confirma que sus credenciales remotas sigan
> vigentes. **Login con Apple está descartado.**
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
- Cliente: widget de Turnstile en onboarding, faucet y solicitud de código de acceso; el token se renueva tras cada intento porque es de un solo uso.
- Server: verificación contra Siteverify. En testnet sin secret se permite desarrollo local; en mainnet la configuración incompleta falla cerrado.

---

## 2. Login por correo con código de 6 dígitos

> El login es Google o código numérico. El correo nunca contiene un enlace de
> acceso y Firebase no genera el código: lo genera y valida el Worker.

### Parte A - Firebase y Cloudflare
1. https://console.firebase.google.com → proyecto **proyecto-prueba-push-firebase**.
2. **Authentication → Sign-in method:** habilita Google. No habilites acceso por enlace de correo.
3. **Authentication → Settings → Authorized domains:** verifica `app.parmelia.me`, `parmelia.me` y `localhost`.
4. **Project settings → Service accounts:** crea una cuenta de servicio dedicada al Worker y conserva el JSON fuera del repo/OneDrive.
5. En Cloudflare Email Sending valida el remitente `acceso@parmelia.me`; el binding `EMAIL` ya está declarado en `server/wrangler.jsonc`.

### Parte B - Configuración del Worker

```powershell
cd server
pnpm exec wrangler secret put FIREBASE_SERVICE_ACCOUNT
pnpm exec wrangler secret put FIREBASE_WEB_API_KEY
pnpm exec wrangler secret put AUTH_CODE_PEPPER
```

`FIREBASE_SERVICE_ACCOUNT` es el JSON completo; `FIREBASE_WEB_API_KEY` es la
clave pública usada para canjear el Custom Token; `AUTH_CODE_PEPPER` debe ser un
valor aleatorio de al menos 32 caracteres. No los prefijes con `VITE_`.

### Flujo implementado

1. El cliente resuelve Turnstile y llama `POST /auth/email-code/request`.
2. El Worker genera seis dígitos con Web Crypto, persiste solo HMAC + TTL + intentos y envía el correo mediante el binding `EMAIL`.
3. `POST /auth/email-code/verify` consume el código atómicamente y devuelve un Firebase Custom Token.
4. El cliente llama `signInWithCustomToken`; desde ahí usa el mismo Firebase ID token que el login Google.

Los códigos expiran en 10 minutos, tienen cinco intentos totales y son de un
solo uso. Recovery exige otro código ligado al UID y entrega un proof distinto,
también de un solo uso; nunca se acepta un correo elegido por el cliente.

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

1. Aplicar todas las migraciones D1 hasta `0032_recovery_step_up.sql`.
2. Validar Turnstile, Email Sending y los tres secretos de Firebase/OTP.
3. Validar FCM (VAPID + service account) y GA4 si se mantiene Analytics.
4. Confirmar Queue, DLQ y migraciones del Durable Object.
5. Ejecutar `pnpm verify:all`, dry-run del Worker y pruebas reales en preview antes de producción.
