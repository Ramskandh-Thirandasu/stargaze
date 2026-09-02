/**
 * Offline support.
 *
 * StarGaze is used in fields. Assuming a network is the one assumption it
 * cannot make, so everything it needs is cached on first visit and served from
 * cache afterwards.
 *
 * Deliberately hand-written rather than generated: the caching rules here are
 * two lines of policy, and a precache manifest keyed on hashed filenames would
 * be more machinery than the whole app.
 */

const VERSION = 'stargaze-v2';

/** The catalogues. These never change, so cache-first with no revalidation. */
const DATA = /\/data\/[^/]+\.json$/;

self.addEventListener('install', (event) => {
  // Take over immediately rather than waiting for every tab to close: there is
  // only ever one tab, and waiting means the first launch has no offline copy.
  self.skipWaiting();
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      cache.addAll([
        './',
        './index.html',
        './manifest.webmanifest',
        './icon.svg',
        './data/stars.json',
        './data/names.json',
        './data/constellations.json',
        './data/planets.json',
        './data/declination.json',
      ]),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Google Fonts and anything else off-origin: let it fail to the fallback
  // stack rather than holding up the page.
  if (url.origin !== self.location.origin) return;

  if (DATA.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetchAndCache(request)),
    );
    return;
  }

  // The page itself is the one thing that must never be stale: it names the
  // hashed asset files, so a cached copy pins the whole app to the build it
  // shipped with. Network first, cache only as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetchAndCache(request).catch(() =>
        caches.match(request).then((hit) => hit ?? caches.match('./index.html')),
      ),
    );
    return;
  }

  // Everything else is hashed, so a cache hit is always the right answer for
  // the build that asked for it. Refresh behind the scenes anyway.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetchAndCache(request).catch(() => hit);
      return hit ?? network;
    }),
  );
});

function fetchAndCache(request) {
  return fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      void caches.open(VERSION).then((cache) => cache.put(request, copy));
    }
    return response;
  });
}
