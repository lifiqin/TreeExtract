using System;
using System.Collections.Generic;

namespace TreeExtractor
{
    // 自动优质主帧不跨树复用；手动/严格最近可明确共享，但仍记录以便提示和避让。
    internal sealed class FrameReservations
    {
        readonly Dictionary<int, HashSet<int>> _treesByFrame = new Dictionary<int, HashSet<int>>();
        readonly Dictionary<int, int> _frameByTree = new Dictionary<int, int>();

        internal bool IsAvailable(int frame, int treeId)
        {
            HashSet<int> owners;
            return !_treesByFrame.TryGetValue(frame, out owners) ||
                (owners.Count == 1 && owners.Contains(treeId));
        }

        internal int? OtherOwner(int frame, int treeId)
        {
            HashSet<int> owners;
            if (!_treesByFrame.TryGetValue(frame, out owners)) return null;
            int? first = null;
            foreach (int owner in owners)
                if (owner != treeId && (!first.HasValue || owner < first.Value)) first = owner;
            return first;
        }

        internal void Reserve(int frame, int treeId)
        {
            if (frame < 0) throw new ArgumentOutOfRangeException("frame");
            if (!IsAvailable(frame, treeId)) throw new InvalidOperationException("Frame already reserved.");
            ReserveShared(frame, treeId);
        }

        internal void ReserveShared(int frame, int treeId)
        {
            if (frame < 0) throw new ArgumentOutOfRangeException("frame");
            int previous;
            if (_frameByTree.TryGetValue(treeId, out previous) && previous != frame) Release(treeId);
            HashSet<int> owners;
            if (!_treesByFrame.TryGetValue(frame, out owners))
                _treesByFrame[frame] = owners = new HashSet<int>();
            owners.Add(treeId);
            _frameByTree[treeId] = frame;
        }

        internal void Release(int treeId)
        {
            int previous;
            if (!_frameByTree.TryGetValue(treeId, out previous)) return;
            _frameByTree.Remove(treeId);
            HashSet<int> owners = _treesByFrame[previous];
            owners.Remove(treeId);
            if (owners.Count == 0) _treesByFrame.Remove(previous);
        }

        internal void Clear()
        {
            _treesByFrame.Clear();
            _frameByTree.Clear();
        }
    }

    // 用树干轴心估计同视线的邻树风险；坐标误差、遮挡和真实树身份仍需人工核查。
    internal static class FrameSeparation
    {
        internal const double NearbyDistanceM = 8.0;
        internal const double AmbiguousAngleDeg = 5.0;

        internal sealed class Axis
        {
            internal int Id;
            internal double X, Y;
        }

        internal sealed class Conflict
        {
            internal int TreeId;
            internal double AngleDeg;
        }

        internal static List<Axis> Nearby(Axis target, IEnumerable<Axis> axes)
        {
            var nearby = new List<Axis>();
            if (target == null || !double.IsFinite(target.X) || !double.IsFinite(target.Y) || axes == null)
                return nearby;
            foreach (Axis axis in axes)
            {
                if (axis == null || axis.Id == target.Id || !double.IsFinite(axis.X) || !double.IsFinite(axis.Y))
                    continue;
                if (Geo.Dist2D(axis.X - target.X, axis.Y - target.Y) <= NearbyDistanceM)
                    nearby.Add(axis);
            }
            return nearby;
        }

        internal static Conflict Find(Axis target, IEnumerable<Axis> nearby, double cameraX, double cameraY)
        {
            if (target == null || nearby == null || !double.IsFinite(cameraX) || !double.IsFinite(cameraY) ||
                !double.IsFinite(target.X) || !double.IsFinite(target.Y)) return null;
            double tx = target.X - cameraX, ty = target.Y - cameraY;
            if (!double.IsFinite(tx) || !double.IsFinite(ty) || Geo.Dist2D(tx, ty) < 1e-6) return null;
            Conflict closest = null;
            foreach (Axis other in nearby)
            {
                if (other == null || other.Id == target.Id || !double.IsFinite(other.X) || !double.IsFinite(other.Y))
                    continue;
                double ox = other.X - cameraX, oy = other.Y - cameraY;
                if (!double.IsFinite(ox) || !double.IsFinite(oy) || Geo.Dist2D(ox, oy) < 1e-6) continue;
                double angle = Math.Abs(Geo.Wrap180(Geo.Deg(Math.Atan2(tx, ty) - Math.Atan2(ox, oy))));
                if (angle <= AmbiguousAngleDeg && (closest == null || angle < closest.AngleDeg ||
                    (angle == closest.AngleDeg && other.Id < closest.TreeId)))
                    closest = new Conflict { TreeId = other.Id, AngleDeg = angle };
            }
            return closest;
        }
    }
}
