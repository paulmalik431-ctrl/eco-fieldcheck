import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app-check.js';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, onSnapshot, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';
import { FIREBASE_CONFIG, CLOUD_MODEL_NAME, RECAPTCHA_SITE_KEY, APPCHECK_DEBUG_TOKEN } from './config.js';

// ---------- Firebase setup ----------
const app = initializeApp(FIREBASE_CONFIG);
if (APPCHECK_DEBUG_TOKEN) self.FIREBASE_APPCHECK_DEBUG_TOKEN = APPCHECK_DEBUG_TOKEN;
if (RECAPTCHA_SITE_KEY || APPCHECK_DEBUG_TOKEN) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY || 'debug-only'),
    isTokenAutoRefreshEnabled: true,
  });
}

// Firestore with an on-device cache: claims are saved on the phone with no signal
// and sync to every reviewer's screen when the network returns.
let db = null, dbError = null;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) { dbError = e.message; console.warn(e); }
const auth = getAuth(app);
let uid = null;

let ai, fieldModel, auditModel, aiError = null;
const CLOUD_MODEL = CLOUD_MODEL_NAME || 'gemini-3.5-flash-lite';
// One JSON schema, used on device (Prompt API responseConstraint) and in the cloud.
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    tree_visible: { type: 'boolean' },
    seedling_count: { type: 'integer' },
    freshly_planted: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['pass', 'review', 'reject'] },
    reason: { type: 'string' },
  },
  required: ['tree_visible', 'seedling_count', 'freshly_planted', 'issues', 'verdict', 'reason'],
};

const CHECK_PROMPT = (c) => `You verify tree-planting claims for a climate programme in Kenya.
Claim: planter "${c.planter || 'unknown'}" says they planted one "${c.species || 'unspecified'}" seedling at site "${c.site || 'unspecified'}".
Look only at the photo. Answer in JSON:
- tree_visible: is a young tree or seedling clearly visible?
- seedling_count: how many seedlings are visible?
- freshly_planted: does the soil around it look recently dug or planted?
- issues: short list of problems (e.g. "photo of a screen", "no seedling", "potted, not planted", "blurry", "looks like a stock photo").
- verdict: "pass" if one planted seedling is clearly visible and nothing looks wrong, "reject" if there is no seedling or the photo looks staged or reused, otherwise "review".
- reason: one sentence.`;

const AUDIT_PROMPT = (c) => `You are the Ghost Audit for a tree-planting payout system. Your job is to try to DISPROVE this claim before money moves.
Claim: planter "${c.planter || 'unknown'}" planted one "${c.species || 'unspecified'}" seedling at "${c.site || 'unspecified'}". The on-device check said: ${JSON.stringify(c.device)}.
Look hard for signs of fraud or error: staged or reused photos, photos of screens or prints, potted plants presented as planted, mature trees presented as new, the wrong species, more than one claim for the same seedling.
Answer in JSON with the same fields. Use "reject" only with clear evidence, "review" if uncertain.`;

try {
  ai = getAI(app, { backend: new GoogleAIBackend() });
  // Hybrid: try Gemini Nano on this device, fall back to Gemini in the cloud.
  fieldModel = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
      promptOptions: { responseConstraint: VERDICT_SCHEMA },
    },
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: { responseMimeType: 'application/json', responseSchema: VERDICT_SCHEMA, temperature: 0.1 },
    },
  });
  // Second opinion always in the cloud, run when there is signal, with an adversarial prompt.
  auditModel = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: { responseMimeType: 'application/json', responseSchema: VERDICT_SCHEMA, temperature: 0.1 },
    },
  });
} catch (e) { aiError = e.message; console.warn(e); }

