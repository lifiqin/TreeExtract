'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTemporary } = require('./test-runtime');
const {
  REQUIRED_FILES,
  SOURCE_GROUPS,
  createReleaseManifest,
  parseArguments,
} = require('../scripts/release-manifest');

const versions = () => ({
  node: '24.0.0',
  npm: '11.0.0',
  dotnetSdk: '10.0.404',
  platform: 'win32',
  arch: 'x64',
});

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'treeextract manifest test '));
  const root = path.join(temporary, 'workspace');
  fs.mkdirSync(root);
  function write(relative, content = 'synthetic test content') {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }
  for (const relative of REQUIRED_FILES) write(relative);
  for (const group of SOURCE_GROUPS) write(`${group.directory}/sample${group.extensions[0]}`);
  write('src/nested/nested.cs');
  write('tests/manual_marks.csv', 'private annotation');
  write('tests/error.log', 'private log');
  write('tests/fixtures/private.jpg', 'private image');
  write('tests/annotation/private-labels.json', 'private annotation');
  write('tests/annotation/private-image.jpg', 'private image');
  write('desktop-js/src/picture.jpg', 'private image');
  write('desktop-js/runtime/private.dll', 'private runtime');
  const deps = {
    electron: '1.0.0',
    'electron-builder': '2.0.0',
    playwright: '3.0.0',
    prettier: '4.0.0',
  };
  write('desktop-js/package.json', JSON.stringify({ devDependencies: deps }));
  const packages = Object.fromEntries(
    Object.entries(deps).map(([name, version]) => [`node_modules/${name}`, { version }]),
  );
  write('desktop-js/package-lock.json', JSON.stringify({ packages }));
  const executable = path.join(temporary, 'private-artifact-name.exe');
  fs.writeFileSync(executable, 'synthetic artifact');
  const output = path.join(temporary, 'manifest.json');
  const args = {
    workspaceRoot: root,
    executablePath: executable,
    outputPath: output,
    versionProvider: versions,
  };
  return { temporary, root, executable, output, args, write };
}

async function withFixture(run) {
  const value = fixture();
  try {
    return await run(value);
  } finally {
    removeTemporary(value.temporary, 'treeextract manifest test ');
  }
}

