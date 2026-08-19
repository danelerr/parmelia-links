# Integraciones - Runbook de configuración (Turnstile, Login, FCM, Analytics, Queues)

> Para cada integración: **Parte A** = pasos de consola (los haces tú),
> **Parte B** = qué valores entregar, y con eso se implementa el código.
> Todo el código está hecho con feature-flags: sin la key configurada, la app
> sigue funcionando exactamente como hoy.
>
> **Estado (jun-2026):** Turnstile (1), Email link (2), FCM push (3) y Analytics
> GA4 (4) están **implementados y en vivo** (secrets/consola configurados; FCM
> verificado con depósitos externos desde MetaMask). **Login con Apple: descartado
> por decisión** (no se integrará). Queues (5) NO se implementó: requiere plan pago.
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
- Cliente: widget de Turnstile en **Onboarding** (antes de crear la cuenta) y en el **faucet** de Settings; el token viaja en el body.
- Server: verificación del token contra `https://challenges.cloudflare.com/turnstile/v0/siteverify` en `/account/create` y `/account/fund`. Sin `TURNSTILE_SECRET_KEY` configurada → se omite (dev sigue fluido).

---

## 2. Login con Email (magic link) - Firebase Auth, cero cambios de server

> **Apple: descartado por decisión** (no se integrará). El código de Apple se
> eliminó del cliente; el login es Google + magic link por correo.

### Parte A - Email link (~5 min, gratis)
1. https://console.firebase.google.com → proyecto **proyecto-prueba-push-firebase**.
2. **Authentication → Sign-in method → Add new provider → Email/Password** → habilítalo **y activa el toggle "Email link (passwordless sign-in)"** → Save.
3. **Authentication → Settings → Authorized domains:** verifica que estén `parmelia.me` y `localhost`.
4. **Authentication → Settings → User account linking:** selecciona **"Link accounts that use the same email"** (así Google y magic link del mismo correo = misma cuenta = misma wallet).
5. (Opcional, recomendado) **Authentication → Templates →** edita la plantilla del email: idioma **español**, nombre del remitente **GatoPago**.

### Parte B - Qué entregar
Solo el aviso: "Email link habilitado". No hay keys que pasarme - el cliente ya tiene la config de Firebase.

### Estado
- Login: botón **"Continuar con correo"** → input → `sendSignInLinkToEmail` → pantalla "Revisa tu correo"; al volver por el link, la app detecta `isSignInWithEmailLink` y completa la sesión. **Implementado.**
- Server: **cero cambios** (mismo JWT de Firebase).

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

## 5. Queues - qué podemos hacer

**Qué es el cambio:** hoy `/pay/submit` espera el recibo on-chain dentro del request (~1-3 s colgado). Con Queues: submit envía la tx, **encola** `{userOpHash, txHash}` y responde al instante; un consumer procesa el recibo, escribe el ledger y dispara el push; el cliente consulta `/pay/status/:userOpHash`. Implementa de una vez los items #15 y #16 del backlog (más resiliencia: si el Worker muere a mitad, la cola reintenta - escrituras ya idempotentes).

**Decisión previa (tuya):** requiere **Workers Paid ($5/mes)** en la cuenta de Cloudflare (dash → Workers & Pages → Plans). 

**Mi recomendación honesta:** no urge en testnet - el flujo síncrono actual funciona y el polling ya está tuneado para Arbitrum. Actívalo cuando (a) pases a mainnet con usuarios reales, o (b) implementemos FCM (push + cola se complementan perfecto: la cola garantiza que el "te pagaron" salga aunque el request original muera). Si decides pagar el plan, avísame y lo implemento junto con un `/pay/status` para el cliente.

---

## Orden sugerido de ejecución

1. **Turnstile** (5 min de consola, gratis) → me pasas site key → implemento.
2. **Email link** (5 min, gratis) → me avisas → implemento Login nuevo.
3. **FCM** (5 min de consola) → me pasas VAPID + secret configurado → implemento push.
4. **GA4** (1 clic) → implemento eventos.
5. **Queues** → decisión de plan; implementación cuando haya volumen o junto a FCM.
