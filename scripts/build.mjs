import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });

await build({
  root,
  configFile: false,
  publicDir: "public",
  build: {
    outDir: dist,
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: path.join(root, "src/content/index.ts"),
      name: "GptReaderContent",
      formats: ["iife"],
      fileName: () => "content.js",
      cssFileName: "content"
    },
    rollupOptions: {
      output: {
        assetFileNames: "[name][extname]"
      }
    }
  }
});

await build({
  root,
  configFile: false,
  publicDir: "public",
  build: {
    outDir: dist,
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: path.join(root, "popup.html"),
      output: {
        entryFileNames: "popup.js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "[name][extname]"
      }
    }
  }
});
