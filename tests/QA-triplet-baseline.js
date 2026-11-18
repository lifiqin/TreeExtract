"use strict";

// QA baseline: read original panoramas only; all mutable data and the bridge run in a fresh temp folder.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { BridgeClient } = require("../desktop-js/src/backend");
const { copyRuntime } = require("../desktop-js/tests/test-runtime");

const root = path.resolve(__dirname, "..");
const runtime = path.join(root, "desktop-js", "runtime");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "treeextract-qa3-"));
const bridgeDir = path.join(temporary, "runtime");
const client = new BridgeClient(
  copyRuntime(path.join(runtime, "TreeExtractorBridge.exe"), bridgeDir),
);

function hash(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function validFrames(zipFile, metaFile) {
  const archive = spawnSync("tar.exe", ["-tf", zipFile], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (archive.status !== 0)
    throw new Error(archive.stderr || "Cannot inspect panorama archive.");
  const names = [];
  for (const entry of archive.stdout.split(/\r?\n/)) {
    const match = entry.match(/JpgFiles\/([0-9.]+)\.jpg$/);
    if (match) names.push(`${match[1]}.jpg`);
  }
  const poses = new Map(
    fs
      .readFileSync(metaFile, "utf8")
      .split(/\r?\n/)
      .map((line) => {
        const fields = line.trim().split(/\s+/);
        const values = fields.slice(1, 7).map(Number);
        return {
          name: fields[0],
          x: values[0],
          y: values[1],
          valid: values.length === 6 && values.every(Number.isFinite),
        };
      })
      .filter((pose) => pose.valid)
      .map((pose) => [pose.name.toLowerCase(), pose]),
  );
  return names.map((name) => poses.get(name.toLowerCase())).filter(Boolean);
}

function treePositions(file) {
  const positions = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const [id, x, y, z, height] = fields.slice(0, 5).map(Number);
    if ([id, x, y, z, height].every(Number.isFinite) && fields.length >= 5)
      positions.set(id, { x, y, z, height });
  }
  return positions;
}

function trunkAxes(file) {
  const axes = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const fields = line.trim().split(",");
    if (
      fields.length < 6 ||
      !fields[0].trim() ||
      !fields[4].trim() ||
      !fields[5].trim()
    )
      continue;
    const id = Number(fields[0]);
    const x = Number(fields[4]);
    const y = Number(fields[5]);
    if ([id, x, y].every(Number.isFinite)) axes.set(id, { x, y });
  }
  return axes;
}

function nearestFrame(tree, frames) {
  let best = null;
  for (const frame of frames) {
    const distance = Math.hypot(tree.x - frame.x, tree.y - frame.y);
    if (!best || distance < best.distance)
      best = { name: frame.name, distance };
  }
  return best;
}

function savePhoto(images, name) {
  if (images.photo)
    fs.writeFileSync(
      path.join(temporary, name),
      Buffer.from(images.photo.split(",")[1], "base64"),
    );
}

