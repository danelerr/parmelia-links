import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Keep Firebase Auth in its own chunk (heaviest dep, rarely changes) so it
        // stays cached across deploys of our own code.
		manualChunks(id) {
		  if (id.includes("/node_modules/firebase/") || id.includes("/node_modules/@firebase/")) return "firebase";
		  if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/react-router")) return "react";
		  if (id.includes("/node_modules/swr/")) return "data";
		},
      },
    },
  },
});
