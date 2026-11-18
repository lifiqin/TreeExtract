'use strict';

// 首次获取识别快照之前变更隔离数据，不能让已加载的树归属到新数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { BridgeClient } = require('../src/backend');
const { copyRuntime } = require('./test-runtime');

const desktop = path.resolve(__dirname, '..');
const source = path.resolve(desktop, '..', '..', 'tree');
const zip = path.join(source, 'Camera4.zip');
const bridge =
  process.env.TREEEXTRACT_TEST_BRIDGE || path.join(desktop, 'runtime', 'TreeExtractorBridge.exe');
const files = [
  'tree_centers2.txt',
  'Metashape.txt',
  'imgPosList.txt',
  'crown.csv',
  'trunk.csv',
  'manual_marks.csv',
];
const available =
  fs.existsSync(bridge) &&
  fs.existsSync(zip) &&
  files.every((name) => fs.existsSync(path.join(source, name)));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function jpegHasMetadata(dataUrl) {
  const bytes = Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64');
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    assert.equal(bytes[offset++], 0xff);
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error('Invalid JPEG segment');
    // APP1/APP13 and comments can carry EXIF, XMP, IPTC or other identifying metadata.
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) return true;
    offset += length;
  }
  throw new Error('JPEG ended before scan data');
}

test('加载后、首次识别快照之前替换数据会被拒绝，重载后身份隔离', { skip: !available }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract-identity-'));
  const data = path.join(directory, 'data');
  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(data);
  copyRuntime(bridge, runtime);
  for (const name of files) fs.copyFileSync(path.join(source, name), path.join(data, name));
  const originalHashes = Object.fromEntries(
    files.map((name) => [name, hash(path.join(source, name))]),
  );
  const zipStat = fs.statSync(zip);
  const tree = path.join(data, 'tree_centers2.txt');
  const original = fs.readFileSync(tree);
  const client = new BridgeClient(path.join(runtime, 'TreeExtractorBridge.exe'));
  try {
    await client.call('load', { dataDir: data, zipPath: zip });
    // 本测试故意不提前调用 recognition.snapshot。
    fs.appendFileSync(tree, '\n');
    await assert.rejects(client.call('recognition.snapshot'), /重新加载/);
    await client.call('load', { dataDir: data, zipPath: zip });
    const changed = await client.call('recognition.snapshot');
    assert.match(changed.datasetFingerprint, /^[a-f0-9]{64}$/);
    fs.writeFileSync(tree, original);
    await assert.rejects(client.call('recognition.snapshot'), /重新加载/);
    await client.call('load', { dataDir: data, zipPath: zip });
    const restored = await client.call('recognition.snapshot');
    assert.notEqual(changed.datasetFingerprint, restored.datasetFingerprint);
    assert.equal(jpegHasMetadata(restored.image), false, '待上传 JPEG 不应含 EXIF/XMP/IPTC 注释');
  } finally {
    client.close();
    for (const name of files) assert.equal(hash(path.join(source, name)), originalHashes[name]);
    const after = fs.statSync(zip);
    assert.equal(after.size, zipStat.size);
    assert.equal(after.mtimeMs, zipStat.mtimeMs);
  }
});
