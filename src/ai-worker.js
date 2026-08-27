// AI worker adapter (ES module worker).
//
// Bridges the app's `choose-move` protocol onto the vendored EGTB engine
// from https://github.com/game-difficulty/2048EndgameTablebase (GPL-3.0,
// see src/egtb/LICENSE): expectimax with adaptive depth 1~24+ plus a
// distilled endgame tablebase embedded in ai_core.wasm.
//
// The vendored src/egtb/worker.js is used byte-for-byte unmodified. Its
// protocol is `{type:"calculate", board_encoded:<16 hex chars>}` in and
// `{type:"move_result", best_move:1..4}` out via the global postMessage.
// We interpose on the global postMessage BEFORE importing it, and replace
// self.onmessage AFTER importing it, so both sides speak our protocol.
"use strict";

const realPostMessage = self.postMessage.bind(self);

// EGTB move codes, confirmed against the upstream demo's key map.
const DIRECTION_BY_CODE = { 1: "Left", 2: "Right", 3: "Up", 4: "Down" };

let engineReady = false;
let currentRequest = null;
let queuedMessage = null;
let vendoredOnMessage = null;

// Board: 4x4 array of tile values (0/2/4/...). EGTB wants 16 hex digits of
// log2 ranks, row-major, capped at 0xF.
function boardToHex(board) {
    let hex = "";
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            const value = board[r][c];
            const rank = value === 0 ? 0 : Math.min(15, Math.round(Math.log2(value)));
            hex += rank.toString(16);
        }
    }
    return hex;
}

function failCurrentRequest(message) {
    if (!currentRequest) return;
    const { requestId, generation } = currentRequest;
    currentRequest = null;
    realPostMessage({ type: "move-error", requestId, generation, message });
}

// Interpose: the vendored worker calls bare postMessage(), which resolves
// to this assignment in the worker's global scope.
self.postMessage = (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
        engineReady = true;
        if (queuedMessage) {
            const pending = queuedMessage;
            queuedMessage = null;
            handleChooseMove(pending);
        }
        return;
    }
    if (message.type === "move_result") {
        if (!currentRequest) return;
        const { requestId, generation } = currentRequest;
        currentRequest = null;
        realPostMessage({
            type: "move-result",
            requestId,
            generation,
            result: {
                direction: DIRECTION_BY_CODE[message.best_move] || null,
                engine: "egtb",
            },
        });
    }
};

function handleChooseMove(message) {
    currentRequest = { requestId: message.requestId, generation: message.generation };
    try {
        vendoredOnMessage({
            data: { type: "calculate", board_encoded: boardToHex(message.board) },
        });
    } catch (error) {
        failCurrentRequest(error instanceof Error ? error.message : "AI search failed");
    }
}

// Importing runs the vendored top-level code: it starts WASM init and
// assigns its own self.onmessage, which we capture and replace.
try {
    await import("./egtb/worker.js");
} catch (error) {
    self.onmessage = (event) => {
        const message = event.data;
        if (!message || message.type !== "choose-move") return;
        realPostMessage({
            type: "move-error",
            requestId: message.requestId,
            generation: message.generation,
            message: error instanceof Error ? error.message : "engine failed to load",
        });
    };
    throw error;
}

vendoredOnMessage = self.onmessage;
if (typeof vendoredOnMessage !== "function") {
    throw new Error("vendored EGTB worker did not install a message handler");
}

self.onmessage = (event) => {
    const message = event.data;
    if (!message || message.type !== "choose-move") return;
    if (currentRequest) {
        // The app keeps one request in flight; a second one means the first
        // became stale (e.g. reset). Prefer the newest board.
        failCurrentRequest("superseded by a newer request");
    }
    if (!engineReady) {
        queuedMessage = message;
        return;
    }
    handleChooseMove(message);
};
