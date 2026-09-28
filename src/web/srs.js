// SRS page, AE2 design (docs/srs-plan.md, "Page design"). Renders the "srs" slice Plugin.cs
// publishes into NOXMFD's telemetry frame (SRS's own state packet plus its age) and posts controls
// to /ext/srs/command (SrsCommands.cs), which forwards them to SRS. COM 1 is SRS's selected radio;
// COM 2 is the page's monitor slot. Standby frequencies exist only here: swap sends the standby as
// the radio's new frequency. The band scope follows COM 1's band.
import { TelemetrySource } from '/assets/services/telemetry-source.js';

const F = window.SrsFormat;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── canvas fit ──────────────────────────────────────────────────────────────────────────────
const STAGE = 900;
// The shell's vertical MAIN label sits on one side edge (either, depending on the pane), so both
// sides keep the TGT page's inset: clamp(34px, 5vw, 48px).
const sideInset = () => Math.min(48, Math.max(34, innerWidth * 0.05));
function fitStage() {
  const s = Math.min(innerWidth - 2 * sideInset(), innerHeight) / STAGE;
  $('stage').style.transform =
    `translate(${(innerWidth - STAGE * s) / 2}px, ${(innerHeight - STAGE * s) / 2}px) scale(${s})`;
}
addEventListener('resize', fitStage);
fitStage();

// ── page state ──────────────────────────────────────────────────────────────────────────────
// Remembered per browser (docs/srs-plan.md, "Phase 2 controls"). Storage can throw (private mode,
// blocked site data), so the page works without it; it just forgets on reload.
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem('srs.' + key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('srs.' + key, JSON.stringify(value)); } catch { /* not remembered */ } },
};
// radio index → Hz. Only finite positive numbers are kept: storage is outside the page's control.
const standby = Object.fromEntries(Object.entries(store.get('standby', {}))
  .filter(([, hz]) => Number.isFinite(hz) && hz > 0));
let com2Stored = store.get('com2', null);   // radio index the player put on COM 2
let selCom = 1;                              // the COM an R button tap assigns to
const held = {};                             // speakers held after SRS stops reporting them (F.speaker)
let lastState = null, lastV = null;

// ── commands ────────────────────────────────────────────────────────────────────────────────
function post(payload) {
  // NOXMFD's command endpoint requires an exact application/json Content-Type. A failure is logged,
  // not thrown: the next state packet shows what SRS actually holds.
  fetch('/ext/srs/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => {
    if (!r.ok) console.warn('[SRS] command rejected:', payload.cmd, r.status);
  }, (err) => console.warn('[SRS] command failed:', payload.cmd, err && err.message));
}

function setStandby(i, hz) {
  standby[i] = hz;
  store.set('standby', standby);
}

// ── band scope ──────────────────────────────────────────────────────────────────────────────
const X0 = 20, X1 = 824, BASE = 120, BAR_MAX = 84, PX_PER_CLIENT = 6;

