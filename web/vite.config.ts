import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: { maximumFileSizeToCacheInBytes: 6 * 1024 * 1024 },
      manifest: {
        name: "Ours",
        short_name: "Ours",
        description: "A shared treasury for modern families.",
        theme_color: "#f5f5f2",
        background_color: "#f5f5f2",
        display: "standalone",
        icons: [{ src: "ours-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
    }),
  ],
});
