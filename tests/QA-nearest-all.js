"use strict";

// 独立计算每棵树的暴力基准，再由 .NET 10 的生产算法逐项核对。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "treeextract-nearest-all-"),
);
const localDotnet = path.join(
  process.env.LOCALAPPDATA || "",
  "TreeExtract",
  "dotnet-sdk",
  "dotnet.exe",
);
const dotnet =
  process.env.TREEEXTRACT_DOTNET ||
  (fs.existsSync(localDotnet) ? localDotnet : "dotnet");
const project = path.join(root, "tests", "TreeExtractor.Tests.csproj");
const testDll = path.join(
  root,
  "tests",
  "bin",
  "Release",
  "net10.0-windows",
  "win-x64",
  "TreeExtractor.Tests.dll",
);
const build = spawnSync(dotnet, ["build", project, "-c", "Release", "--nologo"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
});
if (build.error) throw build.error;
assert.equal(build.status, 0, build.stdout + build.stderr);

for (const [label, directory] of [
  ["D1", path.resolve(root, "..", "tree")],
  ["D2", path.resolve(root, "..", "dataset_runtime", "data")],
  ["D3", path.resolve(root, "..", "dataset_runtime_full", "data")],
]) {
  const zip = path.join(directory, "Camera4.zip");
  const list = spawnSync("tar.exe", ["-tf", zip], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(list.status, 0, list.stderr);
  const names = list.stdout
    .split(/\r?\n/)
    .map((entry) => entry.match(/JpgFiles\/([0-9.]+)\.jpg$/))
    .filter(Boolean)
    .map((match) => `${match[1]}.jpg`);
  const poses = new Map();
  const poseFile = path.join(directory, "Metashape.txt");
  for (const line of fs.readFileSync(poseFile, "utf8").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const values = fields.slice(1, 7).map(Number);
    if (values.length === 6 && values.every(Number.isFinite))
      poses.set(fields[0].toLowerCase(), values);
  }
  const frames = names
    .map((name) => ({ name, pose: poses.get(name.toLowerCase()) }))
    .filter((frame) => frame.pose);
  const axes = new Map();
  for (const line of fs
    .readFileSync(path.join(directory, "trunk.csv"), "utf8")
    .split(/\r?\n/)) {
    const fields = line.split(",");
    if (
      fields.length < 6 ||
      !fields[0].trim() ||
      !fields[4].trim() ||
      !fields[5].trim()
    )
      continue;
    const [id, x, y] = [
      Number(fields[0]),
      Number(fields[4]),
      Number(fields[5]),
    ];
    if ([id, x, y].every(Number.isFinite)) axes.set(id, [x, y]);
  }
  const expected = [];
  for (const line of fs
    .readFileSync(path.join(directory, "tree_centers2.txt"), "utf8")
    .split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const [id, centerX, centerY] = fields.slice(0, 3).map(Number);
    if (![id, centerX, centerY].every(Number.isFinite)) continue;
    const [x, y] = axes.get(id) || [centerX, centerY];
    let best,
      bestDistance = Infinity;
    for (const frame of frames) {
      const distance = Math.hypot(x - frame.pose[0], y - frame.pose[1]);
      if (distance < bestDistance) {
        best = frame.name;
        bestDistance = distance;
      }
    }
    assert.ok(best, `No reference frame for ${label} tree ${id}`);
    expected.push([id, x, y, best, bestDistance].join(","));
  }
  const frameFile = path.join(temporary, `${label}-frames.txt`);
  const expectedFile = path.join(temporary, `${label}-expected.csv`);
  fs.writeFileSync(frameFile, names.join("\n"));
  fs.writeFileSync(expectedFile, expected.join("\n"));
  const test = spawnSync(dotnet, [testDll, "nearest", frameFile, poseFile, expectedFile], {
    encoding: "utf8",
  });
  if (test.error) throw test.error;
  assert.equal(test.status, 0, test.stdout + test.stderr);
  console.log(
    `${label}: ${expected.length} trees, ${frames.length}/${names.length} frames with complete poses; ${test.stdout.trim()}`,
  );
}
console.log(`Evidence: ${temporary}`);
