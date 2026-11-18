'use strict';

// 输入适配层：解析并检查原始采集和树心文件，不写入用户数据。
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_IMAGES = 100000;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
// FrameStore 的 ZIP 条目匹配区分扩展名大小写。
const FRAME_NAME = /^\d+(?:\.\d+)?\.jpg$/;
const POSE_HEADER = 'ImageName GPSTime Longitude Latitude H_Ell Roll Pitch Heading';
const META_HEADER = 'imageName X Y Z Omega Phi Kappa';

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function crdSignature(bytes) {
  // 这三个位置字段记录采集时的状态，不是投影与校正参数；无法识别时保守地比较整个文件。
  const copy = Buffer.from(bytes);
  for (const key of ['stateBD', 'stateLD', 'stateHD']) {
    const marker = Buffer.from(key, 'ascii');
    const at = copy.indexOf(marker);
    if (at < 0 || copy.indexOf(marker, at + 1) >= 0 || at + marker.length + 8 > copy.length)
      return digest(bytes);
    copy.fill(0, at + marker.length, at + marker.length + 8);
  }
  return digest(copy);
}

function linesOf(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/);
}

function poseRows(text, label) {
  const lines = linesOf(text);
  if (lines[0].trim().replace(/\s+/g, ' ').toLowerCase() !== POSE_HEADER.toLowerCase())
    throw new Error(`${label}：imgPosList.txt 表头不符合支持的采集格式。`);
  const rows = [];
  let previous = -Infinity;
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const parts = raw.trim().split(/\s+/);
    const numbers = parts.slice(0, 8).map(Number);
    if (parts.length < 8 || numbers.some((n) => !Number.isFinite(n)))
      throw new Error(`${label}：imgPosList.txt 含无效位姿记录。`);
    if (Math.abs(numbers[0] - numbers[1]) > 0.00001)
      throw new Error(`${label}：图像时间与 GPS 时间不一致，不能自动合并。`);
    if (numbers[0] < previous) break; // 后续是其他镜头槽位，软件按第一路使用。
    previous = numbers[0];
    rows.push({ time: numbers[0], line: parts.slice(0, 8).join(' ') });
  }
  if (!rows.length) throw new Error(`${label}：没有可用的第一路位姿。`);
  return rows;
}

function metaRows(text, imageNames, label) {
  const lines = linesOf(text);
  if (lines[0].trim().replace(/\s+/g, ' ').toLowerCase() !== META_HEADER.toLowerCase())
    throw new Error(`${label}：Metashape.txt 表头不符合支持的格式。`);
  const rows = [];
  const seen = new Set();
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const parts = raw.trim().split(/\s+/);
    const key = (parts[0] || '').toLowerCase();
    if (
      parts.length !== 7 ||
      !FRAME_NAME.test(parts[0]) ||
      !Number.isFinite(Number(parts[0].slice(0, -4))) ||
      parts.slice(1).some((value) => !Number.isFinite(Number(value)))
    )
      throw new Error(`${label}：Metashape.txt 含无效记录。`);
    if (!imageNames.has(key)) throw new Error(`${label}：位姿引用了不存在的照片 ${parts[0]}。`);
    if (seen.has(key)) throw new Error(`${label}：照片位姿重复：${parts[0]}。`);
    seen.add(key);
    rows.push({
      name: parts[0],
      time: Number(parts[0].slice(0, -4)),
      line: parts.join(' '),
      x: Number(parts[1]),
      y: Number(parts[2]),
    });
  }
  if (!rows.length) throw new Error(`${label}：没有对应照片的有效 Metashape 位姿。`);
  return rows;
}

async function jpegDimensions(file) {
  const handle = await fs.open(file, 'r');
  try {
    // 通常只读取 64 KiB；遇到较大的 EXIF 再检查前 1 MiB。
    async function inspect(limit) {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('不是 JPEG');
      let offset = 2;
      while (offset + 4 <= bytesRead) {
        if (buffer[offset++] !== 0xff) throw new Error('JPEG 标记无效');
        while (offset < bytesRead && buffer[offset] === 0xff) offset++;
        const marker = buffer[offset++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytesRead) break;
        const size = buffer.readUInt16BE(offset);
        if (size < 2 || offset + size > bytesRead) break;
        if (
          [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
            marker,
          )
        ) {
          if (size < 7) break;
          return {
            height: buffer.readUInt16BE(offset + 3),
            width: buffer.readUInt16BE(offset + 5),
          };
        }
        offset += size;
      }
      return null;
    }
    const result = (await inspect(64 * 1024)) || (await inspect(1024 * 1024));
    if (!result) throw new Error('找不到 JPEG 尺寸');
    return result;
  } finally {
    await handle.close();
  }
}

async function mapLimited(items, limit, fn) {
  let cursor = 0;
  let failed = false;
  let failure;
  const result = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && cursor < items.length) {
        const index = cursor++;
        try {
          result[index] = await fn(items[index]);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }),
  );
  if (failed) throw failure;
  return result;
}

async function regularBytes(file, label) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
    throw new Error(`${label}不是可读取的配套文件。`);
  return fs.readFile(file);
}

function validateImageLength(length, name) {
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_IMAGE_BYTES)
    throw new Error(`${name}：照片为空或超过 128 MiB，不能合并。`);
}

