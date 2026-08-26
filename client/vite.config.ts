import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `client/` is also a standalone pnpm workspace for Vercel. During monorepo
  // development its dependencies resolve to the root store, so allow that
  // exact parent or Vite rejects font files and visual tests use fallbacks.
  server: {
    fs: { allow: [repositoryRoot] },
  },
  build: {
	manifest: true,
    rollupOptions: {
      output: {
        // Split Firebase Auth into its own chunk. It's the heaviest dependency
        // and almost never changes, so isolating it lets the browser keep it
        // cached across deploys of our own (frequently changing) app code.
		manualChunks(id) {
			if (id.includes("/firebase/analytics") || id.includes("/@firebase/analytics")) {
				return "firebase-analytics";
			}
			if (id.includes("/node_modules/firebase/") || id.includes("/node_modules/@firebase/")) {
				return "firebase";
			}
			if (
				id.includes("/node_modules/react/") ||
				id.includes("/node_modules/react-dom/") ||
				id.includes("/node_modules/react-router")
			) {
				return "react";
			}
			if (id.includes("/node_modules/i18next")) return "i18n";
			if (id.includes("/node_modules/swr/")) return "data";
		},
      },
    },
  },
})
