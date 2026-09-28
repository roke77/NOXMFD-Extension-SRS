using System;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace SrsModule
{
    // Receives SRS's JSON state packets on a background thread (docs/srs-plan.md, "State out").
    // Touches no Unity API: the main thread reads the latest packet through TryGetLatest.
    internal sealed class SrsListener : IDisposable
    {
        private readonly int _port;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly Thread _thread;
        private volatile bool _stop;
        private volatile UdpClient? _client;

        // Written by the receive thread, read by the main thread; one lock keeps packet and
        // arrival time consistent with each other.
        private readonly object _gate = new object();
        private string? _packet;
        private long _arrivedMs = -1;
        private long _seq;

        internal volatile string? Error;

        internal SrsListener(int port)
        {
            _port = port;
            _thread = new Thread(Run) { IsBackground = true, Name = "SRS UDP listener" };
            _thread.Start();
        }

        // The newest packet, its age in ms, and a sequence number that changes on every packet.
        internal bool TryGetLatest(out string packet, out long ageMs, out long seq)
        {
            lock (_gate)
            {
                packet = _packet ?? "";
                seq = _seq;
                ageMs = _arrivedMs < 0 ? -1 : _clock.ElapsedMilliseconds - _arrivedMs;
                return _packet != null;
            }
        }

        private void Run()
        {
            while (!_stop)
            {
                try
                {
                    // Loopback only: SRS sends to 127.0.0.1, and nothing else should feed the page.
                    using var client = new UdpClient(new IPEndPoint(IPAddress.Loopback, _port));
                    _client = client;
                    Error = null;
                    var from = new IPEndPoint(IPAddress.Any, 0);
                    while (!_stop)
                    {
                        byte[] data = client.Receive(ref from);
                        string text = Encoding.UTF8.GetString(data).Trim();
                        lock (_gate)
                        {
                            _packet = text;
                            _arrivedMs = _clock.ElapsedMilliseconds;
                            _seq++;
                        }
                    }
                }
                catch (SocketException e) when (!_stop)
                {
                    // Port taken by another tool, or the socket failed: report it and retry, so the
                    // page recovers once the port frees up.
                    Error = e.SocketErrorCode == SocketError.AddressAlreadyInUse ? "port-busy" : "socket-error";
                    Plugin.Log?.LogWarning($"[SRS] UDP {_port}: {e.SocketErrorCode}; retrying in 5 s.");
                    Thread.Sleep(5000);
                }
                // Dispose closes the socket to unblock Receive; whatever that throws is expected.
                catch (Exception) when (_stop) { }
                catch (Exception e)
                {
                    Error = "socket-error";
                    Plugin.Log?.LogError($"[SRS] UDP {_port} listener failed: {e}");
                    Thread.Sleep(5000);
                }
            }
        }

        public void Dispose()
        {
            _stop = true;
            _client?.Close(); // unblocks Receive
        }
    }
}
