'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertIsolatedUnpackedExecutable } = require('./packaged-test-safety');

test('目录版冒烟测试只接受干净的临时副本，不触碰已有输出', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-package-guard-'));
  const application = path.join(root, 'isolated-fast');
  const runtime = path.join(application, 'resources', 'runtime');
  const executable = path.join(application, 'TreeExtract.exe');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(executable, 'placeholder');
  fs.writeFileSync(path.join(application, 'resources', 'app.asar'), 'placeholder');
  assert.equal(assertIsolatedUnpackedExecutable(executable), true);
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-package-other-'));
  assert.throws(() => assertIsolatedUnpackedExecutable(executable, otherRoot), /临时目录/);
  fs.mkdirSync(path.join(runtime, 'outputs'));
  assert.throws(() => assertIsolatedUnpackedExecutable(executable), /已有日志、输出或配置/);
});
