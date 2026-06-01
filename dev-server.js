#!/usr/bin/env node
/*
 * Dev server for the plain webapp. Zero npm dependencies — just Node builtins.
 *
 * - Serves static files (index.html, app.js, styles.css) from this directory.
 * - Reverse-proxies /tacitlinkx and /webservices (HTTP + WebSocket) to
 *   https://demowebv3.tacitdev.ca, so the browser only ever talks to localhost
 *   (no CORS, no preflight issues).
 *
 * Run: `node dev-server.js`   then open http://localhost:8000
 */

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8000);
const TARGET_HOST = "demowebv3.tacitdev.ca";
const PROXY_PREFIXES = ["/tacitlinkx", "/webservices"];

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".mjs":  "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png":  "image/png",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
};

const ROOT = __dirname;
const shouldProxy = (url) => PROXY_PREFIXES.some((p) => url.startsWith(p));

const server = http.createServer((req, res) => {
    if (shouldProxy(req.url)) return proxyHttp(req, res);
    return serveStatic(req, res);
});

server.on("upgrade", (req, socket, head) => {
    if (!shouldProxy(req.url)) { socket.destroy(); return; }
    proxyWebSocket(req, socket, head);
});

// ─────────────────────────────────────────── Static file serving ────

function serveStatic(req, res) {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const safePath = path.normalize(urlPath === "/" ? "/index.html" : urlPath);
    const filePath = path.join(ROOT, safePath);
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403); res.end("Forbidden"); return;
    }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404); res.end("Not found"); return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
            "Cache-Control": "no-cache",
        });
        res.end(data);
    });
}

// ─────────────────────────────────────────── HTTP reverse proxy ─────

function proxyHttp(req, res) {
    const headers = { ...req.headers };
    headers.host = TARGET_HOST;
    delete headers["accept-encoding"];   // simpler: don't ask for gzip
    const options = {
        host: TARGET_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers,
    };
    const upstream = https.request(options, (upRes) => {
        res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers);
        upRes.pipe(res);
    });
    upstream.on("error", (e) => {
        console.error(`[proxy] ${req.method} ${req.url} →`, e.message);
        if (!res.headersSent) { res.writeHead(502); res.end("Bad gateway"); }
    });
    req.pipe(upstream);
}

// ─────────────────────────────────────────── WebSocket proxy ────────

function proxyWebSocket(clientReq, clientSocket, clientHead) {
    const headers = { ...clientReq.headers };
    headers.host = TARGET_HOST;
    const options = {
        host: TARGET_HOST,
        port: 443,
        path: clientReq.url,
        method: "GET",
        headers,
    };
    const upstream = https.request(options);
    upstream.end();

    upstream.on("upgrade", (upRes, upSocket, upHead) => {
        let respHead = "HTTP/1.1 101 Switching Protocols\r\n";
        for (const [k, v] of Object.entries(upRes.headers)) {
            respHead += `${k}: ${v}\r\n`;
        }
        respHead += "\r\n";
        clientSocket.write(respHead);
        if (upHead && upHead.length) clientSocket.write(upHead);

        upSocket.pipe(clientSocket);
        clientSocket.pipe(upSocket);

        upSocket.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upSocket.destroy());
    });

    upstream.on("response", (upRes) => {
        // Not an upgrade — forward the response then close.
        let respHead = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
        for (const [k, v] of Object.entries(upRes.headers)) {
            respHead += `${k}: ${v}\r\n`;
        }
        respHead += "\r\n";
        clientSocket.write(respHead);
        upRes.pipe(clientSocket);
    });

    upstream.on("error", (e) => {
        console.error(`[ws-proxy] ${clientReq.url} →`, e.message);
        clientSocket.destroy();
    });
}

function lanAddresses() {
    const out = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) {
            if (i.family === "IPv4" && !i.internal) out.push(i.address);
        }
    }
    return out;
}

server.listen(PORT, () => {
    console.log(`OSD plain webapp listening on port ${PORT}`);
    console.log(`  local:  http://localhost:${PORT}`);
    for (const ip of lanAddresses()) {
        console.log(`  lan:    http://${ip}:${PORT}`);
    }
    console.log(`Proxying ${PROXY_PREFIXES.join(", ")} → https://${TARGET_HOST}`);
});
