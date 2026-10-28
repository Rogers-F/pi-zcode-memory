'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 面板与后台共用的安全文件操作。规则与上游 memory-file-path.ts 一致：
 * 只允许记忆根目录内的常规文件，链接一律拒绝。
 */

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel.length > 0 && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function relativeInside(root, target) {
  const rel = path.relative(root, target);
  if (rel.length === 0 || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

const SENSITIVE_SEGMENTS = new Set([
  '.git', 'hooks', '.husky', '.githooks', 'node_modules', '.vscode', '.idea',
  'head', 'config', 'objects', 'refs', '.claude', '.zcode', 'skills', 'commands',
  'agents', '.cargo', '.devcontainer', '.yarn', '.mvn',
]);

function normalizeSegment(segment) {
  const withoutControls = segment
    .toLowerCase()
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, '');
  return (withoutControls.split(':', 1)[0] || '').replace(/[. ]+$/u, '');
}

function containsSensitiveSegment(relPath) {
  return relPath.split(/[\\/]+/u).some((segment) => SENSITIVE_SEGMENTS.has(normalizeSegment(segment)));
}

/** 逻辑路径：拒绝绝对路径、反斜杠、.. 与空段。 */
function splitRelative(relPath) {
  if (typeof relPath !== 'string' || relPath === '' || path.isAbsolute(relPath) || relPath.includes('\\')) {
    throw new Error(`invalid relative path: ${String(relPath)}`);
  }
  const parts = relPath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`invalid relative path: ${relPath}`);
  }
  return parts;
}

/** 解析 root 下的相对路径，允许 "a/b.md" 形式，拒绝穿越与大小写别名。 */
function resolveInside(root, relPath) {
  const parts = splitRelative(relPath);
  const full = path.join(root, ...parts);
  if (!isInside(root, full)) throw new Error(`path escapes memory root: ${relPath}`);
  return full;
}

/**
 * 逐段 lstat：任何符号链接都拒绝；missingOk 时允许尾部不存在（用于新建）。
 */
async function assertNoSymlinks(root, parts, { missingOk = false } = {}) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (missingOk && error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink refused: ${path.relative(root, current)}`);
  }
  return true;
}

/** 目标必须是常规文件、单链接、不超过 maxBytes。 */
function fileProblem(stat, label, maxBytes) {
  if (!stat.isFile()) return `not a regular file: ${label}`;
  if (stat.nlink > 1) return `hard link refused: ${label}`;
  if (maxBytes !== undefined && stat.size > maxBytes) return `file too large: ${label}`;
  return null;
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;

/** 大小写别名：请求的段必须在磁盘上按原样存在，否则拒绝。 */
async function assertExactCase(root, parts, relPath) {
  let current = root;
  for (const part of parts) {
    let entries;
    try {
      entries = await fsp.readdir(current);
    } catch {
      return;
    }
    if (!entries.includes(part)) {
      if (entries.some((name) => name.toLowerCase() === part.toLowerCase())) {
        throw new Error(`case alias refused: ${relPath}`);
      }
      return;
    }
    current = path.join(current, part);
  }
}
/** 读取记忆根内的常规文件；返回 {content, stat}。 */
async function readFileInside(root, relPath, { maxBytes, encoding = 'utf8' } = {}) {
  const parts = splitRelative(relPath);
  await assertExactCase(root, parts, relPath);
  await assertNoSymlinks(root, parts);
  const full = path.join(root, ...parts);
  let handle;
  try {
    handle = await fsp.open(full, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`symlink refused: ${relPath}`);
    throw error;
  }
  try {
    const [opened, named] = await Promise.all([handle.stat(), fsp.lstat(full)]);
    const problem = fileProblem(opened, relPath, maxBytes);
    if (problem) throw new Error(problem);
    if (opened.ino !== named.ino || opened.dev !== named.dev) throw new Error(`path changed while reading: ${relPath}`);
    const content = await handle.readFile(encoding);
    return { content: typeof content === 'string' ? content : content.toString('utf8'), stat: opened };
  } finally {
    await handle.close();
  }
}

/** 目录内的常规文件列表（不跟随链接）。 */
async function listFilesInside(root, relDir = '') {
  const parts = relDir ? splitRelative(relDir) : [];
  if (parts.length > 0) await assertNoSymlinks(root, parts);
  const dir = path.join(root, ...parts);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const rel = [...parts, entry.name].join('/');
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...(await listFilesInside(root, rel)));
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = await fsp.lstat(full);
    } catch {
      continue;
    }
    files.push({ rel, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * 原子写：先写临时文件再改名，避免半个 JSON 被读到。
 * Windows 上目标文件正被另一个进程读、或被杀毒软件扫描时 rename 会短暂失败，重试几次。
 */
async function writeFileAtomic(fullPath, content) {
  const dir = path.dirname(fullPath);
  await fsp.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(fullPath)}.${crypto.randomUUID()}.tmp`);
  await fsp.writeFile(temp, content, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(temp, fullPath);
      return;
    } catch (error) {
      if (!RENAME_RETRY_CODES.has(error?.code) || attempt >= 4) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function readJson(fullPath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(fullPath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(fullPath, value) {
  await writeFileAtomic(fullPath, JSON.stringify(value, null, 2));
}

/** 目录内 mtime 最新的文件，用于 Dream 的最近会话门槛。 */
async function listJsonMtimes(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const stat = await fsp.lstat(path.join(dir, entry.name));
      if (stat.isFile()) result.push({ name: entry.name, mtimeMs: stat.mtimeMs });
    } catch {
      // 单个文件读不到不影响其它条目
    }
  }
  return result;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
  isInside,
  relativeInside,
  splitRelative,
  resolveInside,
  assertNoSymlinks,
  containsSensitiveSegment,
  assertExactCase,
  readFileInside,
  listFilesInside,
  writeFileAtomic,
  writeJson,
  readJson,
  listJsonMtimes,
  sha256,
};
