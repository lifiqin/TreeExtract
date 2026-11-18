using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace TreeExtractor
{
    // 准备阶段拥有 ZIP 句柄；只有会话提交时才将所有权交给 BackendSession。
    internal sealed class PreparedDataset : IDisposable
    {
        internal FrameStore Frames;
        internal PoseIndex Poses;
        internal UtmForest Forest;
        internal Dictionary<string, double[]> Metadata;
        internal Dictionary<int, double> Crown;
        internal Dictionary<int, double[]> Trunk;
        internal ManualMarkSnapshot Marks;
        internal string TreePath;

        internal FrameStore TakeFrames()
        {
            FrameStore result = Frames;
            Frames = null;
            return result;
        }

        public void Dispose()
        {
            if (Frames != null) { Frames.Dispose(); Frames = null; }
        }
    }

    // 输入适配层：读取并检查一整套数据，不更改当前会话或任何源文件。
    internal static class DatasetLoader
    {
        static string Stamp(params string[] paths)
        {
            var result = new StringBuilder();
            foreach (string path in paths)
            {
                var file = new FileInfo(path);
                result.Append(file.Exists ? file.Length.ToString(CultureInfo.InvariantCulture) : "-")
                    .Append(':').Append(file.Exists ? file.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture) : "-")
                    .Append('|');
            }
            return result.ToString();
        }

        static Dictionary<int, double> ReadCrown(string path)
        {
            var result = new Dictionary<int, double>();
            if (!File.Exists(path)) return result;
            foreach (string line in File.ReadLines(path))
            {
                string[] fields = line.Trim().Split(',');
                int id; double radius;
                if (fields.Length >= 4 && int.TryParse(fields[0], out id) &&
                    double.TryParse(fields[3], NumberStyles.Float, CultureInfo.InvariantCulture, out radius) &&
                    !double.IsNaN(radius) && !double.IsInfinity(radius) && radius > 0.05)
                    result[id] = radius;
            }
            return result;
        }

        static Dictionary<int, double[]> ReadTrunk(string path)
        {
            var result = new Dictionary<int, double[]>();
            if (!File.Exists(path)) return result;
            foreach (string line in File.ReadLines(path))
            {
                string[] fields = line.Trim().Split(',');
                int id; double x, y;
                if (fields.Length >= 6 && int.TryParse(fields[0], out id) &&
                    double.TryParse(fields[4], NumberStyles.Float, CultureInfo.InvariantCulture, out x) &&
                    double.TryParse(fields[5], NumberStyles.Float, CultureInfo.InvariantCulture, out y) &&
                    !double.IsNaN(x) && !double.IsInfinity(x) && !double.IsNaN(y) && !double.IsInfinity(y))
                    result[id] = new double[] { x, y };
            }
            return result;
        }

        internal static PreparedDataset Prepare(string zip, string pose, string tree, string meta, string crown, string trunk)
        {
            var prepared = new PreparedDataset { TreePath = tree };
            string marks = Path.Combine(Path.GetDirectoryName(tree), "manual_marks.csv");
            string before = Stamp(zip, pose, tree, meta, crown, trunk, marks);
            try
            {
                prepared.Forest = new UtmForest();
                if (!prepared.Forest.Load(tree))
                    throw new UserFacingException("树心文件加载失败，未切换数据：" + tree);
                var treeIds = new HashSet<int>();
                foreach (var item in prepared.Forest.Trees)
                    if (!treeIds.Add(item.Id))
                        throw new UserFacingException("树心文件存在重复树号 " + item.Id + "，未切换数据：" + tree);
                try
                {
                    prepared.Frames = new FrameStore(zip);
                    if (prepared.Frames.Frames.Count == 0) throw new InvalidDataException("没有可识别的全景帧。");
                }
                catch (Exception ex) { throw new UserFacingException("全景包无效，未切换数据：" + zip + "；原因：" + ex.Message, ex); }
                try
                {
                    prepared.Poses = new PoseIndex(pose);
                    if (prepared.Poses.Poses.Count == 0) throw new InvalidDataException("没有有效位姿。");
                }
                catch (Exception ex) { throw new UserFacingException("位姿文件无效，未切换数据：" + pose + "；原因：" + ex.Message, ex); }
                try
                {
                    prepared.Metadata = new Dictionary<string, double[]>(StringComparer.OrdinalIgnoreCase);
                    foreach (var frame in PanoMath.LoadMetashape(meta))
                    {
                        if (!prepared.Metadata.TryAdd(frame.Name, new double[] { frame.X, frame.Y, frame.Z, frame.Omega, frame.Phi, frame.Kappa }))
                            throw new InvalidDataException("相机帧名重复：" + frame.Name);
                    }
                }
                catch (Exception ex) { throw new UserFacingException("相机位姿文件无效，未切换数据：" + meta + "；原因：" + ex.Message, ex); }
                try { prepared.Marks = ManualMarkRepository.Read(marks); }
                catch (Exception ex) { throw new UserFacingException("手动校正文件无法完整读取，未切换数据。请先备份并检查文件。原因：" + ex.Message, ex); }
                try { prepared.Crown = ReadCrown(crown); prepared.Trunk = ReadTrunk(trunk); }
                catch (Exception ex) { throw new UserFacingException("树木配套文件无法读取，未切换数据：" + ex.Message, ex); }
                if (!string.Equals(before, Stamp(zip, pose, tree, meta, crown, trunk, marks), StringComparison.Ordinal))
                    throw new UserFacingException("数据在加载期间发生变化，未切换数据。请重新选择。");
                return prepared;
            }
            catch { prepared.Dispose(); throw; }
        }
    }
}
