import assert from "node:assert/strict";
import test from "node:test";
import { loadScripts } from "./helpers/load-scripts.mjs";

const context = await loadScripts(["src/game-core.js", "src/ai.js"], {
    performance: { now: () => Date.now() },
});
const { GameAI: AI } = context;

test("identical boards produce one deterministic direction", () => {
    const board = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 2, 0]];
    const directions = new Set();
    for (let index = 0; index < 10; index++) {
        directions.add(AI.chooseBestMove(board, { targetCorner: "bottom-left", timeBudgetMs: 0, maxDepth: 1 }).direction);
    }
    assert.equal(directions.size, 1);
});

test("an incomplete depth never replaces the completed depth", () => {
    const board = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 2, 0]];
    let tick = 0;
    const result = AI.chooseBestMove(board, {
        targetCorner: "bottom-left",
        timeBudgetMs: 2,
        maxDepth: 8,
        now: () => tick++,
    });
    assert.equal(result.completedDepth, 1);
    assert.ok(result.direction);
});

test("terminal boards return no direction", () => {
    const board = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
    const result = AI.chooseBestMove(board, { timeBudgetMs: 0, maxDepth: 1 });
    assert.equal(result.direction, null);
    assert.equal(result.completedDepth, 0);
});

test("evaluation anchors the max tile at the strategy corner", () => {
    const anchored = [[4096, 2048, 1024, 512], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const dislodged = [[512, 2048, 1024, 4096], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const anchoredScore = AI.evaluateBoard(anchored, "top-left");
    const dislodgedScore = AI.evaluateBoard(dislodged, "top-left");
    assert.equal(Number.isFinite(anchoredScore), true);
    assert.ok(anchoredScore > dislodgedScore);
});

test("evaluation rewards a mergeable pair of large tiles", () => {
    const mergeable = [[4096, 4096, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const separated = [[4096, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 4096, 0, 0]];
    assert.ok(AI.evaluateBoard(mergeable, "top-left") > AI.evaluateBoard(separated, "top-left"));
});

test("chance sampling is deterministic and bounded by nodeBudget", () => {
    const board = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 4, 0, 0], [0, 0, 0, 2]];
    const first = AI.chooseBestMove(board, { targetCorner: "bottom-left", nodeBudget: 5000, timeBudgetMs: 1e9, maxDepth: 6 });
    const second = AI.chooseBestMove(board, { targetCorner: "bottom-left", nodeBudget: 5000, timeBudgetMs: 1e9, maxDepth: 6 });
    assert.equal(first.direction, second.direction);
    assert.equal(first.completedDepth, second.completedDepth);
    assert.equal(first.nodes, second.nodes);
    assert.ok(first.nodes <= 5000 + 64);
});

test("the transposition table records hits without changing direction", () => {
    const board = [[2, 4, 8, 16], [32, 64, 128, 256], [512, 1024, 0, 0], [2, 4, 0, 0]];
    const cached = AI.chooseBestMove(board, { timeBudgetMs: 1000, maxDepth: 3, useCache: true });
    const uncached = AI.chooseBestMove(board, { timeBudgetMs: 1000, maxDepth: 3, useCache: false });
    assert.equal(cached.direction, uncached.direction);
    assert.ok(cached.cacheHits > 0);
    assert.ok(cached.nodes <= uncached.nodes);
});
