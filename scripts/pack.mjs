#!/usr/bin/env node
/**
 * 打包：dist/local.pi-zcode-memory-<version>.piplug
 *
 * 格式按宿主的规则：
 * - 安装器只收不压缩（store）的条目。host-core 的 crates\host-core\src\plugins\install.rs
 *   遇到压缩条目报「PLUGIN_INVALID: only store-compressed piplug supported」
 *   （字符串在 resources/bin/pi-desktop-host-core.exe 里）；宿主 PluginPack 工具的说明也写着
 *   「the installer only accepts uncompressed archives」。
 * - 字段与宿主自己的打包器相同：app.asar 里 out/main/chunks/index-*.js 的 buildStoreZip()——
 *   方法 0、标志 0、时间与日期 0、外部属性 0，大小直接写在本地头里，不写目录条目。
 * - 上限：2000 个文件、50 MB、不能有符号链接（同一文件的 pack() 与 install.rs 的报错文字）。
 *
 * 进包文件由本脚本精确控制：运行时只用 Node 内置模块，包里不带 test/、scripts/、node_modules。
 * 脚本本身也只用 Node 内置模块（不依赖 zlib.crc32），系统里较旧的 node 也能跑。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

const INCLUDE_FILES = ['manifest.json', 'main.js', 'extension.js', 'LICENSE', 'NOTICE.md', 'README.md'];
const INCLUDE_DIRS = ['lib', 'renderer', 'docs'];
const EXCLUDE = /(^|\/)(node_modules|dist|test|scripts)(\/|$)|\.env|\.piplug$/;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split('\\').join('/');
    if (EXCLUDE.test(rel)) continue;
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink in package: ${rel}`);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const files = [...INCLUDE_FILES.filter((name) => existsSync(join(root, name)))];
for (const dir of INCLUDE_DIRS) {
  if (existsSync(join(root, dir))) walk(join(root, dir), files);
}
files.sort();
if (files.length > MAX_FILES) throw new Error(`too many files: ${files.length}`);
for (const name of files) {
  // 安装器拒绝越出包根的路径（install.rs「path escaped package root」）
  if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
    throw new Error(`unsafe package path: ${name}`);
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 与宿主 buildStoreZip() 同一布局：每个字段写的值都一样，没写的位置保持 0。 */
function buildStoreZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0, 6); // 标志
    local.writeUInt16LE(0, 8); // 方法 0 = store
    local.writeUInt16LE(0, 10); // 时间
    local.writeUInt16LE(0, 12); // 日期
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小 = 原大小
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const block = Buffer.concat([local, name, data]);
    locals.push(block);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // 30–41：扩展区、注释、磁盘号、内部 / 外部属性都是 0
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += block.length;
  }
  const centralBlock = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBlock, end]);
}

/** 写完按安装器的方式从头读一遍：每个本地头都必须是不压缩条目，名字、大小、CRC 对得上。 */
function verifyStoreZip(archive, entries) {
  let offset = 0;
  for (const entry of entries) {
    if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
      throw new Error(`bad local header for ${entry.name}`);
    }
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const crc = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const size = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.toString('utf8', offset + 30, offset + 30 + nameLength);
    if (method !== 0 || flags !== 0) throw new Error(`${name} is not a plain stored entry (method ${method}, flags ${flags})`);
    if (name !== entry.name) throw new Error(`entry order mismatch: ${name} vs ${entry.name}`);
    if (compressedSize !== size || size !== entry.data.length) throw new Error(`size mismatch for ${name}`);
    const dataStart = offset + 30 + nameLength + extraLength;
    if (dataStart + size > archive.length) throw new Error(`entry truncated: ${name}`);
    if (crc32(archive.subarray(dataStart, dataStart + size)) !== crc) throw new Error(`crc mismatch for ${name}`);
    offset = dataStart + size;
  }
  if (archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('central directory missing');
  const end = archive.length - 22;
  if (archive.readUInt32LE(end) !== END_SIGNATURE || archive.readUInt16LE(end + 10) !== entries.length) {
    throw new Error('end of central directory does not match the entry count');
  }
}

const entries = files.map((name) => ({ name, data: readFileSync(join(root, name)) }));
const archive = buildStoreZip(entries);
verifyStoreZip(archive, entries);
if (archive.length > MAX_BYTES) throw new Error(`package over 50 MB: ${archive.length}`);

const distDir = join(root, 'dist');
mkdirSync(distDir, { recursive: true });
const output = join(distDir, `${manifest.id}-${manifest.version}.piplug`);
writeFileSync(output, archive);
const totalSource = files.reduce((sum, rel) => sum + statSync(join(root, rel)).size, 0);
console.log(`pack: ${output}`);
console.log(`files: ${files.length}, source bytes: ${totalSource}, archive bytes: ${archive.length}`);
console.log('format: store (uncompressed), same layout as the host packer; the installer rejects compressed entries');
