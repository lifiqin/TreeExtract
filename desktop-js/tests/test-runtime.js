'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 测试只复制程序和模型，不复制用户配置、数据、标注或运行日志。
function copyRuntime(executable, destination, { includeModel = true } = {}) {
  const source = path.dirname(executable);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (
      entry.isFile() &&
      (entry.name === path.basename(executable) ||
        /\.dll$/i.test(entry.name) ||
        /^TreeExtractorBridge\.(deps|runtimeconfig)\.json$/i.test(entry.name))
    ) {
      fs.copyFileSync(from, to);
    } else if (entry.isDirectory() && entry.name === 'runtimes') {
      fs.cpSync(from, to, { recursive: true });
    }
  }
  if (includeModel) {
    for (const name of ['tree_cls.onnx', 'person_head.onnx', 'PERSON_HEAD_LICENSE.txt']) {
      const model = path.join(source, 'models', name);
      if (fs.existsSync(model)) {
        fs.mkdirSync(path.join(destination, 'models'), { recursive: true });
        fs.copyFileSync(model, path.join(destination, 'models', name));
      }
    }
  }
  return path.join(destination, path.basename(executable));
}

function removeTemporary(directory, prefix) {
  const root = fs.realpathSync(os.tmpdir());
  const target = fs.realpathSync(directory);
  if (target.startsWith(root + path.sep) && path.basename(target).startsWith(prefix)) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } else {
    throw new Error(`拒绝删除非测试临时目录：${target}`);
  }
}

module.exports = { copyRuntime, removeTemporary };