async function run() {
  const inputs = [
    { label: "D1", source: path.resolve(root, "..", "tree") },
    {
      label: "D2",
      source: path.resolve(root, "..", "dataset_runtime", "data"),
    },
    {
      label: "D3",
      source: path.resolve(root, "..", "dataset_runtime_full", "data"),
    },
  ];
  const result = { temporary, data: [] };
  for (const input of inputs) {
    const isolated = path.join(temporary, input.label);
    fs.mkdirSync(isolated);
    const files = [
      "tree_centers2.txt",
      "Metashape.txt",
      "imgPosList.txt",
      "crown.csv",
      "trunk.csv",
      "manual_marks.csv",
    ];
    const originalHashes = {};
    for (const file of files) {
      const source = path.join(input.source, file);
      originalHashes[file] = hash(source);
      fs.copyFileSync(source, path.join(isolated, file));
    }
    const zipPath = path.join(input.source, "Camera4.zip");
    const frames = validFrames(zipPath, path.join(isolated, "Metashape.txt"));
    const positions = treePositions(path.join(isolated, "tree_centers2.txt"));
    const axes = trunkAxes(path.join(isolated, "trunk.csv"));
    const load = await client.call("load", { dataDir: isolated, zipPath });
    const trees = await client.call("trees");
    assert.ok(
      load.loaded && load.frameCount > 0 && trees.length > 0,
      `${input.label} failed to load`,
    );
    const frameMap = new Map(
      frames.map((frame) => [frame.name.toLowerCase(), frame]),
    );
    const sampleIndices = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((p) =>
      Math.floor((trees.length - 1) * p),
    );
    if (input.label === "D1") {
      for (const id of [105, 106, 110, 117, 121, 128]) {
        const i = trees.findIndex((tree) => tree.id === id);
        if (i >= 0) sampleIndices.push(i);
      }
    }
    const samples = [...new Set(sampleIndices)]
      .sort((a, b) => a - b)
      .map((index) => trees[index]);
    const rows = new Map(
      samples.map((tree) => [
        tree.id,
        {
          id: tree.id,
          height: tree.height,
          nearest: nearestFrame(positions.get(tree.id), frames),
          nearestAxis: nearestFrame(
            axes.get(tree.id) || positions.get(tree.id),
            frames,
          ),
          usedAxis: axes.has(tree.id),
        },
      ]),
    );
    for (const [strategy, dual] of [
      ["quality", false],
      ["quality", true],
      ["nearest", false],
      ["nearest", true],
    ]) {
      await client.call("view.options", {
        autoFrame: true,
        dualFrame: dual,
        frameStrategy: strategy,
      });
      for (const tree of samples) {
        const started = Date.now();
        const state = await client.call("tree.select", { index: tree.index });
        const row = rows.get(tree.id);
        const pose = frameMap.get(state.frame.toLowerCase());
        assert.ok(
          pose,
          `Selected frame has no matching panorama and pose: ${state.frame}`,
        );
        assert.equal(
          state.autoFrame,
          true,
          "Tree selection unexpectedly disabled automatic frame selection",
        );
        assert.equal(
          state.dualFrame,
          dual,
          "Dual-frame option does not match the requested mode",
        );
        assert.equal(
          state.frameStrategy,
          strategy,
          "Unexpected frame-selection strategy",
        );
        if (strategy === "nearest") {
          assert.equal(
            state.frame,
            row.nearestAxis.name,
            `${input.label} tree ${tree.id} is not the true nearest frame`,
          );
        }
        const treePosition = positions.get(tree.id);
        const field =
          strategy === "quality"
            ? dual
              ? "dual"
              : "single"
            : dual
              ? "nearestDual"
              : "nearestSingle";
        row[field] = {
          frame: state.frame,
          distance: state.distance,
          bearing: state.bearing,
          elevation: state.elevation,
          centerDistance: Math.hypot(
            treePosition.x - pose.x,
            treePosition.y - pose.y,
          ),
          markMode: state.markMode,
          status: state.status,
          autoFrame: state.autoFrame,
          dualFrame: state.dualFrame,
          frameStrategy: state.frameStrategy,
          photoRisk: state.photoRisk,
          dualFrameInfo: state.dualFrameInfo,
          elapsedMs: Date.now() - started,
        };
        if (
          [
            samples[0].id,
            samples[Math.floor(samples.length / 2)].id,
            samples[samples.length - 1].id,
            105,
            106,
            110,
          ].includes(tree.id)
        ) {
          const prefix = strategy === "quality" ? "" : "nearest-";
          savePhoto(
            await client.call("images"),
            `${input.label}-${tree.id}-${prefix}${dual ? "dual" : "single"}.jpg`,
          );
        }
        console.log(
          JSON.stringify({
            dataset: input.label,
            tree: tree.id,
            strategy,
            mode: dual ? "dual" : "single",
            frame: state.frame,
            markMode: state.markMode,
            elapsedMs: Date.now() - started,
          }),
        );
      }
    }
    for (const file of files) {
      assert.equal(
        hash(path.join(input.source, file)),
        originalHashes[file],
        `Original changed: ${file}`,
      );
      assert.equal(
        hash(path.join(isolated, file)),
        originalHashes[file],
        `Copied input changed: ${file}`,
      );
    }
    if (input.label === "D1") {
      for (const id of [105, 106]) {
        assert.equal(
          hash(path.join(temporary, `D1-${id}-single.jpg`)),
          hash(path.join(temporary, `D1-${id}-dual.jpg`)),
          `Manual correction changed on tree ${id}`,
        );
      }
    }
    result.data.push({
      dataset: input.label,
      treeCount: load.treeCount,
      zipFrames: load.frameCount,
      framesWithPose: frames.length,
      rows: [...rows.values()],
    });
    fs.writeFileSync(
      path.join(temporary, "results.json"),
      JSON.stringify(result, null, 2),
    );
  }
  client.close();
  if (client.child.exitCode === null) await once(client.child, "exit");
  console.log(`QA RESULTS: ${path.join(temporary, "results.json")}`);
}

run().catch((error) => {
  console.error(error);
  client.close();
  process.exitCode = 1;
});
