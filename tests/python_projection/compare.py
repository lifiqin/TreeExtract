"""Compare the isolated Python projection with actual C# on synthetic inputs.

This is a microbenchmark, not an application benchmark. It never reads user data.
"""

import argparse
import json
import math
from pathlib import Path
import platform
import random
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from experiments.python_projection import projection  # noqa: E402

SAMPLE_COUNT = 512
REPETITIONS = 400
ROUNDS = 7
D = 1.0


def make_cases():
    rng = random.Random(20261118)
    pixel, natural = [], []
    for _ in range(SAMPLE_COUNT):
        vf = rng.uniform(50.0, 100.0)
        hf = projection.horizontal_fov(vf, 4.0 / 3.0, D)
        th, tv = projection.half_scale(hf / 2.0, D), projection.half_scale(vf / 2.0, D)
        center = rng.uniform(0.0, 360.0)
        tilt = rng.uniform(-10.0, 10.0)
        shift = rng.uniform(0.0, 0.4)
        pixel.append(((center + rng.uniform(-30.0, 30.0)) % 360.0,
                      rng.uniform(-20.0, 20.0), center, tilt, th, tv, shift, D))
        natural.append((rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0),
                        center, tilt, hf, vf, shift, D))
    return pixel, natural


def visual_cases():
    vf = 80.0
    hf = projection.horizontal_fov(vf, 4.0 / 3.0, D)
    th, tv = projection.half_scale(hf / 2.0, D), projection.half_scale(vf / 2.0, D)
    return [((350.0 + az_offset) % 360.0, elevation, 350.0, 0.0, th, tv, 0.0, D)
            for elevation in (-24.0, -12.0, 0.0, 12.0, 24.0)
            for az_offset in (-30.0, -15.0, 0.0, 15.0, 30.0)]


def csharp_results(dotnet, oracle, pixel, natural, visual):
    requests = []
    for operation, cases in (("pixel_from_world", pixel),
                             ("world_from_pixel_natural", natural),
                             ("pixel_from_world", visual)):
        requests.extend({"operation": operation, "d": args[-1], "args": args[:-1]} for args in cases)
    result = subprocess.run([dotnet, oracle], input=json.dumps(requests, allow_nan=False),
                            text=True, encoding="utf-8", capture_output=True, check=True, timeout=60)
    responses = json.loads(result.stdout)
    if len(responses) != len(requests):
        raise RuntimeError("C# oracle returned an unexpected number of results")
    n, m = len(pixel), len(natural)
    return responses[:n], responses[n:n + m], responses[n + m:]


def check_agreement(pixel, natural, visual, cs_pixel, cs_natural, cs_visual):
    py_pixel = [projection.pixel_from_world(*a) for a in pixel]
    py_natural = [projection.world_from_pixel_natural(*a) for a in natural]
    py_visual = [projection.pixel_from_world(*a) for a in visual]
    for py_group, cs_group in ((py_pixel, cs_pixel), (py_natural, cs_natural), (py_visual, cs_visual)):
        if not py_group or len(py_group) != len(cs_group):
            raise RuntimeError("Python/C# result count mismatch")
        for py_pair, cs_pair in zip(py_group, cs_group):
            if len(py_pair) != len(cs_pair) or not all(
                math.isfinite(a) and math.isfinite(b)
                and math.isclose(a, b, rel_tol=5e-11, abs_tol=5e-10)
                for a, b in zip(py_pair, cs_pair)
            ):
                raise RuntimeError(f"Python/C# mismatch: {py_pair!r} vs {cs_pair!r}")
    error_px = max(math.hypot((a[0] - b[0]) * 4000, (a[1] - b[1]) * 3000)
                   for a, b in zip(py_pixel, cs_pixel))
    az_error = max(abs(((a[0] - b[0] + 180.0) % 360.0) - 180.0)
                   for a, b in zip(py_natural, cs_natural))
    elevation_error = max(abs(a[1] - b[1]) for a, b in zip(py_natural, cs_natural))
    return {
        "pixel_cases": len(pixel), "natural_cases": len(natural), "visual_cases": len(visual),
        "reference_width": 4000, "reference_height": 3000,
        "max_pixel_distance_4000x3000": error_px,
        "max_azimuth_error_degrees": az_error,
        "max_elevation_error_degrees": elevation_error,
    }, py_visual


def python_timing(function, cases, repetitions):
    checksum = 0.0
    start = time.perf_counter()
    for _ in range(repetitions):
        for args in cases:
            first, second = function(*args)
            checksum += first + second
    return {"seconds": time.perf_counter() - start,
            "calls": repetitions * len(cases), "checksum": checksum}


def send_command(process, command):
    process.stdin.write(json.dumps(command, allow_nan=False) + "\n")
    process.stdin.flush()
    line = process.stdout.readline()
    if not line:
        raise RuntimeError("C# benchmark exited before returning a result")
    return json.loads(line)


