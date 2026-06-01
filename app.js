/*
 * OSD plain web client.
 *
 * Stack: HTML5 + CSS3 + IndexedDB + WebSockets + fetch.
 * No framework, no build step. Served by dev-server.js which also proxies
 * the API + SignalR endpoints so the browser sees same-origin requests
 * (no CORS issues during development).
 */

const CONFIG = {
    email: "admin@backoffice.com",
    encryptedPassword: "qwerty",
    restaurantId: 9675,
    siteName: "BackOffice",
    pageLimit: 10,
    // Empty base → relative URLs → dev server proxies them.
    apiBase: "",
    signalRPath: "/webservices/signalr",
    hubName: "ordersHub",
    pollIntervalMs: 30_000,
};

// ───────────────────────────────────────────────── IndexedDB ─────────

const DB_NAME = "osd";
const DB_VERSION = 1;
const STORE = "orders";

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "Id" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function getAllOrders(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

function replaceAllOrders(db, orders) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        store.clear();
        for (const o of orders) store.put(o);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ───────────────────────────────────────────────── REST API ─────────

async function login() {
    const res = await fetch(
        `${CONFIG.apiBase}/tacitlinkx/RestoLinkxCustomerService.svc/v2/customers.json/login`,
        {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "Site-Name": CONFIG.siteName,
            },
            body: JSON.stringify({
                email: CONFIG.email,
                encryptedPassword: CONFIG.encryptedPassword,
            }),
        }
    );
    if (!res.ok) throw new Error(`login failed: ${res.status}`);
    const data = await res.json();
    if (!data.SessionToken) throw new Error("no SessionToken in login response");
    return data.SessionToken;
}

async function fetchOrders(token) {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const date = `${y}-${m}-${day}`;
    const url =
        `${CONFIG.apiBase}/webservices/api/v1/restaurants/${CONFIG.restaurantId}/orders` +
        `?startDate=${date}T00:00:00&endDate=${date}T23:59:59&limit=${CONFIG.pageLimit}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            "Site-Name": CONFIG.siteName,
        },
    });
    if (!res.ok) throw new Error(`orders fetch failed: ${res.status}`);
    return res.json();
}

// ───────────────────────────────────── Classic ASP.NET SignalR ──────

/**
 * Minimal classic ASP.NET SignalR client over WebSocket transport.
 * Implements the wire protocol directly (no jQuery, no signalr.js).
 *
 * Sequence: negotiate (HTTP) → connect (WS) → start (HTTP) → invoke hub method.
 */
class SignalRConnection {
    constructor({ basePath, hubName, query, onHubMessage, onClose, onError }) {
        this.basePath = basePath;          // e.g. "/webservices/signalr"
        this.hubName = hubName;
        this.query = query;                // already URL-encoded querystring
        this.onHubMessage = onHubMessage;
        this.onClose = onClose;
        this.onError = onError;
        this.ws = null;
        this.invocationId = 0;
        this.stopped = false;
    }

    async start() {
        const connectionData = encodeURIComponent(
            JSON.stringify([{ name: this.hubName }])
        );

        // 1) Negotiate over HTTP — yields ConnectionToken
        const negotiateUrl =
            `${this.basePath}/negotiate?clientProtocol=1.5` +
            `&connectionData=${connectionData}&${this.query}`;
        const negRes = await fetch(negotiateUrl, { credentials: "include" });
        if (!negRes.ok) throw new Error(`negotiate ${negRes.status}`);
        const negotiate = await negRes.json();
        if (!negotiate.TryWebSockets) {
            throw new Error("server doesn't allow WebSocket transport");
        }
        const ct = encodeURIComponent(negotiate.ConnectionToken);

        // 2) Open WebSocket
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl =
            `${proto}//${window.location.host}${this.basePath}/connect` +
            `?transport=webSockets&clientProtocol=1.5` +
            `&connectionToken=${ct}&connectionData=${connectionData}&${this.query}`;
        this.ws = new WebSocket(wsUrl);

        await new Promise((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = (e) => reject(new Error("ws open failed"));
        });

        this.ws.onmessage = (e) => this._handleMessage(e.data);
        this.ws.onclose = () => {
            if (!this.stopped && this.onClose) this.onClose();
        };
        this.ws.onerror = (e) => {
            if (this.onError) this.onError(e);
        };

        // 3) Tell server we're started
        const startUrl =
            `${this.basePath}/start?transport=webSockets&clientProtocol=1.5` +
            `&connectionToken=${ct}&connectionData=${connectionData}&${this.query}`;
        const startRes = await fetch(startUrl, { credentials: "include" });
        if (!startRes.ok) throw new Error(`start ${startRes.status}`);
    }

    _handleMessage(raw) {
        if (!raw) return;
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        if (Array.isArray(data.M)) {
            for (const m of data.M) {
                if (this.onHubMessage) this.onHubMessage(m);
            }
        }
    }

    invoke(method, ...args) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const payload = {
            H: this.hubName,
            M: method,
            A: args,
            I: String(this.invocationId++),
        };
        this.ws.send(JSON.stringify(payload));
    }

    stop() {
        this.stopped = true;
        if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
        }
    }
}

