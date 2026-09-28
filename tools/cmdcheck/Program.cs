using System;
using SrsModule;

// Self-check for SrsCommandMap (accepted commands produce SRS's datagrams, anything outside the
// allow-list or its ranges produces nothing) and SrsPresetSync's parsing. `fetch [host[:port]]`
// instead runs the real preset fetch against an SRS server and prints what it returns.
static class Program
{
    static int failures;

    static void Expect(string? actual, string? expected, string what)
    {
        if (actual == expected) return;
        failures++;
        Console.WriteLine($"FAIL {what}: expected {expected ?? "null"}, got {actual ?? "null"}");
    }

    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "fetch")
        {
            SrsPresetSync.TryParseServer(args.Length > 1 ? args[1] : "127.0.0.1", out string host, out int port);
            Console.WriteLine(SrsPresetSync.Fetch(host, port, 5000) ?? "(no SERVER_PRESETS)");
            return 0;
        }

        Expect(SrsCommandMap.ToSrs("select", 4, double.NaN, double.NaN), "{\"Command\":1,\"RadioId\":4}", "select");
        Expect(SrsCommandMap.ToSrs("freq", 2, 305.25, double.NaN), "{\"Command\":12,\"RadioId\":2,\"Frequency\":305.25}", "freq");
        Expect(SrsCommandMap.ToSrs("volume", 1, double.NaN, 0.8), "{\"Command\":5,\"RadioId\":1,\"Volume\":0.8}", "volume");

        // Guard isn't offered: Nuclear Option has no use for it.
        Expect(SrsCommandMap.ToSrs("guard", 2, double.NaN, double.NaN), null, "guard");

        // Radio 0 is the intercom and 11+ doesn't exist; neither is a page target.
        Expect(SrsCommandMap.ToSrs("select", 0, double.NaN, double.NaN), null, "radio 0");
        Expect(SrsCommandMap.ToSrs("select", 11, double.NaN, double.NaN), null, "radio 11");
        // Missing, non-finite or impossible values are rejected rather than sent.
        Expect(SrsCommandMap.ToSrs("freq", 2, double.NaN, double.NaN), null, "freq missing");
        Expect(SrsCommandMap.ToSrs("freq", 2, double.PositiveInfinity, double.NaN), null, "freq infinite");
        Expect(SrsCommandMap.ToSrs("freq", 2, 0, double.NaN), null, "freq zero");
        Expect(SrsCommandMap.ToSrs("volume", 1, double.NaN, 1.5), null, "volume over 1");
        Expect(SrsCommandMap.ToSrs("volume", 1, double.NaN, -0.1), null, "volume negative");
        // Only the allow-list reaches SRS.
        Expect(SrsCommandMap.ToSrs("transponder", 1, 1, 1), null, "unknown command");
        Expect(SrsCommandMap.ToSrs(null, 1, 1, 1), null, "no command");

        // ── SrsPresetSync ──
        Expect(SrsPresetSync.LastServer(new[] { "[General]", "LastServer=10.0.0.5:5003\r", "X=1" }), "10.0.0.5:5003", "LastServer");
        Expect(SrsPresetSync.LastServer(new[] { "LastServer=" }), null, "LastServer empty");
        Expect(SrsPresetSync.LastServer(new[] { "LastPresetsFolder=" }), null, "LastServer missing");
        Expect(Server("srs.example.com"), "srs.example.com:5002", "server default port");
        Expect(Server("127.0.0.1:5010"), "127.0.0.1:5010", "server with port");
        Expect(Server("host:99999"), null, "server port out of range");
        Expect(Server("host:abc"), null, "server port not a number");
        Expect(Server("  "), null, "server blank");
        string sync = SrsPresetSync.SyncMessage();
        Expect(sync.EndsWith("}\n") && sync.Contains("\"MsgType\":2") ? "ok" : sync, "ok", "SYNC message");
        // The field's raw string, escapes kept; the same text inside a player's name doesn't match.
        const string reply = "{\"MsgType\":2,\"Clients\":[{\"Name\":\"x\\\"SERVER_PRESETS\\\":\\\"bad\"}]," +
                             "\"ServerSettings\":{\"SERVER_PRESETS\":\"{\\\"uhf\\\":[{\\\"Name\\\":\\\"A\\\\\\\"B\\\"}]}\",\"X\":\"1\"}}";
        Expect(SrsPresetSync.RawStringField(reply, "SERVER_PRESETS"), "{\\\"uhf\\\":[{\\\"Name\\\":\\\"A\\\\\\\"B\\\"}]}", "SERVER_PRESETS field");
        Expect(SrsPresetSync.RawStringField(reply, "MISSING"), null, "missing field");
        Expect(SrsPresetSync.RawStringField("{\"SERVER_PRESETS\":\"unterminated", "SERVER_PRESETS"), null, "unterminated field");

        Console.WriteLine(failures == 0 ? "cmdcheck: all checks passed" : $"cmdcheck: {failures} failed");
        return failures == 0 ? 0 : 1;
    }

    static string? Server(string s) => SrsPresetSync.TryParseServer(s, out string h, out int p) ? h + ":" + p : null;
}
