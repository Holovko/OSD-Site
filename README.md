# OSD — Plain Web Client

A separate, framework-free implementation of the Order Status Display that uses
only HTML5, CSS3, and vanilla JavaScript. Coexists with the Compose Multiplatform
web build in `webApp/`; neither knows about the other.

## Tech stack used

| Need | API |
|---|---|
| Layout / styling | CSS Grid, Flexbox, CSS custom properties, `@keyframes` |
| HTTP (login, orders) | `fetch` |
| Local persistence | IndexedDB |
| Real-time updates | WebSocket (classic ASP.NET SignalR protocol, hand-rolled) |
| Online/offline detection | `window.navigator.onLine`, `online`/`offline` events |

No build step, no npm packages in the served code, no transpiler.

## Files

```
webAppPlain/
├── index.html      ← three-column layout + marquee
├── styles.css      ← colors, layout, marquee animation
├── app.js          ← login, fetch orders, IndexedDB, SignalR, render
├── dev-server.js   ← zero-dependency Node server + reverse proxy
└── README.md
```

## Run

```bash
node webAppPlain/dev-server.js
# → http://localhost:8000
```

The dev server reverse-proxies `/tacitlinkx/*` and `/webservices/*` (including
the SignalR WebSocket upgrade) to `https://demowebv3.tacitdev.ca`. Because the
browser only ever talks to `localhost`, **no CORS preflight is involved**.

`PORT=9000 node webAppPlain/dev-server.js` to use a different port.

## What it does

1. On load, opens IndexedDB and renders any cached orders immediately.
2. POSTs login → `SessionToken`.
3. GETs today's orders for restaurant 9675, persists to IndexedDB, renders.
4. Opens a SignalR WebSocket to `ordersHub`, invokes
   `SubscribeToRestaurantOrders(9675)`. On every `OrderMessage` event, re-fetches.
5. If the WebSocket can't be established or drops, falls back to polling every
   30 s.
6. Listens for browser `online`/`offline` events; on reconnect, restarts the
   whole pipeline.

## Display rules (matching Android)

- Every order goes in the **Dine In** column.
- `OrderStatus === "Refunded"` → **Collect**, otherwise → **Preparing**.
- Take Away and Delivery columns are rendered empty for now.

## Production deployment

In production you'd serve `index.html`, `app.js`, `styles.css` from any static
file host and either:

1. Put a reverse proxy (nginx, Caddy, CloudFront) in front of the backend so
   the API is same-origin, OR
2. Enable CORS on `demowebv3.tacitdev.ca` and set `apiBase` / `signalRPath` in
   `app.js` to the absolute backend URL.

The dev server is **development only** — do not deploy it.
