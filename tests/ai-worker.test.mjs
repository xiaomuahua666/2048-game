import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const WASM_BINARY = await readFile(new URL("../src/wasm/ai.wasm", import.meta.url));

async function loadWorker({ withWasm }) {
    const messages = [];
    const sources = new Map();
    for (const path of ["src/wasm/ai.js", "src/game-core.js", "src/ai.js", "src/ai-worker.js"]) {
        sources.set(path, await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
    }

    const context = vm.createContext({
        console,
        Math,
        WebAssembly,
        TextDecoder,
        performance: { now: () => Date.now() },
        setTimeout,
        clearTimeout,
        clearInterval,
        setInterval,
        postMessage: (message) => messages.push(message),
        location: { href: "http://localhost/src/ai-worker.js" },
    });
    context.self = context;
    context.__WASM_BINARY__ = withWasm ? new Uint8Array(WASM_BINARY) : undefined;
    context.importScripts = (...paths) => {
        for (const path of paths) {
            const key = path.replace("./wasm/", "src/wasm/").replace("./", "src/");
            if (!withWasm && key === "src/wasm/ai.js") throw new Error("wasm unavailable");
            vm.runInContext(sources.get(key), context, { filename: key });
        }
    };
    vm.runInContext(sources.get("src/ai-worker.js"), context, { filename: "src/ai-worker.js" });
    // Emscripten defers onRuntimeInitialized through its dependency chain;
    // give pending microtasks a chance to run.
    for (let i = 0; i < 20 && withWasm && context.Module && !context.Module.calledRun; i++) {
        await new Promise((resolveNext) => setTimeout(resolveNext, 25));
    }
    return { context, messages };
}

test("worker answers through the WASM engine with request identity", async () => {
    const { context, messages } = await loadWorker({ withWasm: true });
    context.self.onmessage({
        data: {
            type: "choose-move",
            requestId: 7,
            generation: 3,
            board: [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 2, 0]],
            options: {},
        },
    });
    for (let i = 0; i < 40 && messages.length === 0; i++) {
        await new Promise((resolveNext) => setTimeout(resolveNext, 25));
    }
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "move-result");
    assert.equal(messages[0].requestId, 7);
    assert.equal(messages[0].generation, 3);
    assert.equal(messages[0].result.engine, "wasm");
    assert.ok(["Up", "Right", "Down", "Left"].includes(messages[0].result.direction));
});

test("worker falls back to the JS engine when WASM fails", async () => {
    const { context, messages } = await loadWorker({ withWasm: false });
    context.self.onmessage({
        data: {
            type: "choose-move",
            requestId: 9,
            generation: 1,
            board: [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 2, 0]],
            options: { targetCorner: "bottom-left", nodeBudget: 3000, timeBudgetMs: 1000, maxDepth: 2 },
        },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "move-result");
    assert.equal(messages[0].result.engine, "js");
    assert.ok(messages[0].result.direction);
});

test("worker ignores unrelated message types", async () => {
    const { context, messages } = await loadWorker({ withWasm: false });
    context.self.onmessage({ data: { type: "cancel" } });
    assert.equal(messages.length, 0);
});
