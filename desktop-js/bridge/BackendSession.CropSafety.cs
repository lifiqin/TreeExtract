using System;
using System.Collections.Generic;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        sealed class CropInspection
        {
            public byte[] Png;
            public string ImageSha256;
            public PersonHeadDetection Detection;
        }

        internal static bool CropRequiresReview(PersonHeadDetection detection)
        {
            // A head detector cannot establish that a cropped scalp is absent.
            // Every export requires an explicit review, including a model-negative image.
            return true;
        }

        CropInspection InspectCrop()
        {
            if (_crop == null) throw new InvalidOperationException("还没有可保存的切图。");
            byte[] png;
            using (var stream = new MemoryStream())
            {
                _crop.Save(stream, ImageFormat.Png);
                png = stream.ToArray();
            }
            string digest;
            using (var sha = SHA256.Create())
                digest = BitConverter.ToString(sha.ComputeHash(png)).Replace("-", "").ToLowerInvariant();

            // Inspect the crop itself: the larger 4:3 photo has a different field of view.
            PersonHeadDetection detection = _cropClean == null
                ? PersonHeadDetection.Unavailable("未生成干净切图") : _cropPersonHeadDetection;
            return new CropInspection { Png = png, ImageSha256 = digest, Detection = detection };
        }

        static Dictionary<string, object> CropInspectionInfo(CropInspection inspection)
        {
            var info = DescribePersonHeadDetection(inspection.Detection);
            info["imageSha256"] = inspection.ImageSha256;
            info["requiresReview"] = CropRequiresReview(inspection.Detection);
            return info;
        }

        object DesktopInspectCrop()
        {
            return CropInspectionInfo(InspectCrop());
        }

        object DesktopSaveCrop(string path, string expectedSha256, bool reviewConfirmed)
        {
            CropExportWriter.ValidateDestination(path, new[] {
                _zipPath, _posePath, AppPaths.ZipPath, AppPaths.PosePath, AppPaths.TreePath,
                AppPaths.MetaPath, AppPaths.CrownPath, AppPaths.TrunkPath, _markStorePath
            });
            CropInspection inspection = InspectCrop();
            // The confirmation is valid only for the exact PNG that will be written.
            if (!string.Equals(inspection.ImageSha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("切图内容已变化，请重新检查后保存。");
            if (CropRequiresReview(inspection.Detection) && !reviewConfirmed)
                throw new InvalidOperationException("保存切图前必须人工检查并明确确认，模型未检出也可能漏检。");
            string backup = CropExportWriter.Write(path, inspection.Png);
            return new Dictionary<string, object> {
                { "path", path }, { "imageSha256", inspection.ImageSha256 }, { "backupPath", backup }
            };
        }
    }
}
