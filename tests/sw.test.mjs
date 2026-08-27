// Unit tests for the service worker's runtime logic (fetch routing,
// cache-first strategy, isolation-header injection), run against the real
// template source in a fake SW global scope. build.test.mjs already covers
// that the generated sw.js is current, so testing the template tests the
// deployed behavior.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ORIGIN = "https://example.test";

class FakeHeaders {
    constructor(init) {
        this.map = new Map(init instanceof FakeHeaders ? init.map : Object.entries(init || {}));
    }
    set(key, value) { this.map.set(key, value); }
    get(key) { return this.map.has(key) ? this.map.get(key) : null; }
}

class FakeResponse {
    constructor(body, { status = 200, statusText = "OK", headers } = {}) {
        this.body = body;
        this.status = status;
        this.statusText = statusText;
        this.headers = headers instanceof FakeHeaders ? headers : new FakeHeaders(headers);
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    clone() {
        return new FakeResponse(this.body, {
            status: this.status,
            statusText: this.statusText,
            headers: new FakeHeaders(this.headers),
        });
    }
}

async function loadServiceWorker({ cached = {}, network = {} } = {}) {
    // The template placeholders are substituted the same way build.mjs does.
    const template = await readFile(new URL("../src/sw.template.js", import.meta.url), "utf8");
    const source = template
        .replace("__CACHE_VERSION__", "test")
        .replace("__PRECACHE_ASSETS__", JSON.stringify(["./index.html", "./src/app.js"]));

    const cacheStore = new Map(Object.entries(cached));
    const putCalls = [];
    const fetchCalls = [];
    const listeners = new Map();
    const cache = {
        addAll: async (assets) => { for (const asset of assets) cacheStore.set(asset, new FakeResponse(`precached:${asset}`)); },
        put: async (request, response) => { putCalls.push({ request, response }); },
        match: async (target) => cacheStore.get(typeof target === "string" ? target : target.url) ?? undefined,
    };
    const context = {
        console,
        URL,
        Headers: FakeHeaders,
        Response: FakeResponse,
        caches: {
            open: async () => cache,
            match: async (target) => cache.match(target),
            keys: async () => ["2048-cache-old", "2048-cache-test"],
            delete: async (key) => { context.deletedCaches.push(key); return true; },
        },
        deletedCaches: [],
        fetch: async (request) => {
            fetchCalls.push(request);
            const reply = network[request.url];
            if (!reply) throw new Error(`unexpected network fetch: ${request.url}`);
            return reply;
        },
    };
    context.self = {
        location: { origin: ORIGIN },
        skipWaiting: () => { context.skipWaited = true; },
        clients: { claim: () => { context.claimed = true; } },
        addEventListener: (type, listener) => listeners.set(type, listener),
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "sw.template.js" });

    const dispatchFetch = async (request) => {
        let responded = null;
        listeners.get("fetch")({
            request,
            respondWith: (promise) => { responded = promise; },
        });
        return responded === null ? null : await responded;
    };
    const dispatchWaitUntil = async (type) => {
        let waited = null;
        listeners.get(type)({ waitUntil: (promise) => { waited = promise; } });
        await waited;
    };
    return { context, dispatchFetch, dispatchWaitUntil, putCalls, fetchCalls, cacheStore };
}

const request = (url, { mode = "no-cors", method = "GET" } = {}) => ({ url, mode, method });

test("navigations are served the cached shell with isolation headers", async () => {
    const sw = await loadServiceWorker({
        cached: { "index.html": new FakeResponse("shell") },
    });
    const response = await sw.dispatchFetch(request(`${ORIGIN}/anything/deep/link`, { mode: "navigate" }));
    assert.equal(response.body, "shell");
    assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
    assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
    assert.equal(sw.fetchCalls.length, 0, "cached navigations must not hit the network");
});

test("cached assets are served cache-first without network", async () => {
    const url = `${ORIGIN}/src/app.js`;
    const sw = await loadServiceWorker({
        cached: { [url]: new FakeResponse("cached-app") },
    });
    const response = await sw.dispatchFetch(request(url));
    assert.equal(response.body, "cached-app");
    assert.equal(sw.fetchCalls.length, 0);
});

test("a cache miss fetches, caches a copy, and injects isolation headers", async () => {
    const url = `${ORIGIN}/src/late-asset.js`;
    const sw = await loadServiceWorker({
        network: { [url]: new FakeResponse("fresh", { status: 200 }) },
    });
    const response = await sw.dispatchFetch(request(url));
    assert.equal(response.body, "fresh");
    assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
    assert.equal(sw.putCalls.length, 1, "successful responses must be cached");
    assert.equal(sw.putCalls[0].request.url, url);
});

test("error responses pass through without being cached", async () => {
    const url = `${ORIGIN}/missing.js`;
    const sw = await loadServiceWorker({
        network: { [url]: new FakeResponse("nope", { status: 404, statusText: "Not Found" }) },
    });
    const response = await sw.dispatchFetch(request(url));
    assert.equal(response.status, 404);
    assert.equal(sw.putCalls.length, 0, "non-ok responses must not poison the cache");
});

test("opaque responses are returned untouched", async () => {
    const url = `${ORIGIN}/opaque.bin`;
    const opaque = new FakeResponse(null, { status: 0 });
    const sw = await loadServiceWorker({ network: { [url]: opaque } });
    const response = await sw.dispatchFetch(request(url));
    assert.equal(response, opaque, "status-0 responses must not be rewrapped");
});

test("cross-origin and non-GET requests are not intercepted", async () => {
    const sw = await loadServiceWorker();
    assert.equal(await sw.dispatchFetch(request("https://other.test/x.js")), null);
    assert.equal(await sw.dispatchFetch(request(`${ORIGIN}/x`, { method: "POST" })), null);
});

test("install precaches and activates by deleting stale caches", async () => {
    const sw = await loadServiceWorker();
    await sw.dispatchWaitUntil("install");
    assert.equal(sw.context.skipWaited, true);
    assert.ok(sw.cacheStore.has("./index.html"));
    assert.ok(sw.cacheStore.has("./src/app.js"));
    await sw.dispatchWaitUntil("activate");
    assert.deepEqual(sw.context.deletedCaches, ["2048-cache-old"]);
    assert.equal(sw.context.claimed, true);
});
