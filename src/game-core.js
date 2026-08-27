(function (root) {
    "use strict";

    const BOARD_SIZE = 4;
    const DIRECTIONS = Object.freeze(["Up", "Down", "Left", "Right"]);

    function cloneBoard(board) {
        return board.map((row) => [...row]);
    }

    function slideAndMerge(line) {
        const active = line
            .map((value, fromIndex) => ({ value, fromIndex }))
            .filter(({ value }) => value !== 0);
        const values = [];
        const movements = [];
        let scoreAdded = 0;

        for (let index = 0; index < active.length; index++) {
            const current = active[index];
            const next = active[index + 1];
            const toIndex = values.length;

            if (next && current.value === next.value) {
                const resultValue = current.value * 2;
                const mergeGroup = `merge-${toIndex}`;
                values.push(resultValue);
                scoreAdded += resultValue;
                movements.push(
                    { fromIndex: current.fromIndex, toIndex, sourceValue: current.value, resultValue, merged: true, mergeGroup },
                    { fromIndex: next.fromIndex, toIndex, sourceValue: next.value, resultValue, merged: true, mergeGroup },
                );
                index++;
            } else {
                values.push(current.value);
                movements.push({
                    fromIndex: current.fromIndex,
                    toIndex,
                    sourceValue: current.value,
                    resultValue: current.value,
                    merged: false,
                    mergeGroup: null,
                });
            }
        }

        const newLine = [...values];
        while (newLine.length < BOARD_SIZE) newLine.push(0);
        const changed = newLine.some((value, index) => value !== line[index]);
        return { newLine, changed, movements, scoreAdded };
    }

    function move(board, direction) {
        if (!DIRECTIONS.includes(direction)) {
            throw new TypeError(`Unknown direction: ${direction}`);
        }

        const newBoardState = cloneBoard(board);
        const movements = [];
        const mergedPositions = [];
        let moved = false;
        let scoreAdded = 0;

        for (let lineIndex = 0; lineIndex < BOARD_SIZE; lineIndex++) {
            const horizontal = direction === "Left" || direction === "Right";
            const reverse = direction === "Right" || direction === "Down";
            const coordinate = (orderedIndex) => {
                const axisIndex = reverse ? BOARD_SIZE - 1 - orderedIndex : orderedIndex;
                return horizontal
                    ? { r: lineIndex, c: axisIndex }
                    : { r: axisIndex, c: lineIndex };
            };
            const line = [];
            for (let index = 0; index < BOARD_SIZE; index++) {
                const { r, c } = coordinate(index);
                line.push(board[r][c]);
            }

            const result = slideAndMerge(line);
            moved ||= result.changed;
            scoreAdded += result.scoreAdded;
            for (let index = 0; index < BOARD_SIZE; index++) {
                const { r, c } = coordinate(index);
                newBoardState[r][c] = result.newLine[index];
            }

            for (const movement of result.movements) {
                const from = coordinate(movement.fromIndex);
                const to = coordinate(movement.toIndex);
                const mergeGroup = movement.mergeGroup
                    ? `${direction}-${lineIndex}-${movement.mergeGroup}`
                    : null;
                movements.push({ ...movement, from, to, mergeGroup });
            }

            const seenMergeGroups = new Set();
            for (const movement of result.movements) {
                if (movement.merged && !seenMergeGroups.has(movement.mergeGroup)) {
                    seenMergeGroups.add(movement.mergeGroup);
                    mergedPositions.push(coordinate(movement.toIndex));
                }
            }
        }

        return { newBoardState, moved, movements, mergedPositions, scoreAdded };
    }

    const moveUp = (board) => move(board, "Up");
    const moveDown = (board) => move(board, "Down");
    const moveLeft = (board) => move(board, "Left");
    const moveRight = (board) => move(board, "Right");

    function getEmptyCells(board) {
        const cells = [];
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (board[r][c] === 0) cells.push({ r, c });
            }
        }
        return cells;
    }

    function hasPossibleMoves(board) {
        if (getEmptyCells(board).length > 0) return true;
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (c + 1 < BOARD_SIZE && board[r][c] === board[r][c + 1]) return true;
                if (r + 1 < BOARD_SIZE && board[r][c] === board[r + 1][c]) return true;
            }
        }
        return false;
    }

    function boardKey(board) {
        return board.flat().join(",");
    }

    root.GameCore = Object.freeze({
        BOARD_SIZE,
        DIRECTIONS,
        cloneBoard,
        slideAndMerge,
        move,
        moveUp,
        moveDown,
        moveLeft,
        moveRight,
        getEmptyCells,
        hasPossibleMoves,
        boardKey,
    });
})(globalThis);
