(function (root) {
    "use strict";

    const Core = root.GameCore;
    const AI = root.GameAI;
    if (!Core || !AI) throw new Error("GameCore and GameAI must load before the app");

    const ANIMATION_DURATION = 80;
    const AUTO_PLAY_DELAY = 100;
    const MIN_SWIPE_DISTANCE = 30;


    const gameBoardElement = document.getElementById("game-board");
    const scoreDisplay = document.getElementById("score");
    const gameOverScreen = document.getElementById("game-over-screen");
    const gameMessage = document.getElementById("game-message");
    const newGameButtonMain = document.getElementById("new-game-button-main");
    const newGameButtonOverlay = document.getElementById("new-game-button-overlay");
    const autoPlayButton = document.getElementById("auto-play-button");

    let board = [];
    let score = 0;
    let gameOver = false;
    let isMoving = false;
    let isAutoPlaying = false;
    let generation = 0;
    let targetCorner = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let currentTileElements = new Map();

    let moveCompletionTimeoutId = null;
    let autoPlayTimeoutId = null;
    let pendingMove = null;
    let aiWorker = null;
    let workerUnavailable = false;
    let pendingRequestId = null;
    let requestSequence = 0;

    const setTimer = (callback, delay) => root.setTimeout(callback, delay);
    const clearTimer = (id) => root.clearTimeout(id);
    const isPageHidden = () => document.hidden === true;

    function coordinateKey(r, c) {
        return `${r}-${c}`;
    }

    function occupiedCount(state = board) {
        return state.flat().filter(Boolean).length;
    }

    function drawEmptyCells() {
        if (gameBoardElement.querySelectorAll(".cell").length > 0) return;
        for (let index = 0; index < Core.BOARD_SIZE ** 2; index++) {
            const cell = document.createElement("div");
            cell.className = "cell";
            gameBoardElement.appendChild(cell);
        }
    }

    function tileClass(value) {
        return value <= 65536 ? `tile-${value}` : "tile-higher";
    }

    function getTilePosition(r, c) {
        const boardWidth = gameBoardElement.clientWidth;
        const gap = Number.parseFloat(root.getComputedStyle(gameBoardElement).gap) || 10;
        const size = (boardWidth - (Core.BOARD_SIZE - 1) * gap) / Core.BOARD_SIZE;
        return { left: c * (size + gap), top: r * (size + gap), size };
    }

    function positionTile(tile, r, c) {
        const { left, top, size } = getTilePosition(r, c);
        tile.style.left = `${left}px`;
        tile.style.top = `${top}px`;
        tile.style.width = `${size}px`;
        tile.style.height = `${size}px`;
        tile.dataset.r = String(r);
        tile.dataset.c = String(c);
    }

    function createTile(value, r, c, classes = []) {
        const tile = document.createElement("div");
        tile.className = `tile ${tileClass(value)}`;
        for (const className of classes) tile.classList.add(className);
        tile.textContent = String(value);
        positionTile(tile, r, c);
        return tile;
    }

    function renderBoard(state, { newPositions = [], mergedPositions = [] } = {}) {
        for (const tile of gameBoardElement.querySelectorAll(".tile")) tile.remove();
        currentTileElements = new Map();
        const newKeys = new Set(newPositions.map(({ r, c }) => coordinateKey(r, c)));
        const mergedKeys = new Set(mergedPositions.map(({ r, c }) => coordinateKey(r, c)));
        for (let r = 0; r < Core.BOARD_SIZE; r++) {
            for (let c = 0; c < Core.BOARD_SIZE; c++) {
                const value = state[r][c];
                if (value === 0) continue;
                const key = coordinateKey(r, c);
                const classes = [];
                if (newKeys.has(key)) classes.push("new-tile");
                if (mergedKeys.has(key)) classes.push("merged-tile");
                const tile = createTile(value, r, c, classes);
                gameBoardElement.appendChild(tile);
                currentTileElements.set(key, tile);
            }
        }
    }

    function animateMovements(movements) {
        const sourceElements = new Map(currentTileElements);
        currentTileElements = new Map();
        for (const movement of movements) {
            const tile = sourceElements.get(coordinateKey(movement.from.r, movement.from.c));
            if (!tile) continue;
            tile.dataset.mergeGroup = movement.mergeGroup || "";
            positionTile(tile, movement.to.r, movement.to.c);
        }
    }

    function addRandomTile(state) {
        const emptyCells = Core.getEmptyCells(state);
        if (emptyCells.length === 0) return null;
        const position = emptyCells[Math.floor(Math.random() * emptyCells.length)];
        state[position.r][position.c] = Math.random() < 0.9 ? 2 : 4;
        return position;
    }

    function updateScore(points) {
        score += points;
        scoreDisplay.textContent = String(score);
        if (points <= 0) return;
        const animation = document.createElement("span");
        animation.className = "score-animation";
        animation.textContent = `+${points}`;
        scoreDisplay.parentNode.appendChild(animation);
        animation.addEventListener("animationend", () => animation.remove(), { once: true });
        setTimer(() => animation.remove(), 600);
    }

    function hideGameOver() {
        gameOverScreen.classList.remove("visible");
    }

    function showGameOver() {
        gameMessage.textContent = "游戏结束！";
        gameOverScreen.classList.add("visible");
    }

    function checkGameStatus() {
        if (Core.hasPossibleMoves(board)) return false;
        gameOver = true;
        showGameOver();
        stopAutoPlay();
        return true;
    }

    function cancelMoveCompletion() {
        if (moveCompletionTimeoutId !== null) clearTimer(moveCompletionTimeoutId);
        moveCompletionTimeoutId = null;
        pendingMove = null;
    }

    function cancelAutoPlayScheduling() {
        if (autoPlayTimeoutId !== null) clearTimer(autoPlayTimeoutId);
        autoPlayTimeoutId = null;
        pendingRequestId = null;
    }

    function terminateWorker() {
        if (aiWorker) aiWorker.terminate();
        aiWorker = null;
    }

    function stopAutoPlay() {
        isAutoPlaying = false;
        cancelAutoPlayScheduling();
        terminateWorker();
        autoPlayButton.textContent = "自动游玩 (AI)";
        autoPlayButton.classList.remove("active");
    }

    function setupGame() {
        generation++;
        cancelMoveCompletion();
        stopAutoPlay();
        board = Array.from({ length: Core.BOARD_SIZE }, () => Array(Core.BOARD_SIZE).fill(0));
        score = 0;
        gameOver = false;
        isMoving = false;
        targetCorner = null;
        workerUnavailable = false;
        scoreDisplay.textContent = "0";
        hideGameOver();
        drawEmptyCells();
        const newPositions = [addRandomTile(board), addRandomTile(board)].filter(Boolean);
        renderBoard(board, { newPositions });
    }

    function completeMove(moveResult, moveGeneration) {
        if (moveGeneration !== generation) return;
        moveCompletionTimeoutId = null;
        pendingMove = null;
        const newPosition = addRandomTile(board);
        if (!isPageHidden()) {
            renderBoard(board, {
                newPositions: newPosition ? [newPosition] : [],
                mergedPositions: moveResult.mergedPositions,
            });
        }
        isMoving = false;
        if (!checkGameStatus() && isAutoPlaying) {
            scheduleAutoPlay(Math.max(0, AUTO_PLAY_DELAY - ANIMATION_DURATION));
        }
    }

    function handleMove(direction) {
        if (gameOver || isMoving) return false;
        const result = Core.move(board, direction);
        if (!result.moved) {
            checkGameStatus();
            return false;
        }
        board = result.newBoardState;
        updateScore(result.scoreAdded);
        isMoving = true;
        if (!isPageHidden()) animateMovements(result.movements);
        const moveGeneration = generation;
        cancelMoveCompletion();
        pendingMove = { result, generation: moveGeneration };
        if (isPageHidden()) {
            completeMove(result, moveGeneration);
        } else {
            moveCompletionTimeoutId = setTimer(() => completeMove(result, moveGeneration), ANIMATION_DURATION);
        }
        return true;
    }

    function createWorker() {
        if (aiWorker) return true;
        if (workerUnavailable) return false;
        if (!root.Worker) return false;
        try {
            aiWorker = new root.Worker("src/ai-worker.js");
            aiWorker.onmessage = handleWorkerMessage;
            aiWorker.onerror = () => {
                terminateWorker();
                workerUnavailable = true;
                pendingRequestId = null;
                if (isAutoPlaying) scheduleAutoPlay(0);
            };
            return true;
        } catch {
            terminateWorker();
            workerUnavailable = true;
            return false;
        }
    }

    function applyAiResult(result, requestGeneration, requestId) {
        if (
            !isAutoPlaying ||
            requestGeneration !== generation ||
            requestId !== pendingRequestId ||
            isMoving
        ) return;
        pendingRequestId = null;
        if (result.direction) handleMove(result.direction);
        else checkGameStatus();
    }

    function handleWorkerMessage(event) {
        const message = event.data;
        if (!message) return;
        if (message.type === "move-result") {
            applyAiResult(message.result, message.generation, message.requestId);
        } else if (
            message.type === "move-error" &&
            message.generation === generation &&
            message.requestId === pendingRequestId
        ) {
            pendingRequestId = null;
            terminateWorker();
            workerUnavailable = true;
            if (isAutoPlaying) scheduleAutoPlay(0);
        }
    }

    function requestAiMove() {
        if (!isAutoPlaying || gameOver || isMoving || pendingRequestId !== null) return;
        const requestId = ++requestSequence;
        const requestGeneration = generation;
        pendingRequestId = requestId;
        const options = { targetCorner, ...AI.DEFAULT_SEARCH_OPTIONS };

        if (createWorker()) {
            aiWorker.postMessage({
                type: "choose-move",
                requestId,
                generation: requestGeneration,
                board: Core.cloneBoard(board),
                options,
            });
            return;
        }

        autoPlayTimeoutId = setTimer(() => {
            autoPlayTimeoutId = null;
            if (!isAutoPlaying || requestGeneration !== generation || requestId !== pendingRequestId) return;
            const result = AI.chooseBestMove(Core.cloneBoard(board), options);
            applyAiResult(result, requestGeneration, requestId);
        }, 0);
    }

    function autoPlayStep() {
        if (!isAutoPlaying || gameOver || isMoving) return;
        requestAiMove();
    }

    function scheduleAutoPlay(delay) {
        if (!isAutoPlaying || gameOver) return;
        if (autoPlayTimeoutId !== null) clearTimer(autoPlayTimeoutId);
        if (isPageHidden()) {
            autoPlayTimeoutId = null;
            autoPlayStep();
            return;
        }
        autoPlayTimeoutId = setTimer(() => {
            autoPlayTimeoutId = null;
            if (!isAutoPlaying) return;
            autoPlayStep();
        }, delay);
    }

    function handleVisibilityChange() {
        if (isPageHidden()) {
            if (pendingMove) {
                const move = pendingMove;
                if (moveCompletionTimeoutId !== null) clearTimer(moveCompletionTimeoutId);
                moveCompletionTimeoutId = null;
                completeMove(move.result, move.generation);
            } else if (isAutoPlaying && pendingRequestId === null) {
                if (autoPlayTimeoutId !== null) clearTimer(autoPlayTimeoutId);
                autoPlayTimeoutId = null;
                autoPlayStep();
            }
        } else if (!isMoving) {
            renderBoard(board);
        }
    }

    function startAutoPlay() {
        if (isAutoPlaying || gameOver) return;
        isAutoPlaying = true;
        targetCorner = AI.inferPlayerCorner(board);
        autoPlayButton.textContent = "停止游玩";
        autoPlayButton.classList.add("active");
        scheduleAutoPlay(0);
    }

    function toggleAutoPlay() {
        if (isAutoPlaying) stopAutoPlay();
        else startAutoPlay();
    }

    function handleKeydown(event) {
        if (isAutoPlaying || isMoving || gameOver) return;
        const direction = {
            ArrowUp: "Up",
            ArrowDown: "Down",
            ArrowLeft: "Left",
            ArrowRight: "Right",
        }[event.key];
        if (!direction) return;
        event.preventDefault();
        handleMove(direction);
    }

    function handleTouchStart(event) {
        if (isAutoPlaying || isMoving || gameOver) return;
        touchStartX = event.touches[0].clientX;
        touchStartY = event.touches[0].clientY;
        event.preventDefault();
    }

    function handleTouchEnd(event) {
        if (isAutoPlaying || isMoving || gameOver) return;
        const deltaX = event.changedTouches[0].clientX - touchStartX;
        const deltaY = event.changedTouches[0].clientY - touchStartY;
        let direction = null;
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > MIN_SWIPE_DISTANCE) {
            direction = deltaX > 0 ? "Right" : "Left";
        } else if (Math.abs(deltaY) > MIN_SWIPE_DISTANCE) {
            direction = deltaY > 0 ? "Down" : "Up";
        }
        if (direction) handleMove(direction);
    }

    function initialize() {
        newGameButtonMain.addEventListener("click", setupGame);
        newGameButtonOverlay.addEventListener("click", setupGame);
        autoPlayButton.addEventListener("click", toggleAutoPlay);
        document.addEventListener("keydown", handleKeydown);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        gameBoardElement.addEventListener("touchstart", handleTouchStart, { passive: false });
        gameBoardElement.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
        gameBoardElement.addEventListener("touchend", handleTouchEnd);
        root.addEventListener("resize", () => {
            if (!isMoving) renderBoard(board);
        });
        // Precaches all assets (including the WASM engine) so everything
        // works offline after the first visit. Failure is non-fatal.
        if (root.navigator?.serviceWorker) {
            root.navigator.serviceWorker.register("sw.js").catch(() => {});
        }
        setupGame();
    }

    const testControls = root.__GAME_TESTING__ ? {
        setBoardForTest(nextBoard, nextScore = 0) {
            generation++;
            cancelMoveCompletion();
            stopAutoPlay();
            board = Core.cloneBoard(nextBoard);
            score = nextScore;
            scoreDisplay.textContent = String(score);
            gameOver = !Core.hasPossibleMoves(board);
            isMoving = false;
            hideGameOver();
            renderBoard(board);
        },
    } : {};

    root.Game2048 = Object.freeze({
        setupGame,
        handleMove,
        startAutoPlay,
        stopAutoPlay,
        toggleAutoPlay,
        getState: () => ({
            board: Core.cloneBoard(board),
            score,
            gameOver,
            isMoving,
            isAutoPlaying,
            generation,
            targetCorner,
            occupiedCount: occupiedCount(),
            pending: {
                moveCompletion: moveCompletionTimeoutId !== null,
                autoPlayTimeout: autoPlayTimeoutId !== null,
                aiRequest: pendingRequestId !== null,
            },
        }),
        ...testControls,
    });

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})(globalThis);
