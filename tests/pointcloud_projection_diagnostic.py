"""Overlay one labelled point cloud tree on an existing 4:3 QA photo.

Inputs are read-only and the output image is written only to the specified path.
The point cloud, camera poses, and tree IDs must be independently registered;
an overlay is a hypothesis, not verified image ground truth or a visibility mask.
Requires the optional numpy and OpenCV diagnostic environment.
"""

import argparse
import json
import math

import cv2
import numpy as np


POINT = np.dtype([
    ("x", "<f8"), ("y", "<f8"), ("z", "<f8"),
    ("r", "u1"), ("g", "u1"), ("b", "u1"),
    ("classification", "u1"), ("tree_id", "<u2"),
])


def read_tree(path, target):
    with open(path, encoding="utf-8-sig") as file:
        for line in file:
            row = line.split()
            if len(row) >= 5 and row[0].isdigit() and int(row[0]) == target:
                return np.array([float(value) for value in row[1:5]])
    raise ValueError("Tree ID not found")


def read_pose(path, frame):
    with open(path, encoding="utf-8-sig") as file:
        for line in file:
            row = line.split()
            if len(row) >= 7 and row[0] == frame:
                return np.array([float(value) for value in row[1:7]])
    raise ValueError("Frame pose not found")


def map_points(path):
    with open(path, "rb") as file:
        header = file.read(4096)
    terminator = b"end_header\n"
    offset = header.find(terminator)
    if offset < 0 or b"binary_little_endian 1.0" not in header[:offset]:
        raise ValueError("Unsupported PLY header")
    lines = header[:offset].decode("ascii", errors="strict").splitlines()
    expected = ["property double x", "property double y", "property double z",
                "property uchar diffuse_red", "property uchar diffuse_green",
                "property uchar diffuse_blue", "property uchar classification",
                "property ushort treeid"]
    vertex = next((i for i, line in enumerate(lines) if line.startswith("element vertex ")), -1)
    if vertex < 0 or lines[vertex + 1:vertex + 1 + len(expected)] != expected:
        raise ValueError("Unsupported labelled PLY vertex layout")
    count = int(lines[vertex].split()[2])
    return np.memmap(path, dtype=POINT, mode="r", offset=offset + len(terminator), shape=(count,))


def half_scale(angle_degrees):
    angle = math.radians(angle_degrees)
    return 2 * math.sin(angle) / (1 + math.cos(angle))  # NaturalD=1


def horizontal_fov(vertical_fov):
    target = (4 / 3) * half_scale(vertical_fov / 2)
    low, high = 0.0, 179.0
    for _ in range(48):
        middle = (low + high) / 2
        if half_scale(middle / 2) < target:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def project(azimuth, elevation, bearing, view_elevation, hfov, vfov, shift):
    az, el = np.deg2rad(azimuth), np.deg2rad(elevation)
    a0, e0 = math.radians(bearing), math.radians(view_elevation)
    dx, dy, dz = np.sin(az) * np.cos(el), np.cos(az) * np.cos(el), np.sin(el)
    cp, sp, ce, se = math.cos(a0), math.sin(a0), math.cos(e0), math.sin(e0)
    forward = dx * sp * ce + dy * cp * ce + dz * se
    valid = 1 + forward > 1e-9
    scale = np.divide(2, 1 + forward, out=np.full_like(forward, np.nan), where=valid)
    x = dx * cp - dy * sp
    y = dx * (-sp * se) + dy * (-cp * se) + dz * ce
    fx = 0.5 + 0.5 * scale * x / half_scale(hfov / 2)
    fy = 0.5 - 0.5 * scale * y / half_scale(vfov / 2) + 0.5 * shift
    return fx, fy


def photo_geometry(tree, pose, bearing):
    x, y, z, height = tree
    distance = math.hypot(x - pose[0], y - pose[1])
    base = math.degrees(math.atan2(z - pose[2], distance))
    top = math.degrees(math.atan2(z + height - pose[2], distance))
    vfov = min(max(2 * max(-base, top) + 8, 40), 120)
    hfov = horizontal_fov(vfov)
    _, fy_top = project(np.array([bearing]), np.array([top]), bearing, 0, hfov, vfov, 0)
    _, fy_base = project(np.array([bearing]), np.array([base]), bearing, 0, hfov, vfov, 0)
    shift = 0.0
    if fy_top[0] < 0.06:
        shift = min(2 * (0.06 - fy_top[0]), max(0.0, 2 * (0.98 - fy_base[0])))
    return hfov, vfov, shift


