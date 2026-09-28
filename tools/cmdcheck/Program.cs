using System;
using SrsModule;

// Self-check for SrsCommandMap: accepted commands produce SRS's datagrams, and anything outside the
// allow-list or its ranges produces nothing.
static class Program
{
    static int failures;

    static void Expect(string? actual, string? expected, string what)
    {
        if (actual == expected) return;
        failures++;
        Console.WriteLine($"FAIL {what}: expected {expected ?? "null"}, got {actual ?? "null"}");
    }

    static int Main()
    {
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

        Console.WriteLine(failures == 0 ? "cmdcheck: all checks passed" : $"cmdcheck: {failures} failed");
        return failures == 0 ? 0 : 1;
    }
}
