'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { candidate } = require('./species-cloud');
const { scopeOf, sameScope } = require('./species-scope');

function identity(snapshot) {
  const scope = scopeOf(snapshot);
  const normalized = path.resolve(scope.dataDir).toLowerCase();
  const dataset = crypto
    .createHash('sha256')
    .update(normalized)
    .update('\0')
    .update(scope.datasetFingerprint)
    .digest('hex');
  return {
    dataset,
    datasetFingerprint: scope.datasetFingerprint,
    treeId: scope.treeId,
    treeIndex: scope.treeIndex,
  };
}

async function ensureStore(directory) {
  await fs.mkdir(directory, { recursive: true });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('确认记录目录不可用。');
}

function targetPath(directory, id) {
  return path.join(directory, `${id.dataset}-${id.treeIndex}-${id.treeId}.json`);
}

function validRecord(record, id) {
  if (
    !record ||
    typeof record !== 'object' ||
    Object.keys(record).sort().join(',') !==
      [
        'schema',
        'dataset',
        'datasetFingerprint',
        'treeId',
        'treeIndex',
        'imageSha256',
        'frame',
        'choice',
        'confirmedAt',
        'confirmedBy',
      ]
        .sort()
        .join(',') ||
    record.schema !== 2 ||
    record.dataset !== id.dataset ||
    record.datasetFingerprint !== id.datasetFingerprint ||
    record.treeId !== id.treeId ||
    record.treeIndex !== id.treeIndex ||
    !/^[a-f0-9]{64}$/.test(record.imageSha256 || '') ||
    typeof record.frame !== 'string' ||
    record.frame.length > 180 ||
    record.confirmedBy !== 'human' ||
    typeof record.confirmedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.confirmedAt)) ||
    !record.choice ||
    Object.keys(record.choice).sort().join(',') !== 'name,value'
  )
    return false;
  const { value, name } = record.choice;
  if (value === '__uncertain__') return name === '不确定';
  if (value === '__other__')
    return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 80;
  const match = candidate(value);
  return Boolean(match && match.name === name);
}

function recordRevision(record) {
  return record ? crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex') : null;
}

async function readSpecies(directory, snapshot) {
  const id = identity(snapshot);
  const file = targetPath(directory, id);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
      throw new Error('确认记录文件不安全或过大。');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!validRecord(record, id)) throw new Error('确认记录格式或归属不正确。');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateSelection(snapshot, selection) {
  if (!sameScope(snapshot, selection?.scope))
    throw new Error('数据集、树木、帧或切图已变化，请重新核查后确认。');
  let choice;
  if (selection.value === '__uncertain__') choice = { value: '__uncertain__', name: '不确定' };
  else if (selection.value === '__other__') {
    const name = typeof selection.otherName === 'string' ? selection.otherName.trim() : '';
    if (!name || name.length > 80) throw new Error('请输入不超过 80 字的列表外名称。');
    choice = { value: '__other__', name };
  } else {
    choice = candidate(selection.value);
    if (!choice) throw new Error('请选择目录中的树种、不确定或列表外。');
  }
  return choice;
}

async function saveSpecies(directory, snapshot, selection, { expectedRevision } = {}) {
  const id = identity(snapshot);
  const choice = validateSelection(snapshot, selection);
  await ensureStore(directory);
  const file = targetPath(directory, id);
  const lock = `${file}.lock`;
  let lockHandle;
  let temporary;
  let backupPath = null;
  try {
    try {
      lockHandle = await fs.open(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(`该树确认记录已锁定：${lock}。请确认其他实例已关闭后检查遗留锁。`);
      throw error;
    }
    await lockHandle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      'utf8',
    );
    await lockHandle.sync();
    // 对不属于本程序或损坏的旧文件拒绝覆盖。
    const previous = await readSpecies(directory, snapshot);
    if (expectedRevision !== undefined && recordRevision(previous) !== expectedRevision)
      throw new Error('人工确认记录已被其他实例修改，请重新检查后再保存。');
    if (previous) {
      backupPath = `${file}.${Date.now()}-${crypto.randomUUID()}.backup.json`;
      const bytes = await fs.readFile(file);
      const backup = await fs.open(backupPath, 'wx', 0o600);
      try {
        await backup.writeFile(bytes);
        await backup.sync();
      } finally {
        await backup.close();
      }
    }
    const record = {
      schema: 2,
      ...id,
      imageSha256: snapshot.imageSha256,
      frame: String(snapshot.frame || '').slice(0, 180),
      choice,
      confirmedAt: new Date().toISOString(),
      confirmedBy: 'human',
    };
    temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const output = await fs.open(temporary, 'wx', 0o600);
    try {
      await output.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await output.sync();
    } finally {
      await output.close();
    }
    await fs.rename(temporary, file);
    temporary = null;
    return { record, path: file, backupPath };
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    if (lockHandle) {
      await lockHandle.close();
      await fs.unlink(lock).catch(() => {});
    }
  }
}

module.exports = { identity, readSpecies, saveSpecies, validateSelection, recordRevision };
