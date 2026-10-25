// Service worker: makes the app installable. It deliberately caches nothing,
// so every page and API call always comes from the network (no stale data).
// Only when a page can't load at all (offline) does it show a short notice.

const OFFLINE_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline | Finance App</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ee;font:15px system-ui,sans-serif;text-align:center">
<div><h2 style="margin:0 0 .5rem">You're offline</h2>
<p style="color:#9aa3b2">Finance App needs an internet connection.</p>
<button onclick="location.reload()" style="margin-top:1rem;padding:.6rem 1.2rem;border:0;border-radius:8px;background:#4f8cff;color:#fff;font:inherit;cursor:pointer">Try again</button></div>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).catch(() =>
      new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  );
});
