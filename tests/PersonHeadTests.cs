using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Reflection;
using System.Text;

namespace TreeExtractor
{
    internal static class PersonHeadTests
    {
        static int _checks;
        static readonly List<string> Skipped = new List<string>();

        static void Require(bool condition, string message)
        {
            _checks++;
            if (!condition) throw new InvalidOperationException(message);
        }

        public static int Run(string[] args)
        {
            _checks = 0;
            Skipped.Clear();
            try
            {
                bool requireSymlink = false;
                string scanDirectory = null;
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] == "--require-symlink") requireSymlink = true;
                    else if (args[i] == "--scan" && i + 1 < args.Length) scanDirectory = args[++i];
                    else throw new ArgumentException("Unknown or incomplete person/head test argument: " + args[i]);
                }
                TestDecode();
                TestUnavailable();
                TestSnapshot();
                TestAtomicCropWrite(requireSymlink);
                string model = Path.Combine(Directory.GetCurrentDirectory(), "models", "person_head.onnx");
                Require(File.Exists(model), "The verified person/head model is required for integration tests.");
                using (var detector = new PersonHeadDetector(model))
                using (var blank = new Bitmap(128, 96))
                {
                    using (var g = Graphics.FromImage(blank)) g.Clear(Color.Gray);
                    var result = detector.Detect(blank);
                    Require(result.Status == PersonHeadDetectionStatus.Complete, "Model could not run: " + result.Error);
                    Require(!result.HasPerson && !result.HasHead, "A blank image should not have a detected person or head.");
                    var repeated = detector.Detect(blank);
                    Require(repeated.Status == PersonHeadDetectionStatus.Complete, "Model session could not be reused.");
                    string positiveFixture = Path.Combine(Directory.GetCurrentDirectory(), "tests", "fixtures", "astronaut.png");
                    Require(File.Exists(positiveFixture), "Positive person/head fixture is missing.");
                    using (var positive = new Bitmap(positiveFixture))
                    {
                        var found = detector.Detect(positive);
                        Require(found.Status == PersonHeadDetectionStatus.Complete && found.HasPerson && found.HasHead,
                                "Detector failed the known positive person/head smoke test.");
                        TestPositiveCropGuard(positive, found);
                        // Diagnostic counterexample only: do not require the model to miss this crop
                        // because a future model might improve it.
                        using (var partial = positive.Clone(new Rectangle(190, 16, 60, 20), PixelFormat.Format24bppRgb))
                        {
                            var difficult = detector.Detect(partial);
                            Require(difficult.Status == PersonHeadDetectionStatus.Complete, "Partial-head diagnostic failed to execute.");
                            Console.WriteLine("PARTIAL_HAIR person=" + difficult.HasPerson + " head=" + difficult.HasHead
                                + " (diagnostic only; does not certify scalp detection)");
                        }
                    }
                    if (scanDirectory != null) Scan(detector, scanDirectory);
                }
                Console.WriteLine((Skipped.Count == 0 ? "PASS" : "PASS WITH SKIPS")
                    + " person/head checks=" + _checks + " skipped=" + Skipped.Count
                    + " require_symlink=" + requireSymlink);
                foreach (string skip in Skipped) Console.WriteLine("SKIPPED: " + skip);
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("FAIL person/head: " + ex);
                return 1;
            }
        }

        static void TestDecode()
        {
            const int anchors = 4, channels = PersonHeadDetector.ClassCount + 4;
            var data = new float[channels * anchors];
            // Two overlapping heads: keep only the higher-scored one.
            PutBox(data, anchors, 0, 320, 320, 160, 160, PersonHeadDetector.HeadClass, 0.9f);
            PutBox(data, anchors, 1, 324, 320, 160, 160, PersonHeadDetector.HeadClass, 0.8f);
            // A body is independent of its contained head; do not suppress across classes.
            PutBox(data, anchors, 2, 320, 360, 300, 500, PersonHeadDetector.PersonClass, 0.7f);
            PutBox(data, anchors, 3, -50, -50, 10, 10, PersonHeadDetector.HeadClass, 0.6f);
            var result = PersonHeadDetector.Decode(data, channels, anchors);
            Require(result.Status == PersonHeadDetectionStatus.Complete, "Valid output rejected.");
            Require(result.HasHead && result.HasPerson && result.Boxes.Count == 2, "Class mapping or NMS is incorrect.");
            var head = result.Boxes.Single(box => box.Kind == PersonHeadKind.Head);
            Require(Math.Abs(head.Left - 0.375f) < 1e-5f && Math.Abs(head.Right - 0.625f) < 1e-5f, "Head coordinates are incorrect.");
            Require(PersonHeadDetector.Decode(data, channels - 1, anchors).Status == PersonHeadDetectionStatus.Unavailable,
                    "Invalid output shape was accepted.");
            data[(4 + PersonHeadDetector.HeadClass) * anchors] = float.NaN;
            Require(PersonHeadDetector.Decode(data, channels, anchors).Status == PersonHeadDetectionStatus.Unavailable,
                    "A non-finite score was treated as a negative detection.");
            data[(4 + PersonHeadDetector.HeadClass) * anchors] = 1.5f;
            Require(PersonHeadDetector.Decode(data, channels, anchors).Status == PersonHeadDetectionStatus.Unavailable,
                    "An out-of-range score was treated as a negative detection.");
        }

        static void PutBox(float[] data, int anchors, int index, float x, float y, float width, float height, int classId, float score)
        {
            data[index] = x; data[anchors + index] = y;
            data[2 * anchors + index] = width; data[3 * anchors + index] = height;
            data[(4 + classId) * anchors + index] = score;
        }

        static void TestUnavailable()
        {
            string path = Path.Combine(Path.GetTempPath(), "treeextract-invalid-model-" + Guid.NewGuid().ToString("N") + ".onnx");
            try
            {
                using (var bmp = new Bitmap(16, 16))
                {
                    using (var missing = new PersonHeadDetector(path))
                        Require(missing.Detect(bmp).Status == PersonHeadDetectionStatus.Unavailable, "Missing model must not be treated as a negative detection.");
                    File.WriteAllText(path, "not a valid model");
                    using (var corrupt = new PersonHeadDetector(path))
                        Require(corrupt.Detect(bmp).Status == PersonHeadDetectionStatus.Unavailable, "Incorrect model checksum must fail closed.");
                    var disposed = new PersonHeadDetector(path);
                    disposed.Dispose();
                    disposed.Dispose();
                    Require(disposed.Detect(bmp).Status == PersonHeadDetectionStatus.Unavailable, "Disposed detector must be unavailable.");
                }
            }
            finally { if (File.Exists(path)) File.Delete(path); }
        }

        static void TestSnapshot()
        {
            using (var session = new BackendSession())
            {
                var empty = session.PersonHeadDetectionSnapshot();
                Require((string)empty["status"] == "unavailable", "Unloaded state must be unavailable.");
                Require(empty["personDetected"] == null && empty["headDetected"] == null && empty["scalpDetected"] == null,
                        "Unloaded state must use unknown values, not false.");
            }
            var failure = BackendSession.DescribePersonHeadDetection(PersonHeadDetection.Unavailable("test failure"));
            Require((string)failure["status"] == "unavailable" && failure["personDetected"] == null
                    && failure["headDetected"] == null && failure["scalpDetected"] == null, "A failed model must not produce negative detections.");
            var negative = BackendSession.DescribePersonHeadDetection(new PersonHeadDetection { Status = PersonHeadDetectionStatus.Complete });
            Require((string)negative["status"] == "complete" && Equals(negative["personDetected"], false)
                    && Equals(negative["headDetected"], false) && negative["scalpDetected"] == null,
                    "A negative head result must not imply a scalp result.");
            Require(BackendSession.CropRequiresReview(null), "Unavailable crop detection must require review.");
            Require(BackendSession.CropRequiresReview(PersonHeadDetection.Unavailable("failure")), "Detection failure must require review.");
            var safeNegative = new PersonHeadDetection { Status = PersonHeadDetectionStatus.Complete };
            Require(BackendSession.CropRequiresReview(safeNegative), "A model-negative crop still needs review.");
            safeNegative.Boxes.Add(new PersonHeadBox { Kind = PersonHeadKind.Head });
            Require(BackendSession.CropRequiresReview(safeNegative), "A detected head must require review.");
            var headOnly = BackendSession.DescribePersonHeadDetection(safeNegative);
            Require(Equals(headOnly["personDetected"], true) && Equals(headOnly["headDetected"], true),
                    "A head-only detection must be positive for personDetected.");
        }

        static void TestAtomicCropWrite(bool requireSymlink)
        {
            string directory = Path.Combine(Path.GetTempPath(), "treeextract-crop-write-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                string target = Path.Combine(directory, "crop.png");
                byte[] original = Encoding.UTF8.GetBytes("previous-data");
                byte[] replacement = Encoding.UTF8.GetBytes("new-data");
                bool invalidExtension = false;
                try { CropExportWriter.ValidateDestination(Path.Combine(directory, "input.zip"), new string[0]); }
                catch (ArgumentException) { invalidExtension = true; }
                Require(invalidExtension, "An output without a .png extension must be rejected.");
                bool protectedInput = false;
                try { CropExportWriter.ValidateDestination(target, new[] { target }); }
                catch (IOException) { protectedInput = true; }
                Require(protectedInput, "A protected input must not be accepted as an export target.");
                bool reparse = false;
                try { CropExportWriter.RejectReparseAttributes(FileAttributes.ReparsePoint); }
                catch (IOException) { reparse = true; }
                Require(reparse, "Reparse point attributes must be rejected.");
                string systemLink = Path.Combine(Path.GetPathRoot(directory), "Users", "All Users");
                if (Directory.Exists(systemLink) && (File.GetAttributes(systemLink) & FileAttributes.ReparsePoint) != 0)
                {
                    bool rejectedAncestor = false;
                    try { CropExportWriter.RejectReparsePointAncestors(systemLink); }
                    catch (IOException) { rejectedAncestor = true; }
                    Require(rejectedAncestor, "A real reparse-point ancestor must be rejected.");
                }
                else Skipped.Add("system reparse-point ancestor integration: no known fixture");
                Require(CropExportWriter.Write(target, original) == null, "New output must not invent a backup.");
                string link = Path.Combine(directory, "link.png");
                bool symlinkCreated = false;
                try { File.CreateSymbolicLink(link, target); symlinkCreated = true; }
                catch (Exception ex) when (ex is UnauthorizedAccessException || ex is IOException || ex is PlatformNotSupportedException)
                {
                    if (requireSymlink)
                        throw new InvalidOperationException("Strict mode requires filesystem symlink integration, but creation failed: " + ex.Message, ex);
                    Skipped.Add("filesystem symlink integration: " + ex.GetType().Name + " (" + ex.Message + ")");
                }
                if (symlinkCreated)
                {
                    bool rejectedLink = false;
                    try { CropExportWriter.Write(link, replacement); }
                    catch (IOException) { rejectedLink = true; }
                    Require(rejectedLink && File.ReadAllBytes(target).SequenceEqual(original), "A symlink destination must be rejected.");
                }
                string backup = CropExportWriter.Write(target, replacement);
                Require(File.ReadAllBytes(target).SequenceEqual(replacement), "Replacement output is incorrect.");
                Require(File.Exists(backup) && File.ReadAllBytes(backup).SequenceEqual(original), "Original data was not preserved in the backup.");

                bool interrupted = false;
                try { CropExportWriter.Write(target, original, () => { throw new InvalidOperationException("injected failure"); }); }
                catch (IOException ex)
                {
                    interrupted = true;
                    Require(ex.Message.Contains(".treeextract-stage-"), "The failure must report its recovery path.");
                }
                Require(interrupted && File.ReadAllBytes(target).SequenceEqual(replacement), "Interrupted write damaged the existing output.");
                Require(Directory.GetFiles(directory, ".treeextract-stage-*.tmp").Length == 1, "Failed staged write must remain recoverable.");

                string concurrentTarget = Path.Combine(directory, "concurrent.png");
                byte[] other = Encoding.UTF8.GetBytes("other-writer");
                bool blocked = false;
                try { CropExportWriter.Write(concurrentTarget, original, () => File.WriteAllBytes(concurrentTarget, other)); }
                catch (IOException) { blocked = true; }
                Require(blocked && File.ReadAllBytes(concurrentTarget).SequenceEqual(other), "A concurrent new output must not be overwritten.");
            }
            finally
            {
                // This is a test-owned, non-recursive temporary directory.
                foreach (string file in Directory.GetFiles(directory)) File.Delete(file);
                Directory.Delete(directory);
            }
        }

        static void TestPositiveCropGuard(Bitmap image, PersonHeadDetection detection)
        {
            string directory = Path.Combine(Path.GetTempPath(), "treeextract-positive-crop-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                using (var session = new BackendSession())
                {
                    SetSessionField(session, "_crop", (Bitmap)image.Clone());
                    SetSessionField(session, "_cropClean", (Bitmap)image.Clone());
                    SetSessionField(session, "_cropPersonHeadDetection", detection);
                    var inspected = (Dictionary<string, object>)session.DesktopDispatch("crop.inspect", new Dictionary<string, object>());
                    Require(Equals(inspected["headDetected"], true) && Equals(inspected["requiresReview"], true),
                            "A known positive crop must be flagged for review.");
                    string path = Path.Combine(directory, "positive.png");
                    var parameters = new Dictionary<string, object> {
                        { "path", path }, { "imageSha256", inspected["imageSha256"] }
                    };
                    bool rejected = false;
                    try { session.DesktopDispatch("crop.save", parameters); }
                    catch (InvalidOperationException) { rejected = true; }
                    Require(rejected && !File.Exists(path), "A detected head must not be exported without review.");
                    parameters["reviewConfirmed"] = true;
                    var saved = (Dictionary<string, object>)session.DesktopDispatch("crop.save", parameters);
                    Require(File.Exists(path) && Equals(saved["imageSha256"], inspected["imageSha256"]),
                            "A reviewed positive crop must match the inspected output.");
                }
            }
            finally
            {
                foreach (string file in Directory.GetFiles(directory)) File.Delete(file);
                Directory.Delete(directory);
            }
        }

        static void SetSessionField(BackendSession session, string name, object value)
        {
            var field = typeof(BackendSession).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance);
            if (field == null) throw new InvalidOperationException("Missing test field: " + name);
            field.SetValue(session, value);
        }

        static void Scan(PersonHeadDetector detector, string directory)
        {
            var files = Directory.GetFiles(directory).Where(p => p.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)
                || p.EndsWith(".png", StringComparison.OrdinalIgnoreCase)).OrderBy(p => p, StringComparer.Ordinal).ToArray();
            Require(files.Length > 0, "No input images found.");
            int people = 0, heads = 0;
            var timer = Stopwatch.StartNew();
            foreach (string file in files)
            {
                using (var image = new Bitmap(file))
                {
                    var result = detector.Detect(image);
                    Require(result.Status == PersonHeadDetectionStatus.Complete, "Detector failed: " + result.Error);
                    if (result.HasPerson) people++;
                    if (result.HasHead) heads++;
                    Console.WriteLine("SCAN " + Path.GetFileName(file) + " person=" + result.HasPerson + " head=" + result.HasHead
                        + " boxes=" + result.Boxes.Count);
                    foreach (var box in result.Boxes)
                        Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                            "  BOX {0} score={1:F3} x1={2:F3} y1={3:F3} x2={4:F3} y2={5:F3}",
                            box.Kind, box.Score, box.Left, box.Top, box.Right, box.Bottom));
                }
            }
            timer.Stop();
            Console.WriteLine("SCAN SUMMARY images=" + files.Length + " person=" + people + " head=" + heads
                + " elapsed_ms=" + timer.ElapsedMilliseconds);
        }
    }
}
