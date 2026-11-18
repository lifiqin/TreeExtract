"use strict";

// 对默认数据集树 ID 120–170 做隔离扫描；只读原始全景 ZIP，不改原始标注。
// TREEEXTRACT_TEST_BRIDGE 指定待测后端；TREEEXTRACT_QA_ALL_IMAGES=1 保存全部 51 张；
// TREEEXTRACT_QA_SKIP_FIXED=1 跳过切树状态对照，以便只测双帧一次遍历。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { BridgeClient } = require("../desktop-js/src/backend");
const { copyRuntime } = require("../desktop-js/tests/test-runtime");

const root = path.resolve(__dirname, "..");
const source = path.resolve(root, "..", "tree");
const executable =
  process.env.TREEEXTRACT_TEST_BRIDGE ||
  path.join(root, "desktop-js", "runtime", "TreeExtractorBridge.exe");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "treeextract-selection-qa-"),
);
const data = path.join(temporary, "data");
const runtime = path.join(temporary, "runtime");
const images = path.join(temporary, "images");
const names = [
  "tree_centers2.txt",
  "Metashape.txt",
  "imgPosList.txt",
  "crown.csv",
  "trunk.csv",
  "manual_marks.csv",
];
const samples = new Set([120, 130, 140, 150, 160, 170]);
const saveAllImages = process.env.TREEEXTRACT_QA_ALL_IMAGES === "1";
const skipFixedReplay = process.env.TREEEXTRACT_QA_SKIP_FIXED === "1";

function hash(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function compact(state, elapsedMs) {
  return {
    index: state.treeIndex,
    id: state.treeId,
    frame: state.frame,
    frameIndex: state.frameIndex,
    autoFrame: state.autoFrame,
    strategy: state.frameStrategy,
    distance: state.cameraHorizontalDistance,
    bearing: state.bearing,
    elevation: state.elevation,
    markAz: state.markAz,
    markEl: state.markEl,
    dual: state.dualFrameInfo,
    photoRisk: state.photoRisk || null,
    targetValid: state.targetValid ?? null,
    elapsedMs,
    status: state.status,
  };
}

function saveDataUrl(file, value) {
  if (!value || !value.startsWith("data:image/jpeg;base64,"))
    throw new Error("Missing JPEG: " + file);
  fs.writeFileSync(
    file,
    Buffer.from(value.slice(value.indexOf(",") + 1), "base64"),
  );
}

function frequencies(rows) {
  const counts = new Map();
  for (const row of rows)
    counts.set(row.frame, (counts.get(row.frame) || 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([frame, count]) => ({ frame, count }));
}

function counts(rows, keyOf) {
  const result = {};
  for (const row of rows) {
    const key = keyOf(row) || "unavailable";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

async function main() {
  fs.mkdirSync(data);
  fs.mkdirSync(images);
  const before = {};
  for (const name of names) {
    const input = path.join(source, name);
    before[name] = hash(input);
    fs.copyFileSync(input, path.join(data, name));
  }
  const zip = path.join(source, "Camera4.zip");
  const zipBefore = fs.statSync(zip);
  const isolatedExe = copyRuntime(executable, runtime, { includeModel: false });
  const client = new BridgeClient(isolatedExe);
  const backendDirectory = path.dirname(executable);
  const backendHashes = {};
  for (const name of [
    "TreeExtractorBridge.exe",
    "TreeExtractorBridge.dll",
    "TreeExtractorBridge.runtimeconfig.json",
  ]) {
    const file = path.join(backendDirectory, name);
    if (fs.existsSync(file)) backendHashes[name] = hash(file);
  }
  const report = {
    source: "default tree dataset",
    backendHashes,
    imageMode: saveAllImages ? "all 51" : "six samples",
    skipFixedReplay,
    automatic: [],
    fixed: [],
    sampleImages: [],
  };
  try {
    await client.call("load", { dataDir: data, zipPath: zip });
    await client.call("view.options", {
      frameStrategy: "quality",
      dualFrame: true,
    });
    for (let index = 120; index <= 170; index++) {
      const started = performance.now();
      const state = await client.call("tree.select", { index });
      if (state.treeId !== index)
        throw new Error(`Tree index ${index} has ID ${state.treeId}`);
      report.automatic.push(
        compact(state, Math.round(performance.now() - started)),
      );
      if (saveAllImages || samples.has(state.treeId)) {
        const result = await client.call("images");
        const photo = path.join(images, `tree-${state.treeId}-quality.jpg`);
        saveDataUrl(photo, result.photo);
        report.sampleImages.push({
          treeId: state.treeId,
          frame: state.frame,
          mode: "quality",
          photo,
        });
      }
      if (index % 10 === 0) console.log(`automatic ${index}/170`);
    }
    if (!skipFixedReplay) {
      await client.call("view.options", { frameStrategy: "quality" });
      await client.call("tree.select", { index: 120 });
      const fixedStarted = performance.now();
      report.fixedStart = compact(
        await client.call("frame.step", { direction: 1 }),
        Math.round(performance.now() - fixedStarted),
      );
      for (let index = 120; index <= 170; index++) {
        const started = performance.now();
        const state = await client.call("tree.select", { index });
        report.fixed.push(
          compact(state, Math.round(performance.now() - started)),
        );
        if (index % 10 === 0) console.log(`fixed ${index}/170`);
      }
    }
    report.autoFrames = frequencies(report.automatic);
    report.fixedFrames = frequencies(report.fixed);
    report.dualStates = counts(report.automatic, (row) => row.dual?.state);
    report.dualReasons = counts(report.automatic, (row) => row.dual?.reason);
    report.photoRisks = counts(report.automatic, (row) => row.photoRisk?.state);
    report.meanSelectionMs = Math.round(
      report.automatic.reduce((sum, row) => sum + row.elapsedMs, 0) /
        report.automatic.length,
    );
    report.originalHashesUnchanged = names.every(
      (name) => hash(path.join(source, name)) === before[name],
    );
    const zipAfter = fs.statSync(zip);
    report.zipSizeAndTimeUnchanged =
      zipAfter.size === zipBefore.size &&
      zipAfter.mtimeMs === zipBefore.mtimeMs;
    fs.writeFileSync(
      path.join(temporary, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(`AUTO UNIQUE FRAMES: ${report.autoFrames.length}`);
    console.log(
      skipFixedReplay
        ? "FIXED REPLAY: skipped"
        : `FIXED UNIQUE FRAMES: ${report.fixedFrames.length}`,
    );
    console.log(`DUAL STATES: ${JSON.stringify(report.dualStates)}`);
    console.log(`DUAL REASONS: ${JSON.stringify(report.dualReasons)}`);
    console.log(`MEAN SELECTION MS: ${report.meanSelectionMs}`);
    console.log(`EVIDENCE: ${temporary}`);
    if (!report.originalHashesUnchanged || !report.zipSizeAndTimeUnchanged)
      throw new Error("Original data changed");
  } finally {
    const closed =
      client.child.exitCode === null && client.child.signalCode === null
        ? once(client.child, "close")
        : Promise.resolve();
    client.close();
    await closed;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
