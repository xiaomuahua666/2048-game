import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBrowser, loadScripts } from "./helpers/load-scripts.mjs";

function createFakeStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: (key) => data.delete(key),
        dump: () => Object.fromEntries(data),
    };
}

async function loadApp(overrides = {}) {
    const browser = createFakeBrowser();
    const context = await loadScripts(
        ["src/game-core.js", "src/ai.js", "src/app.js"],
        { ...browser.globals, ...overrides },
    );
    return { ...browser, context };
}

test("reset cancels an in-flight move completion", async () => {
    const { context, scheduler } = await loadApp();
    context.Game2048.setBoardForTest([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    assert.equal(context.Game2048.handleMove("Right"), true);
    context.Game2048.setupGame();
    scheduler.runAll();
    assert.equal(context.Game2048.getState().occupiedCount, 2);
    assert.equal(context.Game2048.getState().pending.moveCompletion, false);
});

test("immediate autoplay stop cancels queued work", async () => {
    const { context, scheduler } = await loadApp();
    const before = JSON.stringify(context.Game2048.getState().board);
    context.Game2048.startAutoPlay();
    context.Game2048.stopAutoPlay();
    scheduler.runAll();
    assert.equal(JSON.stringify(context.Game2048.getState().board), before);
    assert.equal(context.Game2048.getState().isAutoPlaying, false);
    assert.equal(scheduler.pending(), 0);
});

test("foreground autoplay invokes AI without requestAnimationFrame", async () => {
    const { context, scheduler } = await loadApp();
    const before = JSON.stringify(context.Game2048.getState().board);
    context.Game2048.startAutoPlay();
    assert.equal(scheduler.runNext("timeout"), true);
    assert.equal(context.Game2048.getState().pending.aiRequest, true);
    context.Game2048.stopAutoPlay();
    scheduler.runAll();
    assert.equal(JSON.stringify(context.Game2048.getState().board), before);
    assert.equal(scheduler.pending(), 0);
});

test("hiding the page completes a pending animation immediately", async () => {
    const { context, document, scheduler } = await loadApp();
    context.Game2048.setBoardForTest([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    context.Game2048.handleMove("Right");
    assert.equal(context.Game2048.getState().pending.moveCompletion, true);
    document.hidden = true;
    document.dispatch("visibilitychange");
    assert.equal(context.Game2048.getState().pending.moveCompletion, false);
    assert.equal(context.Game2048.getState().occupiedCount, 2);
    scheduler.runAll();
});

test("hidden autoplay chains Worker decisions without main-thread timers", async () => {
    const workers = [];
    class FakeWorker {
        constructor(url) {
            this.url = url;
            this.messages = [];
            this.terminated = false;
            workers.push(this);
        }
        postMessage(message) { this.messages.push(message); }
        terminate() { this.terminated = true; }
    }

    const { context, document, scheduler } = await loadApp({ Worker: FakeWorker });
    context.Game2048.setBoardForTest([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    document.hidden = true;
    context.Game2048.startAutoPlay();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].url, "src/ai-worker.js");
    assert.equal(workers[0].messages.length, 1);
    const first = workers[0].messages[0];
    workers[0].onmessage({
        data: {
            type: "move-result",
            requestId: first.requestId,
            generation: first.generation,
            result: { direction: "Right" },
        },
    });
    assert.equal(workers[0].messages.length, 2);
    assert.equal(context.Game2048.getState().isAutoPlaying, true);
    assert.equal(scheduler.pending(), 0);
    context.Game2048.stopAutoPlay();
    assert.equal(workers[0].terminated, true);
});

test("stopping during move completion does not schedule another AI turn", async () => {
    const { context, scheduler } = await loadApp();
    context.Game2048.setBoardForTest([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    context.Game2048.startAutoPlay();
    context.Game2048.handleMove("Right");
    context.Game2048.stopAutoPlay();
    scheduler.runAll();
    const state = context.Game2048.getState();
    assert.equal(state.occupiedCount, 2);
    assert.equal(state.isAutoPlaying, false);
    assert.equal(state.pending.autoPlayTimeout, false);
});

test("a moving source element travels before reconciliation", async () => {
    const { context, elements, scheduler } = await loadApp();
    context.Game2048.setBoardForTest([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    const sourceTile = elements["game-board"].querySelectorAll(".tile")[0];
    assert.equal(sourceTile.dataset.c, "0");
    context.Game2048.handleMove("Right");
    assert.equal(sourceTile.dataset.c, "3");
    assert.equal(elements["game-board"].querySelectorAll(".tile").includes(sourceTile), true);
    scheduler.runAll();
    assert.equal(context.Game2048.getState().occupiedCount, 2);
});

test("a session starts fresh and writes nothing to storage", async () => {
    const storage = createFakeStorage({ "2048:game-state": JSON.stringify({ version: 1, board: [[2]] }) });
    const { context, scheduler } = await loadApp({ localStorage: storage });
    const state = context.Game2048.getState();
    assert.equal(state.score, 0);
    assert.equal(state.occupiedCount, 2);
    assert.equal(state.isAutoPlaying, false);
    context.Game2048.setBoardForTest([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    context.Game2048.handleMove("Left");
    scheduler.runAll();
    assert.deepEqual(Object.keys(storage.dump()), ["2048:game-state"]);
});

test("autoplay holds a Web Lock and releases it on stop", async () => {
    const lockEvents = [];
    let heldPromise = null;
    const locks = {
        request(name, callback) {
            lockEvents.push(`acquire:${name}`);
            heldPromise = callback();
            return heldPromise.then(() => lockEvents.push(`release:${name}`));
        },
    };
    const { context, scheduler } = await loadApp({ navigator: { locks } });
    context.Game2048.startAutoPlay();
    assert.deepEqual(lockEvents, ["acquire:2048-autoplay"]);
    context.Game2048.stopAutoPlay();
    await heldPromise;
    await new Promise((resolveNext) => setImmediate(resolveNext));
    assert.deepEqual(lockEvents, ["acquire:2048-autoplay", "release:2048-autoplay"]);
    scheduler.runAll();
});

test("reset during autoplay also releases the Web Lock", async () => {
    const lockEvents = [];
    let heldPromise = null;
    const locks = {
        request(name, callback) {
            lockEvents.push("acquire");
            heldPromise = callback();
            return heldPromise.then(() => lockEvents.push("release"));
        },
    };
    const { context, scheduler } = await loadApp({ navigator: { locks } });
    context.Game2048.startAutoPlay();
    context.Game2048.setupGame();
    await heldPromise;
    await new Promise((resolveNext) => setImmediate(resolveNext));
    assert.deepEqual(lockEvents, ["acquire", "release"]);
    scheduler.runAll();
});

test("rapid toggling cannot leak a Web Lock granted after stop", async () => {
    // Locks are granted asynchronously; simulate grant arriving only after
    // the user has already toggled autoplay off again.
    const grants = [];
    const settled = [];
    const locks = {
        request(name, callback) {
            return new Promise((resolveGrant) => grants.push(() => {
                const held = callback();
                held.then(() => settled.push("released"));
                resolveGrant(held);
            }));
        },
    };
    const { context, scheduler } = await loadApp({ navigator: { locks } });
    context.Game2048.startAutoPlay();
    context.Game2048.stopAutoPlay();
    context.Game2048.startAutoPlay();
    context.Game2048.stopAutoPlay();
    assert.equal(grants.length, 1, "spam clicks must not stack lock requests");
    grants.shift()(); // grant arrives after autoplay already stopped
    await new Promise((resolveNext) => setImmediate(resolveNext));
    assert.deepEqual(settled, ["released"], "late grant must self-release");
    scheduler.runAll();
});

test("monkey test: 500 random rapid inputs keep state consistent", async () => {
    const workers = [];
    class FakeWorker {
        constructor() { this.messages = []; workers.push(this); this.terminated = false; }
        postMessage(message) { this.messages.push(message); }
        terminate() { this.terminated = true; }
    }
    const { context, elements, scheduler } = await loadApp({ Worker: FakeWorker });
    let rngState = 12345;
    const random = () => {
        rngState = (rngState * 1664525 + 1013904223) >>> 0;
        return rngState / 0x100000000;
    };
    const actions = [
        () => context.Game2048.setupGame(),
        () => context.Game2048.toggleAutoPlay(),
        () => context.Game2048.startAutoPlay(),
        () => context.Game2048.stopAutoPlay(),
        () => context.Game2048.handleMove(["Up", "Down", "Left", "Right"][Math.floor(random() * 4)]),
        () => scheduler.runNext("timeout"),
        () => {
            // Deliver a (possibly stale) worker reply mid-chaos.
            const worker = workers[workers.length - 1];
            const request = worker?.messages[worker.messages.length - 1];
            if (worker && !worker.terminated && request) {
                worker.onmessage?.({ data: {
                    type: "move-result",
                    requestId: request.requestId,
                    generation: request.generation,
                    result: { direction: "Left" },
                } });
            }
        },
    ];
    for (let step = 0; step < 500; step++) {
        actions[Math.floor(random() * actions.length)]();
        const state = context.Game2048.getState();
        assert.ok(state.score >= 0, "score must never go negative");
        assert.ok(state.occupiedCount >= 1 && state.occupiedCount <= 16, "tile count in range");
        for (const row of state.board) {
            for (const value of row) {
                assert.ok(value === 0 || (value & (value - 1)) === 0, "tiles are powers of two");
            }
        }
    }
    context.Game2048.stopAutoPlay();
    context.Game2048.setupGame();
    scheduler.runAll();
    const finalState = context.Game2048.getState();
    assert.equal(finalState.occupiedCount, 2, "reset always lands on two tiles");
    assert.equal(finalState.isAutoPlaying, false);
    assert.equal(scheduler.pending(), 0, "no callbacks may leak after reset");
    const boardTiles = elements["game-board"].querySelectorAll(".tile");
    assert.equal(boardTiles.length, 2, "DOM matches board state");
});

test("merge sources converge and reconcile once", async () => {
    const { context, elements, scheduler } = await loadApp();
    context.Game2048.setBoardForTest([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    context.Game2048.handleMove("Left");
    const movingTiles = elements["game-board"].querySelectorAll(".tile");
    assert.equal(movingTiles.length, 2);
    assert.equal(movingTiles.every((tile) => tile.dataset.c === "0"), true);
    scheduler.runAll();
    // Value-based matching is ambiguous: the random spawn can also be a 4.
    // The merge destination is identified by its animation class instead.
    const merged = elements["game-board"].querySelectorAll(".tile").filter((tile) => tile.classList.contains("merged-tile"));
    assert.equal(merged.length, 1);
    assert.equal(merged[0].textContent, "4");
    assert.equal(merged[0].dataset.c, "0");
});
