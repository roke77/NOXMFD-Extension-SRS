// SRS page (docs/srs-plan.md, "Page design"). Renders the "srs" slice Plugin.cs publishes into
// NOXMFD's telemetry frame (SRS's own state packet plus its age) and posts controls to
// /ext/srs/command (SrsCommands.cs), which forwards them to SRS. Two layouts, picked with the
// toggle top right: COMPACT (the selected radio's head and a row per radio) and DUAL BAND (AE2:
// band scope, PTT = SRS's selected radio, MON = the page's monitor slot, radio buttons). In code
// PTT and MON are com[1] and com[2].
// Standby frequencies exist only here: swap sends the standby as the radio's new frequency.
import { TelemetrySource } from '/assets/services/telemetry-source.js';

const F = window.SrsFormat;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── canvas fit ──────────────────────────────────────────────────────────────────────────────
// The 900×900 square or, in a tall pane, the 640-wide portrait canvas (AE3 on the design canvas);
// F.fitCanvas picks. The portrait minimum heights are what each layout needs at 640 wide.
const PORTRAIT_MIN_H = { compact: 900, dual: 1160 };
// The shell's vertical MAIN label sits on one side edge (either, depending on the pane), so both
// sides keep the TGT page's inset: clamp(34px, 5vw, 48px).
const sideInset = () => Math.min(48, Math.max(34, innerWidth * 0.05));
let portrait = false;
function fitStage() {
  const was = portrait;
  const { s, W, H, portrait: p } = F.fitCanvas(innerWidth - 2 * sideInset(), innerHeight, PORTRAIT_MIN_H[layout]);
  portrait = p;
  const st = $('stage');
  st.classList.toggle('portrait', portrait);
  st.style.width = W + 'px';
  st.style.height = H + 'px';
  st.style.transform = `translate(${(innerWidth - W * s) / 2}px, ${(innerHeight - H * s) / 2}px) scale(${s})`;
  if (portrait !== was) rerender(); // the scope's geometry follows the canvas width
}

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
let com2Stored = store.get('com2', null);   // radio index the player put on MON
let layout = store.get('layout', 'compact') === 'dual' ? 'dual' : 'compact';
// radio → volume before MUTE, so unmuting restores it. ponytail: page memory only; after a reload
// unmute restores 100%.
const unmuted = {};
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
const X0 = 20, BASE = 120, BAR_MAX = 84, PX_PER_CLIENT = 6;
const scopeW = () => (portrait ? 568 : 844); // the scope's viewBox width on each canvas

function scopeSvg(v) {
  const band = v.band, X1 = scopeW() - 20;
  if (!band) return `<text class="sc-empty" x="${scopeW() / 2}" y="70" text-anchor="middle">NO SCOPE FOR THIS RADIO</text>`;
  const x = (hz) => F.scopeX(hz, band, X0, X1);
  // Labels near the right edge anchor to their end so they stay inside the scope. 14 clears the
  // cursor's 7 px half-width triangle with a gap.
  const anchor = (px) => (px > X1 - 170 ? 'end' : 'start');
  const off = (px) => (px > X1 - 170 ? -14 : 14);
  // Text goes in `t`, drawn after every bar and cursor so no line crosses a label (srs.css outlines it).
  let s = `<path class="sc-grid" d="M${X0} 40H${X1}M${X0} 80H${X1}"/><path class="sc-base" d="M${X0} ${BASE}H${X1}"/>`, t = '';
  for (let hz = band.lo; hz <= band.hi + 1; hz += band.step) {
    const px = x(hz);
    const a = hz === band.lo ? 'start' : hz + band.step > band.hi + 1 ? 'end' : 'middle';
    s += `<path class="sc-grid" d="M${px} 14V${BASE}"/><text class="sc-tick" x="${px}" y="140" text-anchor="${a}">${hz / 1e6}</text>`;
  }
  for (const b of F.scopeBars(v.radios, v.tuned, band, v.rx)) {
    const h = Math.max(3, Math.min(BAR_MAX, b.tuned * PX_PER_CLIENT));
    const px = x(b.hz);
    s += `<rect class="sc-bar${b.rx ? ' rx' : ''}" x="${px - 5}" y="${BASE - h}" width="10" height="${h}"/>`;
    // The speaker sits beside the bar's top, but never above y 80: rows 16–64 hold the cursor labels.
    if (b.rx) t += `<text class="sc-who" x="${px + off(px) * 1.5}" y="${Math.max(80, Math.min(BASE - 8, BASE - h + 14))}" text-anchor="${anchor(px)}">◄ ${esc(b.rx.who)}</text>`;
  }
  // Head cursors: MON first so PTT draws on top when they share a frequency. Each label has its
  // own row (active: 16 / 32, standby: 48 / 64), so a standby close to an active frequency can't
  // overprint it. Standby cursors are dashed and labelled "SBY"; the color says which head.
  [['c2', 'MON', v.com[2], 32, 64], ['c1', 'PTT', v.com[1], 16, 48]].forEach(([cls, label, i, y, sbyY]) => {
    const r = v.radios[i];
    if (i < 0 || !r || F.bandFor(r) !== band) return;
    const sby = standby[i];
    if (sby && sby >= band.lo && sby <= band.hi) {
      const sx = x(sby);
      s += `<path class="sc-cur sc-sby ${cls}" d="M${sx} 18V${BASE}"/>`;
      t += `<text class="sc-lbl ${cls}" x="${sx + off(sx)}" y="${sbyY}" text-anchor="${anchor(sx)}">SBY</text>`;
    }
    const px = x(r.freq);
    s += `<path class="sc-cur ${cls}" d="M${px} 18V${BASE}"/><path class="sc-tri ${cls}" d="M${px - 7} 8h14l-7 10z"/>`;
    t += `<text class="sc-lbl ${cls}" x="${px + off(px)}" y="${y}" text-anchor="${anchor(px)}">${label} ${F.freq(r.freq)} · ${v.tuned[i] || 0}</text>`;
  });
  return s + t;
}

