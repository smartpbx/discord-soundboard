// Minimal service worker: network pass-through, no caching. It exists only to
// make the app installable as a PWA (home-screen icon, standalone display).
// Deliberately no offline cache so the version-SHA refresh flow keeps working
// and users never get stale content.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* default: let the network handle it */ });
