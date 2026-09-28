# SRS MFD — planning

## Status

Planning. Nothing is built yet. The project runs in two phases:

- **Phase 1 — read-only SRS page.** An EXT page that shows every SRS radio: frequency,
  modulation, name, how many players are tuned, and who is transmitting or receiving.
- **Phase 2 — radio controls.** Select a radio, change frequency or channel, and toggle guard from
  the page.

Neither phase needs a NOXMFD core change: the page uses extension API sections 1–4 (page serving,
telemetry slice, commands, EXT navigation; see NOXMFD's `docs/extensions-api.md`). This plan was
checked against the SRS source on `master` (latest release 2.4.1.0).

## Source ticket

Player-submitted, [roke77/NOXMFD#87](https://github.com/roke77/NOXMFD/issues/87): show SRS radio
state in NOXMFD as an extension.

## SRS at a glance

[DCS SimpleRadio Standalone](https://github.com/ciribob/DCS-SimpleRadioStandalone) (SRS, by
ciribob) is a standalone Windows VoIP client (`SR-ClientRadio.exe`) that simulates radios: players
hear each other only when tuned to the same frequency and modulation. Its home page is
[dcssimpleradio.com](http://dcssimpleradio.com/); the GitHub repo is the source of truth for
everything below.

SRS has no Nuclear Option integration, so Nuclear Option players run it in **External AWACS Mode
(EAM)**: SRS supplies its own radio set (from `awacs-radios.json`, a custom file, or the server) and
the player tunes it in SRS's overlay. The extension targets EAM. It never touches game state, so
multiplayer hosts have nothing to allow or forbid.

## Integration surface

SRS exposes two local UDP interfaces. The extension uses both and nothing else: no reflection, no
process access, no dependency on SRS assemblies.

### State out: UDP 7082

`DCSRadioSyncHandler.SendRadioUpdateToDCSAsync` sends one newline-terminated JSON packet to
`127.0.0.1:7080` (meant for DCS) and `127.0.0.1:7082` (meant for flight panels) each time SRS
processes radio info. In EAM that is a fixed loop every **200 ms**. Nuclear Option doesn't bind
7080, but the extension listens on 7082: that port exists for third-party consumers. Both ports are
configurable in SRS (`OutgoingDCSUDPInfo`, `OutgoingDCSUDPOther`).

The packet is a serialized `CombinedRadioState`:

| Field | Type | Meaning |
|---|---|---|
| `RadioInfo.radios[]` | `DCSRadio[11]` | Index 0 is intercom, 1–10 are radios. Per radio: `name`, `freq` (Hz), `modulation`, `secFreq` (guard: Hz when set, `0` = off, `1` = re-enabled from the overlay), `channel` (−1 = none), `volume`, `enc`, `encKey`, `rxOnly`, `retransmit`, `simul` |
| `RadioInfo.selected` | short | Selected radio index |
| `RadioInfo.unit`, `unitId` | string, uint | `"EAM"` in External AWACS Mode |
| `RadioSendingState` | object | `IsSending`, `SendingOn` (radio index), `IsEncrypted` |
| `RadioReceivingState[]` | `[11]`, entries may be null | Per radio: `IsReceiving` (true for 350 ms after the last voice packet), `SentBy` (speaker name), `ReceivedOn`, `IsSecondary` (heard on guard), `IsSimultaneous`, `LastReceivedAt` (local `DateTime` ticks) |
| `ClientCountConnected` | int | Clients on the server |
| `TunedClients[]` | `int[11]` | Clients tuned to each radio's frequency and modulation; 0 while disconnected |

`modulation` values: `0` AM, `1` FM, `2` INTERCOM, `3` DISABLED, `4` HAVEQUICK, `5` SATCOM, `6` MIDS,
`7` SINCGARS.

SRS strips fields marked `[JsonDCSIgnoreSerialization]` from this packet through a resolver that
checks the attribute on the property's *type*, so which of those fields actually appear (`freqMin`,
`freqMax`, `freqMode`, `volMode`, `expansion`) is unclear from the source alone. The first build
step captures a real packet and pins the field set.

### Commands in: UDP 9040

`UDPCommandHandler` accepts one JSON object per datagram on port 9040 (`CommandListenerUDP`,
configurable), case-insensitive:

```json
{"Command": 12, "RadioId": 2, "Frequency": 305.25}
```

| Command | Id | Fields | Phase |
|---|---|---|---|
| `FREQUENCY_DELTA` | 0 | `RadioId`, `Frequency` (MHz delta) | 2 |
| `ACTIVE_RADIO` | 1 | `RadioId` | 2 |
| `TOGGLE_GUARD` | 2 | `RadioId` | 2 |
| `CHANNEL_UP` / `CHANNEL_DOWN` | 3 / 4 | `RadioId` | 2 |
| `SET_VOLUME` | 5 | `RadioId`, `Volume` (0–1) | 2 |
| `GUARD` | 11 | `RadioId`, `Enabled` | 2 |
| `FREQUENCY_SET` | 12 | `RadioId`, `Frequency` (MHz) | 2 |

SRS applies frequency changes only to radios 1–10 whose modulation isn't DISABLED or INTERCOM and
whose `freqMode` is OVERLAY; EAM's default radios are OVERLAY. SRS gives no reply, so the page
learns the result from the next state packet. Transponder, retransmit and simultaneous-transmission
commands exist but are out of scope.

## Architecture

```
SRS ──UDP 7082──► listener thread ──latest packet──► Update() ──PublishSlice("srs")──► page
page ──POST /ext/srs/command──► handler (main thread) ──validate──► UDP 9040 ──► SRS
```

- **Plugin** (BepInEx, depends on NOXMFD). Registers extension id `srs`, label `SRS`.
- **Listener.** A background thread owns a `UdpClient` bound to `127.0.0.1:7082` and keeps the last
  datagram and its arrival time in a volatile field. It never touches Unity.
- **Publishing.** `Update()` publishes on the main thread whenever a new packet arrived, and once
  more when data goes stale (no packet for 1 s). The slice wraps the raw packet rather than
  re-modelling it: `{"ok":true,"ageMs":…,"state":<packet>}`, or `{"ok":false,"reason":"…"}`.
  Forwarding the packet as-is avoids the game's `JsonUtility`, which can't fill nested objects
  under Mono, and keeps the plugin independent of SRS field changes; the page does the parsing.
- **Commands (Phase 2).** The page posts `{"cmd":"freqSet","radio":2,"mhz":305.25}` and similar.
  The handler checks the command against an allow-list, `radio` against 1–10 and numbers for range
  and finiteness, maps it to SRS's schema, and sends one datagram to `127.0.0.1:9040`. Nothing else
  reaches SRS.
- **Config** (BepInEx `.cfg`): state port (default 7082) and command port (default 9040), matching
  SRS's own settings.
- **Page** (`src/web/`): `srs.html`, `srs.css`, `srs.js`, plus a pure `srs-format.js` (frequency
  and modulation formatting, stale checks) with a `node` test, as in the other extensions. Reuses
  NOXMFD's `/assets/shared/theme.css` and `font.css`.

## Page design

The page uses the **AE2 "dual heads with band scope"** design: a band scope on top, two radio heads
(COM 1 and COM 2) with an active and a standby frequency each, and a button per radio at the bottom.
One full page on the 900×900 canvas used by the other extension pages.

![SRS page, AE2 design](images/srs-page-mockup-ae2-dual-heads-scope.png)

- **Header:** `SRS` top left in NOXMFD green at the TGT page's title size (22 px); on the right, in
  dim green, the connection state (`●` green when connected; `NO SRS DATA` red when no packet has
  arrived for 1 s), `EAM`, and `ClientCountConnected`.
- **Band scope:** the UHF AM band, 225–400 MHz. Each frequency in use is a bar whose height is its
  `TunedClients` count; a bar glows while a radio tuned to it is receiving, with the speaker's name
  beside it. Each COM head has two cursors: solid on its active frequency and dashed on its standby
  frequency, amber for COM 1 and green for COM 2. Guard frequencies are labelled. A legend in the
  scope header names the colors and line styles.
- **COM heads:** two stacked panels, COM 1 with the amber selection border. Each shows the assigned
  radio's number and `name`, a `TX` (filled) or `RX` (outlined) badge, the **active** frequency
  (large, white), a swap button, the **standby** frequency (amber), `▲`/`▼` to step the standby
  frequency, and a status line with modulation, tuned count, guard (`GRD <freq>` or `GRD OFF`),
  and volume or the current speaker.
- **Keypad entry:** each standby frequency is a button with NOXMFD's keypad glyph beside the value
  (the same glyph and behavior as the NOAutopilot page); tapping it opens the keypad overlay. It's
  the only typed entry on the page: active frequencies change only through swap, and volume and
  `▲`/`▼` step.
- **Radio buttons:** R1–R10 in a 5×2 grid, one per radio whose modulation isn't DISABLED. Line one:
  a TX/RX lamp, `R<n>`, and the frequency in MHz to three decimals. Line two: the speaker
  (`◄ <SentBy>` white) while receiving, `► YOU` (green) while transmitting, or a dim `—`. The
  radios assigned to COM 1 and COM 2 carry that head's border color. Tapping a button assigns
  that radio to the selected COM.
- **States:** `TX` when `RadioSendingState.SendingOn` is that radio and `IsSending` is true; `RX`
  when that radio's `IsReceiving` is true (`IsSecondary` marks receiving on guard). Guard is on
  when `secFreq` is above 0; whether EAM restores the guard frequency after `secFreq` = 1 is checked
  in the capture step.
- **Speaker hold:** SRS clears `IsReceiving` 350 ms after the last voice packet, so the page keeps
  a speaker's name on screen for 2 s after it clears, to stop it flickering between words.
- **Page-side state:** SRS has one selected radio and no standby frequencies. The standby
  frequencies and the COM 2 assignment live in the page; swap sends `FREQUENCY_SET` with the
  standby value and keeps the old active value as the new standby.

Step size for `▲`/`▼` follows the modulation: 25 kHz for AM/FM.

Colors follow NOXMFD's theme tokens: green for live values, amber for the selection and for
pending values (standby), red for alerts, white for key legends.

## Build steps

### Phase 1

1. **Capture.** With SRS in EAM, dump one 7082 packet to `docs/samples/` (a few lines of Python
   binding the port) and confirm the field table above. Capture again while transmitting and while
   receiving.
2. **Plugin skeleton.** Registration, listener thread, stale detection, slice publishing, config
   entries, embedded page assets.
3. **Page.** Header, band scope, both COM heads showing their active frequencies and states, the
   radio buttons with speakers, and the no-data state. `tools/preview.py` serves
   the page with mock slices (connected, transmitting, receiving, no data), as in the NOAutopilot
   extension.
4. **Live check.** SRS connected to a server in EAM, the game running, the page open on a second
   device. Check tuning, TX, RX and SRS restarts.

### Phase 2

1. **Command handler and allow-list**, with a `node` or C# check for the validation.
2. **Controls** on the page: standby frequencies, swap, `▲`/`▼`, the keypad overlay, radio
   assignment, and volume.
3. **Live check** of every command against SRS's overlay.

## Risks and limits

- **Port contention.** Only one process can bind 7082 unless every binder opts into sharing. If a
  player already runs a flight-panel tool on 7082, they change the port in both SRS and the
  extension's config. The page names the port when it has no data.
- **SRS format changes.** The packet is SRS's internal state serialized as-is, not a documented
  API. Forwarding it raw limits a change to `srs.js`; the capture in `docs/samples/` is the
  reference to diff against.
- **Preset names.** Server and client preset channel names (`SyncedServerSettings`,
  `FilePresetChannelsStore`) aren't in the packet. Phase 1 shows the radio's `name` and `channel`
  number only.
- **Local only.** SRS and the game must run on the same PC; the extension talks to `127.0.0.1`.

## Open questions

- Do players' servers push custom EAM radios (`AllowServerEAMRadioPreset`), and what are the radio
  names? This decides whether `name` alone is useful enough in Phase 1.
- Are preset channel names needed? If so, the options are reading SRS's client preset files from
  its install folder or leaving them out.
- What do COM 1 and COM 2 map to? A candidate: COM 1 follows SRS's `selected` radio (the one
  push-to-talk transmits on), so assigning a radio to COM 1 sends `ACTIVE_RADIO`; COM 2 is a
  page-side monitor slot.
- Which band does the scope show when a COM head is on a VHF radio? Options: switch the scope to
  that head's band, or stack a VHF scope under the UHF one.
