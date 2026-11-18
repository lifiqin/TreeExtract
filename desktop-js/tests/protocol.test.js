'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { copyRuntime, removeTemporary } = require('./test-runtime');

class ProtocolClient {
  constructor(executable, temporary) {
    const env = { ...process.env, TEMP: temporary, TMP: temporary };
    delete env.TREEEXTRACT_DATA_DIR;
    delete env.TREEEXTRACT_ZIP;
    this.pending = [];
    this.buffer = '';
    this.stderr = '';
    this.failure = null;
    this.child = spawn(executable, [], {
      cwd: path.dirname(executable),
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.closed = new Promise((resolve) => {
      this.child.once('close', (code, signal) => resolve({ code, signal }));
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('data', (chunk) => this.receive(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-16000);
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => {
      if (this.pending.length) this.fail(new Error(`后端提前退出（${code}）：${this.stderr}`));
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const request = this.pending.shift();
      if (!request) {
        this.fail(new Error(`收到多余的标准输出：${line.slice(0, 200)}`));
        continue;
      }
      clearTimeout(request.timer);
      try {
        request.resolve(JSON.parse(line));
      } catch (error) {
        request.reject(new Error(`后端输出不是 JSON：${line.slice(0, 200)}；${error.message}`));
      }
    }
  }

  fail(error) {
    this.failure = this.failure || error;
    for (const request of this.pending.splice(0)) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  send(line) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const request = { resolve, reject };
      request.timer = setTimeout(() => {
        this.fail(new Error(`协议响应超时：${line.slice(0, 200)}；${this.stderr}`));
        this.child.kill();
      }, 30000);
      this.pending.push(request);
      this.child.stdin.write(`${line}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 10000);
    const result = await this.closed;
    clearTimeout(timer);
    if (this.failure) throw this.failure;
    assert.equal(result.code, 0, `后端退出异常：${result.signal || result.code}；${this.stderr}`);
  }
}

test(
  'backend JSON protocol validates inputs and stays responsive',
  { timeout: 90000 },
  async (t) => {
    const configured = process.env.TREEEXTRACT_TEST_BRIDGE;
    const executable = configured
      ? path.resolve(configured)
      : path.resolve(__dirname, '..', 'runtime', 'TreeExtractorBridge.exe');
    if (!fs.existsSync(executable)) {
      if (configured) assert.fail(`指定的桥接程序不存在：${executable}`);
      t.skip('Build the backend bridge before running this test.');
      return;
    }

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract protocol '));
    let client;
    try {
      const isolatedExe = copyRuntime(executable, temporary, { includeModel: false });
      client = new ProtocolClient(isolatedExe, temporary);

      let response = await client.send(JSON.stringify({ id: '树/🙂', method: 'defaults' }));
      assert.equal(response.id, '树/🙂');
      assert.equal(response.ok, true);
      assert.ok(response.result.modelPath);

      response = await client.send('{');
      assert.equal(response.id, null);
      assert.equal(response.ok, false);
      assert.ok(response.error);
      response = await client.send('{"id":4}');
      assert.equal(response.ok, false);
      assert.ok(response.error);

      response = await client.send('{"id":3,"method":"view.options","params":{"cal":1e400}}');
      // 超出数值范围的 JSON 可在提取请求 ID 之前被解析器拒绝。
      assert.ok(response.id === 3 || response.id === null);
      assert.equal(response.ok, false);
      assert.ok(response.error);
      response = await client.send('{"id":4,"method":"view.options","params":{"cal":"NaN"}}');
      assert.equal(response.id, 4);
      assert.equal(response.ok, false);
      assert.ok(response.error);

      response = await client.send(
        '{"id":5,"method":"view.options","params":{"cal":2.25,"dualFrame":false}}',
      );
      assert.equal(response.ok, true);
      assert.equal(response.result.cal, 2.25);
      assert.equal(response.result.dualFrame, false);
      response = await client.send('{"id":6,"method":"view.options","params":{"cropWidth":-1}}');
      assert.equal(response.ok, false);
      assert.ok(response.error);
      response = await client.send('{"id":7,"method":"state"}');
      assert.equal(response.ok, true);
      assert.equal(response.result.cal, 2.25);

      response = await client.send('{"id":8,"method":"images"}');
      assert.equal(response.ok, true);
      for (const key of ['panorama', 'photo', 'crop', 'heat'])
        assert.equal(response.result[key], null);

      const replies = await Promise.all(
        [9, 10, 11].map((id) => client.send(JSON.stringify({ id, method: 'state' }))),
      );
      assert.deepEqual(
        replies.map((item) => item.id),
        [9, 10, 11],
      );
      assert.ok(replies.every((item) => item.ok));
      await client.close();
      client = null;
    } finally {
      if (client) await client.close().catch(() => {});
      removeTemporary(temporary, 'treeextract protocol ');
    }
  },
);
