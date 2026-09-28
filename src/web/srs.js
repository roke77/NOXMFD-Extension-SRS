// Placeholder SRS page (docs/srs-plan.md, Phase 1 step 2): shows the slice's status, a one-line
// summary per radio, and the raw packet, to prove SRS state reaches the page end to end.
import { TelemetrySource } from '/assets/services/telemetry-source.js';

const $ = (id) => document.getElementById(id);
const MOD = ['AM', 'FM', 'INT', 'OFF', 'HQ', 'SAT', 'MIDS', 'SINC'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Without live data the radio list would show stale state as if it were current, so it's cleared.
function clearRadios() {
  $('radios').innerHTML = '';
  $('raw').textContent = '';
}

function render(s) {
  const status = $('status');
  if (!s.ok) {
    clearRadios();
    status.className = 'bad';
    status.textContent = s.reason === 'port-busy' ? `UDP ${s.port} IN USE BY ANOTHER PROGRAM`
                       : s.reason === 'stale' ? `NO SRS DATA FOR ${Math.round(s.ageMs / 1000)} S`
                       : `NO SRS DATA ON UDP ${s.port}`;
    return;
  }
  const st = s.state, info = st.RadioInfo, send = st.RadioSendingState;
  status.className = '';
  status.textContent = `● ${info.unit} · ${st.ClientCountConnected} ON SERVER · SEL R${info.selected} · ${s.ageMs} MS`;
  $('radios').innerHTML = info.radios.map((r, i) => {
    if (r.modulation === 3) return '';
    const rx = st.RadioReceivingState[i];
    const state = send.IsSending && send.SendingOn === i ? '<span class="tx">TX</span>'
                : rx && rx.IsReceiving ? `<span class="rx">RX</span> ${esc(rx.SentBy)}` : '';
    return `<tr><td>${i === 0 ? 'INT' : 'R' + i}</td><td>${esc(r.name)}</td>` +
           `<td class="f">${(r.freq / 1e6).toFixed(3)}</td><td>${MOD[r.modulation] ?? r.modulation}</td>` +
           `<td>${st.TunedClients[i]}</td><td>${state}</td></tr>`;
  }).join('');
  $('raw').textContent = JSON.stringify(st, null, 1);
}

function onFrame(d) {
  const s = d.ext && d.ext.srs;
  if (s) render(s);
}

function onNoMission() {
  clearRadios();
  $('status').className = '';
  $('status').textContent = 'WAITING FOR MISSION';
}

const source = new TelemetrySource({ onFrame, onNoMission });
source.connect();
addEventListener('pagehide', () => source.disconnect());
