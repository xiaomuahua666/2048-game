import { readFile } from "node:fs/promises";
import vm from "node:vm";

export async function loadScripts(paths, globals = {}) {
    const context = vm.createContext({ console, Math, Date, ...globals });
    for (const path of paths) {
        const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
        vm.runInContext(source, context, { filename: path });
    }
    return context;
}

class FakeClassList {
    constructor(element) {
        this.element = element;
    }

    add(...names) {
        for (const name of names) this.element.classes.add(name);
    }

    remove(...names) {
        for (const name of names) this.element.classes.delete(name);
    }

    contains(name) {
        return this.element.classes.has(name);
    }
}

export class FakeElement {
    constructor(id = "") {
        this.id = id;
        this.children = [];
        this.parentNode = null;
        this.classes = new Set();
        this.classList = new FakeClassList(this);
        this.style = {};
        this.dataset = {};
        this.textContent = "";
        this.clientWidth = id === "game-board" ? 400 : 0;
        this.listeners = new Map();
    }

    get className() {
        return [...this.classes].join(" ");
    }

    set className(value) {
        this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    querySelectorAll(selector) {
        const className = selector.startsWith(".") ? selector.slice(1) : null;
        const results = [];
        const visit = (element) => {
            for (const child of element.children) {
                if (className && child.classList.contains(className)) results.push(child);
                visit(child);
            }
        };
        visit(this);
        return results;
    }
}

export function createFakeBrowser() {
    const ids = [
        "game-board",
        "score",
        "game-over-screen",
        "game-message",
        "new-game-button-main",
        "new-game-button-overlay",
        "auto-play-button",
    ];
    const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]));
    const scoreContainer = new FakeElement("score-container");
    scoreContainer.appendChild(elements.score);

    const documentListeners = new Map();
    const document = {
        readyState: "complete",
        hidden: false,
        getElementById: (id) => elements[id],
        createElement: () => new FakeElement(),
        addEventListener(type, listener) {
            if (!documentListeners.has(type)) documentListeners.set(type, []);
            documentListeners.get(type).push(listener);
        },
        dispatch(type) {
            for (const listener of documentListeners.get(type) || []) listener({ type });
        },
    };

    let nextId = 1;
    const tasks = new Map();
    const schedule = (type, callback) => {
        const id = nextId++;
        tasks.set(id, { type, callback });
        return id;
    };
    const scheduler = {
        setTimeout: (callback) => schedule("timeout", callback),
        clearTimeout: (id) => tasks.delete(id),
        requestAnimationFrame: (callback) => schedule("frame", callback),
        cancelAnimationFrame: (id) => tasks.delete(id),
        runNext(type) {
            const entry = [...tasks].find(([, task]) => task.type === type);
            if (!entry) return false;
            const [id, task] = entry;
            tasks.delete(id);
            task.callback(0);
            return true;
        },
        runAll(limit = 100) {
            let count = 0;
            while (tasks.size > 0) {
                if (count++ >= limit) throw new Error("fake scheduler did not settle");
                const [id, task] = tasks.entries().next().value;
                tasks.delete(id);
                task.callback(0);
            }
        },
        pending: () => tasks.size,
    };

    return {
        elements,
        document,
        scheduler,
        globals: {
            document,
            __GAME_TESTING__: true,
            setTimeout: scheduler.setTimeout,
            clearTimeout: scheduler.clearTimeout,
            requestAnimationFrame: scheduler.requestAnimationFrame,
            cancelAnimationFrame: scheduler.cancelAnimationFrame,
            getComputedStyle: () => ({ gap: "10px" }),
            addEventListener() {},
            performance: { now: () => 0 },
            Worker: undefined,
        },
    };
}
