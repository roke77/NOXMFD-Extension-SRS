using System;
using System.Net.Sockets;
using System.Text;
using UnityEngine;

namespace SrsModule
{
    // Receives the page's POST /ext/srs/command bodies (NOXMFD calls Handle on the main thread) and
    // forwards each accepted command to SRS as one UDP datagram on 127.0.0.1 (docs/srs-plan.md,
    // "Commands"). SRS sends no reply; the page sees the result in the next state packet.
    internal static class SrsCommands
    {
        // Flat on purpose: Unity's JsonUtility doesn't fill nested objects under Mono. NaN marks a value
        // the page didn't send (JSON has no NaN, so a sent value can't collide with it).
        [Serializable]
        private sealed class Envelope
        {
            public string cmd = "";
            public int radio = 0; // filled by JsonUtility; 0 (the intercom) is rejected by SrsCommandMap
            public double mhz = double.NaN;
            public double vol = double.NaN;
        }

        private static UdpClient? _udp;
        private static int _port;

        internal static void Init(int port)
        {
            _port = port;
            _udp = new UdpClient();
        }

        internal static void Handle(string json)
        {
            var e = new Envelope();
            try { JsonUtility.FromJsonOverwrite(json, e); }
            catch (Exception ex)
            {
                Plugin.Log?.LogWarning($"[SRS] malformed command ignored: {ex.Message}");
                return;
            }

            string? datagram = SrsCommandMap.ToSrs(e.cmd, e.radio, e.mhz, e.vol);
            if (datagram == null)
            {
                Plugin.Log?.LogWarning($"[SRS] command rejected: {json}");
                return;
            }

            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(datagram);
                _udp?.Send(bytes, bytes.Length, "127.0.0.1", _port);
            }
            catch (Exception ex)
            {
                // UDP send only fails locally (socket closed, bad port); SRS not running is silent.
                Plugin.Log?.LogWarning($"[SRS] sending to UDP {_port} failed: {ex.Message}");
            }
        }

        internal static void Dispose()
        {
            _udp?.Close();
            _udp = null;
        }
    }
}