function scopeSvg(v) {
  const band = v.band;
  if (!band) return `<text class="sc-empty" x="422" y="70" text-anchor="middle">NO SCOPE FOR THIS RADIO</text>`;
  const x = (hz) => F.scopeX(hz, band, X0, X1);
  // Labels near the right edge anchor to their end so they stay inside the scope. 14 clears the
  // cursor's 7 px half-width triangle with a gap.
  const anchor = (px) => (px > X1 - 170 ? 'end' : 'start');
  const off = (px) => (px > X1 - 170 ? -14 : 14);
  let s = `<path class="sc-grid" d="M${X0} 40H${X1}M${X0} 80H${X1}"/><path class="sc-base" d="M${X0} ${BASE}H${X1}"/>`;
  for (let hz = band.lo; hz <= band.hi + 1; hz += band.step) {
    const px = x(hz);
    const a = hz === band.lo ? 'start' : hz + band.step > band.hi + 1 ? 'end' : 'middle';
    s += `<path class="sc-grid" d="M${px} 14V${BASE}"/><text class="sc-tick" x="${px}" y="140" text-anchor="${a}">${hz / 1e6}</text>`;
  }
  for (const g of F.guards(v.radios, band)) {
    const px = x(g);
    s += `<path class="sc-grd" d="M${px} 14V${BASE}"/><text class="sc-grd-t" x="${px - 6}" y="${BASE - 6}" text-anchor="end">GRD</text>`;
  }
  for (const b of F.scopeBars(v.radios, v.tuned, band, v.rx)) {
    const h = Math.max(3, Math.min(BAR_MAX, b.tuned * PX_PER_CLIENT));
    const px = x(b.hz);
    s += `<rect class="sc-bar${b.rx ? ' rx' : ''}" x="${px - 5}" y="${BASE - h}" width="10" height="${h}"/>`;
    if (b.rx) s += `<text class="sc-who" x="${px + off(px) * 1.5}" y="${Math.min(BASE - 8, BASE - h + 14)}" text-anchor="${anchor(px)}">◄ ${esc(b.rx.who)}</text>`;
  }
  // COM cursors: COM 2 first so COM 1 draws on top when they share a frequency. Each label has its
  // own row (active: 16 / 32, standby: 48 / 64), so a standby close to an active frequency can't
  // overprint it. Standby cursors are dashed and labelled "SBY"; the color says which COM.
  [['c2', v.com[2], 32, 64], ['c1', v.com[1], 16, 48]].forEach(([cls, i, y, sbyY]) => {
    const r = v.radios[i];
    if (i < 0 || !r || F.bandFor(r) !== band) return;
    const sby = standby[i];
    if (sby && sby >= band.lo && sby <= band.hi) {
      const sx = x(sby);
      s += `<path class="sc-cur sc-sby ${cls}" d="M${sx} 18V${BASE}"/><text class="sc-lbl ${cls}" x="${sx + off(sx)}" y="${sbyY}" text-anchor="${anchor(sx)}">SBY</text>`;
    }
    const px = x(r.freq);
    s += `<path class="sc-cur ${cls}" d="M${px} 18V${BASE}"/><path class="sc-tri ${cls}" d="M${px - 7} 8h14l-7 10z"/>` +
         `<text class="sc-lbl ${cls}" x="${px + off(px)}" y="${y}" text-anchor="${anchor(px)}">${cls.toUpperCase()} ${F.freq(r.freq)} · ${v.tuned[i] || 0}</text>`;
  });
  return s;
}

// ── COM heads ───────────────────────────────────────────────────────────────────────────────
const KP = '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#kp-glyph"/></svg>';
const SWAP = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h14l-3-3M20 16H6l3 3"/></svg>';

function comHtml(n, v) {
  const i = v ? v.com[n] : -1;
  const r = v && i > 0 ? v.radios[i] : null;
  const tx = r && F.isTx(v.send, i), rx = r && v.rx[i];
  const tun = F.tunable(r), sby = r ? standby[i] : null;
  const disabled = tun ? '' : ' disabled';
  const badge = tx ? '<span class="badge tx">TX</span>' : rx ? '<span class="badge rx">RX</span>' : '<span class="badge"></span>';
  const vol = r ? Math.round((r.volume ?? 0) * 100) : 0;
  const grd = r && tun ? `<button class="grd" data-act="grd" data-com="${n}" aria-label="Toggle guard on COM ${n}">${F.guard(r.secFreq)}</button>`
            : r ? `<span>${F.guard(r.secFreq)}</span>` : '';
  const volCtl = r && r.volMode === 1
    ? `<button class="vol" data-act="vol" data-com="${n}" aria-label="COM ${n} volume ${vol}%, tap to set"><div><div style="width:${vol}%"></div></div></button>`
    : `<span class="vol"><div><div style="width:${vol}%"></div></div></span>`;
  return `<div class="com-top"><span>COM ${n} · ${r ? `R${i} ${esc(r.name)}` : F.DASH}</span>${badge}</div>
    <div class="com-mid">
      <div class="act"><span class="lbl">ACTIVE</span><span class="act-f">${r ? F.freq(r.freq) : F.DASH}</span></div>
      <button class="swap" data-act="swap" data-com="${n}" aria-label="Swap COM ${n} active and standby"${tun && sby ? '' : ' disabled'}>${SWAP}</button>
      <button class="sby" data-act="sby" data-com="${n}" aria-label="COM ${n} standby frequency, tap to type"${disabled}><span class="lbl">STANDBY</span><span class="sby-v">${sby ? F.freq(sby) : F.DASH}${KP}</span></button>
      <div class="steps"><button data-act="up" data-com="${n}" aria-label="COM ${n} standby up"${disabled}>▲</button><button data-act="down" data-com="${n}" aria-label="COM ${n} standby down"${disabled}>▼</button></div>
    </div>
    <div class="com-foot">${r ? `<span>${F.modName(r.modulation)} · ${v.tuned[i] || 0} TUNED ·</span>${grd}` : ''}
      <span class="right">${rx ? `<span class="who">◄ ${esc(rx.who)}</span>` : ''}${r ? `<span>VOL</span>${volCtl}<span class="c2">${vol}</span>` : ''}</span></div>`;
}