// ── radio heads ─────────────────────────────────────────────────────────────────────────────
const KP = '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#kp-glyph"/></svg>';
const SWAP = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h14l-3-3M20 16H6l3 3"/></svg>';

// n = 1 is SRS's selected radio (PTT, or SELECTED in compact), n = 2 is MON with its ◄ / ► picker.
function comHtml(n, v, title) {
  const i = v ? v.com[n] : -1;
  const r = v && i > 0 ? v.radios[i] : null;
  const tx = r && F.isTx(v.send, i), rx = r && v.rx[i];
  const tun = F.tunable(r), sby = r ? standby[i] : null;
  const disabled = tun ? '' : ' disabled';
  const badge = tx ? '<span class="badge tx">TX</span>' : rx ? '<span class="badge rx">RX</span>' : '<span class="badge"></span>';
  const vol = r ? Math.round((r.volume ?? 0) * 100) : 0;
  const volCtl = r && r.volMode === 1
    ? `<button class="vol" data-act="vol" data-com="${n}" aria-label="${title} volume ${vol}%, tap to set"><div><div style="width:${vol}%"></div></div></button>`
    : `<span class="vol"><div><div style="width:${vol}%"></div></div></span>`;
  const name = r ? `R${i} ${esc(r.name)}` : F.DASH;
  const pick = (dir, glyph, what) => `<button class="mon-step" data-act="mon" data-dir="${dir}" aria-label="${what} radio on MON"${v ? '' : ' disabled'}>${glyph}</button>`;
  const label = n === 2 ? `${title} · ${pick(-1, '◄', 'Previous')}${name}${pick(1, '►', 'Next')}` : `${title} · ${name}`;
  return `<div class="com-top"><span class="com-name">${label}</span>${badge}</div>
    <div class="com-mid">
      <div class="act"><span class="lbl">ACTIVE${r && v.names[i] ? ` · <span class="pre-n">${esc(v.names[i])}</span>` : ''}</span><span class="act-f">${r ? F.freq(r.freq) : F.DASH}</span></div>
      <button class="swap" data-act="swap" data-com="${n}" aria-label="Swap ${title} active and standby"${tun && sby ? '' : ' disabled'}>${SWAP}</button>
      <button class="sby" data-act="sby" data-com="${n}" aria-label="${title} standby frequency, tap to type"${disabled}><span class="lbl">STANDBY</span><span class="sby-v">${sby ? F.freq(sby) : F.DASH}${KP}</span></button>
      <div class="steps"><button data-act="up" data-com="${n}" aria-label="${title} standby up"${disabled}>▲</button><button data-act="down" data-com="${n}" aria-label="${title} standby down"${disabled}>▼</button></div>
    </div>
    <div class="com-foot">${r ? `<span>${F.modName(r.modulation)} · ${v.tuned[i] || 0} TUNED</span>` : ''}
      <span class="right">${rx ? `<span class="who">◄ ${esc(rx.who)}</span>` : ''}${r ? `<span>VOL</span>${volCtl}<span class="c2">${vol}</span>` : ''}</span></div>`;
}

