'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { JsonLineDecoder } = require('./json-line-decoder');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_STDERR_CHARS = 8000;

// 每个请求与一个 JSON 行对应；所有 C# 图像操作由桥接进程串行执行。
class BridgeClient {
  constructor(executable, { spawnProcess = spawn, maxLineChars } = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.errorOutput = '';
    this.failure = null;
    this.closing = false;
    this.child = spawnProcess(executable, [], {
      cwd: path.dirname(executable),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.decoder = new JsonLineDecoder({
      maxLineChars,
      onLine: (line) => this.receiveLine(line),
      onOverflow: () => this.failProtocol('算法进程返回的数据超过协议大小限制。'),
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.decoder.push(chunk));
    this.child.stdout.on('error', (error) => this.fail(error));
    this.child.stderr.on('data', (chunk) => {
      this.errorOutput = (this.errorOutput + chunk).slice(-MAX_STDERR_CHARS);
    });
    this.child.stderr.on('error', (error) => this.fail(error));
    // 写入时进程可能已退出；监听 stdin 的 error 可避免未处理的 EPIPE 终止界面。
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    // close 发生在 stdout 排空之后，避免进程退出时丢掉最后一条合法响应。
    this.child.on('close', (code, signal) => {
      const suffix = signal ? `，信号 ${signal}` : '';
      this.fail(new Error(`算法进程已退出（${code}${suffix}）。${this.errorOutput}`));
    });
  }

  receiveLine(line) {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      this.failProtocol('算法进程返回了无效的 JSON，已停止当前会话。');
      return;
    }
    if (
      !reply ||
      typeof reply !== 'object' ||
      !Number.isSafeInteger(reply.id) ||
      typeof reply.ok !== 'boolean'
    ) {
      this.failProtocol('算法进程返回了不符合约定的响应，已停止当前会话。');
      return;
    }
    // 已超时请求的迟到响应可以安全丢弃，不能误交给其他请求。
    const request = this.pending.get(reply.id);
    if (!request) return;
    this.pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.ok) request.resolve(reply.result);
    else request.reject(new Error(reply.error || '算法操作失败。'));
  }

  call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing || !this.child.stdin.writable) {
      return Promise.reject(new Error('算法进程不可用。'));
    }
    const id = this.nextId++;
    let payload;
    try {
      payload = JSON.stringify({ id, method, params });
    } catch {
      return Promise.reject(new Error('算法请求包含无法序列化的参数。'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 后端按顺序执行；超时不等于取消，不能擅自杀进程并丢弃未保存校正。
        reject(new Error(`操作超时：${method}；后台可能仍在执行，请确认状态后重试。`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${payload}\n`, (error) => {
          if (error) this.fail(error);
        });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  failProtocol(message) {
    this.fail(new Error(message));
    // 协议流已无法可靠关联响应，终止本进程而不是继续使用错误状态。
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  fail(error) {
    this.failure = this.failure || error;
    this.decoder.stop();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.failure);
    }
    this.pending.clear();
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    if (this.child.stdin.writable) this.child.stdin.end();
  }
}

module.exports = { BridgeClient };
