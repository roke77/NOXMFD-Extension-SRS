// Pure helpers for the SRS page: SRS's packet rules (docs/srs-plan.md, "State out"), radio
// states, the MON default, and band-scope geometry. A classic script (not a module) so
// srs-format.test.js can require() it in plain node; the page reads it as window.SrsFormat.
(function (root) {
  const DASH = '—';
  const MOD = ['AM', 'FM', 'INT', 'OFF', 'HQ', 'SAT', 'MIDS', 'SINC'];
  const AM = 0, FM = 1, INTERCOM = 2, DISABLED = 3;
  // SRS clears IsReceiving 350 ms after the last voice packet; holding the speaker this long stops
  // the name flickering between words.
  const HOLD_MS = 2000;
  const BANDS = [
    { id: 'uhf', label: 'UHF AM · 225–400 MHZ', mod: AM, lo: 225e6, hi: 400e6, step: 25e6 },
    { id: 'vhf', label: 'VHF AM · 118–137 MHZ', mod: AM, lo: 118e6, hi: 137e6, step: 5e6 },
    { id: 'fm', label: 'VHF FM · 30–88 MHZ', mod: FM, lo: 30e6, hi: 88e6, step: 10e6 },
  ];

  const fin = (v) => typeof v === 'number' && isFinite(v);

  const freq = (hz) => (fin(hz) && hz > 0 ? (hz / 1e6).toFixed(3) : DASH);
  const modName = (m) => MOD[m] ?? DASH;
  // A radio the page offers: not DISABLED and not the intercom channel.
  const usable = (r) => !!r && r.modulation !== DISABLED && r.modulation !== INTERCOM;

  // MON (the dual-band layout's second head) defaults to the lowest-numbered usable radio other
  // than PTT (SRS's selected radio).
  function com2Default(radios, selected) {
    for (let i = 1; i < (radios || []).length; i++) if (i !== selected && usable(radios[i])) return i;
    return -1;
  }

  // Transmitting only while IsSending: SendingOn keeps the last radio after push-to-talk is released.
  const isTx = (send, i) => !!send && send.IsSending === true && send.SendingOn === i;

  // Who a radio is hearing, with the speaker held for HOLD_MS after SRS clears IsReceiving.
  // `held` is the page's memory ({ [i]: { who, until } }); it's updated in place.
  function speaker(entry, i, now, held) {
    if (entry && entry.IsReceiving) {
      held[i] = { who: entry.SentBy || DASH, until: now + HOLD_MS };
      return { who: held[i].who };
    }
    const h = held[i];
    if (h && now < h.until) return { who: h.who };
    delete held[i];
    return null;
  }

  function bandFor(r) {
    if (!r) return null;
    return BANDS.find((b) => b.mod === r.modulation && r.freq >= b.lo && r.freq <= b.hi) || null;
  }

  // x position of a frequency on a scope drawn from x0 to x1.
  const scopeX = (hz, band, x0, x1) => x0 + ((hz - band.lo) / (band.hi - band.lo)) * (x1 - x0);

  // One bar per distinct frequency in the band among radios 1–10. Radios sharing a frequency share
  // one bar; its tuned count is the highest SRS reports for them, and it's receiving if any is.
  function scopeBars(radios, tuned, band, rxByRadio) {
    const bars = new Map();
    for (let i = 1; i < (radios || []).length; i++) {
      const r = radios[i];
      if (!usable(r) || bandFor(r) !== band) continue;
      const bar = bars.get(r.freq) || { hz: r.freq, tuned: 0, rx: null };
      bar.tuned = Math.max(bar.tuned, (tuned && tuned[i]) || 0);
      if (rxByRadio && rxByRadio[i] && !bar.rx) bar.rx = rxByRadio[i];
      bars.set(r.freq, bar);
    }
    return [...bars.values()].sort((a, b) => a.hz - b.hz);
  }

  // ── Phase 2 controls ──────────────────────────────────────────────────────────────────────
  const STEP_HZ = 25000; // 25 kHz, the AM/FM channel spacing
  // SRS only applies frequency and volume changes to radios its overlay controls.
  const tunable = (r) => usable(r) && r.freqMode === 1;
  const clampHz = (hz, r) => Math.min(r.freqMax, Math.max(r.freqMin, hz));
  // One ▲/▼ step from `hz` (the standby, or the active frequency when there's no standby yet),
  // snapped to the 25 kHz grid and kept inside the radio's range.
  function stepHz(hz, dir, r) {
    const next = dir > 0 ? (Math.floor(hz / STEP_HZ) + 1) * STEP_HZ : (Math.ceil(hz / STEP_HZ) - 1) * STEP_HZ;
    return clampHz(next, r);
  }

  // Keypad text → MHz, or null for anything that isn't a plain decimal number.
  const parseMhz = (text) => (/^(\d+\.?\d*|\.\d+)$/.test(text) ? parseFloat(text) : null);
  // Why a typed frequency can't be used on this radio, or null when it can.
  function entryError(mhz, r) {
    if (mhz == null) return 'ENTER A FREQUENCY';
    const hz = Math.round(mhz * 1e6);
    if (hz < r.freqMin) return 'MIN ' + freq(r.freqMin);
    if (hz > r.freqMax) return 'MAX ' + freq(r.freqMax);
    return null;
  }

  // MON's radio: the player's pick while it's usable and isn't PTT's, else the default.
  function com2Pick(radios, selected, stored) {
    return Number.isInteger(stored) && stored !== selected && usable((radios || [])[stored])
      ? stored : com2Default(radios, selected);
  }

  // MON's ◄ / ►: the next usable radio from `current` in `dir` (±1), wrapping past R10 / R1 and
  // skipping PTT's radio. Stays on `current` when there's no other.
  function monStep(radios, selected, current, dir) {
    const n = (radios || []).length - 1; // radios 1..n
    for (let k = 0, i = current; k < n; k++) {
      i = ((i - 1 + dir + n) % n) + 1;
      if (i !== selected && usable(radios[i])) return i;
    }
    return current;
  }

  // A tap at `x` along a bar `width` wide → volume 0..1, in 5% steps.
  const volAt = (x, width) => Math.min(1, Math.max(0, Math.round((x / width) * 20) / 20));

  const api = { DASH, MOD, BANDS, HOLD_MS, STEP_HZ, freq, modName, usable, com2Default, isTx,
    speaker, bandFor, scopeX, scopeBars, tunable, clampHz, stepHz, parseMhz, entryError,
    com2Pick, monStep, volAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SrsFormat = api;
})(this);
