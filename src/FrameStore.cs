using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text.RegularExpressions;

namespace TreeExtractor
{
    public class FrameStore : IDisposable
    {
        static readonly Regex FrameNamePattern = new Regex(@"(?:^|/)JpgFiles/([0-9]+(?:\.[0-9]+)?)\.jpg$",
            RegexOptions.CultureInvariant);
        internal const long MaxImageBytes = 128L * 1024 * 1024;
        const long MaxImagePixels = 100L * 1000 * 1000;
        ZipArchive _zip;
        Dictionary<string, ZipArchiveEntry> _entryMap = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        public List<FrameInfo> Frames = new List<FrameInfo>();
        public FrameStore(string zip)
        {
            _zip = ZipFile.OpenRead(zip);
            try
            {
                foreach (var e in _zip.Entries)
                {
                    Match match = FrameNamePattern.Match(e.FullName);
                    if (!match.Success) continue;
                    string gv = match.Groups[1].Value;
                    double gps;
                    if (!double.TryParse(gv, NumberStyles.Float, CultureInfo.InvariantCulture, out gps) ||
                        double.IsNaN(gps) || double.IsInfinity(gps))
                        throw new InvalidDataException("全景帧时间无效：" + e.FullName);
                    ValidateImageLength(e.Length, e.FullName);
                    string name = gv + ".jpg";
                    if (_entryMap.ContainsKey(name))
                        throw new InvalidDataException("全景包包含重复的帧名：" + name);
                    Frames.Add(new FrameInfo { Gps = gps, Name = name });
                    _entryMap.Add(name, e);
                }
                Frames.Sort(delegate (FrameInfo a, FrameInfo b) {
                    int order = a.Gps.CompareTo(b.Gps);
                    return order != 0 ? order : StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name);
                });
            }
            catch
            {
                _zip.Dispose();
                _zip = null;
                throw;
            }
        }
        internal static void ValidateImageLength(long length, string name)
        {
            if (length <= 0 || length > MaxImageBytes)
                throw new InvalidDataException("全景帧大小无效或超过 128 MiB：" + name);
        }
        internal static bool CopyWithinLimit(Stream source, Stream destination, long limit)
        {
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (read > limit - total) return false;
                destination.Write(buffer, 0, read);
                total += read;
            }
            return true;
        }
        public Bitmap Load(string name)
        {
            ZipArchiveEntry e;
            if (_entryMap.TryGetValue(name, out e))
            {
                try
                {
                    using (var s = e.Open())
                    using (var ms = new MemoryStream())
                    {
                        if (!CopyWithinLimit(s, ms, MaxImageBytes)) return null;
                        ms.Position = 0;
                        try
                        {
                            // Bitmap(Stream) 要求流在位图整个生命周期内保持打开（GDI+ 惰性解码），
                            // 这里拷成独立内存位图后流才可以安全释放
                            using (var b = new Bitmap(ms))
                            {
                                if (b.Width <= 0 || b.Height <= 0 || (long)b.Width * b.Height > MaxImagePixels)
                                    return null;
                                return new Bitmap(b);
                            }
                        }
                        catch { return null; }
                    }
                }
                catch { return null; }
            }
            return null;
        }
        public void Dispose()
        {
            if (_zip != null) { _zip.Dispose(); _zip = null; }
        }
    }
}
