using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace TreeExtractor
{
    internal enum PersonHeadDetectionStatus { Unavailable, Complete }
    internal enum PersonHeadKind { Person, Head }

    internal sealed class PersonHeadBox
    {
        public PersonHeadKind Kind;
        public float Score;
        // Normalized coordinates in the original image, not the model's square input.
        public float Left, Top, Right, Bottom;
    }

    internal sealed class PersonHeadDetection
    {
        public PersonHeadDetectionStatus Status;
        public string Error;
        public readonly List<PersonHeadBox> Boxes = new List<PersonHeadBox>();
        public bool HasHead { get { return Boxes.Exists(box => box.Kind == PersonHeadKind.Head); } }
        public bool HasPerson { get { return Boxes.Exists(box => box.Kind == PersonHeadKind.Person); } }

        public static PersonHeadDetection Unavailable(string error)
        {
            return new PersonHeadDetection { Status = PersonHeadDetectionStatus.Unavailable, Error = error };
        }
    }

    /// <summary>
    /// Offline Wholebody34 detector, used only for a warning, never as proof that an image is safe.
    /// Class 0 is body and class 7 is head. Model provenance and limitations are in models/.
    /// </summary>
    internal sealed class PersonHeadDetector : IDisposable
    {
        internal const string ExpectedSha256 = "7dd9b514426b33423ffbc4e22fb6127f2145686441f2c398170585363c009575";
        internal const string ModelFileName = "person_head.onnx";
        internal const int InputSize = 640;
        internal const int ClassCount = 34;
        internal const int HeadClass = 7;
        internal const int PersonClass = 0;
        internal const float ScoreThreshold = 0.35f;
        const float NmsThreshold = 0.5f;
        const int MaxCandidatesPerClass = 256;

        readonly string _modelPath;
        InferenceSession _session;
        string _initializationError;
        bool _initializationAttempted;
        bool _disposed;

        public PersonHeadDetector(string modelPath = null)
        {
            _modelPath = modelPath ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "models", ModelFileName);
        }

        public PersonHeadDetection Detect(Bitmap image)
        {
            if (_disposed) return PersonHeadDetection.Unavailable("人像检测器已关闭");
            if (image == null || image.Width < 2 || image.Height < 2)
                return PersonHeadDetection.Unavailable("当前照片不可用");
            if (!EnsureSession()) return PersonHeadDetection.Unavailable(_initializationError);
            try
            {
                float[] pixels = Preprocess(image);
                var tensor = new DenseTensor<float>(pixels, new[] { 1, 3, InputSize, InputSize });
                string input = _session.InputMetadata.Keys.Single();
                using (var outputs = _session.Run(new[] { NamedOnnxValue.CreateFromTensor(input, tensor) }))
                {
                    foreach (var output in outputs)
                    {
                        var values = output.AsTensor<float>();
                        var dims = values.Dimensions.ToArray();
                        if (dims.Length == 3 && dims[0] == 1 && dims[1] == ClassCount + 4 && dims[2] == 8400)
                            return Decode(values.ToArray(), dims[1], dims[2]);
                    }
                }
                return PersonHeadDetection.Unavailable("人像模型输出格式不匹配");
            }
            catch (Exception ex)
            {
                BackendLog.Write("人体/头部检测失败: " + ex.Message);
                return PersonHeadDetection.Unavailable("人像检测执行失败");
            }
        }

        bool EnsureSession()
        {
            if (_session != null) return true;
            if (_initializationAttempted) return false;
            _initializationAttempted = true;
            try
            {
                if (!File.Exists(_modelPath))
                {
                    _initializationError = "人像模型缺失，恢复后请重启程序";
                    return false;
                }
                using (var hash = SHA256.Create())
                using (var stream = File.OpenRead(_modelPath))
                {
                    string actual = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                    if (!string.Equals(actual, ExpectedSha256, StringComparison.Ordinal))
                    {
                        _initializationError = "人像模型校验失败，恢复后请重启程序";
                        return false;
                    }
                }
                using (var options = new SessionOptions())
                {
                    options.IntraOpNumThreads = Math.Max(1, Math.Min(4, Environment.ProcessorCount / 2));
                    options.InterOpNumThreads = 1;
                    options.GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL;
                    _session = new InferenceSession(_modelPath, options);
                }
                return true;
            }
            catch (Exception ex)
            {
                BackendLog.Write("人体/头部检测模型加载失败: " + ex.Message);
                _initializationError = "人像模型加载失败";
                return false;
            }
        }

        static unsafe float[] Preprocess(Bitmap image)
        {
            // The upstream model expects RGB / 255 and a direct resize to 640x640.
            using (var resized = new Bitmap(InputSize, InputSize, PixelFormat.Format24bppRgb))
            {
                using (var graphics = Graphics.FromImage(resized))
                {
                    graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    graphics.PixelOffsetMode = PixelOffsetMode.Half;
                    graphics.DrawImage(image, new Rectangle(0, 0, InputSize, InputSize));
                }
                var pixels = new float[3 * InputSize * InputSize];
                var bits = resized.LockBits(new Rectangle(0, 0, InputSize, InputSize), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
                try
                {
                    int plane = InputSize * InputSize;
                    for (int y = 0; y < InputSize; y++)
                    {
                        byte* row = (byte*)bits.Scan0 + y * bits.Stride;
                        for (int x = 0; x < InputSize; x++)
                        {
                            int index = y * InputSize + x;
                            pixels[index] = row[x * 3 + 2] / 255f;
                            pixels[plane + index] = row[x * 3 + 1] / 255f;
                            pixels[2 * plane + index] = row[x * 3] / 255f;
                        }
                    }
                }
                finally { resized.UnlockBits(bits); }
                return pixels;
            }
        }

        internal static PersonHeadDetection Decode(float[] data, int channels, int anchors)
        {
            if (channels != ClassCount + 4 || anchors <= 0 || data == null || data.Length != channels * anchors)
                return PersonHeadDetection.Unavailable("人像模型输出格式不匹配");
            var result = new PersonHeadDetection { Status = PersonHeadDetectionStatus.Complete };
            foreach (int classId in new[] { PersonClass, HeadClass })
            {
                var candidates = new List<PersonHeadBox>();
                for (int i = 0; i < anchors; i++)
                {
                    float score = data[(4 + classId) * anchors + i];
                    if (!float.IsFinite(score)) return PersonHeadDetection.Unavailable("人像模型输出含无效数值");
                    if (score < 0f || score > 1f) return PersonHeadDetection.Unavailable("人像模型输出分数超出范围");
                    if (score < ScoreThreshold) continue;
                    float cx = data[i], cy = data[anchors + i];
                    float width = data[2 * anchors + i], height = data[3 * anchors + i];
                    if (!float.IsFinite(cx) || !float.IsFinite(cy) || !float.IsFinite(width) || !float.IsFinite(height))
                        return PersonHeadDetection.Unavailable("人像模型输出含无效坐标");
                    float left = Clamp((cx - width / 2f) / InputSize);
                    float top = Clamp((cy - height / 2f) / InputSize);
                    float right = Clamp((cx + width / 2f) / InputSize);
                    float bottom = Clamp((cy + height / 2f) / InputSize);
                    if (right <= left || bottom <= top) continue;
                    candidates.Add(new PersonHeadBox {
                        Kind = classId == HeadClass ? PersonHeadKind.Head : PersonHeadKind.Person,
                        Score = score, Left = left, Top = top, Right = right, Bottom = bottom
                    });
                }
                candidates.Sort((a, b) => b.Score.CompareTo(a.Score));
                var accepted = new List<PersonHeadBox>();
                foreach (var candidate in candidates.Take(MaxCandidatesPerClass))
                {
                    if (!accepted.Exists(box => IntersectionOverUnion(box, candidate) >= NmsThreshold))
                        accepted.Add(candidate);
                }
                result.Boxes.AddRange(accepted);
            }
            return result;
        }

        static float Clamp(float value) { return Math.Max(0f, Math.Min(1f, value)); }

        static float IntersectionOverUnion(PersonHeadBox a, PersonHeadBox b)
        {
            float width = Math.Max(0f, Math.Min(a.Right, b.Right) - Math.Max(a.Left, b.Left));
            float height = Math.Max(0f, Math.Min(a.Bottom, b.Bottom) - Math.Max(a.Top, b.Top));
            float intersection = width * height;
            float union = (a.Right - a.Left) * (a.Bottom - a.Top) + (b.Right - b.Left) * (b.Bottom - b.Top) - intersection;
            return union > 0f ? intersection / union : 0f;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            if (_session != null) { _session.Dispose(); _session = null; }
        }
    }
}
