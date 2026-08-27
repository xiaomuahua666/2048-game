(function (root) {
    "use strict";

    const Core = root.GameCore;
    if (!Core) throw new Error("GameCore must load before GameAI");

    const CORNERS = Object.freeze(["top-left", "top-right", "bottom-left", "bottom-right"]);
    // Search defaults shared by the app, the worker, and the benchmark.
    // nodeBudget is the primary, machine-independent limit; timeBudgetMs is a
    // wall-clock safety net for very slow devices.
    const DEFAULT_SEARCH_OPTIONS = Object.freeze({
        nodeBudget: 200000,
        timeBudgetMs: 250,
        maxDepth: 6,
        chanceSamples: 6,
    });
    const SEARCH_TIMEOUT = Object.freeze({ type: "search-timeout" });

    function exponent(value) {
        return value === 0 ? 0 : Math.log2(value);
    }

    function cornerCoordinate(corner) {
        switch (corner) {
            case "top-left": return { r: 0, c: 0 };
            case "top-right": return { r: 0, c: 3 };
            case "bottom-right": return { r: 3, c: 3 };
            default: return { r: 3, c: 0 };
        }
    }

    // Snake-shaped positional weights, 4^rank, highest at the target corner.
    // This is the evaluator family that reliably reached 4096+ in the
    // original implementation; keep the exponential shape.
    const weightMatrixCache = new Map();
    function generateWeightMatrix(corner) {
        if (weightMatrixCache.has(corner)) return weightMatrixCache.get(corner);
        const values = Array.from({ length: 16 }, (_, index) => Math.pow(4, index));
        const basePattern = [
            [15, 14, 13, 12],
            [8, 9, 10, 11],
            [7, 6, 5, 4],
            [0, 1, 2, 3],
        ];
        const matrix = Array.from({ length: 4 }, () => Array(4).fill(0));
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                const sourceR = corner.startsWith("bottom") ? 3 - r : r;
                const sourceC = corner.endsWith("right") ? 3 - c : c;
                matrix[r][c] = values[basePattern[sourceR][sourceC]];
            }
        }
        weightMatrixCache.set(corner, matrix);
        return matrix;
    }

    function inferPlayerCorner(board) {
        let maxTile = 0;
        let maxR = -1;
        let maxC = -1;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                if (board[r][c] > maxTile) {
                    maxTile = board[r][c];
                    maxR = r;
                    maxC = c;
                }
            }
        }

        let bestCorner = "bottom-left";
        let bestScore = -Infinity;
        for (const corner of CORNERS) {
            const weights = generateWeightMatrix(corner);
            let score = 0;
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) {
                    if (board[r][c] > 0) score += exponent(board[r][c]) * weights[r][c];
                }
            }
            if (maxTile >= 128) {
                const target = cornerCoordinate(corner);
                if (maxR === target.r && maxC === target.c) score *= 1.5;
            }
            if (score > bestScore) {
                bestScore = score;
                bestCorner = corner;
            }
        }
        return bestCorner;
    }

    // Returns true when two equal tiles share a row/column and the cells
    // between them are empty, i.e. one slide can merge them.
    function checkMergeable(p1, p2, board) {
        if (p1.r === p2.r) {
            if (Math.abs(p1.c - p2.c) === 1) return true;
            for (let c = Math.min(p1.c, p2.c) + 1; c < Math.max(p1.c, p2.c); c++) {
                if (board[p1.r][c] !== 0) return false;
            }
            return true;
        }
        if (p1.c === p2.c) {
            if (Math.abs(p1.r - p2.r) === 1) return true;
            for (let r = Math.min(p1.r, p2.r) + 1; r < Math.max(p1.r, p2.r); r++) {
                if (board[r][p1.c] !== 0) return false;
            }
            return true;
        }
        return false;
    }

    function findPositions(board, value) {
        const positions = [];
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                if (board[r][c] === value) positions.push({ r, c });
            }
        }
        return positions;
    }

    // Faithful port of the proven evaluator from the original page:
    // exponential snake gradient, corner anchoring, food/blocker shaping
    // around the max tile, trapped-tile penalties, monotonicity/smoothness
    // penalties and empty-cell pressure. Values are intentionally huge and
    // discontinuous; strength was validated by play, not elegance.
    function evaluateBoard(boardState, targetCorner) {
        const weights = generateWeightMatrix(targetCorner);
        let scoreVal = 0;
        let emptyCells = 0;
        let maxTile = 0;
        let maxTileR = -1;
        let maxTileC = -1;
        let first4096Pos = null;
        let has16384 = false;
        let has8192 = false;
        let has4096 = false;
        let count4096 = 0;
        let count2048 = 0;
        let weightedGridScore = 0;

        const { r: targetR, c: targetC } = cornerCoordinate(targetCorner);

        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                const value = boardState[r][c];
                if (value === 0) {
                    emptyCells++;
                    continue;
                }
                if (value === 65536) return 1e28;
                if (value === 16384) has16384 = true;
                if (value === 8192) has8192 = true;
                if (value === 4096) {
                    has4096 = true;
                    count4096++;
                    if (!first4096Pos) first4096Pos = { r, c };
                }
                if (value === 2048) count2048++;
                if (value > maxTile) {
                    maxTile = value;
                    maxTileR = r;
                    maxTileC = c;
                }
                weightedGridScore += value * weights[r][c];
            }
        }

        let setupBonusMultiplier = 1.0;
        if (boardState[targetR][targetC] === maxTile && maxTile >= 8192) setupBonusMultiplier = 1.3;
        else if (boardState[targetR][targetC] === maxTile && maxTile >= 4096) setupBonusMultiplier = 1.15;

        if (boardState[targetR][targetC] === 32768) scoreVal += 1e25 * setupBonusMultiplier;
        if (has16384) {
            const positions = findPositions(boardState, 16384);
            if (positions.length >= 2 && checkMergeable(positions[0], positions[1], boardState)) {
                scoreVal += 1.2e22 * setupBonusMultiplier;
            }
        }
        if (has8192) {
            const positions = findPositions(boardState, 8192);
            if (positions.length >= 2 && checkMergeable(positions[0], positions[1], boardState)) {
                scoreVal += 9e22 * setupBonusMultiplier;
            }
        }
        if (has4096) {
            const positions = findPositions(boardState, 4096);
            if (positions.length >= 2 && checkMergeable(positions[0], positions[1], boardState)) {
                scoreVal += 7.5e21 * setupBonusMultiplier;
            }
        }

        if (has4096 && count4096 < 2 && count2048 >= 2) {
            const positions = findPositions(boardState, 2048);
            if (positions.length >= 2 && checkMergeable(positions[0], positions[1], boardState)) {
                let baseBonus = 3.0e19;
                if (first4096Pos && first4096Pos.r === targetR && first4096Pos.c === targetC) baseBonus *= 1.6;
                scoreVal += baseBonus;
            }
        }

        let gridScoreMultiplier = 0.65;
        if (boardState[targetR][targetC] === maxTile && maxTile >= 2048) {
            if (maxTile >= 8192) gridScoreMultiplier = 0.93;
            else if (maxTile >= 4096) gridScoreMultiplier = 0.90;
            else gridScoreMultiplier = 0.80;
        }
        scoreVal += weightedGridScore * gridScoreMultiplier;

        if (maxTileR === targetR && maxTileC === targetC && maxTile >= 512) {
            scoreVal += maxTile * 125000 * (exponent(maxTile) / 3.65);
        } else if (maxTile >= 512) {
            scoreVal -= maxTile * 95000 * (maxTile >= 4096 ? 2.0 : 1.2);
            scoreVal -= (Math.abs(maxTileR - targetR) + Math.abs(maxTileC - targetC)) * maxTile * 2350;
        }

        if (maxTileR === targetR && maxTileC === targetC && maxTile >= 512) {
            const food1 = maxTile / 2;
            const vertNeighborR = targetR === 0 ? 1 : -1;
            const horizNeighborC = targetC === 0 ? 1 : -1;
            const foodBonusFactor = 560 + exponent(maxTile) * 72;
            const blockerPenaltyBase = 2350;
            const blockerMaxTileFactor = 235;

            const vVal = boardState[targetR + vertNeighborR]?.[targetC];
            if (vVal !== undefined) {
                if (vVal === food1) scoreVal += food1 * foodBonusFactor;
                else if (vVal > 0 && vVal < food1) scoreVal -= (food1 - vVal) * blockerPenaltyBase + maxTile * blockerMaxTileFactor;
            }
            const hVal = boardState[targetR][targetC + horizNeighborC];
            if (hVal !== undefined) {
                if (hVal === food1) scoreVal += food1 * foodBonusFactor;
                else if (hVal > 0 && hVal < food1) scoreVal -= (food1 - hVal) * blockerPenaltyBase + maxTile * blockerMaxTileFactor;
            }
        }

        let trappedTilePenalty = 0;
        const trappedPenaltyFactor = 220000;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                const value = boardState[r][c];
                if (value <= 0 || value > 16) continue;
                let trappedCount = 0;
                let largeNeighborSum = 0;
                if (r > 0) { if (boardState[r - 1][c] > value * 4) trappedCount++; largeNeighborSum += boardState[r - 1][c]; } else trappedCount++;
                if (r < 3) { if (boardState[r + 1][c] > value * 4) trappedCount++; largeNeighborSum += boardState[r + 1][c]; } else trappedCount++;
                if (c > 0) { if (boardState[r][c - 1] > value * 4) trappedCount++; largeNeighborSum += boardState[r][c - 1]; } else trappedCount++;
                if (c < 3) { if (boardState[r][c + 1] > value * 4) trappedCount++; largeNeighborSum += boardState[r][c + 1]; } else trappedCount++;
                if (trappedCount >= 3 && largeNeighborSum > value * 16) {
                    trappedTilePenalty += trappedPenaltyFactor * (32 / value);
                }
            }
        }
        scoreVal -= trappedTilePenalty;

        let monotonicityPenalty = 0;
        const monotonicityFactor = 470;
        const accumulateMono = (v1, v2, w1, w2) => {
            if (v1 <= 0 || v2 <= 0) return;
            const e1 = exponent(v1);
            const e2 = exponent(v2);
            if ((w1 > w2 && e1 < e2) || (w2 > w1 && e2 < e1)) {
                monotonicityPenalty += Math.abs(e1 - e2) * (v1 + v2) * monotonicityFactor;
            }
        };
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 3; c++) {
                accumulateMono(boardState[r][c], boardState[r][c + 1], weights[r][c], weights[r][c + 1]);
            }
        }
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 3; r++) {
                accumulateMono(boardState[r][c], boardState[r + 1][c], weights[r][c], weights[r + 1][c]);
            }
        }
        scoreVal -= monotonicityPenalty;

        let smoothnessPenalty = 0;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 3; c++) {
                if (boardState[r][c] > 0 && boardState[r][c + 1] > 0) {
                    smoothnessPenalty += Math.abs(exponent(boardState[r][c]) - exponent(boardState[r][c + 1]));
                }
            }
        }
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 3; r++) {
                if (boardState[r][c] > 0 && boardState[r + 1][c] > 0) {
                    smoothnessPenalty += Math.abs(exponent(boardState[r][c]) - exponent(boardState[r + 1][c]));
                }
            }
        }
        scoreVal -= smoothnessPenalty * 1070;

        if (emptyCells < 2) scoreVal -= 4800000 * (2 - emptyCells);
        scoreVal += emptyCells * 93000;

        let sumOfLogTiles = 0;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                if (boardState[r][c] > 0) sumOfLogTiles += exponent(boardState[r][c]);
            }
        }
        scoreVal += sumOfLogTiles * 1870;

        return scoreVal;
    }

    function preferredDirections(corner) {
        switch (corner) {
            case "top-left": return ["Up", "Left", "Down", "Right"];
            case "top-right": return ["Up", "Right", "Down", "Left"];
            case "bottom-right": return ["Down", "Right", "Up", "Left"];
            default: return ["Down", "Left", "Up", "Right"];
        }
    }

    // Deterministic replacement for the legacy random chance-node sampling:
    // when more than `chanceSamples` cells are empty, expand only the cells
    // with the highest positional weight (nearest the strategy corner),
    // tie-broken by row/column. Same board in => same cells expanded.
    function selectChanceCells(emptyCells, weights, chanceSamples) {
        if (emptyCells.length <= chanceSamples) return emptyCells;
        return [...emptyCells]
            .sort((a, b) => (
                weights[b.r][b.c] - weights[a.r][a.c] ||
                a.r - b.r ||
                a.c - b.c
            ))
            .slice(0, chanceSamples);
    }

    function chooseBestMove(board, options = {}) {
        const targetCorner = options.targetCorner || inferPlayerCorner(board);
        const nodeBudget = options.nodeBudget ?? DEFAULT_SEARCH_OPTIONS.nodeBudget;
        const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_SEARCH_OPTIONS.timeBudgetMs;
        const maxDepth = options.maxDepth ?? DEFAULT_SEARCH_OPTIONS.maxDepth;
        const chanceSamples = options.chanceSamples ?? DEFAULT_SEARCH_OPTIONS.chanceSamples;
        const now = options.now || (() => (root.performance ? root.performance.now() : Date.now()));
        const useCache = options.useCache !== false;
        const start = now();
        const deadline = start + Math.max(0, timeBudgetMs);
        const cache = new Map();
        const weights = generateWeightMatrix(targetCorner);
        const directions = preferredDirections(targetCorner);
        let nodes = 0;
        let cacheHits = 0;
        let enforceBudgets = false;

        const checkBudgets = () => {
            nodes++;
            if (!enforceBudgets) return;
            if (nodes >= nodeBudget) throw SEARCH_TIMEOUT;
            if ((nodes & 63) === 0 && now() >= deadline) throw SEARCH_TIMEOUT;
        };

        const cacheLookup = (key) => {
            if (!useCache || !cache.has(key)) return undefined;
            cacheHits++;
            return cache.get(key);
        };

        const maxNode = (state, depth) => {
            checkBudgets();
            if (depth <= 0 || !Core.hasPossibleMoves(state)) return evaluateBoard(state, targetCorner);
            const key = `M|${depth}|${Core.boardKey(state)}`;
            const cached = cacheLookup(key);
            if (cached !== undefined) return cached;
            let best = -Infinity;
            for (const direction of directions) {
                const result = Core.move(state, direction);
                if (!result.moved) continue;
                best = Math.max(best, chanceNode(result.newBoardState, depth));
            }
            if (best === -Infinity) best = evaluateBoard(state, targetCorner);
            if (useCache) cache.set(key, best);
            return best;
        };

        const chanceNode = (state, depth) => {
            checkBudgets();
            const key = `C|${depth}|${Core.boardKey(state)}`;
            const cached = cacheLookup(key);
            if (cached !== undefined) return cached;
            const emptyCells = Core.getEmptyCells(state);
            if (emptyCells.length === 0) {
                const value = depth <= 1 ? evaluateBoard(state, targetCorner) : maxNode(state, depth - 1);
                if (useCache) cache.set(key, value);
                return value;
            }
            const cells = selectChanceCells(emptyCells, weights, chanceSamples);
            let weightedSum = 0;
            let probabilityMass = 0;
            for (const { r, c } of cells) {
                for (const [tileValue, probability] of [[2, 0.9], [4, 0.1]]) {
                    const next = Core.cloneBoard(state);
                    next[r][c] = tileValue;
                    const value = depth <= 1
                        ? evaluateBoard(next, targetCorner)
                        : maxNode(next, depth - 1);
                    weightedSum += probability * value;
                    probabilityMass += probability;
                }
            }
            const expectedValue = weightedSum / probabilityMass;
            if (useCache) cache.set(key, expectedValue);
            return expectedValue;
        };

        const searchDepth = (depth) => {
            let bestDirection = null;
            let bestValue = -Infinity;
            for (const direction of directions) {
                const result = Core.move(board, direction);
                if (!result.moved) continue;
                const value = chanceNode(result.newBoardState, depth);
                if (value > bestValue) {
                    bestValue = value;
                    bestDirection = direction;
                }
            }
            return { direction: bestDirection, value: bestValue };
        };

        let best = searchDepth(1);
        let completedDepth = best.direction ? 1 : 0;
        enforceBudgets = true;
        for (let depth = 2; depth <= maxDepth; depth++) {
            if (nodes >= nodeBudget || now() >= deadline) break;
            try {
                const candidate = searchDepth(depth);
                if (candidate.direction) {
                    best = candidate;
                    completedDepth = depth;
                }
            } catch (error) {
                if (error !== SEARCH_TIMEOUT) throw error;
                break;
            }
        }

        return {
            direction: best.direction,
            completedDepth,
            nodes,
            cacheHits,
            elapsedMs: now() - start,
            targetCorner,
        };
    }

    root.GameAI = Object.freeze({
        CORNERS,
        DEFAULT_SEARCH_OPTIONS,
        generateWeightMatrix,
        inferPlayerCorner,
        evaluateBoard,
        chooseBestMove,
    });
})(globalThis);
