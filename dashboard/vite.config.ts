import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Keep Firebase Auth in its own chunk (heaviest dep, rarely changes) so it
        // stays cached across deploys of our own code.
        manualChunks: {
          firebase: ["firebase/app", "firebase/auth"],
        },
      },
    },
  },
});