def measure(dotnet, benchmark, pixel, natural):
    process = subprocess.Popen([dotnet, benchmark], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               text=True, encoding="utf-8")
    try:
        ready = send_command(process, {"pixel": pixel, "natural": natural})
        if not ready.get("ready"):
            raise RuntimeError("C# benchmark did not start")
        results = {}
        for name, function, cases in (("pixel", projection.pixel_from_world, pixel),
                                      ("natural", projection.world_from_pixel_natural, natural)):
            python_timing(function, cases, 20)
            send_command(process, {"operation": name, "repetitions": 20})
            python_times, csharp_times = [], []
            for round_index in range(ROUNDS):
                # Alternate order to reduce consistent warm-up/temperature bias.
                if round_index % 2 == 0:
                    py = python_timing(function, cases, REPETITIONS)
                    cs = send_command(process, {"operation": name, "repetitions": REPETITIONS})
                else:
                    cs = send_command(process, {"operation": name, "repetitions": REPETITIONS})
                    py = python_timing(function, cases, REPETITIONS)
                if py["calls"] != cs["calls"] or not math.isclose(
                    py["checksum"], cs["checksum"], rel_tol=1e-10, abs_tol=1e-7
                ):
                    raise RuntimeError(f"Benchmark checksums differ for {name}")
                python_times.append(py["seconds"] * 1_000_000 / py["calls"])
                csharp_times.append(cs["seconds"] * 1_000_000 / cs["calls"])
            py_median, cs_median = statistics.median(python_times), statistics.median(csharp_times)
            results[name] = {
                "calls_per_round": REPETITIONS * len(cases), "rounds": ROUNDS,
                "python_us_per_call": py_median, "csharp_us_per_call": cs_median,
                "csharp_speedup": py_median / cs_median,
                "python_samples_us_per_call": python_times,
                "csharp_samples_us_per_call": csharp_times,
            }
        process.stdin.write('{"operation":"stop"}\n')
        process.stdin.flush()
        process.stdin.close()
        if process.wait(timeout=10) != 0:
            raise RuntimeError("C# benchmark failed to shut down")
        return ready["runtime"], results
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def render_comparison(destination, py_points, cs_points, agreement):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False

    image = Image.new("RGB", (1500, 830), "#f3f6fa")
    draw = ImageDraw.Draw(image)
    font_path = "C:/Windows/Fonts/msyh.ttc"
    if not Path(font_path).is_file():
        return False
    title = ImageFont.truetype(font_path, 32)
    heading = ImageFont.truetype(font_path, 24)
    normal = ImageFont.truetype(font_path, 19)
    small = ImageFont.truetype(font_path, 16)
    draw.text((46, 25), "投影坐标对照：Python 与 C#", font=title, fill="#1d2b3a")
    draw.text((48, 76), "合成方向点映射到同一 4:3 画面；不是现场照片，也不是树木检测结果", font=normal, fill="#506276")
    panels = ((50, "Python", py_points), (800, "C#", cs_points))
    for left, label, points in panels:
        top, width, height = 155, 650, 488
        draw.text((left, 116), label, font=heading, fill="#1d2b3a")
        draw.rectangle((left, top, left + width, top + height), fill="#ffffff", outline="#becbdb", width=2)
        for i in range(1, 4):
            x = left + width * i / 4
            y = top + height * i / 4
            draw.line((x, top, x, top + height), fill="#e2e9f1", width=1)
            draw.line((left, y, left + width, y), fill="#e2e9f1", width=1)
        for index, (fx, fy) in enumerate(points):
            x, y = left + fx * width, top + fy * height
            radius = 9 if index == 12 else 6
            color = "#e04e43" if index == 12 else "#2875c7"
            draw.ellipse((x - radius, y - radius, x + radius, y + radius),
                         fill=color, outline="white", width=2)
        draw.text((left, 653), "25 个相同方向点；红点为中心方向", font=small, fill="#506276")
    error = agreement["max_pixel_distance_4000x3000"]
    draw.text((50, 715), f"另以 512 个合成方向对照：按 4000×3000 换算的最大位置差 {error:.2e} 像素",
              font=normal, fill="#1d2b3a")
    draw.text((50, 754), "两图的重合只说明这些输入上的坐标一致，不证明树木定位或识别准确。",
              font=normal, fill="#a03e31")
    image.save(destination, format="PNG")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dotnet", required=True)
    parser.add_argument("--oracle", required=True)
    parser.add_argument("--benchmark", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    pixel, natural = make_cases()
    visual = visual_cases()
    cs_pixel, cs_natural, cs_visual = csharp_results(args.dotnet, args.oracle, pixel, natural, visual)
    agreement, py_visual = check_agreement(pixel, natural, visual, cs_pixel, cs_natural, cs_visual)
    dotnet_version, timings = measure(args.dotnet, args.benchmark, pixel, natural)
    args.output_dir.mkdir(parents=False, exist_ok=False)
    image_created = render_comparison(
        args.output_dir / "projection-comparison.png", py_visual, cs_visual, agreement
    )
    report = {
        "scope": "synthetic scalar projection microbenchmark; not end-to-end application performance",
        "python": platform.python_version(), "dotnet_runtime": dotnet_version,
        "platform": platform.platform(), "agreement": agreement, "timings": timings,
        "visual_created": image_created,
    }
    with (args.output_dir / "summary.json").open("x", encoding="utf-8") as output:
        json.dump(report, output, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    print(f"Output directory: {args.output_dir}")


if __name__ == "__main__":
    main()
