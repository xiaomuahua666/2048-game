// AI worker adapter (ES module worker).
//
// Runs the vendored engine from https://github.com/ziap/2048-ai (MIT, see
// src/ziap/LICENSE): expectimax over a 64-bit bitboard with lookup tables
// and memory-constrained BFS depth allocation, compiled from Zig to WASM.
// The engine imports shared memory, which requires cross-origin isolation
// (COOP/COEP headers); when unavailable this worker reports move-error and
// the app falls back to the pure-JS engine.
//
// Engine contract (from upstream js/worker.js and js/main.js):
//   - memory: shared, 1024 pages (64MB), imported as env.memory
//   - init() builds lookup tables once
//   - reset_depth() resets the adaptive search budget (new game/session)
//   - search(boardBigInt) -> 0 up, 1 right, 2 down, 3 left, -1 no useful move
//   - board: 16 nibbles of log2 ranks, row-major, first cell highest nibble
"use strict";

const DIRECTION_BY_CODE = { 0: "Up", 1: "Right", 2: "Down", 3: "Left" };
const MEMORY_PAGES = 1024; // mirrors upstream build.zig MEMORY_BYTES

let engine = null;
let engineError = null;
let queuedMessage = null;
let lastGeneration = null;

function boardToBigInt(board) {
    let packed = 0n;
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            const value = board[r][c];
            const rank = value === 0 ? 0 : Math.min(15, Math.round(Math.log2(value)));
            packed = (packed << 4n) | BigInt(rank);
        }
    }
    return packed;
}

// Minimal legality check for the -1 ("certain death, nothing useful") case:
// prefer any direction that changes the board so the game plays out fully.
// canSlide(line) is true when tiles can slide toward line[0] or merge, so a
// plain row maps to Left, a reversed row to Right, a plain column to Up and
// a reversed column to Down.
function firstValidDirection(board) {
    const canSlide = (line) => {
        for (let i = 0; i < 3; i++) {
            if (line[i] === 0 && line.slice(i + 1).some((v) => v !== 0)) return true;
            if (line[i] !== 0 && line[i] === line[i + 1]) return true;
        }
        return false;
    };
    const rows = board;
    const cols = [0, 1, 2, 3].map((c) => board.map((row) => row[c]));
    if (cols.some(canSlide)) return "Up";
    if (rows.some(canSlide)) return "Left";
    if (cols.some((col) => canSlide([...col].reverse()))) return "Down";
    if (rows.some((row) => canSlide([...row].reverse()))) return "Right";
    return null;
}

async function initEngine() {
    const memory = new WebAssembly.Memory({
        initial: MEMORY_PAGES,
        maximum: MEMORY_PAGES,
        shared: true,
    });
    let module;
    if (self.__WASM_BINARY__) {
        module = await WebAssembly.compile(self.__WASM_BINARY__);
    } else {
        const wasmUrl = new URL("./ziap/main.wasm", import.meta.url);
        try {
            module = await WebAssembly.compileStreaming(fetch(wasmUrl));
        } catch {
            // Wrong MIME type on minimal static hosts; compile from bytes.
            const response = await fetch(wasmUrl);
            module = await WebAssembly.compile(await response.arrayBuffer());
        }
    }
    const instance = await WebAssembly.instantiate(module, { env: { memory } });
    instance.exports.init();
    return instance.exports;
}

function handleChooseMove(message) {
    const { requestId, generation, board } = message;
    try {
        // A new generation means reset/new autoplay session: drop the
        // engine's adaptive depth state from the previous game.
        if (generation !== lastGeneration) {
            engine.reset_depth();
            lastGeneration = generation;
        }
        const code = engine.search(boardToBigInt(board));
        const direction = DIRECTION_BY_CODE[code] ?? firstValidDirection(board);
        self.postMessage({
            type: "move-result",
            requestId,
            generation,
            result: { direction, engine: "ziap" },
        });
    } catch (error) {
        self.postMessage({
            type: "move-error",
            requestId,
            generation,
            message: error instanceof Error ? error.message : "AI search failed",
        });
    }
}

self.onmessage = (event) => {
    const message = event.data;
    if (!message || message.type !== "choose-move") return;
    if (engine) {
        handleChooseMove(message);
    } else if (engineError) {
        self.postMessage({
            type: "move-error",
            requestId: message.requestId,
            generation: message.generation,
            message: engineError,
        });
    } else {
        queuedMessage = message; // keep only the latest pre-init request
    }
};

try {
    engine = await initEngine();
    if (queuedMessage) {
        const pending = queuedMessage;
        queuedMessage = null;
        handleChooseMove(pending);
    }
} catch (error) {
    engineError = error instanceof Error
        ? error.message
        : "engine failed to initialize (cross-origin isolation required)";
    if (queuedMessage) {
        const pending = queuedMessage;
        queuedMessage = null;
        self.postMessage({
            type: "move-error",
            requestId: pending.requestId,
            generation: pending.generation,
            message: engineError,
        });
    }
}
