using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace TreeExtractor
{
    /// <summary>实际通过配对检查的单帧图像观测，不保存纹理数组。</summary>
    internal sealed class DualFrameObservationEvidence
    {
        internal readonly string Frame;
        internal readonly double AzimuthDeg, ElevationTopDeg, ElevationBottomDeg, WidthDeg;
        internal readonly double AzimuthOriginDeg, VerticalCalibrationDeg;
        internal readonly double X, YTop, YBottom;
        internal readonly int Width, Height;
        internal readonly string AnalysisPixelSha256;

        DualFrameObservationEvidence(string frame, TrunkMeasure measure, double origin, double calV,
                                     double x, double top, double bottom, EvidenceImageHash source)
        {
            Frame = frame;
            AzimuthDeg = measure.AzPix;
            ElevationTopDeg = measure.ElTop;
            ElevationBottomDeg = measure.ElBot;
            WidthDeg = measure.WidthDeg;
            AzimuthOriginDeg = origin;
            VerticalCalibrationDeg = calV;
            X = x; YTop = top; YBottom = bottom;
            Width = source.Width; Height = source.Height;
            AnalysisPixelSha256 = source.Sha256;
        }

        internal static DualFrameObservationEvidence Create(string frame, TrunkMeasure measure,
                                                             double origin, double calV, EvidenceImageHash source)
        {
            if (string.IsNullOrEmpty(frame) || source == null || !Finite(measure.AzPix) ||
                !Finite(measure.ElTop) || !Finite(measure.ElBot) || !Finite(measure.WidthDeg) ||
                !Finite(origin) || !Finite(calV) || source.Width <= 0 || source.Height <= 0 ||
                string.IsNullOrEmpty(source.Sha256) || source.Sha256.Length != 64 ||
                measure.WidthDeg <= 0 || measure.WidthDeg >= 180 ||
                measure.ElTop <= measure.ElBot) return null;
            double x = Geo.Wrap360(measure.AzPix - origin) / 360.0;
            double top = (90.0 - measure.ElTop - calV) / 180.0;
            double bottom = (90.0 - measure.ElBot - calV) / 180.0;
            if (!Finite(x) || !Finite(top) || !Finite(bottom) || x < 0 || x >= 1 ||
                top < 0 || bottom >= 1 || top >= bottom) return null;
            return new DualFrameObservationEvidence(frame, measure, origin, calV, x, top, bottom, source);
        }

        static bool Finite(double value) { return !double.IsNaN(value) && !double.IsInfinity(value); }
    }

    /// <summary>不可变地绑定同一次成功配对的树、数据集、帧、尝试序号及两侧观测。</summary>
    internal sealed class DualFramePairEvidence
    {
        internal readonly UtmTree Tree;
        internal readonly int TreeId, Attempt;
        internal readonly string DataSetId, FrameA, FrameB;
        internal readonly DualFrameObservationEvidence A, B;
        internal readonly double Cal, CalV, ProjectionD;
        internal readonly bool LevelView;

        internal DualFramePairEvidence(UtmTree tree, DualFrameContext ctx, string frameA, string frameB,
                                       int attempt, DualFrameObservationEvidence a, DualFrameObservationEvidence b)
        {
            Tree = tree; TreeId = tree.Id; DataSetId = ctx.DataSetId;
            FrameA = frameA; FrameB = frameB; Attempt = attempt; A = a; B = b;
            Cal = ctx.Cal; CalV = ctx.CalV; LevelView = ctx.LevelView; ProjectionD = ctx.ProjectionD;
        }

        internal bool MatchesSelection(UtmTree tree, string dataSetId, string frameA, string frameB,
                                       int attempt, double cal, double calV, bool levelView, double projectionD)
        {
            return tree != null && ReferenceEquals(Tree, tree) && TreeId == tree.Id &&
                   string.Equals(DataSetId, dataSetId, StringComparison.Ordinal) &&
                   string.Equals(FrameA, frameA, StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(FrameB, frameB, StringComparison.OrdinalIgnoreCase) &&
                   Attempt == attempt && Cal.Equals(cal) && CalV.Equals(calV) &&
                   LevelView == levelView && ProjectionD.Equals(projectionD);
        }
    }

    internal sealed class EvidenceImageHash
    {
        internal readonly int Width, Height;
        internal readonly string Sha256;
        internal EvidenceImageHash(int width, int height, string sha256)
        {
            Width = width; Height = height; Sha256 = sha256;
        }
    }

    /// <summary>分析缩图的读取、规范像素哈希及按需标记，仅用于本地图证。</summary>
    internal static class DualFrameImageEvidence
    {
        internal const string HashFormat = "sha256-wh32le-topdown-bgra32-v1";
        internal const int MaxPngBytes = 8 * 1024 * 1024;
        internal const int MaxJsonLineCharacters = 64 * 1024 * 1024;
        const int JsonEnvelopeReserve = 4096;

        internal static Bitmap LoadSmallFrame(FrameStore frames, string name)
        {
            Bitmap full = null;
            try
            {
                if (frames == null || string.IsNullOrEmpty(name)) return null;
                full = frames.Load(name);
                return full == null ? null : new Bitmap(full, new Size(DualFrameConfig.RoiSmallW,
                                                                         DualFrameConfig.RoiSmallH));
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 缩图失败: " + ex.Message);
                return null;
            }
            finally
            {
                if (full != null)
                {
                    try { full.Dispose(); }
                    catch (Exception) { }
                }
            }
        }

        /// <summary>
        /// SHA-256 输入为宽、高各 4 字节小端值，随后自上而下逐行写入 BGRA32，
        /// 每行恰好 width*4 字节，不含 stride 填充。非不透明像素拒绝作为图证。
        /// </summary>
        internal static EvidenceImageHash Fingerprint(Bitmap image)
        {
            if (image == null || image.Width <= 0 || image.Height <= 0 ||
                image.Width > DualFrameConfig.RoiSmallW || image.Height > DualFrameConfig.RoiSmallH)
                return null;
            BitmapData data = null;
            try
            {
                int rowBytes = checked(image.Width * 4);
                data = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.ReadOnly,
                                      PixelFormat.Format32bppArgb);
                if (data.Scan0 == IntPtr.Zero || Math.Abs((long)data.Stride) < rowBytes) return null;
                byte[] header = new byte[8];
                WriteUInt32LittleEndian(header, 0, (uint)image.Width);
                WriteUInt32LittleEndian(header, 4, (uint)image.Height);
                byte[] row = new byte[rowBytes];
                using (IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
                {
                    hash.AppendData(header);
                    for (int y = 0; y < image.Height; y++)
                    {
                        Marshal.Copy(IntPtr.Add(data.Scan0, checked(y * data.Stride)), row, 0, rowBytes);
                        // 透明像素在 PNG 编解码时可能发生颜色预乘，不能伪装成同一分析图。
                        for (int x = 3; x < rowBytes; x += 4) if (row[x] != 255) return null;
                        hash.AppendData(row);
                    }
                    string digest = BitConverter.ToString(hash.GetHashAndReset()).Replace("-", "").ToLowerInvariant();
                    return new EvidenceImageHash(image.Width, image.Height, digest);
                }
            }
            catch (Exception ex)
            {
                BackendLog.Write("双帧 图证哈希不可用: " + ex.Message);
                return null;
            }
            finally
            {
                if (data != null)
                {
                    try { image.UnlockBits(data); }
                    catch (Exception ex) { BackendLog.Write("双帧 图证解锁失败: " + ex.Message); }
                }
            }
        }

        static void WriteUInt32LittleEndian(byte[] bytes, int offset, uint value)
        {
            bytes[offset] = (byte)value;
            bytes[offset + 1] = (byte)(value >> 8);
            bytes[offset + 2] = (byte)(value >> 16);
            bytes[offset + 3] = (byte)(value >> 24);
        }

        internal static bool Matches(Bitmap image, DualFrameObservationEvidence observation)
        {
            if (observation == null) return false;
            EvidenceImageHash current = Fingerprint(image);
            return current != null && current.Width == observation.Width && current.Height == observation.Height &&
                   string.Equals(current.Sha256, observation.AnalysisPixelSha256, StringComparison.Ordinal);
        }

        internal static string PngDataUrl(Bitmap image, string expectedPixelSha256 = null)
        {
            using (var stream = new MemoryStream())
            {
                image.Save(stream, ImageFormat.Png);
                if (stream.Length > MaxPngBytes) throw new InvalidDataException("Evidence PNG exceeds size limit.");
                if (expectedPixelSha256 != null)
                {
                    // 若 PNG 编解码改变分析像素，就拒绝而不返回误导性的图证。
                    stream.Position = 0;
                    using (var decoded = new Bitmap(stream))
                    {
                        EvidenceImageHash roundTrip = Fingerprint(decoded);
                        if (roundTrip == null || !string.Equals(roundTrip.Sha256, expectedPixelSha256,
                                                                 StringComparison.Ordinal))
                            throw new InvalidDataException("Evidence PNG pixels changed during encoding.");
                    }
                }
                return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
            }
        }

        /// <summary>
        /// 为 JSON 转义保守计数：base64 非字母数字字符最多按 \uXXXX 六字符计算。
        /// 多留信封空间，避免单行超过前端 JSON Lines 解码器的 64 MiB 字符限制。
        /// </summary>
        internal static long JsonImageUpperBound(string image)
        {
            if (string.IsNullOrEmpty(image) || !image.StartsWith("data:image/png;base64,", StringComparison.Ordinal))
                return long.MaxValue;
            long result = 2; // JSON string quotes
            foreach (char c in image)
            {
                if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
                    result++;
                else if (c == '+' || c == '/' || c == '=' || c == ':' || c == ';' || c == ',')
                    result += 6;
                else return long.MaxValue;
            }
            return result;
        }

        internal static bool FitsJsonLineBudget(int metadataCharacters, params string[] images)
        {
            if (metadataCharacters < 0 || images == null || images.Length != 4) return false;
            long total = (long)metadataCharacters + JsonEnvelopeReserve;
            foreach (string image in images)
            {
                long length = JsonImageUpperBound(image);
                if (length == long.MaxValue || length > MaxJsonLineCharacters - total) return false;
                total += length;
            }
            return total <= MaxJsonLineCharacters;
        }

        internal static Bitmap MarkObservation(Bitmap image, DualFrameObservationEvidence observation)
        {
            if (image == null || observation == null || image.Width != observation.Width ||
                image.Height != observation.Height) return null;
            var marked = new Bitmap(image);
            try
            {
                using (Graphics graphics = Graphics.FromImage(marked))
                using (var pen = new Pen(Color.Red, 2.0f))
                {
                    graphics.SmoothingMode = SmoothingMode.None;
                    float x = (float)(observation.X * image.Width);
                    float top = (float)(observation.YTop * image.Height);
                    float bottom = (float)(observation.YBottom * image.Height);
                    float halfWidth = (float)(observation.WidthDeg / 360.0 * image.Width / 2.0);
                    // 在左右两端各画一次平移副本，正确呈现跨 0°/360° 的候选段。
                    for (int wrap = -1; wrap <= 1; wrap++)
                    {
                        float center = x + wrap * image.Width;
                        graphics.DrawLine(pen, center, top, center, bottom);
                        graphics.DrawRectangle(pen, center - halfWidth, top, halfWidth * 2, bottom - top);
                    }
                }
                return marked;
            }
            catch { marked.Dispose(); throw; }
        }
    }
}
