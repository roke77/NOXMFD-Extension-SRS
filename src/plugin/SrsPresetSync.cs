using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

namespace SrsModule
{
    // Fetches the SRS server's preset channel list (docs/srs-plan.md, "Server presets"). SRS keeps
    // preset names on the server and syncs them to its client over the server's TCP connection;
    // the client's UDP state only carries each radio's preset index. So this asks the server the way
    // SRS's own client does: one SYNC message, whose reply carries the server's settings with
    // SERVER_PRESETS (a JSON string: normalised radio name → [{Name, Frequency}]), then disconnects.
    // The server lists the connection as a client until it closes. Unity-free, so tools/cmdcheck
    // can compile and run it directly.
    internal static class SrsPresetSync
    {
        internal const int DefaultPort = 5002;
        // Sent as the client version; the server refuses versions below its minimum protocol version.
        internal const string ClientVersion = "2.4.1.0";
        // The SYNC reply lists every connected client with its radios; this caps what is read.
        private const int MaxReplyBytes = 4 * 1024 * 1024;

        // The server the SRS client last connected to: LastServer= in its global.cfg, or null.
        internal static string? LastServer(IEnumerable<string> globalCfgLines)
        {
            foreach (string line in globalCfgLines)
                if (line.StartsWith("LastServer=", StringComparison.Ordinal))
                {
                    string value = line.Substring("LastServer=".Length).Trim();
                    return value.Length > 0 ? value : null;
                }
            return null;
        }

        // "host" or "host:port" → host and port (SRS's default when none is given), or false.
        internal static bool TryParseServer(string? server, out string host, out int port)
        {
            host = ""; port = DefaultPort;
            if (string.IsNullOrWhiteSpace(server)) return false;
            string s = server!.Trim();
            int colon = s.LastIndexOf(':');
            if (colon > 0 && s.IndexOf(':') == colon)
            {
                if (!int.TryParse(s.Substring(colon + 1), NumberStyles.None, CultureInfo.InvariantCulture, out port) ||
                    port < 1 || port > 65535) return false;
                s = s.Substring(0, colon);
            }
            host = s;
            return host.Length > 0;
        }

        // A SYNC message as SRS's client sends it, from a throwaway client id.
        internal static string SyncMessage()
        {
            string guid = Convert.ToBase64String(Guid.NewGuid().ToByteArray())
                .Replace('/', '_').Replace('+', '-').Substring(0, 22);
            return "{\"Client\":{\"ClientGuid\":\"" + guid + "\",\"Name\":\"NOXMFD\",\"Coalition\":0}," +
                   "\"MsgType\":2,\"Version\":\"" + ClientVersion + "\"}\n";
        }

        // The raw contents of a JSON string field (escapes kept), or null. A key inside another
        // string can't match: its quotes are escaped there.
        internal static string? RawStringField(string json, string key)
        {
            Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"");
            if (!m.Success) return null;
            int start = m.Index + m.Length;
            for (int i = start; i < json.Length; i++)
            {
                if (json[i] == '\\') { i++; continue; }
                if (json[i] == '"') return json.Substring(start, i - start);
            }
            return null;
        }

        // Connects, sends SYNC, and reads newline-delimited messages until one carries the server's
        // settings; returns its SERVER_PRESETS as a raw JSON string. Throws on network failure,
        // timeout, or a reply without settings.
        internal static string? Fetch(string host, int port, int timeoutMs)
        {
            using (var tcp = new TcpClient())
            {
                if (!tcp.ConnectAsync(host, port).Wait(timeoutMs))
                    throw new TimeoutException($"connect to {host}:{port} timed out");
                tcp.ReceiveTimeout = timeoutMs;
                tcp.SendTimeout = timeoutMs;
                NetworkStream stream = tcp.GetStream();
                byte[] sync = Encoding.UTF8.GetBytes(SyncMessage());
                stream.Write(sync, 0, sync.Length);

                var pending = new MemoryStream();
                var buf = new byte[65536];
                long read = 0;
                while (read < MaxReplyBytes)
                {
                    int n = stream.Read(buf, 0, buf.Length);
                    if (n <= 0) break;
                    read += n;
                    int from = 0;
                    for (int nl; (nl = Array.IndexOf(buf, (byte)'\n', from, n - from)) >= 0; from = nl + 1)
                    {
                        pending.Write(buf, from, nl - from);
                        string line = Encoding.UTF8.GetString(pending.ToArray());
                        pending.SetLength(0);
                        if (line.Contains("\"ServerSettings\"")) return RawStringField(line, "SERVER_PRESETS");
                    }
                    pending.Write(buf, from, n - from);
                }
                throw new IOException($"no server settings from {host}:{port} in {read} bytes");
            }
        }
    }
}
