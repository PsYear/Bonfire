import { defineConfig } from "vite";

export default defineConfig({
  cacheDir: "node_modules/.vite-capture",
  plugins: [{
    name: "gesture-capture-home",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url === "/" || request.url?.startsWith("/?")) {
          request.url = `/capture.html${request.url.slice(1)}`;
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url === "/") request.url = "/capture.html";
        next();
      });
    },
  }],
  build: {
    outDir: "dist-capture",
    rollupOptions: { input: "capture.html" },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/capture-api": {
        target: process.env.CAPTURE_API_TARGET ?? "http://127.0.0.1:8001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/capture-api/, ""),
      },
    },
  },
});
