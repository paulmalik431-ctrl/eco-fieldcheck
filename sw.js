// Offline shell: field sites often have no signal. Cache the app so planters can open it and check on device.
const C='eco-fieldcheck-v2';
const SHELL=['./','./index.html','./main.js','./config.js','./style.css','./manifest.webmanifest','./icon.svg',
 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js','https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js','https://www.gstatic.com/firebasejs/13.4.0/firebase-app-check.js',
 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js','https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).catch(()=>{}))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==C).map(n=>caches.delete(n)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);
 if(u.origin!==location.origin&&u.hostname!=='www.gstatic.com')return;
 e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('./index.html'))))});