async function inspectFolder(folder) {
  const root = await fs.realpath(folder);
  const label = path.basename(root);
  const picture = path.join(root, 'Camera4', 'Picture');
  const imageDir = path.join(picture, 'PictureData');
  const entries = await fs.readdir(imageDir, { withFileTypes: true });
  const jpgs = entries
    .filter((entry) => /\.jpg$/i.test(entry.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!jpgs.length || jpgs.length > MAX_IMAGES)
    throw new Error(`${label}：照片数量为空或超过限制。`);
  if (
    jpgs.some(
      (entry) =>
        !entry.isFile() ||
        !FRAME_NAME.test(entry.name) ||
        !Number.isFinite(Number(entry.name.slice(0, -4))),
    )
  )
    throw new Error(`${label}：照片必须以时间戳命名，扩展名须为小写 .jpg。`);
  const images = await mapLimited(jpgs, 12, async (entry) => {
    const file = path.join(imageDir, entry.name);
    const stat = await fs.stat(file);
    validateImageLength(stat.size, entry.name);
    let dimensions;
    try {
      dimensions = await jpegDimensions(file);
    } catch {
      throw new Error(`${label}：照片损坏或无法识别尺寸：${entry.name}。`);
    }
    if (dimensions.width !== 5760 || dimensions.height !== 2880)
      throw new Error(`${label}：${entry.name} 不是软件要求的 5760×2880 全景图。`);
    return { source: file, name: entry.name, length: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
  });
  const names = new Set(images.map((image) => image.name.toLowerCase()));
  if (names.size !== images.length) throw new Error(`${label}：照片名重复。`);
  const [poseBytes, metaBytes, xmlBytes, crdBytes, cameraBytes] = await Promise.all([
    regularBytes(path.join(root, 'imgPosList.txt'), 'imgPosList.txt'),
    regularBytes(path.join(picture, 'Metashape.txt'), 'Metashape.txt'),
    regularBytes(path.join(root, 'Block_1.xml'), 'Block_1.xml'),
    regularBytes(path.join(root, 'PointCloud.crd'), 'PointCloud.crd'),
    regularBytes(path.join(picture, 'Camera4Param.txt'), 'Camera4Param.txt'),
  ]);
  const definition = xmlBytes.toString('utf8').match(/<Definition>\s*([\s\S]*?)\s*<\/Definition>/);
  if (!definition) throw new Error(`${label}：找不到投影定义，不能核验坐标系。`);
  return {
    root,
    label,
    images,
    pose: poseRows(poseBytes.toString('utf8'), label),
    meta: metaRows(metaBytes.toString('utf8'), names, label),
    projection: definition[1].replace(/\s+/g, ' ').trim(),
    crd: crdSignature(crdBytes),
    camera: digest(cameraBytes),
    evidence: [poseBytes, metaBytes, xmlBytes, crdBytes, cameraBytes].map(digest),
  };
}

async function inspectTrees(directory, meta) {
  if (!directory) return null;
  const root = await fs.realpath(directory);
  let treeFile = path.join(root, 'tree_centers2.txt');
  try {
    await fs.access(treeFile);
  } catch {
    treeFile = path.join(root, 'tree_centers.txt');
  }
  const bytes = await regularBytes(treeFile, '树心文件');
  const rows = [];
  const ids = new Set();
  const treeLines = linesOf(bytes.toString('utf8')).filter((line) => line.trim());
  if (treeLines.length && /^id\b/i.test(treeLines[0].trim())) treeLines.shift();
  for (const line of treeLines) {
    if (!line.trim()) continue;
    const p = line.trim().split(/\s+/);
    if (
      p.length < 5 ||
      !/^\d+$/.test(p[0]) ||
      p.slice(1, 5).some((v) => !Number.isFinite(Number(v)))
    )
      throw new Error('树心文件包含无效记录。');
    if (ids.has(p[0])) throw new Error(`树心编号重复：${p[0]}。`);
    ids.add(p[0]);
    rows.push({ x: Number(p[1]), y: Number(p[2]) });
  }
  if (!rows.length) throw new Error('树心文件没有有效树木。');
  let near = 0;
  for (const tree of rows) {
    if (meta.some((frame) => Math.hypot(tree.x - frame.x, tree.y - frame.y) <= 100)) near++;
  }
  if (!near) throw new Error('树心与相机坐标相距超过 100 米，不能确认属于同一坐标系。');
  const optional = [];
  for (const name of ['crown.csv', 'trunk.csv']) {
    const file = path.join(root, name);
    try {
      const data = await regularBytes(file, name);
      const records = linesOf(data.toString('utf8')).filter((line) => line.trim());
      if (records.length && /^id\s*,/i.test(records[0].trim())) records.shift();
      if (records.some((line) => !ids.has(line.split(',')[0].trim())))
        throw new Error(`${name} 含不在树心文件里的编号。`);
      optional.push({ name, bytes: data });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { root, name: path.basename(treeFile), bytes, optional, count: rows.length, nearby: near };
}

module.exports = {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  POSE_HEADER,
  META_HEADER,
  digest,
  crdSignature,
  inspectFolder,
  inspectTrees,
  mapLimited,
  validateImageLength,
};
