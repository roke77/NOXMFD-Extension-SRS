// SRS page, AE2 design (docs/srs-plan.md, "Page design"), Phase 1: read-only. Renders the "srs"
// slice Plugin.cs publishes into NOXMFD's telemetry frame: SRS's own state packet plus its age.
// COM 1 is SRS's selected radio; COM 2 is the page's monitor slot (its default until Phase 2 adds
// assignment). The band scope follows COM 1's band.
import { TelemetrySource } from '/assets/services/telemetry-source.js';

const F = window.SrsFormat;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── canvas fit ──────────────────────────────────────────────────────────────────────────────
const STAGE = 900;
function fitStage() {
  const s = Math.min(innerWidth, innerHeight) / STAGE;
  $('stage').style.transform =
    `translate(${(innerWidth - STAGE * s) / 2}px, ${(innerHeight - STAGE * s) / 2}px) scale(${s})`;
}
addEventListener('resize', fitStage);
fitStage();

// Speakers held after SRS stops reporting them (F.speaker).
const held = {};

// ── band scope ──────────────────────────────────────────────────────────────────────────────
const X0 = 20, X1 = 824, BASE = 120, BAR_MAX = 84, PX_PER_CLIENT = 6;

function scopeSvg(v) {
  const band = v.band;
  if (!band) return `<text class="sc-empty" x="422" y="70" text-anchor="middle">NO SCOPE FOR THIS RADIO</text>`;
  const x = (hz) => F.scopeX(hz, band, X0, X1);
  // Labels near the right edge anchor to their end so they stay inside the scope.
  const anchor = (px) => (px > X1 - 170 ? 'end' : 'start');
  const off = (px) => (px > X1 - 170 ? -8 : 8);
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
  // COM cursors: COM 2 first so COM 1 draws on top when they share a frequency.
  [['c2', v.com[2], 32], ['c1', v.com[1], 16]].forEach(([cls, i, y]) => {
    const r = v.radios[i];
    if (i < 0 || !r || F.bandFor(r) !== band) return;
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
  const badge = tx ? '<span class="badge tx">TX</span>' : rx ? '<span class="badge rx">RX</span>' : '<span class="badge"></span>';
  const vol = r ? Math.round((r.volume ?? 0) * 100) : 0;
  const right = rx ? `<span class="who">◄ ${esc(rx.who)}</span>`
              : r ? `<span>VOL</span><div class="vol"><div style="width:${vol}%"></div></div><span class="c2">${vol}</span>`
              : '';
  return `<div class="com-top"><span>COM ${n} · ${r ? `R${i} ${esc(r.name)}` : F.DASH}</span>${badge}</div>
    <div class="com-mid">
      <div class="act"><span class="lbl">ACTIVE</span><span class="act-f">${r ? F.freq(r.freq) : F.DASH}</span></div>
      <button class="swap p2" aria-label="Swap COM ${n} active and standby">${SWAP}</button>
      <button class="sby p2" aria-label="COM ${n} standby frequency, tap to type"><span class="lbl">STANDBY</span><span class="sby-v">${F.DASH}${KP}</span></button>
      <div class="steps p2"><button aria-label="COM ${n} standby up">▲</button><button aria-label="COM ${n} standby down">▼</button></div>
    </div>
    <div class="com-foot">${r ? `<span>${F.modName(r.modulation)} · ${v.tuned[i] || 0} TUNED · ${F.guard(r.secFreq)}</span>` : ''}<span class="right">${right}</span></div>`;
}

// ── radio buttons ───────────────────────────────────────────────────────────────────────────
function radsHtml(v) {
  let s = '';
  for (let i = 1; i <= 10; i++) {
    const r = v && v.radios[i];
    if (!F.usable(r)) {
      // No data is a dash; OFF only when SRS reports the radio as DISABLED.
      s += `<div class="rad off"><span class="rad-top"><span class="lamp"></span>R${i}<span class="f">${v ? 'OFF' : F.DASH}</span></span><span class="rad-who">${F.DASH}</span></div>`;
      continue;
    }
    const tx = F.isTx(v.send, i), rx = v.rx[i];
    const cls = i === v.com[1] ? ' c1' : i === v.com[2] ? ' c2' : '';
    const lamp = tx ? 'tx' : rx ? 'rx' : '';
    const who = tx ? '<span class="rad-who tx">► YOU</span>'
              : rx ? `<span class="rad-who rx">◄ ${esc(rx.who)}</span>`
              : `<span class="rad-who">${F.DASH}</span>`;
    s += `<div class="rad${cls}"><span class="rad-top"><span class="lamp ${lamp}"></span>R${i}<span class="f">${F.freq(r.freq)}</span></span>${who}</div>`;
  }
  return s;
}

// ── render ──────────────────────────────────────────────────────────────────────────────────
function view(st) {
  const info = st.RadioInfo, radios = info.radios || [];
  const now = Date.now(), rx = {};
  (st.RadioReceivingState || []).forEach((e, i) => { const w = F.speaker(e, i, now, held); if (w) rx[i] = w; });
  const sel = info.selected;
  const com = { 1: F.usable(radios[sel]) ? sel : -1, 2: F.com2Default(radios, sel) };
  const band = F.bandFor(radios[com[1]]) || F.bandFor(radios[com[2]]) || F.BANDS[0];
  return { radios, tuned: st.TunedClients || [], send: st.RadioSendingState, rx, com, band, st };
}

function render(v, status, bad) {
  $('status').textContent = status;
  $('status').className = 'status' + (bad ? ' bad' : '');
  $('band').textContent = v ? v.band.label : F.DASH;
  $('scope').innerHTML = v ? scopeSvg(v) : '';
  $('com1').innerHTML = comHtml(1, v);
  $('com2').innerHTML = comHtml(2, v);
  $('rads').innerHTML = radsHtml(v);
}

function statusText(s) {
  if (s.reason === 'port-busy') return `UDP ${s.port} IN USE BY ANOTHER PROGRAM`;
  if (s.reason === 'stale') return `NO SRS DATA FOR ${Math.round(s.ageMs / 1000)} S`;
  return `NO SRS DATA ON UDP ${s.port}`;
}

function onFrame(d) {
  const s = d.ext && d.ext.srs;
  if (!s) return;
  // Without live data the page would show stale radios as current, so every other path clears it.
  if (!s.ok) return render(null, statusText(s), true);
  // The packet is SRS's internal state, not a documented API: a shape this page doesn't know
  // reports itself instead of throwing on every frame.
  const info = s.state && s.state.RadioInfo;
  if (!info || !Array.isArray(info.radios)) return render(null, 'UNRECOGNISED SRS DATA', true);
  render(view(s.state), `● ${info.unit} · ${s.state.ClientCountConnected} ON SERVER`, false);
}

function onNoMission() {
  render(null, 'WAITING FOR MISSION', false);
}

render(null, 'WAITING FOR MISSION', false);
const source = new TelemetrySource({ onFrame, onNoMission });
source.connect();
addEventListener('pagehide', () => source.disconnect());