test('清单只含白名单相对路径、两个模型、锁文件及指定 EXE 内容摘要', async () => {
  await withFixture(async ({ root, executable, output, args }) => {
    const manifest = await createReleaseManifest(args);
    const stored = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.deepEqual(stored, manifest);
    assert.equal(manifest.schema, 'treeextract.local-release-inventory.v1');
    const names = manifest.files.map((file) => file.path);
    assert.deepEqual(names, [...names].sort());
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes('src/nested/nested.cs'));
    assert.ok(names.includes('models/tree_cls.onnx'));
    assert.ok(names.includes('models/person_head.onnx'));
    assert.ok(names.includes('tests/annotation/annotation-core.js'));
    assert.ok(names.includes('tests/annotation/app.js'));
    assert.ok(names.includes('tests/annotation/index.html'));
    assert.ok(names.includes('tests/annotation/pair.html'));
    assert.ok(names.includes('tests/annotation/pair.js'));
    assert.ok(names.includes('tests/annotation/styles.css'));
    assert.ok(names.includes('desktop-js/package-lock.json'));
    assert.ok(names.includes('desktop-js/src/species-catalog.json'));
    assert.ok(names.includes('_deps/ort/onnxruntime.dll'));
    assert.ok(!names.some((name) => /manual_marks|\.log$|private|\.jpg$|runtime\//i.test(name)));
    assert.ok(names.every((name) => !path.isAbsolute(name) && !name.includes('\\')));
    assert.equal(manifest.artifact.sizeBytes, fs.statSync(executable).size);
    assert.equal(
      manifest.artifact.sha256,
      crypto.createHash('sha256').update('synthetic artifact').digest('hex'),
    );
    assert.equal(manifest.artifact.role, 'windows-portable-exe');
    assert.equal(manifest.lockedToolVersions.electron, '1.0.0');
    assert.ok(!JSON.stringify(manifest).includes(root));
    assert.ok(!JSON.stringify(manifest).includes(executable));
    assert.ok(!JSON.stringify(manifest).includes('private-artifact-name'));
    assert.match(manifest.limitations.join(' '), /do not prove build provenance/);
    assert.match(manifest.limitations.join(' '), /does not verify code signatures/);
  });
});

test('盲标与双帧复核工具的必需源码缺失即失败，替换会改变其摘要', async () => {
  const required = [
    'tests/annotation/annotation-core.js',
    'tests/annotation/app.js',
    'tests/annotation/index.html',
    'tests/annotation/pair.html',
    'tests/annotation/pair.js',
    'tests/annotation/styles.css',
  ];
  for (const name of required) {
    await withFixture(async ({ root, output, args }) => {
      fs.unlinkSync(path.join(root, ...name.split('/')));
      await assert.rejects(createReleaseManifest(args));
      assert.equal(fs.existsSync(output), false);
    });
  }
  await withFixture(async ({ temporary, args, write }) => {
    const first = await createReleaseManifest(args);
    const changed = ['tests/annotation/pair.html', 'tests/annotation/pair.js'];
    for (const name of changed) write(name, 'replacement source');
    const secondOutput = path.join(temporary, 'manifest-replacement.json');
    const second = await createReleaseManifest({ ...args, outputPath: secondOutput });
    const hashFor = (manifest, name) => manifest.files.find((file) => file.path === name).sha256;
    for (const name of changed) {
      assert.notEqual(hashFor(first, name), hashFor(second, name));
      assert.equal(
        hashFor(second, name),
        crypto.createHash('sha256').update('replacement source').digest('hex'),
      );
    }
  });
});

test('任一必需模型或锁文件缺失时失败且不产生清单', async () => {
  await withFixture(async ({ root, output, args }) => {
    fs.unlinkSync(path.join(root, 'models', 'person_head.onnx'));
    await assert.rejects(createReleaseManifest(args));
    assert.equal(fs.existsSync(output), false);
  });
  await withFixture(async ({ root, output, args }) => {
    fs.unlinkSync(path.join(root, 'backend', 'packages.lock.json'));
    await assert.rejects(createReleaseManifest(args));
    assert.equal(fs.existsSync(output), false);
  });
});

test('既有输出永不覆盖', async () => {
  await withFixture(async ({ output, args }) => {
    fs.writeFileSync(output, 'existing output');
    await assert.rejects(createReleaseManifest(args), /already exists/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'existing output');
  });
});

test('白名单源目录中的目录链接被拒绝', async () => {
  await withFixture(async ({ root, output, args }) => {
    const target = path.join(root, 'tests');
    fs.symlinkSync(target, path.join(root, 'src', 'linked-dir'), 'junction');
    await assert.rejects(createReleaseManifest(args), /Symbolic link/);
    assert.equal(fs.existsSync(output), false);
  });
});

test('白名单文件符号链接被拒绝（系统允许创建时）', async (t) => {
  await withFixture(async ({ root, output, args }) => {
    const target = path.join(root, 'src', 'sample.cs');
    const link = path.join(root, 'src', 'linked.cs');
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      t.diagnostic(
        'File symlink creation is not permitted; directory junction was tested separately.',
      );
      return;
    }
    await assert.rejects(createReleaseManifest(args), /Symbolic link/);
    assert.equal(fs.existsSync(output), false);
  });
});

test('必须包含每个指定源码组，不能以空目录假装完整', async () => {
  await withFixture(async ({ root, output, args }) => {
    fs.unlinkSync(path.join(root, 'desktop-js', 'scripts', 'sample.js'));
    await assert.rejects(createReleaseManifest(args), /Source group is empty/);
    assert.equal(fs.existsSync(output), false);
  });
});

test('输出目录经由链接时拒绝写入', async () => {
  await withFixture(async ({ temporary, args }) => {
    const actual = path.join(temporary, 'actual-output');
    const alias = path.join(temporary, 'alias-output');
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, alias, 'junction');
    await assert.rejects(
      createReleaseManifest({ ...args, outputPath: path.join(alias, 'manifest.json') }),
      /Symbolic links or junctions/,
    );
    assert.deepEqual(fs.readdirSync(actual), []);
  });
});

