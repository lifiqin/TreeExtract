using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace TreeExtractor
{
    /// <summary>
    /// 本地树种识别（ONNX Runtime，离线，不联网）。
    /// 模型：yolov8s-cls 18 类，输入 1×3×384×384，输出 1×18 已带 softmax 的概率。
    /// 预处理必须与训练严格一致：短边缩放到 384（双线性）→ 中心裁剪 384×384 → /255（不做 ImageNet 归一化）。
    /// </summary>
    internal static class TreeClassifier
    {
        public const int Size = 384;

        // 类别顺序 = 模型 names 顺序，改顺序会导致全部错位
        public static readonly string[] Slugs =
        {
            "bailei", "guangyulan", "guihuashu", "hongyeli", "jiazhutao", "jushu",
            "liushan", "liushu", "luanshu", "luoyushan", "mufurong", "pushu",
            "qingtong", "shanhu", "wuhuanzi", "xiangzhang", "xuanlingmu", "yinxingshu"
        };

        public static readonly string[] Names =
        {
            "柏类", "广玉兰", "桂花", "红叶李", "夹竹桃", "榉树",
            "柳杉", "柳树", "栾树", "落羽杉", "木芙蓉", "朴树",
            "青桐", "珊瑚", "无患子", "香樟", "悬铃木", "银杏"
        };

        // 类别偏置校准：把「栾树」的 logit 压低 1.0，抑制它吸走无患子/银杏
        // 来源：在验证集上按宏平均选出（test 上栾树精确率 78%→92%，整体 +0.8）
        static readonly float[] Bias = BuildBias();

        static float[] BuildBias()
        {
            var b = new float[Slugs.Length];
            for (int i = 0; i < Slugs.Length; i++) b[i] = 0f;
            b[Array.IndexOf(Slugs, "luanshu")] = -1.0f;
            return b;
        }

        static InferenceSession _sess;
        static readonly object _lock = new object();

        public static string ModelPath
        {
            get
            {
                string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "models", "tree_cls.onnx");
                if (File.Exists(p)) return p;
                p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tree_cls.onnx");
                return p;
            }
        }

        public static bool Ready
        {
            get
            {
                try { EnsureSession(); return true; }
                catch { return false; }
            }
        }

        static void EnsureSession()
        {
            if (_sess != null) return;
            lock (_lock)
            {
                if (_sess != null) return;
                string path = ModelPath;
                if (!File.Exists(path))
                    throw new FileNotFoundException("找不到树种模型：\n" + path + "\n请把 tree_cls.onnx 放到程序目录的 models 文件夹下。");
                var opt = new SessionOptions();
                opt.IntraOpNumThreads = Math.Max(1, Environment.ProcessorCount / 2);
                opt.InterOpNumThreads = 1;
                opt.GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL;
                _sess = new InferenceSession(path, opt);
            }
        }

        public static void Warmup()
        {
            try
            {
                EnsureSession();
                var t = new DenseTensor<float>(new float[3 * Size * Size], new[] { 1, 3, Size, Size });
                using (var r = _sess.Run(new[] { NamedOnnxValue.CreateFromTensor(_sess.InputMetadata.Keys.First(), t) })) { }
            }
            catch { }
        }

        public class Result
        {
            public int Index;
            public string Name;
            public float Prob;
            public string[] TopNames = new string[3];
            public float[] TopProbs = new float[3];
            public bool Reliable;
            public string Text;
        }

        /// <summary>对一张 Bitmap 做识别；无法识别时返回 null</summary>
        public static Result Predict(Bitmap bmp)
        {
            if (bmp == null) return null;
            EnsureSession();

            float[] probs = RunProbs(bmp);
            var order = TopOrder(probs);

            var r = new Result { Index = order[0], Name = Names[order[0]], Prob = probs[order[0]] };
            for (int k = 0; k < 3; k++)
            {
                r.TopNames[k] = Names[order[k]];
                r.TopProbs[k] = probs[order[k]];
            }

            // 构图一致性：整图结论要与其 5 个裁剪的多数一致。
            // 只在置信度不高时才去做，省掉大部分场景的额外耗时。
            int agree = 5, votes = 5;
            if (r.Prob < 0.85f)
            {
                agree = 0;
                foreach (var box in CropBoxes(bmp, 0.6f))
                {
                    using (var c = Crop(bmp, box))
                    {
                        var pc = RunProbs(c);
                        if (ArgMax(pc) == r.Index) agree++;
                    }
                }
            }

            r.Reliable = r.Prob >= 0.5f && agree >= 4;

            var sb = new System.Text.StringBuilder();
            sb.Append("树种：").Append(r.Name).Append('（').Append((r.Prob * 100).ToString("F1")).Append("%）\r\n");
            sb.Append("候选：");
            for (int k = 0; k < 3; k++)
            {
                if (k > 0) sb.Append(" / ");
                sb.Append(r.TopNames[k]).Append(' ').Append((r.TopProbs[k] * 100).ToString("F0")).Append('%');
            }
            sb.Append("\r\n");
            if (r.Prob < 0.85f)
                sb.Append("构图一致：").Append(agree).Append('/').Append(votes).Append("\r\n");
            sb.Append(r.Reliable
                ? "本地模型判定：可靠"
                : "本地模型判定：存疑（构图/遮挡异常，建议补拍整树 + 叶片特写）");
            r.Text = sb.ToString();
            return r;
        }

        static int ArgMax(float[] a)
        {
            int k = 0;
            for (int i = 1; i < a.Length; i++) if (a[i] > a[k]) k = i;
            return k;
        }

        static int[] TopOrder(float[] a)
        {
            var idx = new int[a.Length];
            for (int i = 0; i < idx.Length; i++) idx[i] = i;
            Array.Sort(idx, (x, y) => a[y].CompareTo(a[x]));
            return idx;
        }

        /// <summary>跑一次前向，返回已做类别校准的概率</summary>
        static float[] RunProbs(Bitmap bmp)
        {
            return RunProbsFromPixels(Preprocess(bmp, Size));
        }

        /// <summary>直接对预处理后的 CHW 像素跑前向（热力图的遮挡实验复用同一入口）</summary>
        static float[] RunProbsFromPixels(float[] px)
        {
            var tensor = new DenseTensor<float>(px, new[] { 1, 3, Size, Size });
            string inName = _sess.InputMetadata.Keys.First();
            string outName = _sess.OutputMetadata.Keys.First();

            float[] raw;
            using (var res = _sess.Run(new[] { NamedOnnxValue.CreateFromTensor(inName, tensor) }))
                raw = res.First(item => item.Name == outName).AsEnumerable<float>().ToArray();

            // 类别校准：probs -> log -> +bias -> softmax
            double max = double.NegativeInfinity;
            var logits = new double[raw.Length];
            for (int i = 0; i < raw.Length; i++)
            {
                logits[i] = Math.Log(Math.Max(raw[i], 1e-9)) + Bias[i];
                if (logits[i] > max) max = logits[i];
            }
            double sum = 0;
            for (int i = 0; i < logits.Length; i++) { logits[i] = Math.Exp(logits[i] - max); sum += logits[i]; }
            var outp = new float[logits.Length];
            for (int i = 0; i < logits.Length; i++) outp[i] = (float)(logits[i] / sum);
            return outp;
        }

        /// <summary>
        /// 识别注意力热力图（遮挡敏感性）：把 384×384 模型输入分成 10×10 格，
        /// 每次遮住一格（填 0.5 灰度）重跑一次，记录目标类概率下降量。
        /// 下降越多说明该区域对当前判定越关键。ONNX 模型只有前向、没有梯度，
        /// 遮挡法是唯一不依赖模型内部结构、可直接解释的解释方式。
        /// 返回与源图同尺寸的叠加图；被取消时返回 null。
        /// </summary>
        public static Bitmap Heatmap(Bitmap bmp, int classIndex, Action<int, int> progress, Func<bool> cancelled)
        {
            if (bmp == null) return null;
            EnsureSession();
            float[] basePx = Preprocess(bmp, Size);
            var baseProbs = RunProbsFromPixels(basePx);
            if (classIndex < 0 || classIndex >= baseProbs.Length) return null;
            float baseP = baseProbs[classIndex];

            const int G = 10;
            var raw = new float[G, G];
            // 复用一个缓冲区，仅恢复上次遮挡区域；每次推理输入与逐格克隆完全相同。
            var occluded = (float[])basePx.Clone();
            float maxRaw = 0;
            for (int gy = 0; gy < G; gy++)
            {
                if (cancelled != null && cancelled()) return null;
                for (int gx = 0; gx < G; gx++)
                {
                    int x0 = gx * Size / G, x1 = (gx + 1) * Size / G;
                    int y0 = gy * Size / G, y1 = (gy + 1) * Size / G;
                    // 用该格自身的均值遮挡（而不是灰块）：只抹掉纹理/结构，
                    // 不引入模型没见过的灰色斑块，响应更聚焦、不会全图一起掉分。
                    var mean = new float[3];
                    int n = (x1 - x0) * (y1 - y0);
                    for (int c = 0; c < 3; c++)
                    {
                        int plane = c * Size * Size;
                        float s = 0;
                        for (int y = y0; y < y1; y++)
                        {
                            int row = plane + y * Size;
                            for (int x = x0; x < x1; x++) s += basePx[row + x];
                        }
                        mean[c] = s / n;
                    }
                    for (int c = 0; c < 3; c++)
                    {
                        int plane = c * Size * Size;
                        float mv = mean[c];
                        for (int y = y0; y < y1; y++)
                        {
                            int row = plane + y * Size;
                            for (int x = x0; x < x1; x++) occluded[row + x] = mv;
                        }
                    }
                    var p = RunProbsFromPixels(occluded);
                    for (int c = 0; c < 3; c++)
                    {
                        int plane = c * Size * Size;
                        for (int y = y0; y < y1; y++)
                        {
                            int start = plane + y * Size + x0;
                            Array.Copy(basePx, start, occluded, start, x1 - x0);
                        }
                    }
                    float drop = baseP - p[classIndex];
                    if (drop < 0) drop = 0;
                    raw[gy, gx] = drop;
                    if (drop > maxRaw) maxRaw = drop;
                }
                if (progress != null) progress((gy + 1) * G, G * G);
            }
            // 遮挡任何区域都会让概率普遍下降，直接归一化会全图发热。
            // 减去全格平均值，只保留「高于平均」的差异区域；若整图都很平均则回退原始值。
            double sum = 0;
            for (int gy = 0; gy < G; gy++)
                for (int gx = 0; gx < G; gx++) sum += raw[gy, gx];
            float meanDrop = (float)(sum / (G * G));
            var imp = new float[G, G];
            float maxImp = 0;
            for (int gy = 0; gy < G; gy++)
                for (int gx = 0; gx < G; gx++)
                {
                    float v = raw[gy, gx] - meanDrop;
                    if (v < 0) v = 0;
                    imp[gy, gx] = v;
                    if (v > maxImp) maxImp = v;
                }
            if (maxImp < 1e-4f)
            {
                imp = raw;
                maxImp = maxRaw;
            }
            // 模型对该图不敏感：给一个下限，避免除零；画面会接近原图
            if (maxImp < 1e-4f) maxImp = 1e-4f;
            return ComposeHeat(bmp, imp, maxImp);
        }

        // 把 10×10 热力网格画回 4:3 原图：只覆盖模型实际看到的中心裁剪区域，
        // 先压暗原图再叠半透明 jet 色，低值区域透明，避免整张图泛蓝。
        static Bitmap ComposeHeat(Bitmap src, float[,] imp, float maxImp)
        {
            int w = src.Width, h = src.Height;
            var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(dst))
            {
                g.DrawImage(src, 0, 0, w, h);
                using (var dim = new SolidBrush(Color.FromArgb(80, 0, 0, 0)))
                    g.FillRectangle(dim, 0, 0, w, h);

                double scale = (double)Size / Math.Min(w, h);
                int nw = Math.Max(Size, (int)Math.Round(w * scale));
                int nh = Math.Max(Size, (int)Math.Round(h * scale));
                int ox = (nw - Size) / 2, oy = (nh - Size) / 2;
                float sx = (float)(ox / scale), sy = (float)(oy / scale);
                float sw = (float)(Size / scale), sh = (float)(Size / scale);

                int G = imp.GetLength(0);
                using (var small = new Bitmap(G, G, PixelFormat.Format32bppArgb))
                {
                    for (int gy = 0; gy < G; gy++)
                        for (int gx = 0; gx < G; gx++)
                        {
                            float v = imp[gy, gx] / maxImp;
                            if (v < 0) v = 0; if (v > 1) v = 1;
                            var c = Jet(v);
                            int a = (int)(255 * Math.Min(1.0, Math.Pow(v, 0.65) * 1.25));
                            small.SetPixel(gx, gy, Color.FromArgb(a, c.R, c.G, c.B));
                        }
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.DrawImage(small, new RectangleF(sx, sy, sw, sh));
                }
            }
            return dst;
        }

        static Color Jet(float v)
        {
            int r = (int)(255 * Math.Min(1, Math.Max(0, 1.5f - Math.Abs(4 * v - 3))));
            int g = (int)(255 * Math.Min(1, Math.Max(0, 1.5f - Math.Abs(4 * v - 2))));
            int b = (int)(255 * Math.Min(1, Math.Max(0, 1.5f - Math.Abs(4 * v - 1))));
            return Color.FromArgb(r, g, b);
        }

        /// <summary>5 个重叠裁剪框（中心 + 四角），与训练侧护栏一致</summary>
        static Rectangle[] CropBoxes(Bitmap bmp, float frac)
        {
            int w = bmp.Width, h = bmp.Height;
            int s = (int)(Math.Min(w, h) * frac);
            var anchors = new[] {
                new[] { 0.5f, 0.5f }, new[] { 0.15f, 0.15f }, new[] { 0.85f, 0.15f },
                new[] { 0.15f, 0.85f }, new[] { 0.85f, 0.85f } };
            var boxes = new Rectangle[anchors.Length];
            for (int i = 0; i < anchors.Length; i++)
            {
                int l = (int)((w - s) * anchors[i][0]);
                int t = (int)((h - s) * anchors[i][1]);
                boxes[i] = new Rectangle(Math.Max(0, Math.Min(l, w - s)), Math.Max(0, Math.Min(t, h - s)), s, s);
            }
            return boxes;
        }

        static Bitmap Crop(Bitmap src, Rectangle box)
        {
            var b = new Bitmap(box.Width, box.Height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(b))
            {
                g.DrawImage(src, new Rectangle(0, 0, box.Width, box.Height), box, GraphicsUnit.Pixel);
            }
            return b;
        }

        /// <summary>与训练一致的预处理：短边缩放 → 中心裁剪 → CHW 且 /255</summary>
        public static float[] Preprocess(Bitmap src, int size)
        {
            int w = src.Width, h = src.Height;
            double scale = (double)size / Math.Min(w, h);
            int nw = Math.Max(size, (int)Math.Round(w * scale));
            int nh = Math.Max(size, (int)Math.Round(h * scale));

            using (var resized = new Bitmap(nw, nh, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(resized))
                {
                    g.InterpolationMode = InterpolationMode.Bilinear;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.Clear(Color.White);
                    g.DrawImage(src, 0, 0, nw, nh);
                }
                int ox = (nw - size) / 2, oy = (nh - size) / 2;
                var data = new float[3 * size * size];
                var bd = resized.LockBits(new Rectangle(0, 0, nw, nh), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                try
                {
                    unsafe
                    {
                        int stride = bd.Stride;
                        byte* base0 = (byte*)bd.Scan0;
                        for (int y = 0; y < size; y++)
                        {
                            byte* row = base0 + (y + oy) * stride;
                            int yoff = y * size;
                            for (int x = 0; x < size; x++)
                            {
                                byte* p = row + (x + ox) * 3;
                                int idx = yoff + x;
                                data[idx] = p[2] / 255f;                    // R
                                data[size * size + idx] = p[1] / 255f;      // G
                                data[2 * size * size + idx] = p[0] / 255f;  // B
                            }
                        }
                    }
                }
                finally { resized.UnlockBits(bd); }
                return data;
            }
        }
    }
}