// ---------- State ----------
const $ = (id) => document.getElementById(id);
const KEY = 'eco-fieldcheck-claims-v1';
let claims = [];               // what the queue shows (from Firestore, or local fallback)
let localOnly = !db;           // true when Firestore is unavailable
if (localOnly) { try { claims = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { claims = []; } }
const saveLocal = () => { try { localStorage.setItem(KEY, JSON.stringify(claims)); } catch (e) { console.warn('storage full', e); } };
let current = { image: null, mime: null, hash: null, gps: null, thumb: null };

// ---------- Sync ----------
function setSync(text, cls) { const s = $('sync'); s.textContent = text; s.className = 'pill ' + cls; }
function startSync() {
  if (!db) { setSync('sync: this browser only', 'warn'); return; }
  const q = query(collection(db, 'claims'), orderBy('at', 'desc'), limit(100));
  onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    claims = snap.docs.map((d) => ({ ...d.data(), id: d.id, pending: d.metadata.hasPendingWrites }))
      .filter((c) => typeof c.thumb === 'string' && c.thumb.startsWith('data:image'));
    const waiting = claims.filter((c) => c.pending).length;
    if (waiting) setSync(`${waiting} saved on device, will sync`, 'warn');
    else setSync(snap.metadata.fromCache ? 'sync: offline copy' : 'synced to reviewers', snap.metadata.fromCache ? 'warn' : 'ok');
    render();
  }, (err) => {
    // e.g. rules not deployed yet: fall back to this browser so the field check keeps working.
    console.warn(err); localOnly = true;
    try { claims = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { claims = []; }
    setSync('sync paused: saved in this browser', 'warn'); render();
  });
}
onAuthStateChanged(auth, (u) => { if (u && !uid) { uid = u.uid; startSync(); } });
signInAnonymously(auth).catch((e) => {
  // No signal on first open: keep working on this device.
  console.warn(e); if (!uid) { localOnly = true; try { claims = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch {} setSync('offline: saved in this browser', 'warn'); render(); }
});

async function saveClaim(c) {
  if (localOnly || !db || !uid) { claims.unshift(c); saveLocal(); render(); return; }
  // setDoc resolves when the server confirms; with no signal it is queued in the
  // on-device cache and the snapshot listener shows it immediately as pending.
  setDoc(doc(db, 'claims', c.id), { ...c, ownerUid: uid }).catch((e) => console.warn('save', e));
}
async function patchClaim(id, fields) {
  const c = claims.find((x) => x.id === id); if (c) Object.assign(c, fields);
  if (localOnly || !db) { saveLocal(); render(); return; }
  updateDoc(doc(db, 'claims', id), fields).catch((e) => console.warn('update', e));
  render();
}

// ---------- Helpers ----------
function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text && text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return { verdict: 'review', reason: 'Model reply was not valid JSON', issues: ['unparsed'], tree_visible: false, seedling_count: 0, freshly_planted: false };
}

// Resize for the model (Prompt API token budget) and keep a small thumbnail for sync.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const draw = (max, q) => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', q);
      };
      resolve({ dataUrl: draw(768, 0.85), thumb: draw(360, 0.7), hash: aHash(img) });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// 64-bit average hash: catches the same photo submitted twice, even resized or recompressed,
// across every phone that has synced the queue.
function aHash(img) {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0, 8, 8);
  const d = x.getImageData(0, 0, 8, 8).data; const g = [];
  for (let i = 0; i < d.length; i += 4) g.push((d[i] + d[i + 1] + d[i + 2]) / 3);
  const avg = g.reduce((a, b) => a + b, 0) / g.length;
  return g.map((v) => (v > avg ? '1' : '0')).join('');
}
const hamming = (a, b) => [...a].reduce((n, ch, i) => n + (ch !== b[i]), 0);

const badge = (src) => src === 'on_device'
  ? '<span class="pill ok">checked on device</span>'
  : src === 'in_cloud' ? '<span class="pill cloud">checked in cloud</span>' : '';
const vtag = (v) => `<span class="v ${v}">${v || '—'}</span>`;

// ---------- On-device availability ----------
async function deviceStatus() {
  const el = $('dev');
  if (!('LanguageModel' in self)) { el.textContent = 'on-device AI: not in this browser (cloud fallback)'; el.className = 'pill warn'; return; }
  try {
    const a = await self.LanguageModel.availability({ expectedInputs: [{ type: 'image' }] });
    el.textContent = `on-device AI: ${a}`;
    el.className = 'pill ' + (a === 'available' ? 'ok' : 'warn');
  } catch { el.textContent = 'on-device AI: unknown'; el.className = 'pill warn'; }
}
function netStatus() { const n = $('net'); n.textContent = navigator.onLine ? 'online' : 'offline'; n.className = 'pill ' + (navigator.onLine ? 'ok' : 'warn'); }
addEventListener('online', netStatus); addEventListener('offline', netStatus);

$('prep').onclick = async () => {
  $('prepMsg').textContent = 'Preparing…';
  try {
    await fieldModel.initializeDeviceModel((p) => { $('prepMsg').textContent = `Downloading Gemini Nano: ${Math.round(p * 100)}%`; });
    $('prepMsg').textContent = 'On-device model ready.';
  } catch (e) { $('prepMsg').textContent = 'On-device model not available here; checks will use the cloud.'; }
  deviceStatus();
};

// ---------- Capture ----------
$('photo').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const { dataUrl, thumb, hash } = await loadImage(f);
  current.image = dataUrl.split(',')[1]; current.mime = 'image/jpeg'; current.hash = hash; current.thumb = thumb;
  $('preview').src = dataUrl; $('check').disabled = false;
};
$('gpsBtn').onclick = () => {
  if (!navigator.geolocation) { $('gps').textContent = 'GPS: not supported'; return; }
  $('gps').textContent = 'GPS: locating…';
  navigator.geolocation.getCurrentPosition(
    (p) => { current.gps = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) };
      $('gps').textContent = `GPS: ${current.gps.lat}, ${current.gps.lng} (±${current.gps.acc} m)`; },
    () => { $('gps').textContent = 'GPS: permission denied'; }, { enableHighAccuracy: true, timeout: 15000 });
};

