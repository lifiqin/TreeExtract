using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text.RegularExpressions;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        // 在独立桥接进程中写入 ZIP64；照片不重新压缩，不覆盖已有文件。
        object DesktopMergeArchive(Dictionary<string, object> args)
        {
            string output = Path.GetFullPath(StringArg(args, "output"));
            object value;
            if (!args.TryGetValue("images", out value) || !(value is List<object> images) ||
                images.Count == 0 || images.Count > 100000)
                throw new InvalidDataException("照片列表无效。");
            var expected = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            using (var stream = new FileStream(output, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, false))
            {
                foreach (object item in images)
                {
                    var image = item as Dictionary<string, object>;
                    if (image == null) throw new InvalidDataException("照片记录无效。");
                    string source = Path.GetFullPath(StringArg(image, "source"));
                    string name = StringArg(image, "name");
                    if (!Regex.IsMatch(name, @"^\d+(?:\.\d+)?\.jpg$", RegexOptions.IgnoreCase) ||
                        !string.Equals(Path.GetFileName(source), name, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("照片文件名无效：" + name);
                    long length = Convert.ToInt64(image["length"], CultureInfo.InvariantCulture);
                    long modified = Convert.ToInt64(image["mtimeMs"], CultureInfo.InvariantCulture);
                    var info = new FileInfo(source);
                    if (!info.Exists || info.Length != length ||
                        new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() != modified)
                        throw new IOException("照片在分析后发生变化：" + name);
                    if (!expected.TryAdd(name, length)) throw new InvalidDataException("照片重名：" + name);
                    var entry = archive.CreateEntry("JpgFiles/" + name, CompressionLevel.NoCompression);
                    using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
                    using (var target = entry.Open()) input.CopyTo(target);
                    info.Refresh();
                    if (info.Length != length ||
                        new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() != modified)
                        throw new IOException("打包期间照片发生变化：" + name);
                }
            }
            using (var archive = ZipFile.OpenRead(output))
            {
                if (archive.Entries.Count != expected.Count) throw new InvalidDataException("全景包条目数量不正确。");
                foreach (var entry in archive.Entries)
                {
                    long length;
                    if (!entry.FullName.StartsWith("JpgFiles/", StringComparison.Ordinal) ||
                        !expected.TryGetValue(entry.Name, out length) || entry.Length != length)
                        throw new InvalidDataException("全景包校验失败：" + entry.FullName);
                }
            }
            return new Dictionary<string, object> { { "entries", expected.Count } };
        }
    }
}
