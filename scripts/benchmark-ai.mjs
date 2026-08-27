import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const gameCountArg = process.argv.find((argument) => argument.startsWith("--games="));
const games = gameCountArg ? Number(gameCountArg.split("=")[1]) : 20;
if (!Number.isInteger(games) || games < 1) throw new Error("--games must be a positive integer");

const context = vm.createContext({ performance, console, Math });
for (const path of ["src/game-core.js", "src/ai.js"]) {
    vm.runInContext(await readFile(new URL(`../${path}`, import.meta.url), "utf8"), context, { filename: path });
}
const { GameCore: Core, GameAI: AI } = context;

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
    const position = empty[Math.floor(random() * empty.length)];
    board[position.r][position.c] = random() < 0.9 ? 2 : 4;
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
    const targetCorner = AI.inferPlayerCorner(board);
    while (Core.hasPossibleMoves(board) && moves < 5000) {
        const start = performance.now();
        const decision = AI.chooseBestMove(board, { targetCorner, ...AI.DEFAULT_SEARCH_OPTIONS });
        timings.push(performance.now() - start);
        if (!decision.direction) break;
        const result = Core.move(board, decision.direction);
        if (!result.moved) throw new Error(`AI selected invalid move ${decision.direction}`);
        board = result.newBoardState;
        score += result.scoreAdded;
        moves++;
        spawn(board, random);
    }
    results.push({ score, moves, maxTile: Math.max(...board.flat()), timings });
}

const sorted = (values) => [...values].sort((a, b) => a - b);
const median = (values) => sorted(values)[Math.floor(values.length / 2)];
const allTimings = results.flatMap((result) => result.timings);
const timingOrder = sorted(allTimings);
const percentile = (fraction) => timingOrder[Math.min(timingOrder.length - 1, Math.floor(timingOrder.length * fraction))];
console.log(JSON.stringify({
    games,
    scoreMean: Math.round(results.reduce((sum, result) => sum + result.score, 0) / games),
    scoreMedian: median(results.map((result) => result.score)),
    maxTileMedian: median(results.map((result) => result.maxTile)),
    survivalMovesMean: Math.round(results.reduce((sum, result) => sum + result.moves, 0) / games),
    decisionMs: {
        p50: Number(percentile(0.5).toFixed(2)),
        p95: Number(percentile(0.95).toFixed(2)),
        max: Number(Math.max(...allTimings).toFixed(2)),
    },
}, null, 2));
