'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { BridgeClient } = require('../src/backend');
const { JsonLineDecoder } = require('../src/json-line-decoder');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdin = new Writable({
      write: (chunk, encoding, done) => {
        this.writes.push(chunk.toString());
        done();
      },
    });
  }

  kill() {
    this.killed = true;
    this.signalCode = 'SIGTERM';
    this.emit('close', null, this.signalCode);
    return true;
  }
}

function createClient(options = {}) {
  const child = new FakeChild();
  const client = new BridgeClient('fake/bridge.exe', {
    spawnProcess: () => child,
    ...options,
  });
  return { child, client };
}

test('JSON 行解码器处理分块、合并、空行和超长输入', () => {
  const lines = [];
  let overflow = 0;
  const decoder = new JsonLineDecoder({
    onLine: (line) => lines.push(line),
    onOverflow: () => overflow++,
    maxLineChars: 8,
  });
  decoder.push('a');
  decoder.push('b\n \nxy\n');
  assert.deepEqual(lines, ['ab', 'xy']);
  decoder.push('123456789');
  decoder.push('ignored\n');
  assert.equal(overflow, 1);
  assert.deepEqual(lines, ['ab', 'xy']);
});

test('桥接客户端按 ID 关联分块响应，不依赖到达顺序', async () => {
  const { child, client } = createClient();
  const first = client.call('first', { value: 1 });
  const second = client.call('second');
  assert.equal(JSON.parse(child.writes[0]).id, 1);
  assert.equal(JSON.parse(child.writes[1]).id, 2);
  child.stdout.write('{"id":2,"ok":true,"result":"');
  child.stdout.write('second"}\n{"id":1,"ok":true,"result":"first"}\n');
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.equal(client.pending.size, 0);
  client.close();
});

test('超时不等于取消，迟到响应不会误交给后续请求', async () => {
  const { child, client } = createClient();
  await assert.rejects(client.call('slow', {}, 15), /后台可能仍在执行/);
  const next = client.call('next');
  child.stdout.write('{"id":1,"ok":true,"result":"late"}\n');
  child.stdout.write('{"id":2,"ok":true,"result":"current"}\n');
  assert.equal(await next, 'current');
  assert.equal(child.killed, false);
  client.close();
});

test('错误协议或过大响应终止会话并拒绝全部未完成请求', async () => {
  for (const input of ['not-json\n', '{"id":"bad","ok":true}\n', 'x'.repeat(65)]) {
    const { child, client } = createClient({ maxLineChars: 64 });
    const requests = Promise.allSettled([client.call('one'), client.call('two')]);
    child.stdout.write(input);
    const results = await requests;
    assert.ok(results.every((result) => result.status === 'rejected'));
    assert.equal(child.killed, true);
    assert.equal(client.pending.size, 0);
    await assert.rejects(client.call('later'), /协议|JSON|响应/);
  }
});

test('管道异常、关闭和不可序列化参数不会留下悬挂请求', async () => {
  const { child, client } = createClient();
  const circular = {};
  circular.self = circular;
  await assert.rejects(client.call('bad', circular), /无法序列化/);
  assert.equal(client.pending.size, 0);
  const request = assert.rejects(client.call('pending'), /broken pipe/);
  child.stdin.emit('error', new Error('broken pipe'));
  await request;
  await assert.rejects(client.call('later'), /broken pipe/);
  client.close();
  client.close();
});

test('等待 stdout 排空后再处理 close，保留进程退出前的最后响应', async () => {
  const { child, client } = createClient();
  const request = client.call('last');
  child.emit('exit', 0, null);
  child.stdout.write('{"id":1,"ok":true,"result":"done"}\n');
  child.emit('close', 0, null);
  assert.equal(await request, 'done');
  await assert.rejects(client.call('later'), /已退出/);
});