// ---------- On-device check (hybrid) ----------
$('check').onclick = async () => {
  const c = { id: crypto.randomUUID(), at: new Date().toISOString(), planter: $('planter').value.trim(), species: $('species').value.trim(),
    site: $('site').value.trim(), gps: current.gps, hash: current.hash, thumb: current.thumb };
  // Rule checks that need no AI, against every claim this device has synced.
  const dup = claims.find((o) => o.hash && hamming(o.hash, c.hash) <= 5);
  const r = $('result'); r.className = 'result'; r.innerHTML = 'Checking…'; $('check').disabled = true;
  const t0 = performance.now();
  try {
    const res = await fieldModel.generateContent([CHECK_PROMPT(c), { inlineData: { data: current.image, mimeType: current.mime } }]);
    c.device = parseJSON(res.response.text());
    c.deviceSource = res.response.inferenceSource;
  } catch (e) {
    console.warn(e);
    c.device = { verdict: 'review', reason: 'No AI available offline on this device; queued for cloud audit.', issues: ['not checked'] };
    c.deviceSource = 'none';
  }
  c.ms = Math.round(performance.now() - t0);
  if (dup) { c.device.issues = [...(c.device.issues || []), `duplicate photo of an earlier claim (${dup.planter || 'unknown'})`]; c.device.verdict = 'reject'; c.device.reason = 'Same photo as an earlier claim.'; }
  if (!c.gps) c.device.issues = [...(c.device.issues || []), 'no GPS'];
  c.audit = null; c.review = 'pending';
  await saveClaim(c);
  r.innerHTML = `${badge(c.deviceSource)} ${vtag(c.device.verdict)} <b>${esc(c.device.reason) || ''}</b><br><span class="muted">Seedlings: ${c.device.seedling_count ?? '—'} · Issues: ${esc((c.device.issues || []).join(', ')) || 'none'} · ${c.ms} ms</span>`;
  $('check').disabled = false;
};

// ---------- Cloud Ghost Audit ----------
$('audit').onclick = async () => {
  if (!navigator.onLine) { alertBox('Offline: the audit will run when you are back online.'); return; }
  const pending = claims.filter((c) => !c.audit && c.thumb);
  $('audit').disabled = true;
  for (const c of pending) {
    let audit;
    try {
      const data = c.thumb.split(',')[1];
      const res = await auditModel.generateContent([AUDIT_PROMPT(c), { inlineData: { data, mimeType: 'image/jpeg' } }]);
      audit = parseJSON(res.response.text());
    } catch (e) { audit = { verdict: 'review', reason: 'Audit failed: ' + e.message }; }
    await patchClaim(c.id, { audit });
  }
  $('audit').disabled = false;
};
function alertBox(msg) { const r = $('result'); r.className = 'result'; r.textContent = msg; }

// ---------- Reviewer ----------
window.setReview = (id, v) => patchClaim(id, { review: v, reviewedAt: new Date().toISOString(), reviewerUid: uid || 'local' });

function render() {
  const n = (f) => claims.filter(f).length;
  $('stats').innerHTML = `<b>${n((c) => c.review === 'approved')}</b> approved · <b>${n((c) => c.review === 'pending')}</b> waiting for a person · <b>${n((c) => c.review === 'rejected')}</b> rejected · <b>${n((c) => c.deviceSource === 'on_device')}</b> checked on device`;
  $('rows').innerHTML = claims.map((c) => `<tr>
    <td><img src="${c.thumb}" alt="" class="thumb"/>${c.pending ? '<br><span class="pill warn small">on device, syncing</span>' : ''}</td>
    <td><b>${esc(c.planter) || '—'}</b><br>${esc(c.species) || '—'}<br><span class="muted small">${esc(c.site)} ${c.gps ? `· ${c.gps.lat}, ${c.gps.lng}` : '· no GPS'}</span></td>
    <td>${badge(c.deviceSource)}<br>${vtag(c.device?.verdict)}<br><span class="small">${esc(c.device?.reason)}</span></td>
    <td>${c.audit ? vtag(c.audit.verdict) + '<br><span class="small">' + esc(c.audit.reason) + '</span>' : '<span class="muted small">waiting for signal</span>'}</td>
    <td>${c.review === 'pending' ? `<button class="sm ok" onclick="setReview('${c.id}','approved')">Approve</button> <button class="sm no" onclick="setReview('${c.id}','rejected')">Reject</button>` : `<span class="v ${c.review === 'approved' ? 'pass' : 'reject'}">${c.review}</span>`}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="muted">No claims yet.</td></tr>';
}
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])));

$('csv').onclick = () => {
  const head = ['id', 'time', 'planter', 'species', 'site', 'lat', 'lng', 'device_source', 'device_verdict', 'device_reason', 'audit_verdict', 'audit_reason', 'review'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = claims.map((c) => [c.id, c.at, c.planter, c.species, c.site, c.gps?.lat, c.gps?.lng, c.deviceSource, c.device?.verdict, c.device?.reason, c.audit?.verdict, c.audit?.reason, c.review].map(q).join(','));
  const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'eco-field-claims.csv'; a.click();
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
netStatus(); deviceStatus(); render();
if (aiError) { const d = $('dev'); d.textContent = 'AI not configured: add Firebase config'; d.className = 'pill warn'; }
if (dbError) setSync('sync unavailable', 'warn');
