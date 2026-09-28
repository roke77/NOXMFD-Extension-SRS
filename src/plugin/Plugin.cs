using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using UnityEngine;

namespace SrsModule
{
    // A separate BepInEx plugin, not part of NOXMFD.dll: it registers the SRS page with NOXMFD's
    // public Api and publishes SRS's latest state packet as the page's slice (docs/srs-plan.md).
    [BepInPlugin("com.roque.srs-module", "NOXMFD: SRS Extension", MyPluginInfo.PLUGIN_VERSION)]
    [BepInDependency("com.roque.NOXMFD", "0.59.0")]
    [BepInProcess("NuclearOption.exe")]
    public class Plugin : BaseUnityPlugin
    {
        internal const string ExtId = "srs";
        internal static ManualLogSource? Log;

        // Matches NOXMFD's 10 Hz frame, so every frame carries a fresh ageMs.
        private const float PublishInterval = 0.1f;
        // SRS sends every 200 ms in EAM; five missed packets means it's gone or disconnected.
        private const long StaleMs = 1000;

        private ConfigEntry<int>? _statePort;
        private SrsListener? _listener;
        private float _nextPublish;
        private bool _registered;

        private void Awake()
        {
            Log = Logger;
            _statePort = Config.Bind("SRS", "State port", 7082,
                new ConfigDescription("UDP port SRS sends its radio state to (SRS setting OutgoingDCSUDPOther). Restart the game after changing it.",
                    new AcceptableValueRange<int>(1024, 65535)));

            _registered = NOXMFD.Api.RegisterExtension(ExtId, "SRS", SrsPageAssets.Resolve);
            if (!_registered)
            {
                Log.LogError("[SRS] failed to register with NOXMFD (id already taken?); extension disabled.");
                return;
            }
            _listener = new SrsListener(_statePort.Value);
            Log.LogInfo($"SRS extension loaded; listening on UDP 127.0.0.1:{_statePort.Value}.");
        }

        private void Update()
        {
            if (!_registered || _listener == null || Time.unscaledTime < _nextPublish) return;
            _nextPublish = Time.unscaledTime + PublishInterval;
            NOXMFD.Api.PublishSlice(ExtId, BuildSlice(_listener, _statePort!.Value));
        }

        // ponytail: forwards SRS's whole packet (~4 KB) in every 10 Hz frame so the page does all the
        // parsing and SRS field changes stay out of C#. If frame size ever matters, trim the packet
        // to the fields srs.js reads before publishing.
        private static string BuildSlice(SrsListener listener, int port)
        {
            bool have = listener.TryGetLatest(out string packet, out long ageMs, out _);
            if (have && ageMs <= StaleMs)
                return "{\"ok\":true,\"ageMs\":" + ageMs + ",\"state\":" + packet + "}";
            string reason = listener.Error ?? (have ? "stale" : "no-data");
            return "{\"ok\":false,\"reason\":\"" + reason + "\",\"port\":" + port + ",\"ageMs\":" + ageMs + "}";
        }

        private void OnDestroy()
        {
            _listener?.Dispose();
            if (_registered) NOXMFD.Api.UnregisterExtension(ExtId);
        }
    }
}
