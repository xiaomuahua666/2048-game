import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("generated index is current and loads separated runtime assets", async () => {
    const check = spawnSync(process.execPath, ["scripts/build.mjs", "--check"], { cwd: root, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert.equal(html.includes("/*__STYLES__*/"), false);
    assert.equal(html.includes("/*__APPLICATION__*/"), false);
    assert.match(html, /<link rel="stylesheet" href="src\/styles\.css">/);
    assert.match(html, /<script src="src\/game-core\.js"><\/script>/);
    assert.match(html, /<script src="src\/ai\.js"><\/script>/);
    assert.match(html, /<script src="src\/app\.js"><\/script>/);
    assert.equal([...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].some((match) => match[1].trim()), false);
    assert.ok(Buffer.byteLength(html) < 4000);
});

test("service worker precaches every runtime asset for offline play", async () => {
    const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
    const assets = JSON.parse(sw.match(/const PRECACHE_ASSETS = (\[[^\]]*\])/)[1]);
    const required = [
        "./index.html",
        "./src/styles.css",
        "./src/game-core.js",
        "./src/ai.js",
        "./src/app.js",
        "./src/ai-worker.js",
        "./src/ziap/main.wasm",
    ];
    for (const asset of required) assert.ok(assets.includes(asset), `missing ${asset}`);
    // Every precached asset must exist on disk, or install fails outright.
    for (const asset of assets) {
        await readFile(new URL(`../${asset.slice(2)}`, import.meta.url));
    }
    assert.match(sw, /caches\.match/);
    assert.match(sw, /skipWaiting/);
    const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
    assert.match(app, /serviceWorker\.register\("sw\.js"\)/);
});
