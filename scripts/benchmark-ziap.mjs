// Seeded full-game benchmark for the vendored ziap engine, driven through
// the real adapter (src/ai-worker.js) in Node.
// Usage: node scripts/benchmark-ziap.mjs [--games=N] [--max-moves=N]
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const argValue = (name, fallback) => {
    const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`));
    const value = raw ? Number(raw.split("=")[1]) : fallback;
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
    return value;
};
const games = argValue("games", 1);
const maxMoves = argValue("max-moves", 30000);

const coreContext = vm.createContext({ console });
vm.runInContext(
    await readFile(new URL("../src/game-core.js", import.meta.url), "utf8"),
    coreContext,
    { filename: "game-core.js" },
);
const Core = coreContext.GameCore;

const replies = [];
globalThis.self = globalThis;
globalThis.__WASM_BINARY__ = await readFile(new URL("../src/ziap/main.wasm", import.meta.url));
globalThis.postMessage = (message) => replies.push(message);
await import("../src/ai-worker.js");

let requestSequence = 0;
async function chooseMove(board, generation) {
    const requestId = ++requestSequence;
    const before = replies.length;
    self.onmessage({ data: { type: "choose-move", requestId, generation, board } });
    const deadline = Date.now() + 120000;
    while (replies.length === before && Date.now() < deadline) {
        await new Promise((resolveNext) => setTimeout(resolveNext, 2));
    }
    const reply = replies[replies.length - 1];
    if (replies.length === before || reply.requestId !== requestId) throw new Error("engine did not answer");
    if (reply.type === "move-error") throw new Error(reply.message);
    return reply.result.direction;
}

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function spawn(board, random) {
    const empty = Core.getEmptyCells(board);
    if (empty.length === 0) return;
    const cell = empty[Math.floor(random() * empty.length)];
    board[cell.r][cell.c] = random() < 0.9 ? 2 : 4;
}

const results = [];
for (let seed = 1; seed <= games; seed++) {
    const random = seededRandom(seed);
    let board = Array.from({ length: 4 }, () => Array(4).fill(0));
    let score = 0;
    let moves = 0;
    const timings = [];
    spawn(board, random);
    spawn(board, random);
    while (Core.hasPossibleMoves(board) && moves < maxMoves) {
        const start = performance.now();
        const direction = await chooseMove(board.map((row) => [...row]), seed);
        timings.push(performance.now() - start);
        if (!direction) break;
        const result = Core.move(board, direction);
        if (!result.moved) throw new Error(`engine chose invalid move ${direction}`);
        board = result.newBoardState;
        score += result.scoreAdded;
        moves++;
        spawn(board, random);
        if (moves % 2000 === 0) {
            console.error(`  seed ${seed}: ${moves} moves, score ${score}, max ${Math.max(...board.flat())}`);
        }
    }
    const maxTile = Math.max(...board.flat());
    results.push({ seed, score, moves, maxTile, timings });
    console.error(`seed ${seed}: score=${score} maxTile=${maxTile} moves=${moves}`);
}

const sorted = (values) => [...values].sort((a, b) => a - b);
const allTimings = results.flatMap((result) => result.timings);
const order = sorted(allTimings);
const pct = (fraction) => order[Math.min(order.length - 1, Math.floor(order.length * fraction))];
console.log(JSON.stringify({
    engine: "ziap",
    games,
    scoreMean: Math.round(results.reduce((sum, r) => sum + r.score, 0) / games),
    maxTiles: results.map((r) => r.maxTile),
    survivalMovesMean: Math.round(results.reduce((sum, r) => sum + r.moves, 0) / games),
    decisionMs: {
        p50: Number(pct(0.5).toFixed(1)),
        p95: Number(pct(0.95).toFixed(1)),
        p99: Number(pct(0.99).toFixed(1)),
        max: Number(Math.max(...allTimings).toFixed(1)),
    },
}, null, 2));
process.exit(0);
