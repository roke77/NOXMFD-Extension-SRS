# SRS MFD — planning

## Status

Phase 1 is released as 0.1.0 and checked in the game, except receiving (step 4). Phase 2's controls
are released as 0.2.0, checked in the preview; their in-game check (Phase 2 step 3), together with
receiving, is next. The project runs in two phases:

- **Phase 1 — read-only SRS page.** An EXT page that shows every SRS radio: frequency,
  modulation, name, how many players are tuned, and who is transmitting or receiving.
- **Phase 2 — radio controls.** Select a radio, change frequency or channel, and toggle guard from
  the page.

Neither phase needs a NOXMFD core change: the page uses extension API sections 1–4 (page serving,
telemetry slice, commands, EXT navigation; see NOXMFD's `docs/extensions-api.md`). This plan was
checked against the SRS source on `master` (latest release 2.4.1.0) and against packets captured
from SRS 2.4.1.0 in EAM (`docs/samples/`).

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
processes radio info. In EAM that is a fixed loop every **200 ms** (about 5 packets a second,
roughly 4 KB each, in the captures). Nuclear Option doesn't bind
7080, but the extension listens on 7082: that port exists for third-party consumers. Both ports are
configurable in SRS (`OutgoingDCSUDPInfo`, `OutgoingDCSUDPOther`).

The packet is a serialized `CombinedRadioState`:

| Field | Type | Meaning |
|---|---|---|
| `RadioInfo.radios[]` | `DCSRadio[11]` | Index 0 is intercom, 1–10 are radios. Per radio: `name`, `freq` (Hz), `freqMin`/`freqMax` (Hz, the tuning range), `freqMode` (`1` = tunable from the overlay), `modulation`, `secFreq` (guard, see below), `channel` (−1 = none), `volume`, `enc`, `encKey`, `rxOnly`, `retransmit`, `simul` |
| `RadioInfo.selected` | short | Selected radio index |
| `RadioInfo.name` | string | The player's EAM name |
| `RadioInfo.unit`, `unitId` | string, uint | `"EAM"` in External AWACS Mode |
| `RadioSendingState` | object | `IsSending`, `SendingOn` (radio index), `IsEncrypted` |
| `RadioReceivingState[]` | `[11]` | Per radio: `IsReceiving` (true for 350 ms after the last voice packet), `SentBy` (speaker name), `ReceivedOn`, `IsSecondary` (heard on guard), `IsSimultaneous`, `LastReceivedAt` (local `DateTime` ticks). An entry is `null` until that radio first receives. |
| `ClientCountConnected` | int | Clients on the server |
| `TunedClients[]` | `int[11]` | Clients tuned to each radio's frequency and modulation; 0 while disconnected. With only the local client connected every entry is 0, so the count appears to exclude the local client. |

`modulation` values: `0` AM, `1` FM, `2` INTERCOM, `3` DISABLED, `4` HAVEQUICK, `5` SATCOM, `6` MIDS,
`7` SINCGARS. Radio 0 is named `SATCOM` in the default EAM set but has modulation INTERCOM, so the
page goes by `modulation`, not `name`.

The captures pin these rules:

- **Guard (`secFreq`).** Above 1: guard is on at that frequency (Hz). `0`: guard is off. `1`: guard
  is on with no guard frequency set; the default EAM FM radios report it from the start, so the
  page shows it as `GRD OFF`.
- **Transmitting.** `RadioSendingState.SendingOn` keeps the last radio used after push-to-talk is
  released (and is `0` before the first transmission), so a radio is transmitting only while
  `IsSending` is true. `RadioInfo.ptt` is DCS's push-to-talk field and stays `false` in EAM; the
  extension ignores it.
- **Field set.** Every field above is present, including `freqMin`, `freqMax` and `freqMode`,
  which SRS marks `[JsonDCSIgnoreSerialization]` but its resolver doesn't strip.

The captures are in `docs/samples/`: `eam-idle.json` (connected, nobody talking) and `eam-tx.json`
(transmitting on radio 1).

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
- **Listener** (`SrsListener.cs`). A background thread owns a `UdpClient` bound to `127.0.0.1:7082`
  and keeps the last datagram and its arrival time behind a lock. It never touches Unity. If the
  port can't be bound (another program holds it) it logs a warning and retries every 5 s.
- **Publishing** (`Plugin.cs`). `Update()` publishes on the main thread at NOXMFD's 10 Hz frame
  rate. The slice wraps the raw packet rather than re-modelling it:
  `{"ok":true,"ageMs":…,"state":<packet>}` while the newest packet is at most 1 s old, otherwise
  `{"ok":false,"reason":"no-data"|"stale"|"port-busy"|"socket-error","port":…,"ageMs":…}`.
  Forwarding the packet as-is avoids the game's `JsonUtility`, which can't fill nested objects
  under Mono, and keeps the plugin independent of SRS field changes; the page does the parsing.
- **Commands** (`SrsCommands.cs`, `SrsCommandMap.cs`). The page posts one flat envelope per
  action: `{"cmd":"select"|"guard","radio":n}`, `{"cmd":"freq","radio":n,"mhz":305.25}` or
  `{"cmd":"volume","radio":n,"vol":0.5}`. The handler checks the command against that allow-list,
  `radio` against 1–10 and numbers for range and finiteness, maps it to SRS's schema, and sends one
  datagram to `127.0.0.1:9040`. Nothing else reaches SRS.
- **Config** (BepInEx `.cfg`): state port (default 7082) and command port (default 9040), matching
  SRS's own settings.
- **Page** (`src/web/`): `srs.html`, `srs.css`, `srs.js`, plus a pure `srs-format.js` (the packet
  rules, speaker hold, COM 2 default and scope geometry) with a `node` test, as in the other
  extensions. Reuses NOXMFD's `/assets/shared/theme.css`, `font.css` and `telemetry-source.js`.

## Page design

The page uses the **AE2 "dual heads with band scope"** design: a band scope on top, two radio heads
(COM 1 and COM 2) with an active and a standby frequency each, and a button per radio at the bottom.
One full page on the 900×900 canvas used by the other extension pages.

![SRS page, AE2 design](images/srs-page-mockup-ae2-dual-heads-scope.png)

- **Header:** `SRS` top left in NOXMFD green at the TGT page's title size (22 px); on the right, in
  dim green, the connection state (`●` green when connected; `NO SRS DATA` red when no packet has
  arrived for 1 s), `EAM`, and `ClientCountConnected`.
- **Band scope:** one scope showing COM 1's band: UHF AM 225–400 MHz, VHF AM 118–137 MHz, or VHF FM
  30–88 MHz. COM 2's cursors appear only when COM 2 is on the same band. Each frequency in use is a bar whose height is its
  `TunedClients` count; a bar glows while a radio tuned to it is receiving, with the speaker's name
  beside it. Each COM head has two cursors: solid on its active frequency and dashed on its standby
  frequency, amber for COM 1 and green for COM 2. Guard frequencies are labelled. A legend in the
  scope header names the colors and line styles.
- **COM heads:** COM 1 always shows SRS's `selected` radio, the one push-to-talk transmits on, so
  assigning a radio to COM 1 sends `ACTIVE_RADIO`. COM 2 is a monitor slot the page remembers,
  defaulting to the lowest-numbered other radio whose modulation isn't DISABLED or INTERCOM. Two
  stacked panels, COM 1 with the amber selection border. Each shows the assigned
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
- **States:** `TX` when `IsSending` is true and `SendingOn` is that radio; `RX` when that radio's
  receiving entry is non-null and `IsReceiving` is true (`IsSecondary` marks receiving on guard).
  Guard shows as `GRD <freq>` when `secFreq` is above 1, otherwise `GRD OFF`.
- **Speaker hold:** SRS clears `IsReceiving` 350 ms after the last voice packet, so the page keeps
  a speaker's name on screen for 2 s after it clears, to stop it flickering between words.
- **Page-side state:** SRS has one selected radio and no standby frequencies. The standby
  frequencies and the COM 2 assignment live in the page (COM 1 follows SRS); swap sends `FREQUENCY_SET` with the
  standby value and keeps the old active value as the new standby.

Step size for `▲`/`▼` follows the modulation: 25 kHz for AM/FM. Stepped and typed frequencies are
clamped to the radio's `freqMin`–`freqMax`, and only radios with `freqMode` 1 accept them.

Phase 2 controls:

- **Selecting a COM:** tapping a COM head makes it the selected COM (amber border). Tapping an R
  button assigns that radio to the selected COM; with COM 1 selected that sends `ACTIVE_RADIO`.
- **Keypad:** the NOAutopilot page's keypad overlay, adapted for frequencies (digits, decimal
  point, CLR, CANCEL, ENTER), showing the radio's tuning range and rejecting entries outside it.
