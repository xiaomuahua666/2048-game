import assert from "node:assert/strict";
import test from "node:test";
import { loadScripts } from "./helpers/load-scripts.mjs";

const { GameCore: Core } = await loadScripts(["src/game-core.js"]);

function referenceMerge(line) {
    const active = line.filter(Boolean);
    const output = [];
    let score = 0;
    for (let index = 0; index < active.length; index++) {
        if (active[index] === active[index + 1]) {
            output.push(active[index] * 2);
            score += active[index] * 2;
            index++;
        } else {
            output.push(active[index]);
        }
    }
    while (output.length < 4) output.push(0);
    return { output, score };
}

test("slideAndMerge matches an independent reference for 625 lines", () => {
    const values = [0, 2, 4, 8, 16];
    let checked = 0;
    for (const a of values) for (const b of values) for (const c of values) for (const d of values) {
        const line = [a, b, c, d];
        const expected = referenceMerge(line);
        const actual = Core.slideAndMerge(line);
        assert.deepEqual([...actual.newLine], expected.output);
        assert.equal(actual.scoreAdded, expected.score);
        checked++;
    }
    assert.equal(checked, 625);
});

test("a tile moving right retains exact source and destination metadata", () => {
    const board = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const result = Core.moveRight(board);
    assert.deepEqual([...result.newBoardState[0]], [0, 0, 0, 2]);
    const movement = result.movements.find((item) => item.sourceValue === 2);
    assert.deepEqual({ ...movement.from }, { r: 0, c: 0 });
    assert.deepEqual({ ...movement.to }, { r: 0, c: 3 });
    assert.equal(movement.merged, false);
    assert.deepEqual(board[0], [2, 0, 0, 0]);
});

test("two pairs produce two deterministic merge groups", () => {
    const result = Core.moveLeft([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    assert.deepEqual([...result.newBoardState[0]], [4, 4, 0, 0]);
    assert.equal(result.scoreAdded, 8);
    assert.equal(new Set(result.movements.map((item) => item.mergeGroup)).size, 2);
    assert.equal(result.mergedPositions.length, 2);
});

test("possible-move detection handles terminal and mergeable full boards", () => {
    const terminal = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
    const mergeable = [[2, 2, 4, 8], [4, 8, 16, 32], [8, 16, 32, 64], [16, 32, 64, 128]];
    assert.equal(Core.hasPossibleMoves(terminal), false);
    assert.equal(Core.hasPossibleMoves(mergeable), true);
});
