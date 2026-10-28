'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { readZip, readLocalHeaders } = require('./helpers/unzip');
const { makeTempDir } = require('./helpers/host');

const root = path.join(__dirname, '..');
const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

function runNode(args, options = {}) {
  return execFileSync(process.execPath, args, {
    cwd: options.cwd || root,
    env: nodeEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('打包：生成 .piplug，体积与内容符合限制', async () => {
  const output = runNode([path.join('scripts', 'pack.mjs')]);
  assert.match(output, /files: \d+/u);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const file = path.join(root, 'dist', `${manifest.id}-${manifest.version}.piplug`);
  assert.ok(fs.existsSync(file));
  const entries = readZip(fs.readFileSync(file));
  const names = entries.map((entry) => entry.name);
  assert.ok(entries.length <= 2000, `文件数 ${entries.length}`);
  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  assert.ok(total <= 50 * 1024 * 1024, `总大小 ${total}`);
  for (const required of ['manifest.json', 'main.js', 'extension.js', 'LICENSE', 'NOTICE.md', 'README.md']) {
    assert.ok(names.includes(required), `缺少 ${required}`);
  }
  assert.ok(names.some((name) => name.startsWith('lib/')));
  assert.ok(names.some((name) => name.startsWith('renderer/')));
  assert.ok(names.some((name) => name.startsWith('docs/')));
  for (const name of names) {
    assert.ok(!name.includes('node_modules'), name);
    assert.ok(!/\.env(\.|$)/u.test(name), name);
    assert.ok(!name.startsWith('test/') && !name.startsWith('scripts/'), name);
  }
});

test('打包：只用不压缩（store）条目，字段与宿主打包器 buildStoreZip 一致（宿主安装器只收这种包）', async () => {
  runNode([path.join('scripts', 'pack.mjs')]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const buffer = fs.readFileSync(path.join(root, 'dist', `${manifest.id}-${manifest.version}.piplug`));
  const { headers, centralOffset } = readLocalHeaders(buffer);
  const central = readZip(buffer);
  assert.ok(headers.length > 0);
  assert.equal(headers.length, central.length, '本地头与中央目录条目数一致');
  assert.equal(buffer.readUInt32LE(centralOffset), 0x02014b50, '本地头之后紧接中央目录');
  const { crc32 } = require('node:zlib');
  for (const header of headers) {
    // host-core install.rs：「PLUGIN_INVALID: only store-compressed piplug supported」
    assert.equal(header.method, 0, `${header.name} 不是 store 条目`);
    assert.equal(header.flags, 0, `${header.name} 的标志位应为 0（宿主 buildStoreZip 写 0）`);
    assert.equal(header.time, 0, header.name);
    assert.equal(header.date, 0, header.name);
    assert.equal(header.compressedSize, header.size, header.name);
    assert.equal(crc32(header.data) >>> 0, header.crc, `${header.name} 的 CRC`);
    // install.rs：「path escaped package root」
    assert.ok(!header.name.startsWith('/') && !header.name.includes('\\') && !header.name.split('/').includes('..'), header.name);
  }
  assert.deepEqual(
    headers.map((header) => header.name),
    central.map((entry) => entry.name),
  );
  for (let index = 0; index < central.length; index += 1) {
    assert.deepEqual(headers[index].data, central[index].data, central[index].name);
  }
});

test('打包：解包目录通过检查脚本，且无需 node_modules 即可加载', async () => {
  runNode([path.join('scripts', 'pack.mjs')]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const file = path.join(root, 'dist', `${manifest.id}-${manifest.version}.piplug`);
  const dir = await makeTempDir('unpacked');
  for (const entry of readZip(fs.readFileSync(file))) {
    const target = path.join(dir, ...entry.name.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, entry.data);
  }
  const check = runNode([path.join(root, 'scripts', 'check.mjs'), dir]);
  assert.match(check, /0 errors/u);
  const loaded = runNode(
    ['-e', "const m=require('./main.js');const e=require('./extension.js');if(typeof m.onLoad!=='function'||typeof e!=='function')throw new Error('bad exports');console.log('loaded')"],
    { cwd: dir },
  );
  assert.match(loaded, /loaded/u);
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules')));
});