- **Volume:** tapping a point on a head's VOL bar sets that volume (`SET_VOLUME`).
- **Guard:** tapping a head's `GRD` text toggles guard (`TOGGLE_GUARD`).
- **Remembered in the browser** (`localStorage`, per device): each radio's standby frequency and
  the COM 2 assignment. COM 2 falls back to its default when its radio becomes unusable.

Colors follow NOXMFD's theme tokens: green for live values, amber for the selection and for
pending values (standby), red for alerts, white for key legends.

## Build steps

### Phase 1

1. **Capture.** With SRS in EAM, dump 7082 packets to `docs/samples/` (a few lines of Python
   binding the port). Idle and transmitting are captured. Still to capture: receiving, with a
   second client talking on the same frequency, which also confirms `SentBy`, `IsSecondary` and
   whether `TunedClients` excludes the local client.
2. **Plugin skeleton** (built). Registration, listener thread, stale detection, slice publishing,
   the state-port config entry, embedded page assets, and a placeholder page that lists the radios
   and the raw packet. `tools/preview.py` serves the page with mock slices from `docs/samples/`
   (idle, transmitting, receiving, no data, port busy, stale, no mission) or with live packets
   from a running SRS.
3. **Page** (built). Header, band scope, both COM heads showing their active frequencies and
   states, the radio buttons with speakers, and the no-data and no-mission states. The Phase 2
   controls (standby, swap, `▲`/`▼`, keypad glyph, assignment hint) are in the markup but hidden,
   so the layout doesn't move when they arrive. `src/web/srs-format.js` holds the packet rules,
   checked by `node src/web/srs-format.test.js` against `docs/samples/`. The preview's `busy`
   scenario reproduces the AE2 mockup's data.
