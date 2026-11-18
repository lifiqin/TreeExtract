"""Compare two pose conventions using local panorama feature correspondences.

This diagnostic reads the supplied ZIP and pose file without changing them.
It needs the existing numpy and OpenCV installation; it is not a runtime dependency.
Correspondences are unlabelled, so results are diagnostic, not ground truth.
The default mask avoids the example's operator sector and bottom of the image;
it is not person detection and cannot guarantee the remaining points are static.
"""

import argparse
import json
import math
import zipfile

import cv2
import numpy as np


def load_pose(path, name):
    with open(path, encoding="utf-8-sig") as file:
        for line in file:
            parts = line.split()
            if len(parts) >= 7 and parts[0].lower() == name.lower():
                pose = np.array([float(value) for value in parts[1:7]], dtype=float)
                if np.isfinite(pose).all():
                    return pose
                break
    raise ValueError("Frame has no complete finite pose: " + name)


def load_panorama(archive, name, width):
    matches = [item for item in archive.namelist() if item.lower().endswith("/" + name.lower())]
    if len(matches) != 1:
        raise ValueError("Expected one panorama entry for " + name)
    encoded = np.frombuffer(archive.read(matches[0]), dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("Could not decode " + name)
    return cv2.resize(image, (width, width // 2), interpolation=cv2.INTER_AREA)


def rotation(pose):
    omega, phi, kappa = np.deg2rad(pose[3:6])
    co, so = math.cos(omega), math.sin(omega)
    cp, sp = math.cos(phi), math.sin(phi)
    ck, sk = math.cos(kappa), math.sin(kappa)
    rx = np.array([[1, 0, 0], [0, co, -so], [0, so, co]])
    ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    rz = np.array([[ck, -sk, 0], [sk, ck, 0], [0, 0, 1]])
    return rz @ ry @ rx


def rays(points, image_shape, pose, convention):
    height, width = image_shape
    longitude = points[:, 0] * (2 * math.pi / width)
    elevation = math.pi / 2 - points[:, 1] * (math.pi / height)
    cos_el = np.cos(elevation)
    transform = rotation(pose)
    if convention == "yaw_only":
        forward = transform[:, 1]
        yaw = math.atan2(forward[0], forward[1])
        azimuth = longitude + yaw
        return np.column_stack((np.sin(azimuth) * cos_el,
                                np.cos(azimuth) * cos_el,
                                np.sin(elevation)))
    # Candidate convention matching yaw-only for nominal omega=180, phi=0.
    # Metashape export conventions must be independently verified before use.
    local = np.column_stack((-np.sin(longitude) * cos_el,
                             np.cos(longitude) * cos_el,
                             -np.sin(elevation)))
    return local @ transform.T


def diagnostic_mask(shape):
    height, width = shape
    mask = np.full(shape, 255, dtype=np.uint8)
    # Empirical sector for the supplied example data, not a general person detector.
    mask[:, int(width * 40 / 360):int(width * 135 / 360) + 1] = 0
    mask[int(height * 0.85):, :] = 0
    return mask


def correspondences(first, second):
    sift = cv2.SIFT_create(nfeatures=5000)
    first_points, first_desc = sift.detectAndCompute(first, diagnostic_mask(first.shape))
    second_points, second_desc = sift.detectAndCompute(second, diagnostic_mask(second.shape))
    if first_desc is None or second_desc is None:
        raise ValueError("No SIFT features found")
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    forward = matcher.knnMatch(first_desc, second_desc, k=2)
    reverse = matcher.knnMatch(second_desc, first_desc, k=2)
    reverse_good = {m.queryIdx: m.trainIdx for pair in reverse if len(pair) == 2
                    for m, n in [pair] if m.distance < 0.72 * n.distance}
    good = [m for pair in forward if len(pair) == 2 for m, n in [pair]
            if m.distance < 0.72 * n.distance and reverse_good.get(m.trainIdx) == m.queryIdx]
    first_xy = np.array([first_points[m.queryIdx].pt for m in good], dtype=float).reshape(-1, 2)
    second_xy = np.array([second_points[m.trainIdx].pt for m in good], dtype=float).reshape(-1, 2)
    return first_xy, second_xy, first_points, second_points, good


def epipolar_statistics(points_a, points_b, shape, pose_a, pose_b, convention):
    direction_a = rays(points_a, shape, pose_a, convention)
    direction_b = rays(points_b, shape, pose_b, convention)
    baseline = pose_b[:3] - pose_a[:3]
    normal = np.cross(baseline, direction_a)
    length = np.linalg.norm(normal, axis=1)
    valid = length > 0.1 * np.linalg.norm(baseline)
    if not np.any(valid):
        raise ValueError("No non-degenerate feature correspondences")
    sine = np.abs(np.sum(normal[valid] * direction_b[valid], axis=1)) / length[valid]
    degrees = np.rad2deg(np.arcsin(np.clip(sine, 0, 1)))
    return {"count": int(degrees.size), "median_deg": float(np.median(degrees)),
            "p25_deg": float(np.quantile(degrees, 0.25)),
            "fraction_below_1deg": float(np.mean(degrees < 1.0)),
            "fraction_below_3deg": float(np.mean(degrees < 3.0))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip_path")
    parser.add_argument("pose_path")
    parser.add_argument("frame_a")
    parser.add_argument("frame_b")
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--match-image", help="optional output path for manual correspondence review")
    args = parser.parse_args()
    pose_a = load_pose(args.pose_path, args.frame_a)
    pose_b = load_pose(args.pose_path, args.frame_b)
    with zipfile.ZipFile(args.zip_path) as archive:
        first = load_panorama(archive, args.frame_a, args.width)
        second = load_panorama(archive, args.frame_b, args.width)
    xy_a, xy_b, keypoints_a, keypoints_b, good = correspondences(first, second)
    if args.match_image:
        visual = cv2.drawMatches(first, keypoints_a, second, keypoints_b, good, None,
                                 flags=cv2.DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS)
        ok, encoded = cv2.imencode(".jpg", visual)
        if not ok:
            raise ValueError("Could not encode match diagnostic")
        encoded.tofile(args.match_image)
    if len(xy_a) < 12:
        raise ValueError("Too few independent image matches: " + str(len(xy_a)))
    result = {"warning": "Unlabelled matches may be moving or incorrect; not ground truth.",
              "frame_a": args.frame_a, "frame_b": args.frame_b,
              "baseline_m": float(np.linalg.norm(pose_b[:3] - pose_a[:3])),
              "matches": len(xy_a)}
    for convention in ("yaw_only", "full_candidate"):
        result[convention] = epipolar_statistics(xy_a, xy_b, first.shape, pose_a, pose_b, convention)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
