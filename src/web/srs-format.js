// Pure helpers for the SRS page: SRS's packet rules (docs/srs-plan.md, "State out"), radio
// states, the COM 2 default, and band-scope geometry. A classic script (not a module) so
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
  // secFreq: above 1 = guard on at that frequency; 0 = off; 1 = on with no frequency set (the
  // default EAM FM radios report it from the start), which shows as off.
  const guard = (secFreq) => (fin(secFreq) && secFreq > 1 ? 'GRD ' + freq(secFreq) : 'GRD OFF');
  // A radio the page offers: not DISABLED and not the intercom channel.
  const usable = (r) => !!r && r.modulation !== DISABLED && r.modulation !== INTERCOM;

  // COM 2 defaults to the lowest-numbered usable radio other than COM 1 (SRS's selected radio).
  function com2Default(radios, selected) {
    for (let i = 1; i < (radios || []).length; i++) if (i !== selected && usable(radios[i])) return i;
    return -1;
  }

  // Transmitting only while IsSending: SendingOn keeps the last radio after push-to-talk is released.
  const isTx = (send, i) => !!send && send.IsSending === true && send.SendingOn === i;

  // Who a radio is hearing, with the speaker held for HOLD_MS after SRS clears IsReceiving.
  // `held` is the page's memory ({ [i]: { who, grd, until } }); it's updated in place.
  function speaker(entry, i, now, held) {
    if (entry && entry.IsReceiving) {
      held[i] = { who: entry.SentBy || DASH, grd: !!entry.IsSecondary, until: now + HOLD_MS };
      return { who: held[i].who, grd: held[i].grd };
    }
    const h = held[i];
    if (h && now < h.until) return { who: h.who, grd: h.grd };
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

  // Guard frequencies (secFreq above 1) of the band's radios, deduplicated.
  function guards(radios, band) {
    const out = new Set();
    for (let i = 1; i < (radios || []).length; i++) {
      const r = radios[i];
      if (usable(r) && bandFor(r) === band && r.secFreq > 1) out.add(r.secFreq);
    }
    return [...out].sort((a, b) => a - b);
  }

  const api = { DASH, MOD, BANDS, HOLD_MS, freq, modName, guard, usable, com2Default, isTx, speaker,
    bandFor, scopeX, scopeBars, guards };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SrsFormat = api;
})(this);
