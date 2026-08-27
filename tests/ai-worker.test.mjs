// End-to-end tests for the AI worker adapter running the real vendored
// ziap WASM engine inside Node. Worker globals are stubbed; the binary is
// injected via __WASM_BINARY__ because Node cannot fetch file:// URLs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sent = [];
globalThis.self = globalThis;
globalThis.__WASM_BINARY__ = await readFile(new URL("../src/ziap/main.wasm", import.meta.url));
globalThis.postMessage = (message) => sent.push(message);

await import("../src/ai-worker.js");

async function requestMove(board, requestId, generation, timeoutMs = 30000) {
    const before = sent.length;
    self.onmessage({ data: { type: "choose-move", requestId, generation, board } });
    const deadline = Date.now() + timeoutMs;
    while (sent.length === before && Date.now() < deadline) {
        await new Promise((resolveNext) => setTimeout(resolveNext, 10));
    }
    assert.ok(sent.length > before, "worker did not answer in time");
    return sent[sent.length - 1];
}

test("adapter answers choose-move through the real ziap engine", async () => {
    const reply = await requestMove(
        [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 4, 0]],
        11,
        3,
    );
    assert.equal(reply.type, "move-result");
    assert.equal(reply.requestId, 11);
    assert.equal(reply.generation, 3);
    assert.equal(reply.result.engine, "ziap");
    assert.ok(["Up", "Down", "Left", "Right"].includes(reply.result.direction));
});

test("identical board and generation give one deterministic direction", async () => {
    const board = [[4, 2, 0, 0], [16, 8, 0, 0], [64, 32, 2, 0], [256, 128, 4, 2]];
    const directions = new Set();
    for (let index = 0; index < 5; index++) {
        const reply = await requestMove(board, 100 + index, 5);
        directions.add(reply.result.direction);
    }
    assert.equal(directions.size, 1);
});

test("a dead board still returns null direction", async () => {
    const reply = await requestMove(
        [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]],
        12,
        6,
    );
    assert.equal(reply.type, "move-result");
    assert.equal(reply.result.direction, null);
});

test("engine -1 on a live board falls back to a legal direction", async () => {
    // Nearly dead board with exactly one legal move (merge in top row).
    const board = [[2, 2, 4, 8], [4, 8, 16, 32], [8, 16, 32, 64], [16, 32, 64, 128]];
    const reply = await requestMove(board, 13, 7);
    assert.equal(reply.type, "move-result");
    assert.ok(["Left", "Right"].includes(reply.result.direction));
});

test("every reply direction is legal under production rules", async () => {
    const { loadScripts } = await import("./helpers/load-scripts.mjs");
    const { GameCore: Core } = await loadScripts(["src/game-core.js"]);
    // Boards engineered so only specific directions are legal, including
    // single-legal-move cases in all four directions. A mirrored fallback
    // mapping fails this test; membership-only assertions do not catch it.
    const boards = [
        [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], // only Right/Down
        [[0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], // only Left/Down
        [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0]], // only Right/Up
        [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 2]], // only Left/Up
        [[2, 2, 4, 8], [4, 8, 16, 32], [8, 16, 32, 64], [16, 32, 64, 128]], // only Left/Right
        [[2, 4, 8, 16], [2, 8, 16, 32], [4, 16, 32, 64], [8, 32, 64, 128]], // only Up/Down
    ];
    for (const [index, board] of boards.entries()) {
        const reply = await requestMove(board.map((row) => [...row]), 300 + index, 9);
        assert.equal(reply.type, "move-result");
        assert.ok(reply.result.direction, `board ${index} must yield a direction`);
        const outcome = Core.move(board, reply.result.direction);
        assert.equal(outcome.moved, true,
            `board ${index}: ${reply.result.direction} must be a legal move`);
    }
});

test("adapter ignores unrelated message types", async () => {
    const before = sent.length;
    self.onmessage({ data: { type: "calculate" } });
    self.onmessage({ data: null });
    await new Promise((resolveNext) => setTimeout(resolveNext, 100));
    assert.equal(sent.length, before);
});
