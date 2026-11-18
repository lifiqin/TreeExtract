'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

test(
  'backend rebuild preserves user files and leaves the old runtime intact on failure',
  { timeout: 240000 },
  () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract build test '));
    try {
      for (const directory of ['src', 'desktop-js/bridge', 'desktop-js/scripts']) {
        fs.cpSync(path.join(root, directory), path.join(temporary, directory), { recursive: true });
      }
      for (const file of [
        'global.json',
        'backend/TreeExtractor.Backend.csproj',
        'backend/Dependencies.props',
        'backend/packages.lock.json',
        '_deps/ort/lib/netstandard2.0/Microsoft.ML.OnnxRuntime.dll',
        '_deps/ort/onnxruntime.dll',
      ]) {
        copyFile(path.join(root, file), path.join(temporary, file));
      }

      const runtime = path.join(temporary, 'desktop-js', 'runtime');
      const preserved = {
        'TreeExtractorBridge.exe': 'old executable',
        'TreeExtractor.ini': 'custom configuration',
        'manual_marks.csv': '1,0.10,-0.20',
        'data/user.txt': 'user data',
        'outputs/replay.csv': 'user output',
        'error.log': 'existing log',
        'keep.json': '{"user":true}',
      };
      for (const [name, content] of Object.entries(preserved)) {
        const file = path.join(runtime, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      const script = path.join(temporary, 'desktop-js', 'scripts', 'build-bridge.ps1');
      const build = (extraArguments = []) =>
        spawnSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extraArguments],
          {
            cwd: temporary,
            encoding: 'utf8',
            timeout: 180000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );

      // 缺少模型时发布必须失败，不能替换旧程序或更改用户文件。
      const failed = build();
      assert.notEqual(failed.status, 0, '缺少模型时应拒绝替换运行时');
      for (const [name, content] of Object.entries(preserved)) {
        assert.equal(fs.readFileSync(path.join(runtime, name), 'utf8'), content, name);
      }

      copyFile(
        path.join(root, 'models', 'tree_cls.onnx'),
        path.join(temporary, 'models', 'tree_cls.onnx'),
      );
      for (const name of ['person_head.onnx', 'PERSON_HEAD_LICENSE.txt']) {
        copyFile(path.join(root, 'models', name), path.join(temporary, 'models', name));
      }
      const successful = build();
      assert.equal(successful.status, 0, successful.stdout + successful.stderr);
      for (const [name, content] of Object.entries(preserved)) {
        if (name !== 'TreeExtractorBridge.exe') {
          assert.equal(fs.readFileSync(path.join(runtime, name), 'utf8'), content, name);
        }
      }
      const config = JSON.parse(
        fs.readFileSync(path.join(runtime, 'TreeExtractorBridge.runtimeconfig.json'), 'utf8'),
      );
      assert.equal(config.runtimeOptions.tfm, 'net10.0');
      assert.ok(fs.existsSync(path.join(runtime, 'coreclr.dll')));
      const leftovers = fs
        .readdirSync(path.join(temporary, 'desktop-js'))
        .filter((name) => /^runtime-(stage|backup)-/.test(name));
      assert.deepEqual(leftovers, []);

      // 显式保留备份时，新旧运行时中的用户数据都必须可读。
      const retained = build(['-KeepBackup']);
      assert.equal(retained.status, 0, retained.stdout + retained.stderr);
      const backups = fs
        .readdirSync(path.join(temporary, 'desktop-js'))
        .filter((name) => name.startsWith('runtime-backup-'));
      assert.equal(backups.length, 1);
      for (const name of ['TreeExtractor.ini', 'manual_marks.csv', 'data/user.txt']) {
        assert.equal(fs.readFileSync(path.join(runtime, name), 'utf8'), preserved[name]);
        assert.equal(
          fs.readFileSync(path.join(temporary, 'desktop-js', backups[0], name), 'utf8'),
          preserved[name],
        );
      }
    } finally {
      const tempRoot = fs.realpathSync(os.tmpdir());
      const target = fs.realpathSync(temporary);
      if (
        target.startsWith(tempRoot + path.sep) &&
        path.basename(target).startsWith('treeextract build test ')
      ) {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  },
);
