import { access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");
const readBytes = (path) => readFile(resolve(root, path));

// Every file the app needs at runtime; the service worker precaches all of
// them so the game works fully offline after the first visit.
const PRECACHE_ASSETS = [
    "index.html",
    "src/styles.css",
    "src/game-core.js",
    "src/ai.js",
    "src/app.js",
    "src/ai-worker.js",
    "src/wasm/ai.js",
    "src/wasm/ai.wasm",
    "src/favicon.svg",
    "src/favicon.png",
    "src/apple-touch-icon.png",
];

const template = await read("src/index.template.html");
const swTemplate = await read("src/sw.template.js");
await Promise.all([
    ...["src/styles.css", "src/game-core.js", "src/ai.js", "src/app.js", "src/ai-worker.js"]
        .map((path) => read(path)),
    access(resolve(root, "src/wasm/ai.js")),
    access(resolve(root, "src/wasm/ai.wasm")),
    access(resolve(root, "src/wasm/LICENSE")),
]);

for (const asset of ["src/styles.css", "src/game-core.js", "src/ai.js", "src/app.js"]) {
    if (!template.includes(asset)) throw new Error(`Template does not reference ${asset}`);
}
if (template.includes("/*__STYLES__*/") || template.includes("/*__APPLICATION__*/")) {
    throw new Error("Template still contains an inline build placeholder");
}

const indexOutput = `${template.replace(/\r\n?/g, "\n").trimEnd()}\n`;

// Cache version = hash of all cached content, so any asset change invalidates
// the old cache and clients pick up the new build automatically.
const hash = createHash("sha256");
hash.update(indexOutput);
for (const asset of PRECACHE_ASSETS.slice(1)) hash.update(await readBytes(asset));
const swOutput = `${swTemplate
    .replace("__CACHE_VERSION__", hash.digest("hex").slice(0, 12))
    .replace("__PRECACHE_ASSETS__", JSON.stringify(PRECACHE_ASSETS.map((asset) => `./${asset}`)))
    .replace(/\r\n?/g, "\n")
    .trimEnd()}\n`;

const checkMode = process.argv.includes("--check");
let stale = false;
for (const [path, output] of [["index.html", indexOutput], ["sw.js", swOutput]]) {
    const target = resolve(root, path);
    let current = "";
    try {
        current = await readFile(target, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    if (current === output) continue;
    stale = true;
    if (!checkMode) {
        await writeFile(target, output, "utf8");
        console.log(`generated ${path}`);
    }
}

if (checkMode) {
    if (stale) {
        console.error("generated files are stale; run npm run build");
        process.exitCode = 1;
    } else {
        console.log("generated files are current");
    }
} else if (!stale) {
    console.log("generated files already current");
}