def height_statistics(xyz, tree):
    """Summarize labelled point locations without treating them as verified trunk points."""
    result = []
    relative_height = xyz[:, 2] - tree[2]
    for low, high in ((0, 0.5), (0.5, 1), (1, 1.5), (1.5, 2), (2, 3)):
        sample = xyz[(relative_height >= low) & (relative_height < high)]
        if len(sample) == 0:
            continue
        median = np.median(sample[:, :2], axis=0)
        result.append({"height_m": [low, high], "points": len(sample),
                       "median_xy": median.tolist(),
                       "distance_to_center_m": float(np.linalg.norm(median - tree[:2]))})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("point_cloud")
    parser.add_argument("base_json")
    parser.add_argument("tree_file")
    parser.add_argument("pose_file")
    parser.add_argument("report")
    parser.add_argument("photo")
    parser.add_argument("tree_id", type=int)
    parser.add_argument("output")
    parser.add_argument("--scene-step", type=int, default=0,
                        help="sample every Nth point and render nearby scene instead of a tree")
    parser.add_argument("--scene-radius", type=float, default=15.0)
    parser.add_argument("--yaw-shift", type=float, default=0.0)
    parser.add_argument("--elevation-shift", type=float, default=0.0)
    args = parser.parse_args()
    with open(args.base_json, encoding="utf-8-sig") as file:
        base = json.load(file)
    with open(args.report, encoding="utf-8-sig") as file:
        report = json.load(file)
    row = next(item for item in report["automatic"] if item["id"] == args.tree_id)
    tree = read_tree(args.tree_file, args.tree_id)
    pose = read_pose(args.pose_file, row["frame"])
    mapped = map_points(args.point_cloud)
    if args.scene_step > 0:
        sampled = mapped[::args.scene_step]
        x = sampled["x"] + base["baseX"] - pose[0]
        y = sampled["y"] + base["baseY"] - pose[1]
        points = sampled[x * x + y * y <= args.scene_radius ** 2]
    else:
        points = mapped[mapped["tree_id"] == args.tree_id]
    if len(points) == 0:
        raise ValueError("No labelled point cloud points for this tree")
    xyz = np.column_stack((points["x"] + base["baseX"],
                           points["y"] + base["baseY"],
                           points["z"] + base["baseZ"]))
    relative = xyz - pose[:3]
    horizontal = np.hypot(relative[:, 0], relative[:, 1])
    azimuth = np.rad2deg(np.arctan2(relative[:, 0], relative[:, 1])) - args.yaw_shift
    elevation = np.rad2deg(np.arctan2(relative[:, 2], horizontal)) - args.elevation_shift
    hfov, vfov, shift = photo_geometry(tree, pose, row["bearing"])
    fx, fy = project(azimuth, elevation, row["bearing"], 0, hfov, vfov, shift)
    image = cv2.imdecode(np.fromfile(args.photo, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Photo not found")
    height, width = image.shape[:2]
    visible = np.isfinite(fx) & np.isfinite(fy) & (fx >= 0) & (fx <= 1) & (fy >= 0) & (fy <= 1)
    px = np.rint(fx[visible] * (width - 1)).astype(int)
    py = np.rint(fy[visible] * (height - 1)).astype(int)
    low = (xyz[visible, 2] - tree[2]) < 1.5
    if args.scene_step > 0:
        # Approximate a visible surface using the nearest sampled point per pixel.
        depth = np.linalg.norm(relative[visible], axis=1)
        pixels = py * width + px
        order = np.lexsort((depth, pixels))
        sorted_pixels = pixels[order]
        first = np.concatenate(([True], sorted_pixels[1:] != sorted_pixels[:-1]))
        selected = order[first]
        render = np.zeros_like(image)
        color = np.column_stack((points["b"][visible], points["g"][visible], points["r"][visible]))
        render[py[selected], px[selected]] = color[selected]
        render = cv2.dilate(render, np.ones((3, 3), dtype=np.uint8))
        image = np.hstack((image, render))
    else:
        overlay = image.copy()
        overlay[py[~low], px[~low]] = (255, 0, 255)  # higher labelled points: magenta
        overlay[py[low], px[low]] = (0, 255, 255)   # low labelled points: yellow
        image = cv2.addWeighted(overlay, 0.75, image, 0.25, 0)
    ok, encoded = cv2.imencode(".jpg", image)
    if not ok:
        raise ValueError("Could not encode overlay")
    encoded.tofile(args.output)
    print(json.dumps({"tree_id": args.tree_id, "frame": row["frame"],
                      "labelled_points": len(points), "in_frame": int(visible.sum()),
                      "hfov": hfov, "vfov": vfov, "shift": shift,
                      "height_statistics": height_statistics(xyz, tree) if not args.scene_step else [],
                      "output": args.output}, indent=2))


if __name__ == "__main__":
    main()
