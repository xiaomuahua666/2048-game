// End-to-end tests for the AI worker adapter running the real vendored
// EGTB engine (WASM) inside Node's ESM loader. `self`, `postMessage`, and
// `performance` are stubbed to emulate a module worker's global scope.
import assert from "node:assert/strict";
import test from "node:test";

const sent = [];
globalThis.self = globalThis;
globalThis.postMessage = (message) => sent.push(message);
// The vendored worker logs verbosely; keep test output readable.
const silentConsole = { ...console, log: () => {}, info: () => {} };
globalThis.console = silentConsole;

await import("../src/ai-worker.js");
globalThis.console = console;

async function requestMove(board, requestId, generation, timeoutMs = 30000) {
    const before = sent.length;
    self.onmessage({ data: { type: "choose-move", requestId, generation, board } });
    const deadline = Date.now() + timeoutMs;
    while (sent.length === before && Date.now() < deadline) {
        await new Promise((resolveNext) => setTimeout(resolveNext, 25));
    }
    assert.ok(sent.length > before, "worker did not answer in time");
    return sent[sent.length - 1];
}

test("adapter answers choose-move through the real EGTB engine", async () => {
    const reply = await requestMove(
        [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 4, 0]],
        11,
        3,
    );
    assert.equal(reply.type, "move-result");
    assert.equal(reply.requestId, 11);
    assert.equal(reply.generation, 3);
    assert.equal(reply.result.engine, "egtb");
    assert.ok(["Up", "Down", "Left", "Right"].includes(reply.result.direction));
});

test("adapter reports null direction on a dead board", async () => {
    const reply = await requestMove(
        [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]],
        12,
        3,
    );
    assert.equal(reply.type, "move-result");
    // Engine signals no-move with a non-positive code; adapter maps it to null.
    assert.equal(reply.result.direction, null);
});

test("adapter echoes request identity across sequential requests", async () => {
    const first = await requestMove(
        [[4, 2, 0, 0], [16, 8, 0, 0], [64, 32, 2, 0], [256, 128, 4, 2]],
        21,
        7,
    );
    const second = await requestMove(
        [[2, 0, 0, 0], [0, 0, 0, 0], [0, 4, 0, 0], [0, 0, 0, 2]],
        22,
        7,
    );
    assert.equal(first.requestId, 21);
    assert.equal(second.requestId, 22);
    assert.equal(second.generation, 7);
    assert.ok(second.result.direction);
});

test("adapter ignores unrelated message types", async () => {
    const before = sent.length;
    self.onmessage({ data: { type: "update_speed", ratio: 2 } });
    self.onmessage({ data: null });
    await new Promise((resolveNext) => setTimeout(resolveNext, 100));
    assert.equal(sent.length, before);
});
