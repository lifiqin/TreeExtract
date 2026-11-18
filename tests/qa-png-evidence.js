'use strict';

// Independent, deliberately narrow PNG reader for 8-bit non-interlaced
// analysis images. Unsupported encodings fail closed rather than being guessed.
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 12_000_000;
const MAX_BYTES = 64 * 1024 * 1024;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, up, upperLeft) {
  const p = left + up - upperLeft;
  const a = Math.abs(p - left),
    b = Math.abs(p - up),
    c = Math.abs(p - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

function decodeAnalysisPng(input, { includePixels = false } = {}) {
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_BYTES || bytes.length < 45 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Invalid PNG signature or size');
  }
  let offset = 8;
  let width = 0,
    height = 0,
    channels = 0,
    ended = false;
  const imageData = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > MAX_BYTES || dataEnd + 4 > bytes.length)
      throw new Error('Invalid PNG chunk length');
    const type = bytes.toString('ascii', typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('Invalid PNG chunk type');
    if (crc32(bytes.subarray(typeStart, dataEnd)) !== bytes.readUInt32BE(dataEnd)) {
      throw new Error(`Invalid PNG CRC: ${type}`);
    }
    if (offset === 8 && type !== 'IHDR') throw new Error('PNG IHDR must be first');
    if (type === 'IHDR') {
      if (width || length !== 13) throw new Error('Invalid PNG IHDR');
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8],
        colorType = bytes[dataStart + 9];
      if (
        !width ||
        !height ||
        width * height > MAX_PIXELS ||
        bitDepth !== 8 ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        bytes[dataStart + 12] !== 0
      ) {
        throw new Error('Unsupported PNG dimensions, depth or interlace');
      }
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] || 0;
      if (!channels) throw new Error('Unsupported PNG color type');
    } else if (type === 'IDAT') {
      if (!width || ended) throw new Error('Unexpected PNG IDAT');
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'tRNS') {
      throw new Error('PNG transparency chunk is not supported');
    } else if (type === 'IEND') {
      if (length || dataEnd + 4 !== bytes.length) throw new Error('Invalid PNG end');
      ended = true;
      break;
    } else if (type !== 'PLTE' && /^[A-Z]/.test(type)) {
      throw new Error(`Unsupported critical PNG chunk: ${type}`);
    }
    offset = dataEnd + 4;
  }
  if (!width || !ended || !imageData.length) throw new Error('Incomplete PNG');
  const rowLength = width * channels;
  const expected = (rowLength + 1) * height;
  const inflated = zlib.inflateSync(Buffer.concat(imageData), { maxOutputLength: expected });
  if (inflated.length !== expected) throw new Error('Unexpected PNG decoded size');
  const digest = crypto.createHash('sha256');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  digest.update(header);
  let previous = Buffer.alloc(rowLength);
  const bgra = Buffer.alloc(width * 4);
  const pixels = includePixels ? Buffer.alloc(width * height * 4) : null;
  for (let y = 0; y < height; y++) {
    const start = y * (rowLength + 1);
    const filter = inflated[start];
    if (filter > 4) throw new Error('Unsupported PNG filter');
    const row = Buffer.alloc(rowLength);
    for (let x = 0; x < rowLength; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, upperLeft);
      row[x] = (inflated[start + 1 + x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels,
        dst = x * 4;
      const gray = channels <= 2;
      bgra[dst] = gray ? row[src] : row[src + 2];
      bgra[dst + 1] = gray ? row[src] : row[src + 1];
      bgra[dst + 2] = row[src];
      bgra[dst + 3] = channels === 2 || channels === 4 ? row[src + channels - 1] : 255;
    }
    digest.update(bgra);
    if (pixels) bgra.copy(pixels, y * width * 4);
    previous = row;
  }
  const result = { width, height, pixelSha256: digest.digest('hex') };
  if (pixels) result.pixels = pixels;
  return result;
}

module.exports = { decodeAnalysisPng };
