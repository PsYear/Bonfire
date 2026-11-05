import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "node_modules/@mediapipe/tasks-vision");
const destination = path.join(root, "public/gesture");
await mkdir(path.join(destination, "wasm"), { recursive: true });
await copyFile(path.join(source, "vision_bundle.cjs"), path.join(destination, "vision_bundle.js"));
for (const name of await readdir(path.join(source, "wasm"))) {
  if (/\.(js|wasm)$/.test(name)) {
    await copyFile(path.join(source, "wasm", name), path.join(destination, "wasm", name));
  }
}
console.log("Prepared local MediaPipe gesture assets.");
