import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/recursive'
import './index.css'
import './lib/i18n'
import { initPwaInstall } from './lib/pwaInstall'
import App from './App.tsx'

// Capture the browser's one-shot install event before authenticated routes
// finish loading. Home can then trigger it from its own install control.
initPwaInstall()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PWA: register the app-shell service worker (production only so dev/HMR
// never fights a cache). Install is offered, never forced.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell is a nice-to-have, never blocking */
    })
  })
}
