import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Keep PDF fonts, CMaps and image decoders local, including in offline containers.
const pdfAssets = ["cmaps", "standard_fonts", "wasm", "iccs"];

// In dev, the Vite server proxies /api to the Axum backend on :7979 so the
// frontend and backend can run as separate processes with no CORS friction.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "reader-pdf-assets",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "reader-pdf/LICENSE", source: readFileSync(resolve("node_modules/pdfjs-dist/LICENSE")) });
      this.emitFile({ type: "asset", fileName: "reader-pdf/DOMPurify-LICENSE", source: readFileSync(resolve("node_modules/dompurify/LICENSE")) });
        for (const directory of pdfAssets) {
          const source = resolve("node_modules/pdfjs-dist", directory);
          for (const name of readdirSync(source))
            this.emitFile({
              type: "asset",
              fileName: `reader-pdf/${directory}/${name}`,
              source: readFileSync(resolve(source, name)),
            });
        }
      },
      configureServer(server) {
        server.middlewares.use("/reader-pdf", (req, res, next) => {
          const match = /^\/(cmaps|standard_fonts|wasm|iccs)\/([\w.-]+)$/.exec(
            req.url || "",
          );
          if (!match) return next();
          try {
            res.setHeader(
              "Content-Type",
              match[2].endsWith(".wasm")
                ? "application/wasm"
                : "application/octet-stream",
            );
            res.end(
              readFileSync(
                resolve("node_modules/pdfjs-dist", match[1], match[2]),
              ),
            );
          } catch {
            next();
          }
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:7979",
        changeOrigin: true,
      },
    },
  },
});
