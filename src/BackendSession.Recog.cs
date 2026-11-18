using System.Drawing;

namespace TreeExtractor
{
    public partial class BackendSession
    {
        int _heatTreeNo;

        // 返回独立副本，由调用者释放。
        Bitmap GetRecogSource()
        {
            Bitmap source = _cropClean ?? _crop ?? _recogClean ?? _photo;
            return source == null ? null : (Bitmap)source.Clone();
        }

        void SetHeat(Bitmap bitmap, string emptyText)
        {
            ReplaceImage(ref _heat, bitmap);
        }

        void ClearHeat(string emptyText)
        {
            _heatTreeNo = 0;
            _heatTitle = "识别注意力热力图（本地模型）";
            SetHeat(null, emptyText);
        }
    }
}
