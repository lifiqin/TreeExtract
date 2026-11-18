using System;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        string _speciesDatasetFingerprint;
        string _speciesSourceStamp;
        string _speciesIdentityError;

        string DesktopSpeciesSourceStamp()
        {
            var paths = new[] { AppPaths.TreePath, AppPaths.PosePath, AppPaths.MetaPath,
                AppPaths.CrownPath, AppPaths.TrunkPath, _zipPath };
            var stamp = new StringBuilder();
            foreach (string path in paths)
            {
                var file = new FileInfo(path);
                stamp.Append(file.Exists ? file.Length.ToString() : "-")
                    .Append(':').Append(file.Exists ? file.LastWriteTimeUtc.Ticks.ToString() : "-").Append('|');
            }
            return stamp.ToString();
        }

        // 元数据按内容哈希；ZIP 使用中央目录中每个条目的名称、长度和 CRC。
        // 后者不是整个 ZIP 的密码学哈希，图像内容另由当前切图 SHA-256 绑定。
        string DesktopSpeciesDatasetFingerprint()
        {
            if (!string.IsNullOrEmpty(_speciesIdentityError))
                throw new IOException(_speciesIdentityError);
            string stamp = DesktopSpeciesSourceStamp();
            if (!string.IsNullOrEmpty(_speciesDatasetFingerprint))
            {
                if (!string.Equals(stamp, _speciesSourceStamp, StringComparison.Ordinal))
                    throw new IOException("数据文件已变化，请重新加载数据后再使用树种复核。");
                return _speciesDatasetFingerprint;
            }
            using (var manifest = new MemoryStream())
            using (var writer = new BinaryWriter(manifest, Encoding.UTF8, true))
            {
                writer.Write("TreeExtract species dataset v1");
                foreach (var item in new[] {
                    new { Role = "tree", Path = AppPaths.TreePath },
                    new { Role = "pose", Path = AppPaths.PosePath },
                    new { Role = "meta", Path = AppPaths.MetaPath },
                    new { Role = "crown", Path = AppPaths.CrownPath },
                    new { Role = "trunk", Path = AppPaths.TrunkPath }
                })
                {
                    writer.Write(item.Role);
                    bool exists = File.Exists(item.Path);
                    writer.Write(exists);
                    if (!exists) continue;
                    var before = new FileInfo(item.Path);
                    long length = before.Length;
                    DateTime changed = before.LastWriteTimeUtc;
                    using (var file = new FileStream(item.Path, FileMode.Open, FileAccess.Read, FileShare.Read))
                    using (var sha = SHA256.Create())
                        writer.Write(sha.ComputeHash(file));
                    var after = new FileInfo(item.Path);
                    if (after.Length != length || after.LastWriteTimeUtc != changed)
                        throw new IOException("数据文件在计算树种确认身份时发生变化。");
                }
                using (var archive = ZipFile.OpenRead(_zipPath))
                {
                    writer.Write(archive.Entries.Count);
                    foreach (var entry in archive.Entries)
                    {
                        writer.Write(entry.FullName);
                        writer.Write(entry.Length);
                        writer.Write(entry.CompressedLength);
                        writer.Write(entry.Crc32);
                    }
                }
                writer.Flush();
                manifest.Position = 0;
                using (var sha = SHA256.Create())
                    _speciesDatasetFingerprint = BitConverter.ToString(sha.ComputeHash(manifest))
                        .Replace("-", "").ToLowerInvariant();
                if (!string.Equals(stamp, DesktopSpeciesSourceStamp(), StringComparison.Ordinal))
                {
                    _speciesDatasetFingerprint = null;
                    throw new IOException("数据文件在计算树种确认身份时发生变化。");
                }
                _speciesSourceStamp = stamp;
                return _speciesDatasetFingerprint;
            }
        }
    }
}
