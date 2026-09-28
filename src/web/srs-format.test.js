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

// Guard: above 1 is a frequency, 0 is off, and 1 (the EAM FM radios' default) also shows as off.
assert.strictEqual(F.guard(radios[1].secFreq), 'GRD 243.000');
assert.strictEqual(F.guard(radios[3].secFreq), 'GRD OFF');
assert.strictEqual(F.guard(0), 'GRD OFF');

// Radio 0 is named SATCOM but is the intercom; it's never offered.
assert.strictEqual(radios[0].name, 'SATCOM');
assert.strictEqual(F.usable(radios[0]), false);
assert.strictEqual(F.usable(radios[1]), true);
assert.strictEqual(F.usable({ ...radios[1], modulation: 3 }), false);

// COM 2 defaults to the lowest usable radio that isn't SRS's selected one.
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
  { who: 'VIPER 1-1', grd: false });
assert.deepStrictEqual(F.speaker({ IsReceiving: false, SentBy: 'VIPER 1-1' }, 1, 1000 + F.HOLD_MS - 1, held),
  { who: 'VIPER 1-1', grd: false });
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
assert.deepStrictEqual(F.guards(radios, uhf), [243e6]);
assert.deepStrictEqual(F.guards(radios, F.BANDS[2]), []);

console.log('srs-format: all checks passed');
