using System;
using System.Collections.Generic;
using System.IO;

namespace TreeExtractor
{
    // 树心与全景对照表适配。
    public partial class BackendSession
    {
        List<PanoRow> _desktopTableRows;

        object DesktopBuildTable()
        {
            if (_utmForest == null) throw new InvalidOperationException("请先加载树心数据。");
            var frames = PanoMath.LoadMetashape(AppPaths.MetaPath);
            double[] times = null, yaws = null;
            if (File.Exists(AppPaths.PosePath)) PanoMath.LoadImu(AppPaths.PosePath, out times, out yaws);
            _desktopTableRows = PanoMath.Build(_utmForest.Trees, frames, times, yaws, 1.5, 30.0);
            var rows = new List<object>();
            foreach (PanoRow r in _desktopTableRows)
                rows.Add(new Dictionary<string, object> {
                    { "id", r.Id }, { "height", r.TreeH }, { "frame", r.Frame },
                    { "distance", r.Hz }, { "bearing", r.Bear }, { "offset", r.Off }
                });
            return rows;
        }

        object DesktopSelectTableRow(int id)
        {
            if (_desktopTableRows == null) throw new InvalidOperationException("请先计算对照表。");
            PanoRow row = _desktopTableRows.Find(r => r.Id == id);
            int index = _utmForest.Trees.FindIndex(t => t.Id == id);
            if (row == null || index < 0) throw new ArgumentException("找不到该树。");
            _selUtmTree = index;
            double az, el, distance;
            UtmForest.TreeAzim(AimTrunk(_utmForest.Trees[index]), row.CamX, row.CamY, row.CamZ, out az, out el, out distance);
            if (!GotoFrame(row.Frame, az, distance, el)) throw new InvalidOperationException("全景包中没有对应帧。");
            DesktopClearRecognition();
            return DesktopState();
        }

        object DesktopExportTable(string path, string format)
        {
            if (_desktopTableRows == null) throw new InvalidOperationException("请先计算对照表。");
            if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("请选择保存路径。");
            var headers = new List<string>(TreeTableExport.Headers);
            if (format == "xlsx") TreeTableExport.WriteXlsx(path, headers, _desktopTableRows);
            else if (format == "csv") TreeTableExport.WriteCsv(path, headers, _desktopTableRows);
            else throw new ArgumentException("不支持的表格格式。");
            return new Dictionary<string, object> { { "path", path }, { "count", _desktopTableRows.Count } };
        }

    }
}
