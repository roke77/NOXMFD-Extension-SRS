using System;
using System.IO;
using System.Threading;

namespace SrsModule
{
    // Keeps the SRS server's preset list for the page (SrsPresetSync does the fetch). While SRS is
    // sending state it re-reads the SRS client's LastServer every few seconds and fetches the list
    // on a pool thread whenever that server changes, retrying a failed fetch after a minute.
    // ponytail: fetches once per server per game session, so a server that changes its presets
    // while connected shows the old names until the game restarts or the SRS client switches
    // servers; a periodic re-fetch is the upgrade, at one more short server connection each time.
    internal sealed class SrsPresets
    {
        private const float CheckEvery = 5f, RetryAfter = 60f;
        private const int TimeoutMs = 5000;

        private readonly string _globalCfg;
        private float _nextCheck;
        private bool _cfgWarned;

        // Written by the fetch thread, read by the main thread.
        private volatile string? _raw;         // SERVER_PRESETS as a raw JSON string
        private volatile string? _fetchedFor;  // the server _raw came from
        private volatile bool _busy, _failed;

        internal SrsPresets(string srsClientFolder)
        {
            _globalCfg = Path.Combine(srsClientFolder, "global.cfg");
        }

        // The latest preset list as a raw JSON string (for a JSON string field), or null.
        internal string? Raw => _raw;

        // Main thread, every publish. `live`: SRS is sending state, so its client is running.
        internal void Tick(float now, bool live)
        {
            if (_busy) return;
            if (_failed) { _failed = false; _nextCheck = now + RetryAfter; return; }
            if (!live || now < _nextCheck) return;
            _nextCheck = now + CheckEvery;

            string? server = ReadLastServer();
            if (server == null || server == _fetchedFor) return;
            // Another server: its names aren't known yet, and the last server's don't apply.
            _raw = null;
            if (!SrsPresetSync.TryParseServer(server, out string host, out int port))
            {
                Plugin.Log?.LogWarning($"[SRS] presets: can't read server address \"{server}\" from {_globalCfg}.");
                _fetchedFor = server; // don't warn every 5 s about the same value
                return;
            }
            _busy = true;
            ThreadPool.QueueUserWorkItem(_ => Fetch(server, host, port));
        }

        private void Fetch(string server, string host, int port)
        {
            try
            {
                _raw = SrsPresetSync.Fetch(host, port, TimeoutMs);
                _fetchedFor = server;
                Plugin.Log?.LogInfo(_raw == null || _raw == "{}"
                    ? $"[SRS] presets: server {server} has no preset channels."
                    : $"[SRS] presets: loaded from server {server}.");
            }
            catch (Exception e)
            {
                Plugin.Log?.LogWarning($"[SRS] presets: fetch from {server} failed ({e.GetBaseException().Message}); retrying in {RetryAfter:0} s.");
                _failed = true;
            }
            finally { _busy = false; }
        }

        // Read with shared access: the SRS client rewrites global.cfg while it runs. A failed read
        // (the file mid-write) just waits for the next check; a missing file is worth one warning.
        private string? ReadLastServer()
        {
            try
            {
                using (var stream = new FileStream(_globalCfg, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream))
                    return SrsPresetSync.LastServer(reader.ReadToEnd().Split('\n'));
            }
            catch (Exception e) when (e is FileNotFoundException || e is DirectoryNotFoundException)
            {
                if (!_cfgWarned) Plugin.Log?.LogWarning($"[SRS] presets: {_globalCfg} not found; set \"SRS client folder\" to SRS's Client folder.");
                _cfgWarned = true;
                return null;
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                return null;
            }
        }
    }
}
