import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { clientDeliveryPlugin } from "./scripts/client-delivery-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), clientDeliveryPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client/src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  publicDir: "client/public",
  build: {
    manifest: true,
    outDir: "client/dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
