const CACHE_NAME = 'magicarena-shell-v1';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
];

const BYPASS_PREFIXES = ['/ws', '/api/'];
const BYPASS_EXACT = new Set(['/health', '/ready', '/metrics']);

const shouldBypassRequest = (request, url) => {
  if (request.method !== 'GET') {
    return true;
  }

  if (url.origin !== self.location.origin) {
    return true;
  }

  if (request.headers.has('upgrade')) {
    return true;
  }

  if (BYPASS_EXACT.has(url.pathname)) {
    return true;
  }

  return BYPASS_PREFIXES.some(
    (prefix) =>
      url.pathname === prefix || url.pathname.startsWith(`${prefix}`),
  );
};

const isImmutableViteAsset = (pathname) =>
  pathname.startsWith('/assets/') && /\.(js|css)$/.test(pathname);

const networkFirst = async (request, fallbackUrl = null) => {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached =
      (await cache.match(request)) ??
      (fallbackUrl ? await cache.match(fallbackUrl) : undefined);
    if (cached) {
      return cached;
    }
    throw error;
  }
};

const cacheFirst = async (request) => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
  }
  return response;
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  if (shouldBypassRequest(event.request, requestUrl)) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, '/index.html'));
    return;
  }

  if (isImmutableViteAsset(requestUrl.pathname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(networkFirst(event.request));
});

