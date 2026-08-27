import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");

const template = await read("src/index.template.html");
const requiredAssets = [
    "src/styles.css",
    "src/game-core.js",
    "src/ai.js",
    "src/app.js",
    "src/ai-worker.js",
];
await Promise.all(requiredAssets.map((path) => read(path)));
// Binary/vendored assets: existence check only.
await Promise.all([
    access(resolve(root, "src/wasm/ai.js")),
    access(resolve(root, "src/wasm/ai.wasm")),
    access(resolve(root, "src/wasm/LICENSE")),
]);

for (const asset of requiredAssets.slice(0, 4)) {
    if (!template.includes(asset)) throw new Error(`Template does not reference ${asset}`);
}
if (template.includes("/*__STYLES__*/") || template.includes("/*__APPLICATION__*/")) {
    throw new Error("Template still contains an inline build placeholder");
}

const output = `${template.replace(/\r\n?/g, "\n").trimEnd()}\n`;

const outputPath = resolve(root, "index.html");
let current = "";
try {
    current = await readFile(outputPath, "utf8");
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}

if (process.argv.includes("--check")) {
    if (current !== output) {
        console.error("index.html is stale; run npm run build");
        process.exitCode = 1;
    } else {
        console.log("index.html is current");
    }
} else if (current !== output) {
    await writeFile(outputPath, output, "utf8");
    console.log("generated index.html");
} else {
    console.log("index.html already current");
}
