import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const clientBuild = {
  version: packageMetadata.version,
  commit: process.env.NEXUSHARNESS_COMMIT ?? "development",
  builtAt: process.env.NEXUSHARNESS_BUILD_TIME ?? new Date().toISOString(),
  mode: process.env.NODE_ENV ?? "development"
};

export default defineConfig({
  plugins: [
    react(),
    {
      name: "nexusharness-build-metadata",
      transformIndexHtml() {
        return [
          {
            tag: "meta",
            attrs: { name: "nexusharness-version", content: clientBuild.version },
            injectTo: "head"
          },
          {
            tag: "meta",
            attrs: { name: "nexusharness-commit", content: clientBuild.commit },
            injectTo: "head"
          },
          {
            tag: "meta",
            attrs: { name: "nexusharness-built-at", content: clientBuild.builtAt },
            injectTo: "head"
          }
        ];
      }
    }
  ],
  define: {
    __NEXUSHARNESS_BUILD__: JSON.stringify(clientBuild)
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  }
});
