using System;
using System.Collections.Generic;
using System.IO;

namespace TreeExtractor
{
    /// <summary>Commits a complete image using same-directory atomic file operations.</summary>
    internal static class CropExportWriter
    {
        public static string Write(string destination, byte[] bytes, Action beforeCommit = null)
        {
            if (string.IsNullOrWhiteSpace(destination)) throw new ArgumentException("请选择保存路径。");
            if (bytes == null || bytes.Length == 0) throw new ArgumentException("切图内容为空。");
            string target = Path.GetFullPath(destination);
            string directory = Path.GetDirectoryName(target);
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
                throw new DirectoryNotFoundException("保存目录不存在：" + directory);
            RejectReparsePointAncestors(directory);
            if (Directory.Exists(target)) throw new IOException("保存路径是目录：" + target);

            bool existed = File.Exists(target);
            if (existed) RejectReparsePoint(target);
            string nonce = Guid.NewGuid().ToString("N");
            string stage = Path.Combine(directory, ".treeextract-stage-" + nonce + ".tmp");
            string backup = Path.Combine(directory, ".treeextract-backup-" + nonce + ".bak");
            bool stageCreated = false;
            try
            {
                using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stageCreated = true;
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                // Only used by deterministic tests to simulate another writer at the commit boundary.
                if (beforeCommit != null) beforeCommit();
                if (existed)
                {
                    // Never follow a reparse point chosen as the destination.
                    RejectReparsePoint(target);
                    File.Replace(stage, target, backup);
                    return backup;
                }
                // The non-overwriting overload fails if a concurrent writer created the target.
                File.Move(stage, target);
                return null;
            }
            catch (Exception ex)
            {
                string leftovers = stageCreated && File.Exists(stage) ? " 暂存文件保留于：" + stage : "";
                if (File.Exists(backup)) leftovers += " 旧文件备份保留于：" + backup;
                // The JSON bridge reports only the innermost exception message; keep recovery paths
                // in the outer message rather than nesting the exception and losing them.
                throw new IOException("切图保存失败；未主动删除已有文件。" + leftovers
                    + " 原因：" + ex.GetType().Name + ": " + ex.Message);
            }
        }

        static void RejectReparsePoint(string path)
        {
            RejectReparseAttributes(File.GetAttributes(path));
        }

        internal static void RejectReparsePointAncestors(string directory)
        {
            for (var item = new DirectoryInfo(directory); item != null; item = item.Parent)
                RejectReparseAttributes(item.Attributes);
        }

        internal static void RejectReparseAttributes(FileAttributes attributes)
        {
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("保存路径不能使用符号链接或重解析点。");
        }

        internal static void ValidateDestination(string destination, IEnumerable<string> protectedPaths)
        {
            if (string.IsNullOrWhiteSpace(destination)) throw new ArgumentException("请选择保存路径。");
            string target = Path.GetFullPath(destination);
            if (!string.Equals(Path.GetExtension(target), ".png", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("切图只能保存为 .png 文件。");
            foreach (string input in protectedPaths)
            {
                if (!string.IsNullOrWhiteSpace(input) &&
                    string.Equals(target, Path.GetFullPath(input), StringComparison.OrdinalIgnoreCase))
                    throw new IOException("保存路径与当前输入或人工标注文件相同，拒绝覆盖。");
            }
        }
    }
}
