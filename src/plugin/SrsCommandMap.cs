using System.Globalization;

namespace SrsModule
{
    // Maps one page command to the JSON datagram SRS's UDPCommandHandler accepts on port 9040
    // (docs/srs-plan.md, "Commands in"). The page's values come from a browser, so everything is
    // checked here; anything not on the allow-list maps to null and is never sent. Unity-free, so
    // tools/cmdcheck can compile and run it directly.
    internal static class SrsCommandMap
    {
        // SRS's UDPInterfaceCommand.UDPCommandType ids.
        private const int ActiveRadio = 1, SetVolume = 5, FrequencySet = 12;

        internal static string? ToSrs(string? cmd, int radio, double mhz, double vol)
        {
            if (radio < 1 || radio > 10) return null;
            switch (cmd)
            {
                case "select": return Datagram(ActiveRadio, radio);
                // SRS clamps to the radio's own range; this only rejects values no radio could hold.
                // The comparisons are false for NaN, so a missing value is rejected too.
                case "freq":
                    return mhz > 0 && mhz < 10000
                        ? Datagram(FrequencySet, radio, ",\"Frequency\":" + mhz.ToString("R", CultureInfo.InvariantCulture))
                        : null;
                case "volume":
                    return vol >= 0 && vol <= 1
                        ? Datagram(SetVolume, radio, ",\"Volume\":" + vol.ToString("R", CultureInfo.InvariantCulture))
                        : null;
                default: return null;
            }
        }

        private static string Datagram(int command, int radio, string extra = "")
            => "{\"Command\":" + command + ",\"RadioId\":" + radio + extra + "}";
    }
}
