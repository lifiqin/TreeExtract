"""Synthetic Python tests and a live comparison with the actual C# projection."""

import json
import math
import os
from pathlib import Path
import random
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from experiments.python_projection import projection  # noqa: E402


def case(operation, d, *args):
    return {"operation": operation, "d": d, "args": args}


def comparison_cases():
    """Use only synthetic inputs, including seams, clamping and fallback edges."""
    rng = random.Random(20261118)
    cases = []
    for d in (projection.LEGACY_D, projection.LOW_DISTORTION_D):
        for angle in (0.0, 1.0, 20.0, 40.0, 60.0, 89.0):
            cases.append(case("half_scale", d, angle))
        for vf in (40.0, 80.0, 120.0):
            cases.append(case("horizontal_fov", d, vf, 4.0 / 3.0))
        for offset in ((119.99, 120.0, 120.01) if d == 0.5 else (179.9, 180.0, 180.1)):
            cases.append(case("pixel_from_world", d, offset, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0))
        for center_azimuth in (0.0, 359.5, 360.0):
            for center_elevation in (-89.0, 0.0, 89.0):
                for u, v in ((0.0, 0.0), (-1.0, -1.0), (1.0, 1.0)):
                    cases.append(
                        case("world_from_pixel_pinhole", d, u, v, center_azimuth, center_elevation, 90.0, 80.0)
                    )
                    cases.append(
                        case("world_from_pixel_natural", d, u, v, center_azimuth, center_elevation, 90.0, 80.0, 0.4)
                    )
        for _ in range(350):
            vf = rng.uniform(40.0, 120.0)
            aspect = rng.uniform(1.0, 2.0)
            hf = projection.horizontal_fov(vf, aspect, d)
            th, tv = projection.half_scale(hf / 2.0, d), projection.half_scale(vf / 2.0, d)
            azimuth = rng.uniform(-720.0, 720.0)
            elevation = rng.uniform(-89.0, 89.0)
            center_azimuth = rng.uniform(-720.0, 720.0)
            center_elevation = rng.uniform(-80.0, 80.0)
            u, v, shift = rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0), rng.uniform(0.0, 0.4)
            cases.extend(
                (
                    case("half_scale", d, vf / 2.0),
                    case("horizontal_fov", d, vf, aspect),
                    case(
                        "pixel_from_world", d, azimuth, elevation, center_azimuth, center_elevation, th, tv, shift
                    ),
                    case("world_from_pixel_pinhole", d, u, v, center_azimuth, center_elevation, hf, vf),
                    case(
                        "world_from_pixel_natural", d, u, v, center_azimuth, center_elevation, hf, vf, shift
                    ),
                )
            )
    return cases


def evaluate_python(request):
    operation, args, d = request["operation"], request["args"], request["d"]
    if operation == "world_from_pixel_pinhole":
        return projection.world_from_pixel_pinhole(*args)
    function = getattr(projection, operation)
    result = function(*args, d=d)
    return result if isinstance(result, tuple) else (result,)


class ProjectionTests(unittest.TestCase):
    def test_reference_values_and_csharp_fallback(self):
        self.assertAlmostEqual(projection.half_scale(45.0, 1.0), 2 * (math.sqrt(2) - 1), places=14)
        self.assertEqual(projection.pixel_from_world(0, 0, 0, 0, 1, 1, 0), (0.5, 0.5))
        self.assertEqual(projection.pixel_from_world(180, 0, 0, 0, 1, 1, 0, 1.0), (0.5, 0.5))
        self.assertEqual(projection.pixel_from_world(120.01, 0, 0, 0, 1, 1, 0, 0.5), (0.5, 0.5))
        self.assertNotEqual(projection.pixel_from_world(119.99, 0, 0, 0, 1, 1, 0, 0.5), (0.5, 0.5))
        self.assertEqual(projection.world_from_pixel_pinhole(0, 0, 0, 90, 90, 80)[1], 89.0)
        self.assertEqual(projection.world_from_pixel_pinhole(0, 0, 0, -90, 90, 80)[1], -89.0)

    def test_natural_projection_round_trip(self):
        checks = 0
        for d in (0.5, 1.0):
            for vf in (40.0, 80.0, 120.0):
                hf = projection.horizontal_fov(vf, 4.0 / 3.0, d)
                th = projection.half_scale(hf / 2.0, d)
                tv = projection.half_scale(vf / 2.0, d)
                self.assertAlmostEqual(th / tv, 4.0 / 3.0, places=11)
                for shift in (0.0, 0.4):
                    for tilt in (-25.0, 0.0, 25.0):
                        for u in (-1.0, -0.75, -0.25, 0.0, 0.25, 0.75, 1.0):
                            for v in (-1.0, -0.75, -0.25, 0.0, 0.25, 0.75, 1.0):
                                az, el = projection.world_from_pixel_natural(
                                    u, v, 359.5, tilt, hf, vf, shift, d
                                )
                                if abs(el) >= 88.999:
                                    continue  # The original implementation deliberately clamps elevation.
                                fx, fy = projection.pixel_from_world(az, el, 359.5, tilt, th, tv, shift, d)
                                self.assertAlmostEqual(fx, (u + 1.0) / 2.0, delta=1e-9)
                                self.assertAlmostEqual(fy, (1.0 - v) / 2.0, delta=1e-9)
                                checks += 1
        self.assertGreater(checks, 1700)

    def test_modes_are_explicit_and_do_not_change_each_other(self):
        first = projection.half_scale(45.0, projection.LOW_DISTORTION_D)
        self.assertNotEqual(first, projection.half_scale(45.0, projection.LEGACY_D))
        self.assertEqual(first, projection.half_scale(45.0))

    def test_matches_live_csharp_oracle(self):
        dotnet = os.environ.get("TREEEXTRACT_PROJECTION_DOTNET")
        oracle = os.environ.get("TREEEXTRACT_PROJECTION_ORACLE")
        self.assertTrue(
            dotnet and oracle, "Run tests/python_projection/run-parity.ps1 to build the C# oracle."
        )
        cases = comparison_cases()
        process = subprocess.run(
            [dotnet, oracle],
            input=json.dumps(cases, allow_nan=False),
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
            timeout=60,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        expected = json.loads(process.stdout)
        self.assertEqual(len(expected), len(cases))
        for index, (request, csharp) in enumerate(zip(cases, expected)):
            with self.subTest(index=index, operation=request["operation"], d=request["d"]):
                actual = evaluate_python(request)
                self.assertEqual(len(actual), len(csharp))
                for py_value, cs_value in zip(actual, csharp):
                    self.assertTrue(math.isfinite(py_value) and math.isfinite(cs_value))
                    self.assertTrue(
                        math.isclose(py_value, cs_value, rel_tol=5e-11, abs_tol=5e-10),
                        f"Python={py_value!r}, C#={cs_value!r}, input={request!r}",
                    )
        print(f"Compared {len(cases)} synthetic projection cases against the C# sources.")


if __name__ == "__main__":
    unittest.main()
