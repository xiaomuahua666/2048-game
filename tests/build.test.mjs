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
    assert.ok(Buffer.byteLength(html) < 3000);
});
