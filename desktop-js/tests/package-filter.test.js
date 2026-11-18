'use strict';

// electron-builder 的文件匹配器是发布边界：依赖升级后仍不得夹带用户数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const { build } = require('../package.json');

function matches(patterns, relative, directory = false) {
  const root = path.resolve('packaging-contract-fixture');
  const matcher = new FileMatcher(root, root, (value) => value, patterns);
  return matcher.createFilter()(path.join(root, relative), { isDirectory: () => directory });
}

test('portable 打包只包含界面资源和显式允许的后端运行文件', () => {
  const runtime = build.extraResources.find((resource) => resource.to === 'runtime');
  assert.ok(runtime, '缺少运行时资源白名单');
  for (const name of [
    'TreeExtractorBridge.exe',
    'TreeExtractorBridge.dll',
    'TreeExtractorBridge.deps.json',
    'TreeExtractorBridge.runtimeconfig.json',
    'models/tree_cls.onnx',
    'models/person_head.onnx',
    'models/PERSON_HEAD_LICENSE.txt',
  ]) {
    assert.equal(matches(runtime.filter, name), true, `应打包 ${name}`);
  }
  for (const name of [
    'manual_marks.csv',
    'TreeExtractor.ini',
    'error.log',
    'data/user.txt',
    'outputs/replay.csv',
    'models/unlisted.onnx',
  ]) {
    assert.equal(matches(runtime.filter, name), false, `不得打包 ${name}`);
  }
  for (const name of [
    'src/main.js',
    'src/renderer/index.html',
    'src/renderer/dual-frame-view.mjs',
    'src/renderer/image-safety-gate.mjs',
    'src/renderer/pan-drag-queue.mjs',
    'src/renderer/species-review.mjs',
    'src/renderer/tree-list-view.mjs',
    'src/renderer/image-focus.mjs',
    'src/renderer/table-view.mjs',
    'src/ipc-registrar.js',
    'src/session-coordinator.js',
    'src/tree-ipc.js',
    'src/species-ipc.js',
    'src/species-catalog.json',
    'src/species-cloud.js',
    'src/cloud-credentials.js',
    'src/species-orchestration.js',
    'src/species-scope.js',
    'src/species-store.js',
    'package.json',
  ]) {
    assert.equal(matches(build.files, name), true, `应打包 ${name}`);
  }
  assert.equal(matches(build.files, 'tests/private-fixture.csv'), false);
});

test('便携版冒烟测试拒绝直接启动 win-unpacked 候选目录', () => {
  const script = path.join(__dirname, 'portable-smoke.js');
  const candidate = path.join(os.tmpdir(), 'win-unpacked', 'TreeExtract.exe');
  const result = spawnSync(process.execPath, [script, candidate], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不应直接运行 win-unpacked 候选/);
});

test('凭据测试与性能测试也拒绝直接启动候选目录', () => {
  const candidate = path.join(os.tmpdir(), 'win-unpacked', 'TreeExtract.exe');
  for (const name of ['credential-packaged-smoke.js', 'launch-benchmark.js']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TREEEXTRACT_FAST_EXE: candidate,
        TREEEXTRACT_PORTABLE_EXE: 'placeholder',
      },
    });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /不应直接运行 win-unpacked 候选/, name);
  }
});