// ── radio buttons ───────────────────────────────────────────────────────────────────────────
function radsHtml(v) {
  let s = '';
  for (let i = 1; i <= 10; i++) {
    const r = v && v.radios[i];
    if (!F.usable(r)) {
      // No data is a dash; OFF only when SRS reports the radio as DISABLED.
      s += `<button class="rad off" disabled><span class="rad-top"><span class="lamp"></span>R${i}<span class="f">${v ? 'OFF' : F.DASH}</span></span><span class="rad-who">${F.DASH}</span></button>`;
      continue;
    }
    const tx = F.isTx(v.send, i), rx = v.rx[i];
    const cls = i === v.com[1] ? ' c1' : i === v.com[2] ? ' c2' : '';
    const lamp = tx ? 'tx' : rx ? 'rx' : '';
    const who = tx ? '<span class="rad-who tx">► YOU</span>'
              : rx ? `<span class="rad-who rx">◄ ${esc(rx.who)}</span>`
              : `<span class="rad-who">${F.DASH}</span>`;
    s += `<button class="rad${cls}" data-act="rad" data-r="${i}" aria-label="Assign R${i} to COM ${selCom}"><span class="rad-top"><span class="lamp ${lamp}"></span>R${i}<span class="f">${F.freq(r.freq)}</span></span>${who}</button>`;
  }
  return s;
}

// ── render ──────────────────────────────────────────────────────────────────────────────────
function view(st) {
  const info = st.RadioInfo, radios = info.radios || [];
  const now = Date.now(), rx = {};
  (st.RadioReceivingState || []).forEach((e, i) => { const w = F.speaker(e, i, now, held); if (w) rx[i] = w; });
  const sel = info.selected;
  const com = { 1: F.usable(radios[sel]) ? sel : -1, 2: F.com2Pick(radios, sel, com2Stored) };
  const band = F.bandFor(radios[com[1]]) || F.bandFor(radios[com[2]]) || F.BANDS[0];
  return { radios, tuned: st.TunedClients || [], send: st.RadioSendingState, rx, com, band, st };
}

// Only touch the DOM when a block's markup changed: rebuilding buttons at 10 Hz could swap one out
// between press and release and swallow the tap.
const shown = {};
function setHtml(id, html) {
  if (shown[id] === html) return;
  shown[id] = html;
  $(id).innerHTML = html;
}

function render(v, status, bad) {
  lastV = v;
  setHtml('status', esc(status));
  $('status').className = 'status' + (bad ? ' bad' : '');
  setHtml('band', v ? v.band.label : F.DASH);
  setHtml('scope', v ? scopeSvg(v) : '');
  setHtml('com1', comHtml(1, v));
  setHtml('com2', comHtml(2, v));
  $('com1').classList.toggle('sel', selCom === 1);
  $('com2').classList.toggle('sel', selCom === 2);
  setHtml('rads', radsHtml(v));
  if (!v) closeKeypad();
}

function statusText(s) {
  if (s.reason === 'port-busy') return `UDP ${s.port} IN USE BY ANOTHER PROGRAM`;
  if (s.reason === 'stale') return `NO SRS DATA FOR ${Math.round(s.ageMs / 1000)} S`;
  return `NO SRS DATA ON UDP ${s.port}`;
}

function show(s) {
  // Without live data the page would show stale radios as current, so every other path clears it.
  if (!s.ok) return render(null, statusText(s), true);
  // The packet is SRS's internal state, not a documented API: a shape this page doesn't know
  // reports itself instead of throwing on every frame.
  const info = s.state && s.state.RadioInfo;
  if (!info || !Array.isArray(info.radios)) return render(null, 'UNRECOGNISED SRS DATA', true);
  render(view(s.state), `● ${info.unit} · ${s.state.ClientCountConnected} ON SERVER`, false);
}

