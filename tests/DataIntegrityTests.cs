using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

namespace TreeExtractor
{
    internal static class DataIntegrityTests
    {
        static int checks, failures;

        static void Check(bool condition, string message)
        {
            checks++;
            if (!condition) throw new Exception(message);
        }

        static void Case(string name, Action action)
        {
            try { action(); Console.WriteLine("PASS " + name); }
            catch (Exception ex) { failures++; Console.Error.WriteLine("FAIL " + name + ": " + ex.Message); }
        }

        static void WriteZip(string path, params string[] names)
        {
            using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
                foreach (string name in names)
                    using (var writer = new StreamWriter(zip.CreateEntry(name).Open())) writer.Write("data");
        }

        static void FrameOrdering(string root)
        {
            string zip = Path.Combine(root, "ordered.zip");
            WriteZip(zip, "JpgFiles/3.jpg", "JpgFiles/1.jpg", "Camera4/JpgFiles/2.jpg");
            using (var store = new FrameStore(zip))
            {
                Check(store.Frames.Count == 3, "three frames");
                Check(store.Frames[0].Gps == 1 && store.Frames[1].Gps == 2 && store.Frames[2].Gps == 3,
                    "navigation order must follow timestamp, not ZIP order");
            }
        }

        static void DuplicateFrames(string root)
        {
            string zip = Path.Combine(root, "duplicate.zip");
            WriteZip(zip, "JpgFiles/1.jpg", "other/JpgFiles/1.jpg");
            bool rejected = false;
            try { using (var ignored = new FrameStore(zip)) { } }
            catch (InvalidDataException) { rejected = true; }
            Check(rejected, "same frame name must be rejected instead of silently replacing one image");
            using (new FileStream(zip, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        }

        static void ImageSizeLimits()
        {
            FrameStore.ValidateImageLength(FrameStore.MaxImageBytes, "boundary.jpg");
            bool rejected = false;
            try { FrameStore.ValidateImageLength(FrameStore.MaxImageBytes + 1, "too-large.jpg"); }
            catch (InvalidDataException) { rejected = true; }
            Check(rejected, "oversized ZIP entries are rejected before decompression");
            rejected = false;
            try { FrameStore.ValidateImageLength(0, "empty.jpg"); }
            catch (InvalidDataException) { rejected = true; }
            Check(rejected, "empty ZIP entries are rejected");
            using (var input = new MemoryStream(new byte[5]))
            using (var output = new MemoryStream())
                Check(!FrameStore.CopyWithinLimit(input, output, 4), "actual decoded bytes also obey the limit");
        }

        static void PoseSegmentsAndAngles(string root)
        {
            string pose = Path.Combine(root, "poses.txt");
            File.WriteAllText(pose,
                "ImageName GPSTime Longitude Latitude H_Ell Roll Pitch Heading\n" +
                "100 100 0 0 0 0 0 359\n102 102 0 0 0 0 0 1\n" +
                "100 100 0 0 0 0 0 123\n102 102 0 0 0 0 0 125\n", Encoding.UTF8);
            var index = new PoseIndex(pose);
            Check(index.Poses.Count == 2, "only the first camera segment is used");
            double heading = Geo.Wrap360(index.GetAt(101).Heading);
            Check(Math.Abs(Geo.Wrap180(heading)) < 0.00001, "heading interpolation must cross north via the shortest arc");
        }

        static void ManualMarkPersistence(string root)
        {
            string file = Path.Combine(root, "manual_marks.csv");
            string oldTemporary = file + ".tmp";
            File.WriteAllText(oldTemporary, "user-owned temporary file");
            var empty = ManualMarkRepository.Read(file);
            Check(!empty.Exists && empty.Entries.Count == 0, "absent marks start empty");
            var entries = new Dictionary<int, double[]> { { 10, new double[] { 1.25, -0.5 } } };
            var first = ManualMarkRepository.Write(file, entries, empty);
            Check(first.BackupPath == null && File.Exists(file), "first save creates marks");
            byte[] previous = File.ReadAllBytes(file);
            entries[10] = new double[] { 2.5, -1.0 };
            var second = ManualMarkRepository.Write(file, entries, first.Snapshot);
            Check(File.Exists(second.BackupPath), "replacing marks creates a backup");
            Check(Convert.ToHexString(File.ReadAllBytes(second.BackupPath)) == Convert.ToHexString(previous),
                "backup preserves previous content");
            Check(File.ReadAllText(oldTemporary) == "user-owned temporary file", "fixed-name temporary file is not overwritten");
            File.AppendAllText(file, "# external change\n");
            string changed = File.ReadAllText(file);
            bool rejected = false;
            try { ManualMarkRepository.Write(file, entries, second.Snapshot); }
            catch (UserFacingException) { rejected = true; }
            Check(rejected && File.ReadAllText(file) == changed, "external edit is never silently overwritten");
            File.WriteAllText(file, "10,NaN,0\n");
            rejected = false;
            try { ManualMarkRepository.Read(file); }
            catch (InvalidDataException) { rejected = true; }
            Check(rejected && File.ReadAllText(file) == "10,NaN,0\n", "invalid entries fail closed without changing source");
            File.WriteAllText(file, "10,1,2\n10,3,4\n");
            rejected = false;
            try { ManualMarkRepository.Read(file); }
            catch (InvalidDataException) { rejected = true; }
            Check(rejected, "duplicate tree IDs are rejected");
        }

        static void SetSessionField(BackendSession session, string name, object value)
        {
            var field = typeof(BackendSession).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic);
            if (field == null) throw new Exception("Missing session field: " + name);
            field.SetValue(session, value);
        }

        static Dictionary<string, object> SessionState(BackendSession session)
        {
            return (Dictionary<string, object>)session.DesktopDispatch("state", new Dictionary<string, object>());
        }

        static void DesktopDistanceState(string root)
        {
            string zip = Path.Combine(root, "state.zip");
            WriteZip(zip, "JpgFiles/1.jpg");
            // Only state is queried: no source images, models or annotation files are read or changed.
            using (var session = new BackendSession())
            {
                SetSessionField(session, "_frames", new FrameStore(zip));
                var forest = new UtmForest();
                forest.Trees.Add(new UtmTree { Id = 42, X = 3, Y = 4, Z = 0, Height = 8 });
                SetSessionField(session, "_utmForest", forest);
                SetSessionField(session, "_selUtmTree", 0);
                SetSessionField(session, "_curName", "1.JPG");
                var poses = new Dictionary<string, double[]> { { "1.jpg", new double[6] } };
                SetSessionField(session, "_metaPose", poses);
                var state = SessionState(session);
                Check((int)state["frameIndex"] == 1 && (bool)state["framePoseAvailable"],
                      "current frame lookup remains case-insensitive");
                Check((double)state["cameraHorizontalDistance"] == 5 && !(bool)state["distanceUsesTrunkAxis"],
                      "distance falls back to the tree center without measured trunk");

                var axes = new Dictionary<int, double[]> { { 42, new double[] { 0, 2 } } };
                SetSessionField(session, "_trunkXy", axes);
                state = SessionState(session);
                Check((double)state["cameraHorizontalDistance"] == 2 && (bool)state["distanceUsesTrunkAxis"],
                      "distance uses the measured trunk axis");
                axes[42] = new double[] { 0, 0 };
                Check((double)SessionState(session)["cameraHorizontalDistance"] == 0,
                      "coincident camera and trunk report zero instead of null");
                axes[42] = new double[] { double.NaN, 0 };
                state = SessionState(session);
                Check((double)state["cameraHorizontalDistance"] == 5 && !(bool)state["distanceUsesTrunkAxis"],
                      "invalid trunk still falls back to the center");

                var invalidPoses = new List<double[]> { null, new double[5] };
                foreach (double invalid in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity })
                    for (int component = 0; component < 6; component++)
                    {
                        var pose = new double[6];
                        pose[component] = invalid;
                        invalidPoses.Add(pose);
                    }
                foreach (double[] pose in invalidPoses)
                {
                    poses["1.jpg"] = pose;
                    state = SessionState(session);
                    Check(!(bool)state["framePoseAvailable"] && state["cameraHorizontalDistance"] == null &&
                          state["distanceUsesTrunkAxis"] == null,
                          "incomplete or non-finite pose has no inferred distance or axis flag");
                }
                poses.Clear();
                Check(SessionState(session)["cameraHorizontalDistance"] == null, "missing pose has null distance");
                poses["1.jpg"] = new double[6];
                SetSessionField(session, "_curName", "missing.jpg");
                state = SessionState(session);
                Check((int)state["frameIndex"] == 0 && !(bool)state["framePoseAvailable"] &&
                      state["cameraHorizontalDistance"] == null, "missing frame keeps the existing protocol sentinel");
                SetSessionField(session, "_curName", "1.jpg");
                SetSessionField(session, "_selUtmTree", -1);
                state = SessionState(session);
                Check((bool)state["framePoseAvailable"] && state["cameraHorizontalDistance"] == null &&
                      state["distanceUsesTrunkAxis"] == null, "unselected tree has no distance despite a valid camera");
            }
            using (new FileStream(zip, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        }

        internal static int Run()
        {
            string root = Path.Combine(Path.GetTempPath(), "treeextract-integrity-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            Case("Frame ordering", () => FrameOrdering(root));
            Case("Duplicate frames", () => DuplicateFrames(root));
            Case("Image size limits", ImageSizeLimits);
            Case("Pose segments and circular heading", () => PoseSegmentsAndAngles(root));
            Case("Manual mark persistence", () => ManualMarkPersistence(root));
            Case("Desktop camera distance state", () => DesktopDistanceState(root));
            Console.WriteLine("DATA INTEGRITY CHECKS=" + checks + " FAILURES=" + failures + " TEMP=" + root);
            return failures == 0 ? 0 : 1;
        }
    }
}
