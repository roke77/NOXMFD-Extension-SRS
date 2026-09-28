// node src/web/srs-format.test.js — self-check for the SRS page's packet rules, checked against
// the captured packets in docs/samples/.
const assert = require('assert');
const path = require('path');
const F = require('./srs-format.js');
const sample = (n) => require(path.join(__dirname, '..', '..', 'docs', 'samples', `eam-${n}.json`));
const idle = sample('idle'), tx = sample('tx');
const radios = idle.RadioInfo.radios;

// Frequencies in MHz to three decimals; missing data is a dash, never "NaN".
assert.strictEqual(F.freq(251000000), '251.000');
assert.strictEqual(F.freq(30000000), '30.000');
assert.strictEqual(F.freq(undefined), F.DASH);

// Radio 0 is named SATCOM but is the intercom; it's never offered.
assert.strictEqual(radios[0].name, 'SATCOM');
assert.strictEqual(F.usable(radios[0]), false);
assert.strictEqual(F.usable(radios[1]), true);
assert.strictEqual(F.usable({ ...radios[1], modulation: 3 }), false);

// MON defaults to the lowest usable radio that isn't SRS's selected one.
assert.strictEqual(F.com2Default(radios, 1), 2);
assert.strictEqual(F.com2Default(radios, 2), 1);
assert.strictEqual(F.com2Default([radios[0]], 1), -1);

// TX only while IsSending; SendingOn alone (kept after release) doesn't count.
assert.strictEqual(F.isTx(tx.RadioSendingState, 1), true);
assert.strictEqual(F.isTx(tx.RadioSendingState, 2), false);
assert.strictEqual(F.isTx({ IsSending: false, SendingOn: 1 }, 1), false);

// Speaker hold: live while receiving, held for HOLD_MS after, then gone; null entries are idle.
const held = {};
assert.deepStrictEqual(F.speaker({ IsReceiving: true, SentBy: 'VIPER 1-1', IsSecondary: false }, 1, 1000, held),
  { who: 'VIPER 1-1' });
assert.deepStrictEqual(F.speaker({ IsReceiving: false, SentBy: 'VIPER 1-1' }, 1, 1000 + F.HOLD_MS - 1, held),
  { who: 'VIPER 1-1' });
assert.strictEqual(F.speaker(null, 1, 1000 + F.HOLD_MS, held), null);
assert.strictEqual(held[1], undefined);
assert.strictEqual(F.speaker(idle.RadioReceivingState[2], 2, 0, held), null);

// Bands by modulation and frequency.
assert.strictEqual(F.bandFor(radios[1]).id, 'uhf');
assert.strictEqual(F.bandFor(radios[6]).id, 'vhf');
assert.strictEqual(F.bandFor(radios[3]).id, 'fm');
assert.strictEqual(F.bandFor({ modulation: 0, freq: 150e6 }), null);

// Scope geometry: band edges map to the ends.
const uhf = F.BANDS[0];
assert.strictEqual(F.scopeX(225e6, uhf, 20, 824), 20);
assert.strictEqual(F.scopeX(400e6, uhf, 20, 824), 824);

// The default EAM set puts four UHF radios on 251.000: one bar, receiving if any radio is.
const bars = F.scopeBars(radios, [0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0], uhf, { 2: { who: 'MAGIC 1-1' } });
assert.strictEqual(bars.length, 1);
assert.strictEqual(bars[0].hz, 251e6);
assert.strictEqual(bars[0].tuned, 3);
assert.strictEqual(bars[0].rx.who, 'MAGIC 1-1');

// ── Phase 2 controls ──
const uhfR = radios[1]; // 1–400 MHz in the default EAM set
assert.strictEqual(F.tunable(uhfR), true);
assert.strictEqual(F.tunable(radios[0]), false);
assert.strictEqual(F.tunable({ ...uhfR, freqMode: 0 }), false);

// ▲/▼ step 25 kHz, snap an off-grid value onto the grid first, and stay inside the range.
assert.strictEqual(F.stepHz(251000000, 1, uhfR), 251025000);
assert.strictEqual(F.stepHz(251000000, -1, uhfR), 250975000);
assert.strictEqual(F.stepHz(251010000, 1, uhfR), 251025000);
assert.strictEqual(F.stepHz(251010000, -1, uhfR), 251000000);
assert.strictEqual(F.stepHz(400000000, 1, uhfR), 400000000);
assert.strictEqual(F.stepHz(1000000, -1, uhfR), 1000000);

// Keypad entry: plain decimals only, checked against the radio's range.
assert.strictEqual(F.parseMhz('305.25'), 305.25);
assert.strictEqual(F.parseMhz('.5'), 0.5);
assert.strictEqual(F.parseMhz('3.0.5'), null);
assert.strictEqual(F.parseMhz(''), null);
assert.strictEqual(F.entryError(305.25, uhfR), null);
assert.strictEqual(F.entryError(null, uhfR), 'ENTER A FREQUENCY');
assert.strictEqual(F.entryError(401, uhfR), 'MAX 400.000');
assert.strictEqual(F.entryError(0.5, uhfR), 'MIN 1.000');

// MON: the player's pick while valid, else the default; never PTT's radio.
assert.strictEqual(F.com2Pick(radios, 1, 6), 6);
assert.strictEqual(F.com2Pick(radios, 6, 6), 1);
assert.strictEqual(F.com2Pick(radios, 1, 0), 2);
assert.strictEqual(F.com2Pick(radios, 1, null), 2);

// MON's ◄ / ►: step, skip PTT's radio, wrap both ways, stay put with nowhere to go.
assert.strictEqual(F.monStep(radios, 1, 2, 1), 3);
assert.strictEqual(F.monStep(radios, 3, 2, 1), 4);
assert.strictEqual(F.monStep(radios, 1, 2, -1), 10);
assert.strictEqual(F.monStep(radios, 10, 9, 1), 1);
assert.strictEqual(F.monStep([radios[0], radios[1], radios[2]], 1, 2, 1), 2);

// Volume taps snap to 5%.
assert.strictEqual(F.volAt(0, 220), 0);
assert.strictEqual(F.volAt(220, 220), 1);
assert.strictEqual(F.volAt(110, 220), 0.5);
assert.strictEqual(F.volAt(250, 220), 1);

console.log('srs-format: all checks passed');
