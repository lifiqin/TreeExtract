'use strict';

// A local inventory, not provenance, signing verification or an SBOM.
// Only the fixed source groups and required files below can enter the manifest.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REQUIRED_FILES = Object.freeze([
  'global.json',
  '.github/workflows/windows-ci.yml',
  'backend/TreeExtractor.Backend.csproj',
  'backend/Dependencies.props',
  'backend/packages.lock.json',
  'tests/TreeExtractor.Tests.csproj',
  'tests/packages.lock.json',
  'tests/annotation/annotation-core.js',
  'tests/annotation/app.js',
  'tests/annotation/index.html',
  'tests/annotation/pair.html',
  'tests/annotation/pair.js',
  'tests/annotation/styles.css',
  'desktop-js/package.json',
  'desktop-js/package-lock.json',
  'desktop-js/src/species-catalog.json',
  '_deps/ort/lib/netstandard2.0/Microsoft.ML.OnnxRuntime.dll',
  '_deps/ort/onnxruntime.dll',
  '_deps/ort/LICENSE.txt',
  'models/tree_cls.onnx',
  'models/person_head.onnx',
  'models/PERSON_HEAD_LICENSE.txt',
]);

const SOURCE_GROUPS = Object.freeze([
  { directory: 'src', extensions: ['.cs'], recursive: true },
  { directory: 'desktop-js/bridge', extensions: ['.cs'], recursive: true },
  { directory: 'desktop-js/src', extensions: ['.js', '.mjs', '.html', '.css'], recursive: true },
  { directory: 'desktop-js/scripts', extensions: ['.js', '.ps1'], recursive: false },
  { directory: 'desktop-js/tests', extensions: ['.js'], recursive: false },
  { directory: 'scripts', extensions: ['.ps1'], recursive: false },
  { directory: 'tests', extensions: ['.cs', '.js', '.ps1', '.py'], recursive: false },
  { directory: 'tests/annotation', extensions: ['.js', '.html', '.css'], recursive: true },
]);

const LOCKED_TOOLS = Object.freeze(['electron', 'electron-builder', 'playwright', 'prettier']);
const HASH_BLOCK_BYTES = 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

// Check every existing path component. On Windows this also rejects junctions.
function assertNoLinks(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) fail('Symbolic links or junctions are not allowed in input paths.');
  }
  return absolute;
}

function requiredFile(root, relative) {
  const file = assertNoLinks(path.join(root, ...relative.split('/')));
  const info = fs.lstatSync(file);
  if (!info.isFile()) fail(`Required file is not a regular file: ${relative}`);
  return file;
}

