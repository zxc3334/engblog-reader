/* EngBlog Reader Service Worker
 * 缓存应用外壳与静态资源（离线可用）；API 请求永不缓存（保证数据实时性）。
 * 注意：Service Worker 仅在 HTTPS 或 localhost 下生效，http://局域网IP 访问时自动跳过。
 */
const CACHE = 'engblog-v1';
const ASSETS = [
  '/',
  '/static/css/style.css',
  '/static/js/app.js',
  '/static/manifest.webmanifest',
  '/static/icons/icon-192.png',
  'https://cdn.jsdelivr.net/npm/markdown-it@13.0.2/dist/markdown-it.min.js',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/common.min.js',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .catch(() => {})           // 离线安装失败不影响在线使用
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // CDN 资源交给浏览器缓存
  if (url.pathname.startsWith('/api/')) return;      // API 永不缓存
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((resp) => {
      if (resp.ok && e.request.method === 'GET') {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return resp;
    }))
  );
});
