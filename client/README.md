# Client (Parmelia web app)

SPA de Parmelia: React 19 + TypeScript + Vite 7 + Tailwind v4. Es una PWA instalable. Ver `../ARCHITECTURE.md` para la arquitectura completa.

## Desarrollo

```txt
pnpm install
pnpm --filter client dev      # o: npm run dev
npm run build                 # tsc -b + vite build
```

## Variables de entorno

Copia `client/.env.example` a `client/.env` y complétalo (gitignored):

| Variable | Descripción |
| --- | --- |
| `VITE_FIREBASE_*` | Config de Firebase web (incluye `VITE_FIREBASE_MEASUREMENT_ID` para GA4) |
| `VITE_SERVER_URL` / `VITE_APP_URL` | URLs del backend / frontend |
| `VITE_CHAIN_KEY` | Red activa (`arbitrum-sepolia` / `arbitrum-one`) |
| `VITE_TURNSTILE_SITE_KEY` | Site key de Turnstile (pública) |
| `VITE_FIREBASE_VAPID_KEY` | VAPID pública para web push |
| `VITE_ENABLE_APPLE_LOGIN` | `"true"` para mostrar el botón de Apple |

## Notas

- El service worker (`public/sw.js`) se registra solo en producción (PWA shell + push FCM).
- Las páginas usan `React.lazy`; todo va envuelto en `ErrorBoundary`.
- Capas transversales en `src/lib/`: `api` (fetch tipado), `notify` (avisos), `firebase` (auth), `push`, `analytics`.
- Deploy: Vercel construye desde esta carpeta.
