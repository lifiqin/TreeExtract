using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace TreeExtractor
{
    internal sealed class ManualMarkSnapshot
    {
        internal Dictionary<int, double[]> Entries;
        internal string Digest;
        internal bool Exists;
    }

    internal sealed class ManualMarkWriteResult
    {
        internal ManualMarkSnapshot Snapshot;
        internal string BackupPath;
    }

    // 负责校正文件的严格解析、版本检查和原子写入；不依赖 UI 或会话状态。
    internal static class ManualMarkRepository
    {
        const int MaxBytes = 10 * 1024 * 1024;
        const string Header = "# TreeExtractor 手动校正：树号,dAz°,dEl°（相对自动树干锚点的偏移）";

        static string Hash(byte[] bytes)
        {
            using (var sha = SHA256.Create()) return Convert.ToHexString(sha.ComputeHash(bytes));
        }

        static byte[] ReadBytes(Stream stream)
        {
            if (stream.Length > MaxBytes) throw new InvalidDataException("校正文件超过 10 MiB。");
            using (var buffer = new MemoryStream())
            {
                stream.CopyTo(buffer);
                if (buffer.Length > MaxBytes) throw new InvalidDataException("校正文件超过 10 MiB。");
                return buffer.ToArray();
            }
        }

        static void CheckFileKind(string path)
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.Directory) != 0)
                throw new InvalidDataException("校正文件路径是目录：" + path);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("校正文件不能是符号链接或重解析点：" + path);
        }

        internal static ManualMarkSnapshot Read(string path)
        {
            if (!File.Exists(path))
            {
                if (Directory.Exists(path)) throw new InvalidDataException("校正文件路径是目录：" + path);
                return new ManualMarkSnapshot { Exists = false, Entries = new Dictionary<int, double[]>() };
            }
            CheckFileKind(path);
            byte[] bytes;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                bytes = ReadBytes(stream);
            return Parse(bytes, path);
        }

        static ManualMarkSnapshot Parse(byte[] bytes, string path)
        {
            var result = new ManualMarkSnapshot { Exists = true, Digest = Hash(bytes), Entries = new Dictionary<int, double[]>() };
            string text = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF');
            using (var reader = new StringReader(text))
            {
                string raw;
                int lineNumber = 0;
                while ((raw = reader.ReadLine()) != null)
                {
                    lineNumber++;
                    string line = raw.Trim();
                    if (line.Length == 0 || line[0] == '#') continue;
                    string[] fields = line.Split(',');
                    int id; double az, el;
                    if (fields.Length != 3 ||
                        !int.TryParse(fields[0].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out id) ||
                        !double.TryParse(fields[1].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out az) ||
                        !double.TryParse(fields[2].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out el) ||
                        double.IsNaN(az) || double.IsInfinity(az) || double.IsNaN(el) || double.IsInfinity(el))
                        throw new InvalidDataException("校正文件第 " + lineNumber + " 行无效：" + path);
                    if (!result.Entries.TryAdd(id, new double[] { az, el }))
                        throw new InvalidDataException("校正文件中树号重复：" + id + "，文件：" + path);
                }
            }
            return result;
        }

        static byte[] Serialize(Dictionary<int, double[]> entries)
        {
            var lines = new List<string> { Header };
            var ids = new List<int>(entries.Keys);
            ids.Sort();
            foreach (int id in ids)
            {
                double[] value = entries[id];
                if (value == null || value.Length < 2 || double.IsNaN(value[0]) || double.IsInfinity(value[0]) ||
                    double.IsNaN(value[1]) || double.IsInfinity(value[1]))
                    throw new InvalidDataException("树号 " + id + " 的校正数值无效。");
                lines.Add(id.ToString(CultureInfo.InvariantCulture) + "," +
                    value[0].ToString("F5", CultureInfo.InvariantCulture) + "," +
                    value[1].ToString("F5", CultureInfo.InvariantCulture));
            }
            return new UTF8Encoding(false).GetBytes(string.Join(Environment.NewLine, lines) + Environment.NewLine);
        }

        internal static ManualMarkWriteResult Write(string path, Dictionary<int, double[]> entries, ManualMarkSnapshot expected)
        {
            if (expected == null) throw new UserFacingException("校正文件未能完整读取，为避免覆盖，不能保存。");
            byte[] replacement = Serialize(entries);
            string dir = Path.GetDirectoryName(path);
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
                throw new UserFacingException("校正文件所在目录不存在，未保存：" + path);
            if (Directory.Exists(path)) throw new UserFacingException("校正文件路径是目录，未保存：" + path);
            string temporary = path + ".tmp." + Guid.NewGuid().ToString("N");
            string backup = null;
            FileStream current = null;
            try
            {
                if (File.Exists(path))
                {
                    CheckFileKind(path);
                    current = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
                    string digest = Hash(ReadBytes(current));
                    if (!expected.Exists || !string.Equals(digest, expected.Digest, StringComparison.Ordinal))
                        throw new UserFacingException("校正文件已被外部修改，未覆盖。请备份并重新加载：" + path);
                }
                else if (expected.Exists)
                    throw new UserFacingException("校正文件已被外部删除或移动，未保存：" + path);

                using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    output.Write(replacement, 0, replacement.Length);
                    output.Flush(true);
                }
                if (current != null)
                {
                    backup = path + ".backup." + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture)
                        + "." + Guid.NewGuid().ToString("N");
                    File.Replace(temporary, path, backup);
                }
                else File.Move(temporary, path); // 默认不得覆盖并发新建的文件。
                return new ManualMarkWriteResult { Snapshot = Parse(replacement, path), BackupPath = backup };
            }
            finally { if (current != null) current.Dispose(); }
        }
    }
}