// ───────────────────────────────────────────────── Bucketing ─────────

/**
 * Plan rules for the current iteration:
 *  - Every order goes in the Dine In column.
 *  - OrderStatus === "Refunded" → Collect, else → Preparing.
 *  - Take Away and Delivery columns are present but empty.
 */
function bucketOrders(orders) {
    const dineInPreparing = [];
    const dineInCollect = [];
    for (const o of orders) {
        const status = (o.OrderStatus || "").toLowerCase();
        const id = String(o.PosOrderId ?? "");
        if (status === "refunded") dineInCollect.push(id);
        else dineInPreparing.push(id);
    }
    return {
        DINE_IN: { PREPARING: dineInPreparing, COLLECT: dineInCollect },
        TAKE_AWAY: { PREPARING: [], COLLECT: [] },
        DELIVERY: { PREPARING: [], COLLECT: [] },
    };
}

// ───────────────────────────────────────────────── Rendering ─────────

const BUCKET_NODES = {
    DINE_IN: {
        PREPARING: document.getElementById("dineInPreparing"),
        COLLECT: document.getElementById("dineInCollect"),
    },
    TAKE_AWAY: {
        PREPARING: document.getElementById("takeAwayPreparing"),
        COLLECT: document.getElementById("takeAwayCollect"),
    },
    DELIVERY: {
        PREPARING: document.getElementById("deliveryPreparing"),
        COLLECT: document.getElementById("deliveryCollect"),
    },
};

function renderBucket(node, ids) {
    node.replaceChildren(
        ...ids.map((id) => {
            const div = document.createElement("div");
            div.className = "order-num";
            div.textContent = id;
            return div;
        })
    );
}

function render(state) {
    for (const col of Object.keys(BUCKET_NODES)) {
        renderBucket(BUCKET_NODES[col].PREPARING, state[col].PREPARING);
        renderBucket(BUCKET_NODES[col].COLLECT, state[col].COLLECT);
    }
}

// ───────────────────────────────────────────────── App lifecycle ─────

const state = {
    db: null,
    sessionToken: null,
    signalR: null,
    pollTimer: null,
    refreshing: false,
};

async function refresh() {
    if (state.refreshing) return;          // simple mutex
    state.refreshing = true;
    try {
        if (!state.sessionToken) state.sessionToken = await login();
        const orders = await fetchOrders(state.sessionToken);
        await replaceAllOrders(state.db, orders);
        render(bucketOrders(orders));
    } finally {
        state.refreshing = false;
    }
}

async function renderFromCache() {
    const cached = await getAllOrders(state.db);
    render(bucketOrders(cached));
}

function stopPolling() {
    if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
    }
}
function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
        refresh().catch((e) => console.error("[poll] refresh failed", e));
    }, CONFIG.pollIntervalMs);
}

function stopSignalR() {
    if (state.signalR) {
        state.signalR.stop();
        state.signalR = null;
    }
}

async function startSignalR() {
    stopSignalR();
    if (!state.sessionToken) return false;
    const qs =
        `SiteName=${encodeURIComponent(CONFIG.siteName)}` +
        `&SessionToken=${encodeURIComponent(state.sessionToken)}`;
    const conn = new SignalRConnection({
        basePath: CONFIG.signalRPath,
        hubName: CONFIG.hubName,
        query: qs,
        onHubMessage: (msg) => {
            if (msg.M === "OrderMessage") {
                console.log("[SignalR] OrderMessage received");
                refresh().catch((e) =>
                    console.error("[SignalR] refresh failed", e)
                );
            }
        },
        onClose: () => {
            console.warn("[SignalR] closed — falling back to polling");
            state.signalR = null;
            startPolling();
        },
        onError: (e) => console.error("[SignalR] error", e),
    });
    try {
        await conn.start();
        conn.invoke("SubscribeToRestaurantOrders", CONFIG.restaurantId);
        state.signalR = conn;
        console.log("[SignalR] connected and subscribed");
        return true;
    } catch (e) {
        console.warn("[SignalR] start failed, will use polling instead", e);
        conn.stop();
        return false;
    }
}

async function runPipeline() {
    try {
        await refresh();
    } catch (e) {
        console.error("[pipeline] initial refresh failed", e);
        return;
    }
    const ok = await startSignalR();
    if (!ok) startPolling();
}

async function init() {
    state.db = await openDb();
    await renderFromCache();   // show stale data instantly if any

    // Cache the app shell so the page loads even when the network is down.
    // Service Workers only register on secure contexts (https / localhost);
    // accessing the page via LAN IP will skip this silently.
    if ("serviceWorker" in navigator) {
        try {
            await navigator.serviceWorker.register("/sw.js");
            console.log("[sw] registered");
        } catch (e) {
            console.warn("[sw] registration failed", e);
        }
    }

    window.addEventListener("online", () => {
        console.log("[net] online — restarting pipeline");
        void runPipeline();
    });
    window.addEventListener("offline", () => {
        console.warn("[net] offline — pausing");
        stopSignalR();
        stopPolling();
    });

    if (navigator.onLine) void runPipeline();
}

init().catch((e) => console.error("[init] failed", e));
