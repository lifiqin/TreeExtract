'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-deploy-fast-'));
  const desktop = path.join(root, 'desktop');
  const scripts = path.join(desktop, 'scripts');
  const current = path.join(desktop, 'release-net10', 'TreeExtract-fast');
  const candidate = path.join(desktop, 'release-candidate-test', 'win-unpacked');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(candidate, { recursive: true });
  const script = path.join(scripts, 'deploy-fast.ps1');
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'deploy-fast.ps1'), script);
  function write(rootDir, relative, value) {
    const file = path.join(rootDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  write(current, 'TreeExtract.exe', 'previous executable');
  write(current, 'resources/app.asar', 'previous frontend');
  write(current, 'resources/runtime/TreeExtractor.ini', 'user config');
  write(current, 'resources/runtime/outputs/local.csv', 'user output');
  write(candidate, 'TreeExtract.exe', 'new executable');
  write(candidate, 'resources/app.asar', 'new frontend');
  return { root, desktop, current, candidate, script };
}

function deploy(script, candidate, tag) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-CandidateDirectory',
      candidate,
      '-Tag',
      tag,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
}

test('目录版安全切换：更新程序、保留额外用户文件及完整旧目录', () => {
  const f = fixture();
  const result = deploy(f.script, f.candidate, 'safe-test');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const backup = path.join(f.desktop, 'release-net10', 'TreeExtract-fast.backup-safe-test');
  assert.equal(fs.readFileSync(path.join(f.current, 'TreeExtract.exe'), 'utf8'), 'new executable');
  assert.equal(
    fs.readFileSync(path.join(f.current, 'resources', 'app.asar'), 'utf8'),
    'new frontend',
  );
  assert.equal(
    fs.readFileSync(path.join(f.current, 'resources', 'runtime', 'TreeExtractor.ini'), 'utf8'),
    'user config',
  );
  assert.equal(
    fs.readFileSync(path.join(f.current, 'resources', 'runtime', 'outputs', 'local.csv'), 'utf8'),
    'user output',
  );
  assert.equal(
    fs.readFileSync(path.join(backup, 'TreeExtract.exe'), 'utf8'),
    'previous executable',
  );
  assert.equal(
    fs.readFileSync(path.join(backup, 'resources', 'app.asar'), 'utf8'),
    'previous frontend',
  );
  assert.equal(deploy(f.script, f.candidate, 'safe-test').status === 0, false, '不能覆盖旧备份');
});

test('目录版部署拒绝工作区外的候选且不改动现有应用', () => {
  const f = fixture();
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  assert.notEqual(deploy(f.script, outside, 'outside-test').status, 0);
  assert.equal(
    fs.readFileSync(path.join(f.current, 'TreeExtract.exe'), 'utf8'),
    'previous executable',
  );
  assert.equal(
    fs.existsSync(path.join(f.desktop, 'release-net10', 'TreeExtract-fast.backup-outside-test')),
    false,
  );
});
