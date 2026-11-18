'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BridgeClient } = require('../src/backend');

const executable =
  process.env.TREEEXTRACT_TEST_BRIDGE ||
  path.join(__dirname, '..', 'runtime', 'TreeExtractorBridge.exe');

test(
  '独立后端创建全景包并拒绝覆盖或打包已变更的照片',
  { skip: !fs.existsSync(executable) },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-archive-test-'));
    t.after(() => {
      const resolved = fs.realpathSync(root);
      assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
      assert.ok(path.basename(resolved).startsWith('treeextract-archive-test-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    });
    const source = path.join(root, '123.456.jpg');
    fs.writeFileSync(source, 'fixture image bytes');
    const stat = fs.statSync(source);
    const images = [
      { source, name: path.basename(source), length: stat.size, mtimeMs: Math.floor(stat.mtimeMs) },
    ];
    const output = path.join(root, 'Camera4.zip');
    const bridge = new BridgeClient(executable);
    try {
      const result = await bridge.call('merge.archive', { output, images });
      assert.equal(result.entries, 1);
      const archive = fs.readFileSync(output);
      assert.ok(archive.includes(Buffer.from('JpgFiles/123.456.jpg')));
      assert.ok(archive.includes(Buffer.from('fixture image bytes')));
      await assert.rejects(bridge.call('merge.archive', { output, images }));
      assert.deepEqual(fs.readFileSync(output), archive);
      fs.appendFileSync(source, ' changed');
      await assert.rejects(
        bridge.call('merge.archive', { output: path.join(root, 'changed.zip'), images }),
        /发生变化/,
      );
    } finally {
      bridge.close();
    }
  },
);
