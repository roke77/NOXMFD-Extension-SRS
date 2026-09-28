"""Browser preview of the SRS page without the game.

    python tools/preview.py [port] [path/to/NOXMFD]

Serves /ext/srs/* from this repo's src/web, /assets/shared|services/* from a NOXMFD checkout
(default: a sibling ../NOXMFD), and a mock /stream whose frames carry an ext.srs slice built like
Plugin.BuildSlice. GET /scenario?s=<name> switches what the stream sends:
  idle, tx          the captured packets in docs/samples/
  rx                idle with R1 receiving VIPER 1-1
  busy              AE2's mockup data: COM 1 on R2 transmitting, R1 receiving, players tuned
  live              real SRS packets from UDP 127.0.0.1:7082 (don't run the game at the same time)
  unknown           a packet shape the page doesn't recognise
  no-data, port-busy, stale, nomission
POST /ext/srs/command is checked like SrsCommandMap.cs; in live mode the datagram goes to the real
SRS on UDP 9040, otherwise a rough simulation applies it to the mock. GET /commands lists them.
"""
import copy, json, socket, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

REPO = Path(__file__).resolve().parent.parent
EXT = REPO / "src" / "web"
NOX = (Path(sys.argv[2]) if len(sys.argv) > 2 else REPO.parent / "NOXMFD") / "src" / "web"
MIME = {".css": "text/css", ".js": "text/javascript", ".html": "text/html", ".woff2": "font/woff2"}

SAMPLES = {n: json.loads((REPO / "docs" / "samples" / f"eam-{n}.json").read_text("utf-8")) for n in ("idle", "tx")}
RX = copy.deepcopy(SAMPLES["idle"])
RX["RadioReceivingState"][1] = {"LastReceivedAt": 0, "IsSecondary": False, "IsSimultaneous": False,
                                "ReceivedOn": 1, "PlayedEndOfTransmission": False, "SentBy": "VIPER 1-1",
                                "IsReceiving": True}
RX["TunedClients"][1] = 1
RX["ClientCountConnected"] = 2

# AE2's mockup data: COM 1 on R2 transmitting at 305.250, R1 hearing VIPER 1-1 with 14 tuned.
BUSY = copy.deepcopy(RX)
BUSY["RadioInfo"]["selected"] = 2
for i, hz in ((2, 305.25e6), (4, 264.5e6), (6, 131e6)):
    BUSY["RadioInfo"]["radios"][i]["freq"] = hz
BUSY["RadioSendingState"] = {"IsSending": True, "SendingOn": 2, "IsEncrypted": 0}
BUSY["TunedClients"] = [0, 14, 4, 0, 9, 2, 0, 2, 0, 2, 2]
BUSY["ClientCountConnected"] = 23

state = {"s": "idle"}
live = {"packet": None, "at": 0.0, "error": None}
MOCKS = {"idle": SAMPLES["idle"], "tx": SAMPLES["tx"], "rx": RX, "busy": BUSY}
commands = []  # every command body received, for GET /commands

# SRS's UDPCommandType ids, as SrsCommandMap.cs sends them.
SRS_IDS = {"select": 1, "guard": 2, "volume": 5, "freq": 12}


def to_srs(c):
    """Mirrors SrsCommandMap.ToSrs: the datagram SRS gets, or None when the plugin would reject it."""
    cmd, r = c.get("cmd"), c.get("radio")
    if cmd not in SRS_IDS or not isinstance(r, int) or not 1 <= r <= 10:
        return None
    d = {"Command": SRS_IDS[cmd], "RadioId": r}
    if cmd == "freq":
        if not isinstance(c.get("mhz"), (int, float)) or not 0 < c["mhz"] < 10000: return None
        d["Frequency"] = c["mhz"]
    if cmd == "volume":
        if not isinstance(c.get("vol"), (int, float)) or not 0 <= c["vol"] <= 1: return None
        d["Volume"] = c["vol"]
    return d


def simulate(d):
    """Rough stand-in for SRS applying a datagram to the mock scenario, enough to see the page follow."""
    st = MOCKS.get(state["s"])
    if not st: return
    info = st["RadioInfo"]; r = info["radios"][d["RadioId"]]
    if d["Command"] == 1: info["selected"] = d["RadioId"]
    elif d["Command"] == 12: r["freq"] = min(r["freqMax"], max(r["freqMin"], round(d["Frequency"] * 1e6)))
    elif d["Command"] == 5: r["volume"] = d["Volume"]
    elif d["Command"] == 2:
        if r["secFreq"] > 1: r["_grd"], r["secFreq"] = r["secFreq"], 0
        else: r["secFreq"] = r.get("_grd", 243e6)


def listen_live():
    """Mirrors SrsListener: loopback-only UDP receive, latest packet wins."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind(("127.0.0.1", 7082))
    except OSError:
        live["error"] = "port-busy"; return
    while True:
        live["packet"], live["at"] = json.loads(s.recv(65535).decode("utf-8")), time.time()


def slice_for(name):
    if name in MOCKS:
        return {"ok": True, "ageMs": 80, "state": MOCKS[name]}
    if name == "unknown":
        return {"ok": True, "ageMs": 60, "state": {"Radios": []}}
    if name == "live":
        if live["packet"] is None:
            return {"ok": False, "reason": live["error"] or "no-data", "port": 7082, "ageMs": -1}
        age = int((time.time() - live["at"]) * 1000)
        if age > 1000:
            return {"ok": False, "reason": "stale", "port": 7082, "ageMs": age}
        return {"ok": True, "ageMs": age, "state": live["packet"]}
    if name == "stale":
        return {"ok": False, "reason": "stale", "port": 7082, "ageMs": 4200}
    return {"ok": False, "reason": name, "port": 7082, "ageMs": -1}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _file(self, p):
        if not p.is_file():
            self.send_error(404); return
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(p.suffix, "application/octet-stream"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(p.read_bytes())

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        if path in ("/", "/ext/srs"):
            return self._file(EXT / "srs.html")
        if path.startswith("/ext/srs/"):
            return self._file(EXT / path[len("/ext/srs/"):])
        if path.startswith("/assets/shared/"):
            return self._file(NOX / "shared" / path[len("/assets/shared/"):])
        if path.startswith("/assets/services/"):
            return self._file(NOX / "services" / path[len("/assets/services/"):])
        if path == "/scenario":
            state["s"] = parse_qs(u.query).get("s", [state["s"]])[0]
            if state["s"] == "live" and not live.get("thread"):
                live["thread"] = threading.Thread(target=listen_live, daemon=True)
                live["thread"].start()
            body = json.dumps(state, default=str).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(body); return
        if path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                while True:
                    if state["s"] == "nomission":
                        frame = {"ping": True, "missionRunning": False}
                    else:
                        frame = {"ext": {"srs": slice_for(state["s"])}}
                    self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
                    self.wfile.flush()
                    time.sleep(0.1)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return
        if path == "/commands":
            body = json.dumps(commands).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(body); return
        self.send_error(404)

    def do_POST(self):
        if urlparse(self.path).path != "/ext/srs/command":
            self.send_error(404); return
        if self.headers.get("Content-Type") != "application/json":
            self.send_error(415); return
        c = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        d = to_srs(c)
        commands.append({"page": c, "srs": d})
        if d and state["s"] == "live":
            socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(json.dumps(d).encode(), ("127.0.0.1", 9040))
        elif d:
            simulate(d)
        self.send_response(204); self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