// ── radio buttons and compact rows ──────────────────────────────────────────────────────────
// A radio's lamp class and speaker markup: ► YOU while transmitting, the held speaker while
// receiving, else a dash.
function activity(v, i) {
  const tx = F.isTx(v.send, i), rx = v.rx[i];
  return {
    lamp: tx ? 'tx' : rx ? 'rx' : '',
    who: tx ? '<span class="rad-who tx">► YOU</span>'
       : rx ? `<span class="rad-who rx">◄ ${esc(rx.who)}</span>`
       : `<span class="rad-who">${F.DASH}</span>`,
  };
}

// A radio's preset name where it's on one (in place of the frequency, which stays in the tooltip),
// else its frequency.
function freqOrPreset(v, i, r) {
  const name = v.names[i];
  return name ? `<span class="f pre" title="${F.freq(r.freq)} MHZ">${esc(name)}</span>` : `<span class="f">${F.freq(r.freq)}</span>`;
}

function radsHtml(v) {
  let s = '';
  for (let i = 1; i <= 10; i++) {
    const r = v && v.radios[i];
    if (!F.usable(r)) {
      // No data is a dash; OFF only when SRS reports the radio as DISABLED.
      s += `<button class="rad off" disabled><span class="rad-top"><span class="lamp"></span>R${i}<span class="f">${v ? 'OFF' : F.DASH}</span></span><span class="rad-who">${F.DASH}</span></button>`;
      continue;
    }
    const { lamp, who } = activity(v, i);
    const cls = i === v.com[1] ? ' c1' : i === v.com[2] ? ' c2' : '';
    s += `<button class="rad${cls}" data-act="rad" data-r="${i}" aria-label="Talk on R${i}"><span class="rad-top"><span class="lamp ${lamp}"></span>R${i}${freqOrPreset(v, i, r)}</span>${who}</button>`;
  }
  return s;
}

function rowsHtml(v) {
  let s = '';
  for (let i = 1; i <= 10; i++) {
    const r = v && v.radios[i];
    if (!F.usable(r)) {
      s += `<div class="row off"><button class="row-pick" disabled><span class="lamp"></span><span class="rn">R${i}</span><span class="f">${v ? 'OFF' : F.DASH}</span></button><button class="mute" disabled>MUTE</button></div>`;
      continue;
    }
    const { lamp, who } = activity(v, i), muted = !(r.volume > 0);
    const mute = `<button class="mute${muted ? ' on' : ''}" data-act="mute" data-r="${i}" aria-label="${muted ? 'Unmute' : 'Mute'} R${i}"${r.volMode === 1 ? '' : ' disabled'}>${muted ? 'MUTED' : 'MUTE'}</button>`;
    s += `<div class="row${i === v.com[1] ? ' c1' : ''}"><button class="row-pick" data-act="rad" data-r="${i}" aria-label="Select R${i}"><span class="lamp ${lamp}"></span><span class="rn">R${i}</span>${freqOrPreset(v, i, r)}${who}<span class="tun">${v.tuned[i] || 0} TUNED</span></button>${mute}</div>`;
  }
  return s;
}