function collectGroup(root, group) {
  const directory = assertNoLinks(path.join(root, ...group.directory.split('/')));
  if (!fs.lstatSync(directory).isDirectory()) fail(`Missing source directory: ${group.directory}`);
  const files = [];
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      const supported = group.extensions.includes(path.extname(entry.name).toLowerCase());
      if (entry.isSymbolicLink()) {
        if (group.recursive || supported)
          fail(`Symbolic link in source whitelist: ${childRelative}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (group.recursive) visit(child, childRelative);
      } else if (entry.isFile()) {
        if (supported) files.push(childRelative);
      } else if (supported) {
        fail(`Source entry is not a regular file: ${childRelative}`);
      }
    }
  }
  visit(directory, group.directory);
  if (!files.length) fail(`Source group is empty: ${group.directory}`);
  return files;
}

async function hashFile(file) {
  assertNoLinks(file);
  const beforeOpen = fs.lstatSync(file, { bigint: true });
  if (!beforeOpen.isFile()) fail('Manifest input must be a regular file.');
  const handle = await fs.promises.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.ino !== beforeOpen.ino || before.dev !== beforeOpen.dev) {
      fail('Manifest input changed during opening.');
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BLOCK_BYTES);
    let count = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      count += bytesRead;
      if (!Number.isSafeInteger(count)) fail('Manifest input is too large.');
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(count) !== after.size
    ) {
      fail('Manifest input changed while it was being read.');
    }
    return { sizeBytes: count, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function commandVersion(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  const version = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (
    result.error ||
    result.status !== 0 ||
    !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
  ) {
    fail('Unable to read a required tool version.');
  }
  return version.replace(/^v/, '');
}

function localToolVersions(root) {
  const npm =
    process.platform === 'win32'
      ? commandVersion(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', 'npm.cmd --version'],
          root,
        )
      : commandVersion('npm', ['--version'], root);
  const candidates = [];
  if (process.env.TREEEXTRACT_DOTNET) candidates.push(process.env.TREEEXTRACT_DOTNET);
  if (process.env.LOCALAPPDATA)
    candidates.push(path.join(process.env.LOCALAPPDATA, 'TreeExtract', 'dotnet-sdk', 'dotnet.exe'));
  candidates.push('dotnet');
  let dotnetSdk = null;
  for (const candidate of candidates) {
    try {
      const version = commandVersion(candidate, ['--version'], root);
      if (/^10\.0\.\d+$/.test(version)) {
        dotnetSdk = version;
        break;
      }
    } catch {
      // Try the next configured candidate; no path is written into the manifest.
    }
  }
  if (!dotnetSdk) fail('A .NET 10 SDK is required to create a release manifest.');
  return {
    node: process.versions.node,
    npm,
    dotnetSdk,
    platform: process.platform,
    arch: process.arch,
  };
}

function lockedToolVersions(packageBytes, lockBytes) {
  let packageData;
  let lock;
  try {
    packageData = JSON.parse(packageBytes.toString('utf8'));
    lock = JSON.parse(lockBytes.toString('utf8'));
  } catch {
    fail('Invalid JavaScript package or lock file.');
  }
  const versions = {};
  for (const name of LOCKED_TOOLS) {
    const declared = packageData.devDependencies && packageData.devDependencies[name];
    const entry = lock.packages && lock.packages[`node_modules/${name}`];
    if (
      !entry ||
      typeof entry.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version) ||
      declared !== entry.version
    ) {
      fail(`Declared and locked tool versions do not match: ${name}`);
    }
    versions[name] = entry.version;
  }
  return versions;
}

function sanitizedToolVersions(value) {
  if (!value || typeof value !== 'object') fail('Invalid local tool versions.');
  const result = {};
  for (const key of ['node', 'npm', 'dotnetSdk']) {
    if (
      typeof value[key] !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value[key])
    ) {
      fail('Invalid local tool versions.');
    }
    result[key] = value[key];
  }
  for (const key of ['platform', 'arch']) {
    if (typeof value[key] !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(value[key])) {
      fail('Invalid local tool versions.');
    }
    result[key] = value[key];
  }
  return result;
}

async function createReleaseManifest({
  workspaceRoot,
  executablePath,
  outputPath,
  versionProvider = localToolVersions,
}) {
  const root = assertNoLinks(workspaceRoot);
  if (!fs.lstatSync(root).isDirectory()) fail('Workspace must be a directory.');
  const executable = assertNoLinks(executablePath);
  if (path.extname(executable).toLowerCase() !== '.exe')
    fail('The release artifact must be an EXE.');
  const output = path.resolve(outputPath);
  if (path.extname(output).toLowerCase() !== '.json')
    fail('The manifest output must be a JSON file.');
  assertNoLinks(path.dirname(output));
  if (fs.existsSync(output)) fail('The manifest output already exists.');

  const names = new Set(REQUIRED_FILES);
  for (const group of SOURCE_GROUPS) for (const file of collectGroup(root, group)) names.add(file);
  const ordered = [...names].sort();
  const packagePath = requiredFile(root, 'desktop-js/package.json');
  const lockPath = requiredFile(root, 'desktop-js/package-lock.json');
  const packageBytes = fs.readFileSync(packagePath);
  const lockBytes = fs.readFileSync(lockPath);
  const lockedTools = lockedToolVersions(packageBytes, lockBytes);
  const files = [];
  for (const name of ordered) {
    const record = await hashFile(requiredFile(root, name));
    files.push({ path: name, ...record });
  }
  const packageHash = crypto.createHash('sha256').update(packageBytes).digest('hex');
  const lockHash = crypto.createHash('sha256').update(lockBytes).digest('hex');
  if (
    files.find((file) => file.path === 'desktop-js/package.json').sha256 !== packageHash ||
    files.find((file) => file.path === 'desktop-js/package-lock.json').sha256 !== lockHash
  ) {
    fail('A JavaScript manifest or lock file changed during collection.');
  }
  const artifact = await hashFile(executable);
  if (!artifact.sizeBytes) fail('The release artifact is empty.');
  const versions = sanitizedToolVersions(versionProvider(root));
  const manifest = {
    schema: 'treeextract.local-release-inventory.v1',
    generatedAtUtc: new Date().toISOString(),
    limitations: [
      'Hashes describe bytes read locally; they do not prove build provenance.',
      'This inventory does not verify code signatures or establish software safety.',
      'Datasets, user files, annotations, logs and test images are excluded.',
    ],
    toolVersions: versions,
    lockedToolVersions: lockedTools,
    files,
    artifact: { role: 'windows-portable-exe', ...artifact },
  };
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  const outputHandle = await fs.promises.open(output, 'wx');
  try {
    await outputHandle.writeFile(contents, 'utf8');
    await outputHandle.sync();
  } finally {
    await outputHandle.close();
  }
  return manifest;
}

function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !['--artifact', '--output'].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      options[key]
    ) {
      fail('Usage: node release-manifest.js --artifact <exe> --output <new-json-file>');
    }
    options[key] = args[i + 1];
  }
  if (!options['--artifact'] || !options['--output']) {
    fail('Usage: node release-manifest.js --artifact <exe> --output <new-json-file>');
  }
  return { executablePath: options['--artifact'], outputPath: options['--output'] };
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    options.workspaceRoot = path.resolve(__dirname, '..', '..');
    createReleaseManifest(options)
      .then((result) =>
        console.log(
          `Manifest created: ${result.files.length} files, SHA-256 ${result.artifact.sha256}`,
        ),
      )
      .catch((error) => {
        console.error(`Manifest failed: ${error.message}`);
        process.exitCode = 1;
      });
  } catch (error) {
    console.error(`Manifest failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { REQUIRED_FILES, SOURCE_GROUPS, createReleaseManifest, parseArguments };