// Re-render right after a local change instead of waiting for the next 10 Hz frame.
function rerender() {
  if (lastState) show(lastState);
}

// ── controls ────────────────────────────────────────────────────────────────────────────────
function comRadio(n) {
  const i = lastV ? lastV.com[n] : -1;
  const r = i > 0 ? lastV.radios[i] : null;
  return F.tunable(r) ? { i, r } : null;
}

const ACTIONS = {
  swap(n) {
    const c = comRadio(n);
    if (!c || !standby[c.i]) return;
    post({ cmd: 'freq', radio: c.i, mhz: standby[c.i] / 1e6 });
    setStandby(c.i, c.r.freq);
  },
  up(n) { step(n, 1); },
  down(n) { step(n, -1); },
  sby(n) { openKeypad(n); },
  grd(n) { const c = comRadio(n); if (c) post({ cmd: 'guard', radio: c.i }); },
  vol(n, e, el) {
    const i = lastV ? lastV.com[n] : -1;
    if (i < 1) return;
    const box = el.getBoundingClientRect(); // screen px, already scaled like the stage
    post({ cmd: 'volume', radio: i, vol: F.volAt(e.clientX - box.left, box.width) });
  },
  rad(_, e, el) {
    const i = Number(el.dataset.r);
    if (!lastV) return;
    if (selCom === 1) {
      post({ cmd: 'select', radio: i });
      if (com2Stored === i) { com2Stored = null; store.set('com2', null); }
    } else if (i !== lastV.com[1]) {
      com2Stored = i;
      store.set('com2', i);
    }
    rerender();
  },
};

function step(n, dir) {
  const c = comRadio(n);
  if (!c) return;
  setStandby(c.i, F.stepHz(standby[c.i] || c.r.freq, dir, c.r));
  rerender();
}

$('stage').addEventListener('click', (e) => {
  if (e.target.closest('#keypad')) return;
  const head = e.target.closest('.com');
  if (head) selCom = head.id === 'com2' ? 2 : 1;
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) ACTIONS[el.dataset.act](Number(el.dataset.com), e, el);
  if (head || el) rerender();
});

// ── keypad ──────────────────────────────────────────────────────────────────────────────────
let kpCom = 0, kpText = '';

function kpShow(error) {
  $('kp-display').textContent = kpText;
  $('kp-display').classList.toggle('bad', !!error);
  $('kp-error').textContent = error || '';
}

function openKeypad(n) {
  const c = comRadio(n);
  if (!c) return;
  kpCom = n;
  kpText = '';
  $('kp-title').textContent = `COM ${n} · R${c.i} STANDBY MHZ`;
  $('kp-range').textContent = `${F.freq(c.r.freqMin)} – ${F.freq(c.r.freqMax)}`;
  kpShow('');
  $('keypad').hidden = false;
}

function closeKeypad() {
  kpCom = 0;
  $('keypad').hidden = true;
}

function kpEnter() {
  const c = comRadio(kpCom);
  if (!c) return closeKeypad();
  const mhz = F.parseMhz(kpText), err = F.entryError(mhz, c.r);
  if (err) return kpShow(err);
  setStandby(c.i, Math.round(mhz * 1e6));
  closeKeypad();
  rerender();
}

$('kp-grid').addEventListener('click', (e) => {
  const k = e.target.closest('[data-k]')?.dataset.k;
  if (!k) return;
  if (k === 'back') kpText = kpText.slice(0, -1);
  else if (kpText.length < 7) kpText += k;
  kpShow('');
});
$('kp-cancel').addEventListener('click', closeKeypad);
$('kp-enter').addEventListener('click', kpEnter);

// ── telemetry ───────────────────────────────────────────────────────────────────────────────
function onFrame(d) {
  const s = d.ext && d.ext.srs;
  if (!s) return;
  lastState = s;
  show(s);
}

function onNoMission() {
  lastState = null;
  render(null, 'WAITING FOR MISSION', false);
}

render(null, 'WAITING FOR MISSION', false);
const source = new TelemetrySource({ onFrame, onNoMission });
source.connect();
addEventListener('pagehide', () => source.disconnect());