4. **Live check.** SRS connected to a server in EAM, the game running, the page open on a second
   device. Checked in the game with SRS 2.4.1.0 on a local server: COM 1 follows the radio
   selected in SRS's overlay and COM 2 takes the next usable radio; retuning moves the bars and
   cursors; the scope switches between UHF AM, VHF AM and VHF FM with COM 1's radio; guard shows
   `GRD OFF` for the FM radios; TX and `► YOU` show while push-to-talk is held and clear on
   release; closing SRS mid-mission shows `NO SRS DATA` and clears the radios, and reconnecting
   recovers the page. Parked until another player can join: receiving (speaker names, the speaker
   hold, `IsSecondary` on guard, and `TunedClients` counts) with a second client.

### Phase 2

1. **Command handler and allow-list** (built). `SrsCommands.cs` parses the page's flat envelope
   (`{"cmd","radio","mhz","vol"}`) and `SrsCommandMap.cs` maps `select`, `guard`, `freq` and
   `volume` to SRS's datagrams, rejecting anything else, radio 0 or 11+, and non-finite or
   impossible values; `dotnet run --project tools/cmdcheck` checks it. The command port is a
   setting (default 9040).
2. **Controls** (built): standby frequencies, swap, `▲`/`▼`, the keypad overlay, selecting a COM,
   radio assignment, guard and volume. `srs-format.js` holds the stepping, entry checks, COM 2
   pick and volume math, covered by `srs-format.test.js`. The page only rewrites a block when its
   markup changes, so a 10 Hz refresh can't replace a button mid-tap. `tools/preview.py` answers
   commands: it simulates SRS on the mocks and forwards to the real SRS in `live` mode. Every
   control is checked in the preview.
3. **Live check** of every command against SRS's overlay, in the game.

## Releases

- GitHub releases only; the extension is not listed in NOMM (the NOMNOM registry).
- The zip holds `NOXMFD.SrsModule/NOXMFD.SrsModule.dll`, extracted into `BepInEx/plugins/`.
- `0.1.0` is Phase 1, the read-only page; `0.2.0` is Phase 2, the controls.

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
- **In a mission only.** NOXMFD carries extension slices inside its mission telemetry frame; at the
  main menu it sends pings without them, so the page shows SRS state only while a mission runs.

## Open questions

- Do players' servers push custom EAM radios (`AllowServerEAMRadioPreset`), and what are the radio
  names? This decides whether `name` alone is useful enough in Phase 1.
- Are preset channel names needed? If so, the options are reading SRS's client preset files from
  its install folder or leaving them out.
