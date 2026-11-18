'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 目录版运行会在自身 runtime 写日志和回放，不能用真实发布目录做冒烟测试。
function assertIsolatedUnpackedExecutable(executable, tempRoot = os.tmpdir()) {
  const directory = path.dirname(path.resolve(executable));
  if (path.basename(directory).toLowerCase() === 'win-unpacked')
    throw new Error('不应直接运行 win-unpacked 候选；请复制到隔离目录后测试。');

  const resources = path.join(directory, 'resources');
  if (!fs.existsSync(path.join(resources, 'app.asar'))) return false;
  const relative = path.relative(fs.realpathSync(tempRoot), fs.realpathSync(directory));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('目录版测试必须使用系统临时目录内的隔离副本。');
  if (fs.lstatSync(executable).isSymbolicLink() || fs.lstatSync(resources).isSymbolicLink())
    throw new Error('目录版测试拒绝符号链接。');

  const runtime = path.join(resources, 'runtime');
  if (!fs.existsSync(runtime) || fs.lstatSync(runtime).isSymbolicLink())
    throw new Error('目录版测试需要无链接的隔离运行时目录。');
  for (const name of ['outputs', 'error.log', 'TreeExtractor.ini', 'manual_marks.csv']) {
    if (fs.existsSync(path.join(runtime, name)))
      throw new Error('隔离副本包含已有日志、输出或配置，不能用于测试。');
  }
  return true;
}

module.exports = { assertIsolatedUnpackedExecutable };
