// Seeded full-game benchmark for the vendored WASM engine.
// Usage: node scripts/benchmark-wasm.mjs [--games=N]
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const gamesArg = process.argv.find((argument) => argument.startsWith("--games="));
const games = gamesArg ? Number(gamesArg.split("=")[1]) : 5;
if (!Number.isInteger(games) || games < 1) throw new Error("--games must be a positive integer");

const root = new URL("../", import.meta.url);
const context = vm.createContext({
    console, Math, WebAssembly, TextDecoder, performance,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: "http://localhost/" },
});
context.self = context;
context.Module = {
    wasmBinary: new Uint8Array(await readFile(new URL("src/wasm/ai.wasm", root))),
    noInitialRun: true,
};
vm.runInContext(await readFile(new URL("src/wasm/ai.js", root), "utf8"), context, { filename: "ai.js" });
vm.runInContext(await readFile(new URL("src/game-core.js", root), "utf8"), context, { filename: "game-core.js" });
const { GameCore: Core, Module } = context;
for (let i = 0; i < 100 && !Module.calledRun; i++) await new Promise((r) => setTimeout(r, 20));
if (!Module.calledRun) throw new Error("WASM engine failed to initialize");

const DIRECTIONS = ["Up", "Right", "Down", "Left"];

function boardToRows(board) {
    const rows = new Array(4);
    for (let r = 0; r < 4; r++) {
        let row = 0;
        for (let c = 0; c < 4; c++) {
            const value = board[r][c];
            row = (row << 4) | (value === 0 ? 0 : Math.min(15, Math.round(Math.log2(value))));
        }
        rows[r] = row;
    }
    return rows;
}

function chooseMove(board) {
    const rows = boardToRows(board);
    let direction = null;
    let best = 0;
    for (let dir = 0; dir < 4; dir++) {
        const score = Module._jsWork(rows[0], rows[1], rows[2], rows[3], dir);
        if (score > best) {
            best = score;
            direction = DIRECTIONS[dir];
        }
    }
    if (direction === null) {
        for (const candidate of DIRECTIONS) {
            if (Core.move(board, candidate).moved) return candidate;
        }
    }
    return direction;
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
    while (Core.hasPossibleMoves(board) && moves < 100000) {
        const start = performance.now();
        const direction = chooseMove(board);
        timings.push(performance.now() - start);
        if (!direction) break;
        const result = Core.move(board, direction);
        if (!result.moved) throw new Error(`invalid move ${direction}`);
        board = result.newBoardState;
        score += result.scoreAdded;
        moves++;
        spawn(board, random);
    }
    const maxTile = Math.max(...board.flat());
    results.push({ seed, score, moves, maxTile, timings });
    console.error(`seed ${seed}: score=${score} maxTile=${maxTile} moves=${moves}`);
}

const sorted = (values) => [...values].sort((a, b) => a - b);
const median = (values) => sorted(values)[Math.floor(values.length / 2)];
const allTimings = results.flatMap((result) => result.timings);
const order = sorted(allTimings);
const pct = (fraction) => order[Math.min(order.length - 1, Math.floor(order.length * fraction))];
const reached = (tile) => results.filter((r) => r.maxTile >= tile).length;
console.log(JSON.stringify({
    engine: "wasm",
    games,
    scoreMean: Math.round(results.reduce((sum, r) => sum + r.score, 0) / games),
    scoreMedian: median(results.map((r) => r.score)),
    maxTileMedian: median(results.map((r) => r.maxTile)),
    reached4096: `${reached(4096)}/${games}`,
    reached8192: `${reached(8192)}/${games}`,
    reached16384: `${reached(16384)}/${games}`,
    survivalMovesMean: Math.round(results.reduce((sum, r) => sum + r.moves, 0) / games),
    decisionMs: {
        p50: Number(pct(0.5).toFixed(2)),
        p95: Number(pct(0.95).toFixed(2)),
        max: Number(Math.max(...allTimings).toFixed(2)),
    },
}, null, 2));
