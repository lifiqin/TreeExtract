'use strict';

const path = require('node:path');
const fields = ['dataDir', 'datasetFingerprint', 'treeId', 'treeIndex', 'frame', 'imageSha256'];

function scopeOf(snapshot) {
  if (
    !snapshot ||
    typeof snapshot.dataDir !== 'string' ||
    !path.isAbsolute(snapshot.dataDir) ||
    !/^[a-f0-9]{64}$/.test(snapshot.datasetFingerprint || '') ||
    !Number.isSafeInteger(snapshot.treeId) ||
    !Number.isSafeInteger(snapshot.treeIndex) ||
    snapshot.treeIndex < 1 ||
    typeof snapshot.frame !== 'string' ||
    !/^[a-f0-9]{64}$/.test(snapshot.imageSha256 || '')
  )
    throw new Error('当前数据集、树木或切图信息无效。');
  return Object.fromEntries(fields.map((field) => [field, snapshot[field]]));
}

function sameScope(snapshot, expected) {
  if (!expected || typeof expected !== 'object') return false;
  const actual = scopeOf(snapshot);
  return fields.every((field) => actual[field] === expected[field]);
}

module.exports = { scopeOf, sameScope };
