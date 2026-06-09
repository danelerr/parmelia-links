import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Split Firebase Auth into its own chunk. It's the heaviest dependency
        // and almost never changes, so isolating it lets the browser keep it
        // cached across deploys of our own (frequently changing) app code.
        manualChunks: {
          firebase: ["firebase/app", "firebase/auth"],
        },
      },
    },
  },
})
