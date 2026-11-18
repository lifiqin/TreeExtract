'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CloudCredentialStore } = require('../src/cloud-credentials');

function fakeStorage(key = crypto.randomBytes(32)) {
  return {
    async isAsyncEncryptionAvailable() {
      return true;
    },
    async encryptStringAsync(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    async decryptStringAsync(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return {
        result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
          'utf8',
        ),
        shouldReEncrypt: false,
      };
    },
  };
}

test('模拟安全存储：只保存密文，同一账户可在新实例中读取、更换和删除', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeextract-credentials-'));
  const storage = fakeStorage();
  const store = new CloudCredentialStore(directory, storage);
  const secret = 'test-only-placeholder-key';
  assert.equal((await store.status()).configured, false);
  await store.save(secret);
  assert.equal((await store.status()).configured, true);
  assert.equal(
    (await fs.readFile(path.join(directory, 'deepseek.dat'))).includes(Buffer.from(secret)),
    false,
  );
  assert.equal(await new CloudCredentialStore(directory, storage).read(), secret);
  const other = new CloudCredentialStore(directory, fakeStorage());
  assert.equal((await other.status()).damaged, true);
  await assert.rejects(other.read(), /无法解密/);
  await store.save('test-rotated-placeholder');
  assert.equal(await store.read(), 'test-rotated-placeholder');
  await store.clear();
  assert.equal((await store.status()).configured, false);
});

test('存储不可用、损坏文件及加密错误均不能泄露密钥或覆盖旧文件', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeextract-credentials-fail-'));
  const secret = 'test-secret-never-log';
  const unavailable = new CloudCredentialStore(directory, {
    isAsyncEncryptionAvailable: async () => false,
  });
  await assert.rejects(unavailable.save(secret), (error) => !error.message.includes(secret));
  const failing = new CloudCredentialStore(directory, {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async () => {
      throw new Error(secret);
    },
  });
  await assert.rejects(failing.save(secret), (error) => !error.message.includes(secret));
  await fs.writeFile(path.join(directory, 'deepseek.dat'), 'user-owned-invalid-file');
  const store = new CloudCredentialStore(directory, fakeStorage());
  assert.equal((await store.status()).damaged, true);
  await assert.rejects(store.save(secret));
  await assert.rejects(store.clear());
  assert.equal(
    await fs.readFile(path.join(directory, 'deepseek.dat'), 'utf8'),
    'user-owned-invalid-file',
  );
});