test('指定 EXE 的路径经过目录链接时也被拒绝', async () => {
  await withFixture(async ({ temporary, executable, output, args }) => {
    const actual = path.join(temporary, 'actual-artifacts');
    const alias = path.join(temporary, 'alias-artifacts');
    fs.mkdirSync(actual);
    fs.copyFileSync(executable, path.join(actual, 'artifact.exe'));
    fs.symlinkSync(actual, alias, 'junction');
    await assert.rejects(
      createReleaseManifest({ ...args, executablePath: path.join(alias, 'artifact.exe') }),
      /Symbolic links or junctions/,
    );
    assert.equal(fs.existsSync(output), false);
  });
});

test('空或非 EXE 制品、损坏的锁文件均不得生成清单', async () => {
  await withFixture(async ({ executable, output, args }) => {
    fs.writeFileSync(executable, '');
    await assert.rejects(createReleaseManifest(args), /artifact is empty/);
    assert.equal(fs.existsSync(output), false);
  });
  await withFixture(async ({ temporary, output, args }) => {
    const nonExe = path.join(temporary, 'artifact.txt');
    fs.writeFileSync(nonExe, 'bytes');
    await assert.rejects(
      createReleaseManifest({ ...args, executablePath: nonExe }),
      /must be an EXE/,
    );
    assert.equal(fs.existsSync(output), false);
  });
  await withFixture(async ({ output, args, write }) => {
    write('desktop-js/package-lock.json', '{}');
    await assert.rejects(createReleaseManifest(args), /tool versions do not match/);
    assert.equal(fs.existsSync(output), false);
  });
});

test('版本字段只能包含版本，不得泄漏任意附加内容', async () => {
  await withFixture(async ({ output, args }) => {
    const withExtra = () => ({ ...versions(), privatePath: 'private-user-path' });
    const result = await createReleaseManifest({ ...args, versionProvider: withExtra });
    assert.equal(Object.hasOwn(result.toolVersions, 'privatePath'), false);
    assert.ok(!fs.readFileSync(output, 'utf8').includes('private-user-path'));
  });
  await withFixture(async ({ output, args }) => {
    const invalid = () => ({ ...versions(), npm: 'private-user-path' });
    await assert.rejects(
      createReleaseManifest({ ...args, versionProvider: invalid }),
      /Invalid local tool versions/,
    );
    assert.equal(fs.existsSync(output), false);
  });
});

test('锁文件中的伪造版本和非 JSON 输出都被拒绝', async () => {
  await withFixture(async ({ output, args, write }) => {
    const deps = {
      electron: 'private-user-path',
      'electron-builder': '2.0.0',
      playwright: '3.0.0',
      prettier: '4.0.0',
    };
    write('desktop-js/package.json', JSON.stringify({ devDependencies: deps }));
    const packages = Object.fromEntries(
      Object.entries(deps).map(([name, version]) => [`node_modules/${name}`, { version }]),
    );
    write('desktop-js/package-lock.json', JSON.stringify({ packages }));
    await assert.rejects(createReleaseManifest(args), /tool versions do not match/);
    assert.equal(fs.existsSync(output), false);
  });
  await withFixture(async ({ temporary, args }) => {
    const output = path.join(temporary, 'manifest.txt');
    await assert.rejects(
      createReleaseManifest({ ...args, outputPath: output }),
      /must be a JSON file/,
    );
    assert.equal(fs.existsSync(output), false);
  });
});

test('命令行参数必须显式指定制品和新输出，不能重复或混入未知参数', () => {
  assert.deepEqual(parseArguments(['--artifact', 'input.exe', '--output', 'out.json']), {
    executablePath: 'input.exe',
    outputPath: 'out.json',
  });
  for (const args of [
    [],
    ['--artifact', 'input.exe'],
    ['--artifact', '--output', '--output', 'out.json'],
    ['--artifact', 'a.exe', '--output', 'out.json', '--artifact', 'b.exe'],
    ['--artifact', 'a.exe', '--unknown', 'out.json'],
  ]) {
    assert.throws(() => parseArguments(args), /Usage/);
  }
});
