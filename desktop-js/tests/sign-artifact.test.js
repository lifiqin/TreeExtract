'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { removeTemporary } = require('./test-runtime');

const script = path.resolve(__dirname, '../scripts/sign-artifact.ps1');

test('发布签名预检失败时不得修改或替换原始制品', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract signing test '));
  try {
    const artifact = path.join(temporary, 'candidate.exe');
    const tool = path.join(temporary, 'signtool.exe');
    fs.writeFileSync(artifact, 'unsigned test artifact');
    fs.writeFileSync(tool, 'not an executable');
    const expectedHash = crypto.createHash('sha256').update('unsigned test artifact').digest('hex');
    const run = (thumbprint, timestamp, hash = expectedHash) =>
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Artifact',
          artifact,
          '-ExpectedSha256',
          hash,
          '-CertificateThumbprint',
          thumbprint,
          '-TimestampUrl',
          timestamp,
          '-SignTool',
          tool,
        ],
        { encoding: 'utf8', timeout: 30000 },
      );
    const checks = [
      ['bad-thumbprint', 'https://example.invalid/', expectedHash, /CertificateThumbprint/],
      ['0'.repeat(40), 'http://example.invalid/', expectedHash, /TimestampUrl/],
      ['0'.repeat(40), 'https://example.invalid/', 'invalid', /ExpectedSha256/],
      ['0'.repeat(40), 'https://example.invalid/', expectedHash, /valid trusted Microsoft/],
    ];
    for (const [thumbprint, timestamp, hash, expectedError] of checks) {
      const result = run(thumbprint, timestamp, hash);
      assert.notEqual(result.status, 0, '无效证书或时间戳服务不得获得发布签名');
      assert.match(result.stderr, expectedError);
      assert.equal(fs.readFileSync(artifact, 'utf8'), 'unsigned test artifact');
      assert.deepEqual(fs.readdirSync(temporary).sort(), ['candidate.exe', 'signtool.exe']);
    }
  } finally {
    removeTemporary(temporary, 'treeextract signing test ');
  }
});
