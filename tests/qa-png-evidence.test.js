'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { decodeAnalysisPng } = require('./qa-png-evidence');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function predictor(filter, left, up, upperLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  const p = left + up - upperLeft;
  const choices = [left, up, upperLeft];
  const deltas = choices.map((x) => Math.abs(p - x));
  return choices[deltas.indexOf(Math.min(...deltas))];
}

function samplePng({ colorType = 6, interlace = 0 } = {}) {
  const width = 2,
    height = 5,
    stride = width * 4;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  header[12] = interlace;
  const rows = Array.from({ length: height }, (_, y) =>
    Buffer.from(Array.from({ length: stride }, (_, x) => (y * 31 + x * 17 + 3) % 256)),
  );
  const encoded = [];
  for (let y = 0; y < height; y++) {
    const row = rows[y],
      previous = y ? rows[y - 1] : Buffer.alloc(stride);
    const filtered = Buffer.alloc(stride + 1);
    filtered[0] = y;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0,
        up = previous[x],
        upperLeft = x >= 4 ? previous[x - 4] : 0;
      filtered[x + 1] = (row[x] - predictor(y, left, up, upperLeft) + 256) & 255;
    }
    encoded.push(filtered);
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(encoded))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const digest = crypto.createHash('sha256');
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32LE(width, 0);
  dimensions.writeUInt32LE(height, 4);
  digest.update(dimensions);
  for (const row of rows) {
    const bgra = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      bgra[i] = row[i + 2];
      bgra[i + 1] = row[i + 1];
      bgra[i + 2] = row[i];
      bgra[i + 3] = row[i + 3];
    }
    digest.update(bgra);
  }
  return { png, width, height, expected: digest.digest('hex') };
}

test('real GDI+ PNG decodes into the documented top-down BGRA digest', () => {
  const file = path.join(__dirname, 'fixtures', 'qa-rgba-2x2.png');
  const result = decodeAnalysisPng(fs.readFileSync(file));
  assert.deepEqual(result, {
    width: 2,
    height: 2,
    pixelSha256: '3f87ea342a98dd1f42879035ed798f9099f95a51aa525ecd5753db8cb4b9986e',
  });
});

test('all five PNG row filters produce the original top-down BGRA bytes', () => {
  const fixture = samplePng();
  assert.deepEqual(decodeAnalysisPng(fixture.png), {
    width: fixture.width,
    height: fixture.height,
    pixelSha256: fixture.expected,
  });
});

test('corrupt, truncated, unsupported and non-PNG images are rejected', () => {
  const fixture = samplePng();
  const corrupt = Buffer.from(fixture.png);
  corrupt[50] ^= 1;
  assert.throws(() => decodeAnalysisPng(corrupt), /CRC/);
  assert.throws(
    () => decodeAnalysisPng(fixture.png.subarray(0, fixture.png.length - 1)),
    /end|Incomplete|length/i,
  );
  assert.throws(() => decodeAnalysisPng(samplePng({ colorType: 3 }).png), /color type/);
  assert.throws(() => decodeAnalysisPng(samplePng({ interlace: 1 }).png), /interlace/);
  assert.throws(() => decodeAnalysisPng(Buffer.from('not png')), /signature/);
});