// ── render ──────────────────────────────────────────────────────────────────────────────────
function view(st, presets) {
  const info = st.RadioInfo, radios = info.radios || [];
  const now = Date.now(), rx = {};
  (st.RadioReceivingState || []).forEach((e, i) => { const w = F.speaker(e, i, now, held); if (w) rx[i] = w; });
  const sel = info.selected;
  const com = { 1: F.usable(radios[sel]) ? sel : -1, 2: F.com2Pick(radios, sel, com2Stored) };
  const band = F.bandFor(radios[com[1]]) || F.bandFor(radios[com[2]]) || F.BANDS[0];
  const names = {};
  for (let i = 1; i < radios.length; i++) names[i] = F.presetName(presets, radios[i]);
  return { radios, tuned: st.TunedClients || [], send: st.RadioSendingState, rx, com, band, names, st };
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
  $('scope').setAttribute('viewBox', `0 0 ${scopeW()} 150`);
  setHtml('scope', v ? scopeSvg(v) : '');
  setHtml('com1', comHtml(1, v, 'PTT'));
  setHtml('com2', comHtml(2, v, 'MON'));
  setHtml('rads', radsHtml(v));
  setHtml('cpt', comHtml(1, v, 'SELECTED'));
  setHtml('rows', rowsHtml(v));
  if (!v) closeKeypad();
}

function showLayout() {
  $('compact').hidden = layout !== 'compact';
  $('dual').hidden = layout !== 'dual';
  $('layout-tog').classList.toggle('dual', layout === 'dual');
  $('layout-tog').setAttribute('aria-checked', String(layout === 'dual'));
}

function statusText(s) {
  if (s.reason === 'port-busy') return `UDP ${s.port} IN USE BY ANOTHER PROGRAM`;
  if (s.reason === 'stale') return `NO SRS DATA FOR ${Math.round(s.ageMs / 1000)} S`;
  return `NO SRS DATA ON UDP ${s.port}`;
}

// The server's preset list arrives as a JSON string in every frame (Plugin.cs BuildSlice); it's
// parsed only when it changes. A list that doesn't parse is ignored: frequencies show instead.
let presetsRaw = null, presets = null;
function readPresets(raw) {
  if (raw === presetsRaw) return presets;
  presetsRaw = raw;
  try { presets = typeof raw === 'string' ? JSON.parse(raw) : null; }
  catch (e) { presets = null; console.warn('[SRS] unreadable server presets:', e.message); }
  return presets;
}

function show(s) {
  // Without live data the page would show stale radios as current, so every other path clears it.
  if (!s.ok) return render(null, statusText(s), true);
  // The packet is SRS's internal state, not a documented API: a shape this page doesn't know
  // reports itself instead of throwing on every frame.
  const info = s.state && s.state.RadioInfo;
  if (!info || !Array.isArray(info.radios)) return render(null, 'UNRECOGNISED SRS DATA', true);
  render(view(s.state, readPresets(s.presets)), `● ${info.unit} · ${s.state.ClientCountConnected} ON SERVER`, false);
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
  vol(n, e, el) {
    const i = lastV ? lastV.com[n] : -1;
    if (i < 1) return;
    const box = el.getBoundingClientRect(); // screen px, already scaled like the stage
    post({ cmd: 'volume', radio: i, vol: F.volAt(e.clientX - box.left, box.width) });
  },
  mute(_, e, el) {
    const i = Number(el.dataset.r), r = lastV && lastV.radios[i];
    if (!r) return;
    if (r.volume > 0) { unmuted[i] = r.volume; post({ cmd: 'volume', radio: i, vol: 0 }); }
    else post({ cmd: 'volume', radio: i, vol: unmuted[i] || 1 });
  },
  layout() {
    layout = layout === 'dual' ? 'compact' : 'dual';
    store.set('layout', layout);
    showLayout();
    fitStage();
  },
  // Tapping a radio (a dual-band button or a compact row) makes it PTT. MON's radio moving to PTT
  // drops the MON pick, so MON takes its default instead of jumping back when PTT moves on.
  rad(_, e, el) {
    const i = Number(el.dataset.r);
    post({ cmd: 'select', radio: i });
    if (com2Stored === i) { com2Stored = null; store.set('com2', null); }
  },
  mon(_, e, el) {
    if (!lastV) return;
    com2Stored = F.monStep(lastV.radios, lastV.com[1], lastV.com[2], Number(el.dataset.dir));
    store.set('com2', com2Stored);
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
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  ACTIONS[el.dataset.act](Number(el.dataset.com), e, el);
  rerender();
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
  $('kp-title').textContent = `R${c.i} STANDBY MHZ`;
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

addEventListener('resize', fitStage);
fitStage();
showLayout();
render(null, 'WAITING FOR MISSION', false);
const source = new TelemetrySource({ onFrame, onNoMission });
source.connect();
addEventListener('pagehide', () => source.disconnect());
