'use strict';

// 合并的是采集目录中的全景和位姿，不合并 LAS/点云工程本身。
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FOLDERS = 16;
const {
  MAX_IMAGES,
  POSE_HEADER,
  META_HEADER,
  digest,
  crdSignature,
  inspectFolder,
  inspectTrees,
} = require('./capture-reader');

function explainFileError(error) {
  if (error?.code === 'ENOENT') return `缺少必要的文件或目录：${error.path || '请检查数据结构'}。`;
  if (error?.code === 'EACCES' || error?.code === 'EPERM')
    return '没有读取数据的权限，请检查文件或文件夹权限。';
  return error?.message || '读取数据失败。';
}

function countUncoveredImages({ images, pose }) {
  let uncovered = 0;
  for (const image of images) {
    const time = Number(image.name.slice(0, -4));
    let lo = 0;
    let hi = pose.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (pose[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    const before = lo > 0 ? Math.abs(pose[lo - 1].time - time) : Infinity;
    const after = lo < pose.length ? Math.abs(pose[lo].time - time) : Infinity;
    if (Math.min(before, after) > 2) uncovered++;
  }
  return uncovered;
}

async function analyzeFolders(folders, treeDirectory = '') {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(folders) || folders.length < 2 || folders.length > MAX_FOLDERS)
    return { ok: false, errors: ['请选择 2 至 16 个原始采集文件夹。'], warnings, folders: [] };
  const inspected = [];
  for (const folder of folders) {
    try {
      inspected.push(await inspectFolder(folder));
    } catch (error) {
      errors.push(`${path.basename(String(folder))}：${explainFileError(error)}`);
    }
  }
  if (new Set(inspected.map((item) => item.root.toLowerCase())).size !== inspected.length)
    errors.push('不能重复选择同一个文件夹。');
  if (inspected.length > 1) {
    for (const item of inspected.slice(1)) {
      if (item.projection !== inspected[0].projection || item.crd !== inspected[0].crd)
        errors.push(`${item.label}：投影或坐标校正参数与其他目录不同，无法安全合并。`);
      if (item.camera !== inspected[0].camera)
        errors.push(`${item.label}：相机参数与其他目录不同。`);
    }
  }
  const images = inspected.flatMap((item) => item.images);
  const names = new Set();
  for (const image of images) {
    const key = image.name.toLowerCase();
    if (names.has(key)) errors.push(`照片名冲突：${image.name}；不会覆盖或猜测去重。`);
    names.add(key);
  }
  const meta = inspected.flatMap((item) => item.meta).sort((a, b) => a.time - b.time);
  const poses = inspected.flatMap((item) => item.pose).sort((a, b) => a.time - b.time);
  for (let i = 1; i < poses.length; i++) {
    if (poses[i].time === poses[i - 1].time && poses[i].line !== poses[i - 1].line) {
      errors.push('两个目录包含相同时间但内容不同的位姿，无法确定采用哪一条。');
      break;
    }
  }
  const uniquePoses = poses.filter((row, index) => !index || row.time !== poses[index - 1].time);
  if (images.length > MAX_IMAGES) errors.push(`照片总数超过 ${MAX_IMAGES} 张。`);
  let trees = null;
  if (treeDirectory && meta.length) {
    try {
      trees = await inspectTrees(treeDirectory, meta);
    } catch (error) {
      errors.push(`树心数据：${explainFileError(error)}`);
    }
  }
  const missing = images.length - meta.length;
  if (missing > 0)
    warnings.push(
      `${missing} 张照片缺少原始 Metashape 位姿，将保留照片，但不能使用这些照片进行完整位姿定位。`,
    );
  if (!treeDirectory)
    warnings.push('未选择已配准的树心数据：可合并照片和位姿，但输出不能直接加载树列表。');
  if (trees && trees.nearby < trees.count)
    warnings.push(`${trees.count - trees.nearby} 棵树距离全部相机超过 100 米，请检查树心范围。`);
  for (const item of inspected) {
    const uncovered = countUncoveredImages(item);
    if (uncovered)
      warnings.push(
        `${item.label}：${uncovered} 张照片附近 2 秒内没有第一路 IMU 记录，方向回退可能不可靠。`,
      );
  }
  warnings.push(
    '坐标参数一致和空间接近不代表点云相同或已经精确配准；原始 OPK 角度约定也需人工核对。',
  );
  warnings.push('照片只检查 JPEG 文件头和尺寸，不代表每张照片都已完整解码。');
  if (trees) warnings.push('不会复制旧的人工校正；新数据请重新核对并保存校正。');
  const summary = inspected.map((item) => ({
    path: item.root,
    images: item.images.length,
    poses: item.meta.length,
  }));
  const fingerprint = digest(
    Buffer.from(
      JSON.stringify({
        folders: inspected.map((item) => ({
          root: item.root,
          evidence: item.evidence,
          images: item.images,
        })),
        tree: trees && {
          root: trees.root,
          name: trees.name,
          bytes: digest(trees.bytes),
          optional: trees.optional.map((v) => [v.name, digest(v.bytes)]),
        },
      }),
    ),
  );
  return {
    ok: !errors.length && inspected.length === folders.length,
    errors,
    warnings,
    folders: summary,
    imageCount: images.length,
    metaCount: meta.length,
    poseCount: uniquePoses.length,
    totalBytes: images.reduce((sum, image) => sum + image.length, 0),
    treeCount: trees?.count || 0,
    plan: {
      folders: inspected.map((item) => item.root),
      treeDirectory: trees?.root || '',
      images,
      meta,
      poses: uniquePoses,
      trees,
      fingerprint,
    },
  };
}

function publicAnalysis(result) {
  const { plan, ...summary } = result;
  return summary;
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function createMergedDataset(analysis, destination, writeArchive) {
  if (!analysis?.ok || !analysis.plan) throw new Error('请先完成兼容性分析。');
  const fresh = await analyzeFolders(analysis.plan.folders, analysis.plan.treeDirectory);
  if (!fresh.ok || fresh.plan.fingerprint !== analysis.plan.fingerprint)
    throw new Error('源文件在分析后发生变化，请重新分析。');
  const parent = await fs.realpath(destination);
  if (
    fresh.plan.folders.some((source) => isWithin(parent, source)) ||
    (fresh.plan.trees && isWithin(parent, fresh.plan.trees.root))
  )
    throw new Error('输出位置不能位于采集目录或树心目录内部，请选择其他文件夹。');
  const free = await fs.statfs(parent).catch(() => null);
  if (free && Number(free.bavail) * Number(free.bsize) < fresh.totalBytes + 64 * 1024 * 1024)
    throw new Error('目标磁盘可用空间不足，至少需要照片总大小加 64 MiB。');
  const tag = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const stage = path.join(parent, `TreeExtract_merge_${tag}_incomplete`);
  const final = path.join(parent, `TreeExtract_merge_${tag}`);
  await fs.mkdir(stage);
  // 每个配套文件只允许首次创建；任何失败都保留暂存目录供排查。
  const writeNewFile = (name, bytes) => fs.writeFile(path.join(stage, name), bytes, { flag: 'wx' });
  try {
    await writeArchive(path.join(stage, 'Camera4.zip'), fresh.plan.images);
    for (const [name, header, rows] of [
      ['Metashape.txt', META_HEADER, fresh.plan.meta],
      ['imgPosList.txt', POSE_HEADER, fresh.plan.poses],
    ])
      await writeNewFile(name, header + '\n' + rows.map((row) => row.line).join('\n') + '\n');
    if (fresh.plan.trees) {
      for (const file of [fresh.plan.trees, ...fresh.plan.trees.optional])
        await writeNewFile(file.name, file.bytes);
    }
    const report = {
      version: 1,
      createdAt: new Date().toISOString(),
      inputs: fresh.folders,
      treeDirectory: fresh.plan.treeDirectory || null,
      imageCount: fresh.imageCount,
      metaCount: fresh.metaCount,
      poseCount: fresh.poseCount,
      treeCount: fresh.treeCount,
      warnings: fresh.warnings,
    };
    await writeNewFile('merge-report.json', JSON.stringify(report, null, 2) + '\n');
    await fs.rename(stage, final);
    return {
      directory: final,
      imageCount: fresh.imageCount,
      metaCount: fresh.metaCount,
      treeCount: fresh.treeCount,
      warnings: fresh.warnings,
      loadable: Boolean(fresh.plan.trees),
    };
  } catch (error) {
    throw new Error(`合并未完成。未覆盖原文件，未完成目录保留在：${stage}。原因：${error.message}`);
  }
}

module.exports = { analyzeFolders, createMergedDataset, publicAnalysis, crdSignature };
