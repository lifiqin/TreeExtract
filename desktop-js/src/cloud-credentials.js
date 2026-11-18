'use strict';

// 密钥仅以 Windows 用户账户保护的密文落盘；不把密钥返回界面或写入日志。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const HEADER = Buffer.from('TreeExtract.Credential.v1\0', 'ascii');
const MAX_FILE_BYTES = 32768;

class CloudCredentialStore {
  constructor(directory, storage) {
    this.directory = directory;
    this.storage = storage;
    this.file = path.join(directory, 'deepseek.dat');
    this.lock = path.join(directory, 'deepseek.lock');
  }

  async available() {
    try {
      return await this.storage.isAsyncEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async readEncrypted() {
    try {
      const dir = await fs.lstat(this.directory);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('不安全的密钥目录。');
      const info = await fs.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES)
        throw new Error('密钥文件不可用。');
      const bytes = await fs.readFile(this.file);
      if (bytes.length <= HEADER.length || !bytes.subarray(0, HEADER.length).equals(HEADER))
        throw new Error('密钥文件格式不正确，未覆盖原文件。');
      return bytes.subarray(HEADER.length);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async status() {
    const available = await this.available();
    try {
      const encrypted = await this.readEncrypted();
      if (encrypted && available) {
        const decrypted = await this.storage.decryptStringAsync(encrypted);
        if (
          !decrypted ||
          typeof decrypted.result !== 'string' ||
          !/^[\x21-\x7e]{1,512}$/.test(decrypted.result)
        )
          throw new Error('invalid');
      }
      return { available, configured: Boolean(encrypted), damaged: false };
    } catch {
      return { available, configured: false, damaged: true };
    }
  }

  async save(secret) {
    if (typeof secret !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(secret))
      throw new Error('请输入有效的 API 密钥。');
    if (!(await this.available())) throw new Error('Windows 安全存储不可用，未保存密钥。');
    let encrypted;
    try {
      encrypted = await this.storage.encryptStringAsync(secret);
    } catch {
      throw new Error('Windows 加密失败，未保存密钥。');
    }
    if (
      !Buffer.isBuffer(encrypted) ||
      encrypted.length === 0 ||
      encrypted.length > MAX_FILE_BYTES - HEADER.length
    )
      throw new Error('加密结果不可用，未保存密钥。');
    await fs.mkdir(this.directory, { recursive: true });
    const dir = await fs.lstat(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('不安全的密钥目录。');
    let lock;
    let temporary;
    try {
      lock = await fs.open(this.lock, 'wx', 0o600);
      await this.readEncrypted(); // 损坏或不属于本程序的文件不能被覆盖。
      temporary = path.join(this.directory, `deepseek.${crypto.randomUUID()}.tmp`);
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(Buffer.concat([HEADER, encrypted]));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, this.file);
      temporary = null;
      return { configured: true };
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      if (lock) {
        await lock.close();
        await fs.unlink(this.lock).catch(() => {});
      }
    }
  }

  async read() {
    if (!(await this.available())) throw new Error('Windows 安全存储不可用。');
    let encrypted;
    try {
      encrypted = await this.readEncrypted();
    } catch {
      throw new Error('密钥文件损坏或不可读取，请检查本机配置。');
    }
    if (!encrypted) throw new Error('尚未配置 DeepSeek API 密钥。');
    try {
      const result = await this.storage.decryptStringAsync(encrypted);
      if (
        !result ||
        typeof result.result !== 'string' ||
        !/^[\x21-\x7e]{1,512}$/.test(result.result)
      )
        throw new Error('invalid');
      return result.result;
    } catch {
      throw new Error('无法解密密钥，请在当前 Windows 账户重新配置。');
    }
  }

  async clear() {
    const existing = await this.readEncrypted();
    if (!existing) return { configured: false };
    let lock;
    try {
      lock = await fs.open(this.lock, 'wx', 0o600);
      await this.readEncrypted();
      await fs.unlink(this.file);
      return { configured: false };
    } finally {
      if (lock) {
        await lock.close();
        await fs.unlink(this.lock).catch(() => {});
      }
    }
  }
}

module.exports = { CloudCredentialStore };
