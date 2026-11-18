"""Experimental port of the finite-input projection math in src/Proj.cs.

This module is deliberately independent of the desktop application.  ``d`` is
passed explicitly instead of sharing C#'s mutable Proj.NaturalD global state.
The supported and tested input domain is described in the accompanying README.
"""

import math

LEGACY_D = 0.5
LOW_DISTORTION_D = 1.0


def _rad(degrees: float) -> float:
    return degrees * math.pi / 180.0


def _deg(radians: float) -> float:
    return radians * 180.0 / math.pi


def _wrap360(value: float) -> float:
    # C# % keeps the sign of its dividend, unlike Python's % operator.
    value = math.fmod(value, 360.0)
    return value + 360.0 if value < 0.0 else value


def half_scale(angle_deg: float, d: float = LOW_DISTORTION_D) -> float:
    """Convert an angular radius in degrees to the radial image scale."""
    angle = _rad(angle_deg)
    return (d + 1.0) * math.sin(angle) / (d + math.cos(angle))


def horizontal_fov(
    vertical_fov_deg: float, aspect: float, d: float = LOW_DISTORTION_D
) -> float:
    """Match Proj.Hfov's 48-step binary search for the horizontal FOV."""
    target = aspect * half_scale(vertical_fov_deg / 2.0, d)
    low, high = 0.0, 179.0
    for _ in range(48):
        mid = (low + high) / 2.0
        if half_scale(mid / 2.0, d) < target:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0


def pixel_from_world(
    azimuth_deg: float,
    elevation_deg: float,
    center_azimuth_deg: float,
    center_elevation_deg: float,
    horizontal_scale: float,
    vertical_scale: float,
    shift: float,
    d: float = LOW_DISTORTION_D,
) -> tuple[float, float]:
    """Project a world direction to normalized photo coordinates (y down)."""
    azimuth, elevation = _rad(azimuth_deg), _rad(elevation_deg)
    center_azimuth, center_elevation = _rad(center_azimuth_deg), _rad(center_elevation_deg)
    dx = math.sin(azimuth) * math.cos(elevation)
    dy = math.cos(azimuth) * math.cos(elevation)
    dz = math.sin(elevation)
    cp, sp = math.cos(center_azimuth), math.sin(center_azimuth)
    ce, se = math.cos(center_elevation), math.sin(center_elevation)
    z = dx * sp * ce + dy * cp * ce + dz * se
    # Preserve the existing C# fallback, not a claim that this point is visible.
    if d + z <= 1e-9:
        return 0.5, 0.5
    x = dx * cp - dy * sp
    y = dx * (-sp * se) + dy * (-cp * se) + dz * ce
    scale = (d + 1.0) / (d + z)
    return (
        0.5 + 0.5 * (scale * x) / horizontal_scale,
        0.5 - 0.5 * (scale * y) / vertical_scale + 0.5 * shift,
    )


def _world_direction(
    x: float, y: float, z: float, center_azimuth_deg: float, center_elevation_deg: float
) -> tuple[float, float]:
    p0, e0 = _rad(center_azimuth_deg), _rad(center_elevation_deg)
    cp, sp, ce, se = math.cos(p0), math.sin(p0), math.cos(e0), math.sin(e0)
    rx = x * cp - y * sp * se + z * sp * ce
    ry = -x * sp - y * cp * se + z * cp * ce
    rz = y * ce + z * se
    azimuth = _wrap360(_deg(math.atan2(rx, ry)))
    elevation = _deg(math.atan2(rz, math.sqrt(rx * rx + ry * ry)))
    return azimuth, min(max(elevation, -89.0), 89.0)


def world_from_pixel_pinhole(
    u: float,
    v: float,
    center_azimuth_deg: float,
    center_elevation_deg: float,
    horizontal_fov_deg: float,
    vertical_fov_deg: float,
) -> tuple[float, float]:
    """Invert the pinhole model used for panorama preview interactions."""
    th = math.tan(_rad(horizontal_fov_deg) / 2.0)
    tv = math.tan(_rad(vertical_fov_deg) / 2.0)
    return _world_direction(u * th, v * tv, 1.0, center_azimuth_deg, center_elevation_deg)


def world_from_pixel_natural(
    u: float,
    v: float,
    center_azimuth_deg: float,
    center_elevation_deg: float,
    horizontal_fov_deg: float,
    vertical_fov_deg: float,
    shift: float,
    d: float = LOW_DISTORTION_D,
) -> tuple[float, float]:
    """Invert the radial projection used for the 4:3 photo and crop."""
    x = u * half_scale(horizontal_fov_deg / 2.0, d)
    y = (v + shift) * half_scale(vertical_fov_deg / 2.0, d)
    d1 = d + 1.0
    r2 = x * x + y * y
    qa = r2 + d1 * d1
    qb = 2.0 * d * r2
    qc = r2 * d * d - d1 * d1
    discriminant = max(qb * qb - 4.0 * qa * qc, 0.0)
    z = (-qb + math.sqrt(discriminant)) / (2.0 * qa)
    scale = (d + z) / d1
    return _world_direction(x * scale, y * scale, z, center_azimuth_deg, center_elevation_deg)
