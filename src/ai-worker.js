"use strict";

// AI worker. Prefers the vendored WebAssembly engine (MIT, from
// https://github.com/maitamdev/2048-ai): expectimax over a 64-bit bitboard
// with 65536-entry move/evaluation lookup tables and a persistent
// transposition table, iterative deepening from 3 ply. Falls back to the
// pure-JS engine (game-core.js + ai.js) when WASM cannot initialize, e.g.
// on memory pressure or very old browsers.

const DIRECTIONS = ["Up", "Right", "Down", "Left"];

let wasmState = "loading";
let queuedMessage = null;

function flushQueued() {
    if (!queuedMessage) return;
    const message = queuedMessage;
    queuedMessage = null;
    handleRequest(message);
}

self.Module = {
    // Tests running under Node inject the binary; browsers fetch it via
    // locateFile relative to this worker's directory.
    wasmBinary: self.__WASM_BINARY__,
    noInitialRun: true,
    locateFile: (path, directory) => `${directory}wasm/${path}`,
    onRuntimeInitialized() {
        wasmState = "ready";
        flushQueued();
    },
    onAbort() {
        wasmState = "failed";
        flushQueued();
    },
};

try {
    importScripts("./wasm/ai.js");
} catch {
    wasmState = "failed";
}

importScripts("./game-core.js", "./ai.js");

// Pack the board into four 16-bit rows: row 0 is the top row, column 0 is
// the highest nibble, each nibble is log2(tileValue).
function boardToRows(board) {
    const rows = new Array(4);
    for (let r = 0; r < 4; r++) {
        let row = 0;
        for (let c = 0; c < 4; c++) {
            const value = board[r][c];
            const rank = value === 0 ? 0 : Math.min(15, Math.round(Math.log2(value)));
            row = (row << 4) | rank;
        }
        rows[r] = row;
    }
    return rows;
}

function firstValidDirection(board) {
    for (const direction of DIRECTIONS) {
        if (self.GameCore.move(board, direction).moved) return direction;
    }
    return null;
}

function chooseWithWasm(board) {
    const rows = boardToRows(board);
    let direction = null;
    let bestScore = 0;
    for (let dir = 0; dir < 4; dir++) {
        const score = self.Module._jsWork(rows[0], rows[1], rows[2], rows[3], dir);
        if (score > bestScore) {
            bestScore = score;
            direction = DIRECTIONS[dir];
        }
    }
    // The engine scores a move 0 when it is invalid or leads to certain
    // death; keep playing to the real end in the latter case.
    if (direction === null) direction = firstValidDirection(board);
    return { direction, engine: "wasm" };
}

function handleRequest(message) {
    const { requestId, generation, board, options } = message;
    try {
        const result = wasmState === "ready"
            ? chooseWithWasm(board)
            : { ...self.GameAI.chooseBestMove(board, options), engine: "js" };
        self.postMessage({ type: "move-result", requestId, generation, result });
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
    if (wasmState === "loading") {
        // Keep only the latest request; the app never has more than one in
        // flight, and a stale board must not be answered after a newer one.
        queuedMessage = message;
        return;
    }
    handleRequest(message);
};
