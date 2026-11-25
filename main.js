import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app-check.js';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js';
import { FIREBASE_CONFIG, CLOUD_MODEL_NAME, RECAPTCHA_SITE_KEY, APPCHECK_DEBUG_TOKEN } from './config.js';

// ---------- Firebase setup ----------
const cfg = FIREBASE_CONFIG;
const app = initializeApp(cfg);
if (APPCHECK_DEBUG_TOKEN) self.FIREBASE_APPCHECK_DEBUG_TOKEN = APPCHECK_DEBUG_TOKEN;
if (RECAPTCHA_SITE_KEY || APPCHECK_DEBUG_TOKEN) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY || 'debug-only'),
    isTokenAutoRefreshEnabled: true,
  });
}
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
let claims = [];
try { claims = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { claims = []; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(claims)); } catch (e) { console.warn('storage full', e); } };
let current = { image: null, mime: null, hash: null, gps: null };

// ---------- Helpers ----------
function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text && text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return { verdict: 'review', reason: 'Model reply was not valid JSON', issues: ['unparsed'], tree_visible: false, seedling_count: 0, freshly_planted: false };
}

// Resize to keep on-device input small (Prompt API token budget) and store a thumbnail.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const max = 768;
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.85);
      resolve({ dataUrl, hash: aHash(img) });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// 64-bit average hash: catches the same photo submitted twice, even resized or recompressed.
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
  const { dataUrl, hash } = await loadImage(f);
  current.image = dataUrl.split(',')[1]; current.mime = 'image/jpeg'; current.hash = hash;
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
    site: $('site').value.trim(), gps: current.gps, hash: current.hash, thumb: $('preview').src };
  // Rule checks that need no AI
  const dup = claims.find((o) => o.hash && hamming(o.hash, c.hash) <= 5);
  const r = $('result'); r.className = 'result'; r.innerHTML = 'Checking…'; $('check').disabled = true;
  const t0 = performance.now();
  try {
    const res = await fieldModel.generateContent([CHECK_PROMPT(c), { inlineData: { data: current.image, mimeType: current.mime } }]);
    c.device = parseJSON(res.response.text());
    c.deviceSource = res.response.inferenceSource;
  } catch (e) {
    c.device = { verdict: 'review', reason: 'No AI available offline on this device; queued for cloud audit.', issues: ['not checked'] };
    c.deviceSource = 'none';
  }
  c.ms = Math.round(performance.now() - t0);
  if (dup) { c.device.issues = [...(c.device.issues || []), 'duplicate photo of an earlier claim']; c.device.verdict = 'reject'; c.device.reason = 'Same photo as an earlier claim.'; }
  if (!c.gps) c.device.issues = [...(c.device.issues || []), 'no GPS'];
  c.audit = null; c.review = 'pending';
  claims.unshift(c); save(); render();
  r.innerHTML = `${badge(c.deviceSource)} ${vtag(c.device.verdict)} <b>${c.device.reason || ''}</b><br><span class="muted">Seedlings: ${c.device.seedling_count ?? '—'} · Issues: ${(c.device.issues || []).join(', ') || 'none'} · ${c.ms} ms</span>`;
  $('check').disabled = false;
};

// ---------- Cloud Ghost Audit ----------
$('audit').onclick = async () => {
  if (!navigator.onLine) { alertBox('Offline: the audit will run when you are back online.'); return; }
  const pending = claims.filter((c) => !c.audit && c.thumb);
  for (const c of pending) {
    try {
      const data = c.thumb.split(',')[1];
      const res = await auditModel.generateContent([AUDIT_PROMPT(c), { inlineData: { data, mimeType: 'image/jpeg' } }]);
      c.audit = parseJSON(res.response.text());
    } catch (e) { c.audit = { verdict: 'review', reason: 'Audit failed: ' + e.message }; }
    save(); render();
  }
};
function alertBox(msg) { const r = $('result'); r.className = 'result'; r.textContent = msg; }

// ---------- Reviewer ----------
window.setReview = (id, v) => { const c = claims.find((x) => x.id === id); if (c) { c.review = v; c.reviewedAt = new Date().toISOString(); save(); render(); } };

function render() {
  $('rows').innerHTML = claims.map((c) => `<tr>
    <td><img src="${c.thumb}" alt="" class="thumb"/></td>
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
if (aiError) { const d = document.getElementById('dev'); d.textContent = 'AI not configured: add Firebase config'; d.className = 'pill warn'; }
