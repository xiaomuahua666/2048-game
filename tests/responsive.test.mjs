import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const template = await readFile(new URL("../src/index.template.html", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("viewport permits zoom", () => {
    assert.match(template, /width=device-width, initial-scale=1/);
    assert.doesNotMatch(template, /user-scalable=no|maximum-scale=1/);
});

test("layout is fluid, scrollable, and motion-aware", () => {
    assert.match(styles, /--board-size:\s*min\(/);
    assert.match(styles, /aspect-ratio:\s*1/);
    assert.match(styles, /overflow-y:\s*auto/);
    assert.match(styles, /max-height:\s*560px/);
    assert.match(styles, /prefers-reduced-motion:\s*reduce/);
    assert.doesNotMatch(styles, /#game-board\s*\{[^}]*width:\s*(400|320|280)px/s);
});
