using System;
using System.Collections.Generic;
using System.IO;

namespace TreeExtractor
{
    // 数据路径解析：程序不再绑定「E:\树木识别\tree」这个固定位置，换电脑/换盘符只改一个 ini。
    //
    // 数据目录（DataDir）判定顺序：
    //   1. exe 同级 TreeExtractor.ini 里的 DataDir（绝对路径或相对 exe 的路径）
    //   2. 含 Camera4.zip 的 data\ 目录（便携版完整布局，拷齐了全景包才用它）
    //   3. 含 Camera4.zip 的历史默认目录 E:\树木识别\tree（老机器零改动）
    //   4. 只有小数据文件的 data\ 目录（提示仍指向 data\Camera4.zip）
    //   5. 历史默认目录（哪怕不全）
    //   6. exe 所在目录
    //
    // 单个文件也可以在 ini 里单独覆盖（Zip=Pose=Tree=Meta=Crown=Trunk=），
    // 典型场景：5.8GB 的 Camera4.zip 放在另一块盘上。
    static class AppPaths
    {
        public const string IniName = "TreeExtractor.ini";
        static string _root;
        static Dictionary<string, string> _ini;

        public static string ExeDir { get { return AppDomain.CurrentDomain.BaseDirectory; } }

        public static string Root
        {
            get
            {
                if (_root == null) _root = ResolveRoot();
                return _root;
            }
        }

        static Dictionary<string, string> Ini
        {
            get
            {
                if (_ini == null) _ini = LoadIni();
                return _ini;
            }
        }

        // 全景包（5.8GB，允许单独指到别的盘）
        public static string ZipPath { get { return Pick("Zip", "Camera4.zip"); } }
        // 姿态文件（IMU）
        public static string PosePath { get { return Pick("Pose", "imgPosList.txt"); } }
        // 树心：优先修正版（真实树高 + 中文树种）
        public static string TreePath { get { return Pick("Tree", "tree_centers2.txt", "tree_centers.txt"); } }
        // Metashape 姿态
        public static string MetaPath { get { return Pick("Meta", "Metashape.txt"); } }
        // 点云实测树冠半径
        public static string CrownPath { get { return Pick("Crown", "crown.csv"); } }
        // 点云实测树干轴心
        public static string TrunkPath { get { return Pick("Trunk", "trunk.csv"); } }

        // 供桌面壳层在用户选择数据目录后切换当前会话；不写入或覆盖任何 ini 文件。
        internal static void ConfigureSession(string dataDirectory, string zipPath)
        {
            if (string.IsNullOrWhiteSpace(dataDirectory))
                throw new ArgumentException("数据目录不能为空。", "dataDirectory");
            string root = Path.GetFullPath(dataDirectory);
            if (!Directory.Exists(root))
                throw new DirectoryNotFoundException("找不到数据目录：" + root);
            var settings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (!string.IsNullOrWhiteSpace(zipPath)) settings["Zip"] = Path.GetFullPath(zipPath);
            _root = root;
            _ini = settings;
        }

        static string ResolveRoot()
        {
            string v;
            if (Ini.TryGetValue("DataDir", out v) && v.Length > 0)
            {
                string p = Path.IsPathRooted(v) ? v : Path.Combine(ExeDir, v);
                if (Directory.Exists(p)) return p;
                // 配置了但目录不存在：仍然用它（报错信息会指向用户配置的位置，便于排查）
                return p;
            }
            string data = Path.Combine(ExeDir, "data");
            string legacy = @"E:\树木识别\tree";
            // 便携版的 data\ 只有树心/姿态等小文件时，不能算「完整数据目录」：
            // 5.8GB 的 Camera4.zip 通常没跟着拷贝，这会导致「找不到全景包」。
            // 因此 data 里有全景包才优先；否则老机器上的 tree\ 有全景包就用它。
            // 换到新电脑两者都没有时，仍回退 data（报错路径与便携版说明一致）。
            if (File.Exists(Path.Combine(data, "Camera4.zip"))) return data;
            if (File.Exists(Path.Combine(legacy, "Camera4.zip"))) return legacy;
            if (Directory.Exists(data)) return data;
            if (Directory.Exists(legacy)) return legacy;
            return ExeDir;
        }

        // ini 显式配置优先（即使文件不存在也返回配置值，让报错指向真实位置）；
        // 否则在数据目录里按候选名依次找，都不存在时返回首个候选（供界面预填）
        static string Pick(string key, params string[] names)
        {
            string v;
            if (Ini.TryGetValue(key, out v) && v.Length > 0)
                return Path.IsPathRooted(v) ? v : Path.Combine(Root, v);
            foreach (var n in names)
            {
                string p = Path.Combine(Root, n);
                if (File.Exists(p)) return p;
            }
            return Path.Combine(Root, names[0]);
        }

        static Dictionary<string, string> LoadIni()
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                string path = Path.Combine(ExeDir, IniName);
                if (!File.Exists(path)) return d;
                foreach (var raw in File.ReadAllLines(path))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line[0] == ';' || line[0] == '#' || line[0] == '[') continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim();
                    string val = line.Substring(eq + 1).Trim().Trim('"');
                    if (k.Length > 0) d[k] = val;
                }
            }
            catch (Exception ex) { BackendLog.Write("读取 " + IniName + " 失败: " + ex.Message); }
            return d;
        }
    }
}
