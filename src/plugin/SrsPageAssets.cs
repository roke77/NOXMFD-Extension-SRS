using System;
using System.IO;
using System.Reflection;

namespace SrsModule
{
    // Embedded web assets for the SRS page, the same suffix-match pattern NOXMFD's own pages and its
    // other extensions use (EXTENSIONS.md, "2. Serving your page"). Runs on an HTTP worker, so it
    // touches nothing but this assembly's resources.
    internal static class SrsPageAssets
    {
        private static readonly Assembly Asm = typeof(SrsPageAssets).Assembly;

        internal static byte[]? Resolve(string relPath)
        {
            string name = string.IsNullOrEmpty(relPath) ? "srs.html" : relPath;
            string suffix = "." + ("web." + name).Replace('/', '.');
            foreach (string n in Asm.GetManifestResourceNames())
            {
                if (!n.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) continue;
                using Stream? s = Asm.GetManifestResourceStream(n);
                if (s == null) return null;
                var ms = new MemoryStream();
                s.CopyTo(ms);
                return ms.ToArray();
            }
            return null;
        }
    }
}
