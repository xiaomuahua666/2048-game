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

test("an accepted reply with an illegal direction cannot stall autoplay", async () => {
    const workers = [];
    class FakeWorker {
        constructor() { this.messages = []; workers.push(this); }
        postMessage(message) { this.messages.push(message); }
        terminate() {}
    }
    const { context, scheduler } = await loadApp({ Worker: FakeWorker });
    // Tile pinned at top-left: "Up" and "Left" are illegal.
    context.Game2048.setBoardForTest([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    context.Game2048.startAutoPlay();
    scheduler.runNext("timeout");
    const worker = workers[workers.length - 1];
    const request = worker.messages[worker.messages.length - 1];
    worker.onmessage({ data: {
        type: "move-result",
        requestId: request.requestId,
        generation: request.generation,
        result: { direction: "Up" }, // illegal: board must not change
    } });
    // The chain must reschedule instead of dying silently.
    const state = context.Game2048.getState();
    assert.equal(state.isAutoPlaying, true);
    assert.ok(state.pending.autoPlayTimeout || state.pending.aiRequest,
        "autoplay must have a pending continuation after a failed move");
    context.Game2048.stopAutoPlay();
    scheduler.runAll();
});

test("hidden JS fallback advances without timers", async () => {
    // No Worker at all: the JS engine is the only path. While hidden the
    // fallback must chain moves synchronously (hidden-tab timers are
    // throttled to >=1s). A stub engine keeps each step O(1); real-engine
    // strength is covered by tests/ai-worker.test.mjs and the benchmark.
    const browser = createFakeBrowser();
    const stubAI = {
        DEFAULT_SEARCH_OPTIONS: {},
        inferPlayerCorner: () => "bottom-left",
        chooseBestMove: (board) => {
            for (const direction of ["Left", "Right", "Up", "Down"]) {
                // Cheap legality probe: any direction the real rules accept.
                if (coreForStub.move(board, direction).moved) return { direction };
            }
            return { direction: null };
        },
    };
    const coreContext = await loadScripts(["src/game-core.js"]);
    const coreForStub = coreContext.GameCore;
    const context = await loadScripts(
        ["src/game-core.js", "src/app.js"],
        { ...browser.globals, Worker: undefined, GameAI: stubAI },
    );
    browser.document.hidden = true;
    const before = context.Game2048.getState().moves;
    context.Game2048.startAutoPlay();
    const state = context.Game2048.getState();
    // The synchronous chain must have advanced the game with zero reliance
    // on timers: either it is still running (deferred beyond the recursion
    // cap) or the game finished, but score/occupancy must show progress.
    assert.ok(state.score > 0 || state.occupiedCount > 2 || state.gameOver,
        "hidden fallback must make progress synchronously");
    context.Game2048.stopAutoPlay();
    browser.scheduler.runAll();
});

test("a discarded tab restores the autoplay session and resumes", async () => {
    const storage = createFakeStorage({
        "2048:autoplay-session": JSON.stringify({
            board: [[128, 64, 0, 0], [4, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
            score: 1234,
            targetCorner: "top-left",
        }),
    });
    const browser = createFakeBrowser();
    browser.document.wasDiscarded = true;
    const context = await loadScripts(
        ["src/game-core.js", "src/ai.js", "src/app.js"],
        { ...browser.globals, sessionStorage: storage },
    );
    const state = context.Game2048.getState();
    assert.equal(state.score, 1234);
    assert.equal(state.board[0][0], 128);
    assert.equal(state.isAutoPlaying, true);
    assert.equal(state.targetCorner, "top-left");
    context.Game2048.stopAutoPlay();
    browser.scheduler.runAll();
});

test("a manual refresh ignores and clears any leftover session", async () => {
    const storage = createFakeStorage({
        "2048:autoplay-session": JSON.stringify({
            board: [[128, 64, 0, 0], [4, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
            score: 1234,
            targetCorner: "top-left",
        }),
    });
    const browser = createFakeBrowser(); // wasDiscarded undefined = normal load
    const context = await loadScripts(
        ["src/game-core.js", "src/ai.js", "src/app.js"],
        { ...browser.globals, sessionStorage: storage },
    );
    const state = context.Game2048.getState();
    assert.equal(state.score, 0);
    assert.equal(state.occupiedCount, 2);
    assert.equal(state.isAutoPlaying, false);
    assert.equal(storage.dump()["2048:autoplay-session"], undefined);
    browser.scheduler.runAll();
});

test("autoplay moves write the session; stopping clears it", async () => {
    const storage = createFakeStorage();
    const workers = [];
    class FakeWorker {
        constructor() { this.messages = []; workers.push(this); }
        postMessage(message) { this.messages.push(message); }
        terminate() {}
    }
    const { context, scheduler } = await loadApp({ sessionStorage: storage, Worker: FakeWorker });
    context.Game2048.setBoardForTest([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    context.Game2048.startAutoPlay();
    scheduler.runNext("timeout");
    const worker = workers[workers.length - 1];
    const request = worker.messages[worker.messages.length - 1];
    worker.onmessage({ data: {
        type: "move-result",
        requestId: request.requestId,
        generation: request.generation,
        result: { direction: "Left" },
    } });
    // Drain everything: score-animation cleanup, completeMove, next schedule.
    scheduler.runAll();
    const saved = JSON.parse(storage.dump()["2048:autoplay-session"]);
    assert.equal(saved.board[0][0], 4);
    assert.ok(saved.score >= 4);
    context.Game2048.stopAutoPlay();
    assert.equal(storage.dump()["2048:autoplay-session"], undefined);
    scheduler.runAll();
});

// Cheap stand-in for GameAI: real corner vocabulary, O(1) move choice.
// The real engine's strength is covered elsewhere; these tests only need
// the app<->engine contract (and would take minutes with real search).
async function createStubAI() {
    const { GameCore: Core } = await loadScripts(["src/game-core.js"]);
    return {
        CORNERS: Object.freeze(["top-left", "top-right", "bottom-left", "bottom-right"]),
        DEFAULT_SEARCH_OPTIONS: {},
        inferPlayerCorner: () => "bottom-left",
        chooseBestMove(board, options = {}) {
            // Mirror the real engine's corner handling: a non-string corner
            // throws exactly like generateWeightMatrix's corner.startsWith.
            const corner = options.targetCorner || "bottom-left";
            corner.startsWith("top");
            for (const direction of ["Left", "Down", "Right", "Up"]) {
                if (Core.move(board, direction).moved) return { direction };
            }
            return { direction: null };
        },
    };
}

test("a corrupt targetCorner in the session is dropped, not passed to the AI", async () => {
    const storage = createFakeStorage({
        "2048:autoplay-session": JSON.stringify({
            board: [[128, 64, 0, 0], [4, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
            score: 1234,
            targetCorner: 42, // non-string: corner.startsWith throws in the JS engine
        }),
    });
    const browser = createFakeBrowser();
    browser.document.wasDiscarded = true;
    const stubAI = await createStubAI();
    const context = await loadScripts(
        ["src/game-core.js", "src/app.js"],
        { ...browser.globals, sessionStorage: storage, GameAI: stubAI },
    );
    const state = context.Game2048.getState();
    assert.equal(state.isAutoPlaying, true, "restore must survive a corrupt corner");
    assert.ok(
        stubAI.CORNERS.includes(state.targetCorner),
        `corner must be re-inferred to a valid value, got ${state.targetCorner}`,
    );
    // The engine must be reachable without throwing on the restored corner.
    for (let step = 0; step < 6; step++) browser.scheduler.runNext("timeout");
    context.Game2048.stopAutoPlay();
    browser.scheduler.runAll();
});

test("an external move during a pending AI request cannot starve autoplay", async () => {
    // JS-fallback path (no Worker): requestAiMove parks its answer on a 0ms
    // timer with pendingRequestId set. An external handleMove followed by
    // the page going hidden runs completeMove synchronously, whose
    // scheduleAutoPlay clears that timer — the request can never answer.
    // Unless handleMove invalidates the stale request id, requestAiMove
    // then refuses to issue a new request forever and autoplay starves.
    const browser = createFakeBrowser();
    const stubAI = await createStubAI();
    const context = await loadScripts(
        ["src/game-core.js", "src/app.js"],
        { ...browser.globals, GameAI: stubAI },
    );
    const { document, scheduler } = browser;
    context.Game2048.setBoardForTest([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    context.Game2048.startAutoPlay();
    scheduler.runNext("timeout"); // autoplay step issues the AI request
    assert.equal(context.Game2048.getState().pending.aiRequest, true);
    assert.equal(context.Game2048.handleMove("Left"), true); // external move
    const scoreAfterMove = context.Game2048.getState().score;
    // Hide the page before the 0ms fallback timer fires: completeMove runs
    // synchronously and its rescheduling clears the pending fallback timer.
    document.hidden = true;
    document.dispatch("visibilitychange");
    const state = context.Game2048.getState();
    assert.equal(state.isAutoPlaying, true);
    // With the fix, the hidden synchronous chain keeps playing (score grows
    // or the game ends); a starved chain freezes at the external move's score.
    assert.ok(
        state.score > scoreAfterMove || state.gameOver,
        `autoplay must keep advancing after an external move (score stuck at ${state.score})`,
    );
    context.Game2048.stopAutoPlay();
    scheduler.runAll();
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
