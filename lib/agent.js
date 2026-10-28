'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { LIMITS } = require('./constants');
const safe = require('./fs-safe');
const memory = require('./memory');

// ============================================================
// 纯文本工具协议（宿主 agent.complete 只返回文本，没有 tool_calls）
// ============================================================

const TOOL_CALL_PATTERN = /<tool_call\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/gu;

function parseToolCalls(text) {
  const calls = [];
  let match;
  const pattern = new RegExp(TOOL_CALL_PATTERN.source, 'gu');
  while ((match = pattern.exec(String(text || ''))) !== null) {
    calls.push({ name: match[1], raw: match[2] });
  }
  return calls;
}

function stripToolCalls(text) {
  return String(text || '').replace(new RegExp(TOOL_CALL_PATTERN.source, 'gu'), '').trim();
}

function parseToolInput(call) {
  try {
    const value = JSON.parse(call.raw.trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value;
  } catch {
    // 模型有时在 JSON 前后写解释文字：取出第一个大括号块再试一次
    const start = call.raw.indexOf('{');
    const end = call.raw.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      const value = JSON.parse(call.raw.slice(start, end + 1));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

function formatToolResult(name, text, isError) {
  const body = String(text ?? '');
  const clipped = body.length > 20000 ? `${body.slice(0, 20000)}\n…(truncated)` : body;
  return `<tool_result name="${name}"${isError ? ' error="true"' : ''}>\n${clipped}\n</tool_result>`;
}

// ============================================================
// 归档（E4：FreeDesktop Trash 1.0 布局，额外字段允许）
// ============================================================

function trashStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function encodeTrashPath(localPath) {
  return String(localPath).split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

function archivePaths(storageRoot, projectKey) {
  const base = path.join(storageRoot, 'archive', projectKey);
  return { base, files: path.join(base, 'files'), info: path.join(base, 'info') };
}

async function uniqueArchiveTarget(filesDir, rel) {
  const dir = path.join(filesDir, ...rel.split('/'));
  const ext = path.extname(rel);
  const base = rel.slice(0, rel.length - ext.length);
  let candidate = rel;
  let counter = 1;
  for (;;) {
    const full = path.join(filesDir, ...candidate.split('/'));
    try {
      await fsp.lstat(full);
      candidate = `${base}.${counter}${ext}`;
      counter += 1;
    } catch {
      await fsp.mkdir(path.dirname(full), { recursive: true });
      return { rel: candidate, full };
    }
  }
}

/**
 * 改写或删除前把旧内容搬进 archive/<projectKey>/{files,info}。
 * trashinfo 只写 Trash 规范要求的 Path/DeletionDate，另加两个 X- 扩展键。
 */
async function archiveMemoryFile(input) {
  const { storageRoot, projectKey, memoryRoot, filePath, reason } = input;
  const rel = safe.relativeInside(memoryRoot, filePath);
  if (!rel) throw new Error(`archive refused outside memory root: ${filePath}`);
  const { content, stat } = await safe.readFileInside(memoryRoot, rel.split(path.sep).join('/'));
  const paths = archivePaths(storageRoot, projectKey);
  const target = await uniqueArchiveTarget(paths.files, rel.split(path.sep).join('/'));
  await fsp.writeFile(target.full, content, 'utf8');
  const infoRel = `${target.rel}.trashinfo`;
  const infoFull = path.join(paths.info, ...infoRel.split('/'));
  await fsp.mkdir(path.dirname(infoFull), { recursive: true });
  const decommissionDate = trashStamp(new Date());
  const info = [
    '[Trash Info]',
    `Path=${encodeTrashPath(filePath.split(path.sep).join('/'))}`,
    `DeletionDate=${decommissionDate}`,
    `X-ZCodeMemory-Reason=${reason}`,
    `X-ZCodeMemory-Size=${stat.size}`,
    '',
  ].join('\n');
  await fsp.writeFile(infoFull, info, 'utf8');
  return { rel: target.rel, infoRel, size: stat.size, deletedAt: decommissionDate };
}

function parseTrashInfo(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/u)) {
    const pair = /^([A-Za-z0-9_.-]+)=(.*)$/u.exec(line);
    if (pair) values[pair[1]] = pair[2];
  }
  if (!values.Path) return undefined;
  let originalPath;
  try {
    originalPath = values.Path.split('/').map((part) => decodeURIComponent(part)).join('/');
  } catch {
    return undefined;
  }
  return {
    originalPath,
    deletionDate: values.DeletionDate || '',
    reason: values['X-ZCodeMemory-Reason'] || 'unknown',
    size: Number.parseInt(values['X-ZCodeMemory-Size'] || '0', 10) || 0,
  };
}

async function listArchive(input) {
  const paths = archivePaths(input.storageRoot, input.projectKey);
  const entries = [];
  const walk = async (dir, prefix) => {
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const infoRel = `${rel}.trashinfo`;
      let info;
      try {
        info = parseTrashInfo(await fsp.readFile(path.join(paths.info, ...infoRel.split('/')), 'utf8'));
      } catch {
        info = undefined;
      }
      if (!info) continue;
      let stat;
      try {
        stat = await fsp.lstat(path.join(paths.files, ...rel.split('/')));
      } catch {
        continue;
      }
      entries.push({ ...info, rel, infoRel, size: stat.size, archivedAt: stat.mtimeMs });
    }
  };
  await walk(paths.files, '');
  entries.sort((left, right) => right.archivedAt - left.archivedAt);
  return entries;
}

async function restoreArchiveEntry(input) {
  const paths = archivePaths(input.storageRoot, input.projectKey);
  const source = path.join(paths.files, ...input.rel.split('/'));
  const infoSource = path.join(paths.info, ...`${input.rel}.trashinfo`.split('/'));
  const info = parseTrashInfo(await fsp.readFile(infoSource, 'utf8'));
  if (!info) throw new Error('archive entry has no trashinfo');
  const target = info.originalPath;
  if (!path.isAbsolute(target)) throw new Error('archive entry has no absolute original path');
  try {
    await fsp.lstat(target);
    throw new Error(`目标文件已存在，未覆盖：${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(source, target);
  await fsp.rm(source, { force: true });
  await fsp.rm(infoSource, { force: true });
  return { restoredTo: target };
}

async function purgeArchiveEntry(input) {
  const paths = archivePaths(input.storageRoot, input.projectKey);
  await fsp.rm(path.join(paths.files, ...input.rel.split('/')), { force: true });
  await fsp.rm(path.join(paths.info, ...`${input.rel}.trashinfo`.split('/')), { force: true });
  return { ok: true };
}

// ============================================================
// 工具执行
// ============================================================

const READ_ONLY_COMMANDS = new Set(['ls', 'find', 'cat', 'stat', 'wc', 'head', 'tail', 'grep', 'pwd', 'echo', 'true']);

const DENY_TOOL = (root) => `only Read, Grep, Glob, read-only Bash, and Edit/Write within ${root} are allowed`;
const DENY_BASH = (root) => `Only read-only shell commands and rm with all paths inside ${root} are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)`;

function splitShell(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '|' || char === ';' || char === '&') {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function tokenizeCommand(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function resolveToolPath(value, workspaceRoot) {
  const text = String(value || '').trim();
  if (!text) return undefined;
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(workspaceRoot, text);
}

function globToRegExp(pattern) {
  let out = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*';
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '.';
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`${out}$`, 'u');
}

async function walkAll(root, relDir = '') {
  const results = [];
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, ...relDir.split('/').filter(Boolean)), { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(...(await walkAll(root, rel)));
      continue;
    }
    if (entry.isFile()) results.push(rel);
  }
  return results;
}

function numberValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class ToolRunner {
  constructor(options) {
    this.memoryRoot = options.memoryRoot;
    this.workspaceRoot = options.workspaceRoot;
    this.storageRoot = options.storageRoot;
    this.projectKey = options.projectKey;
    this.sessionId = options.sessionId;
    this.improveE4 = options.improveE4 !== false;
    this.readPaths = new Set();
    this.touchedPaths = new Set();
    this.now = options.now || Date.now;
  }

  async run(call) {
    const input = parseToolInput(call);
    if (!input) return { text: '<tool_use_error>Error: tool input is not valid JSON</tool_use_error>', isError: true };
    switch (call.name) {
      case 'Read':
        return this.read(input);
      case 'Grep':
        return this.grep(input);
      case 'Glob':
        return this.glob(input);
      case 'Bash':
        return this.bash(input);
      case 'Write':
        return this.write(input);
      case 'Edit':
        return this.edit(input);
      default:
        return { text: `<tool_use_error>Error: No such tool available: ${call.name}</tool_use_error>`, isError: true };
    }
  }

  async read(input) {
    const full = resolveToolPath(input.file_path, this.workspaceRoot);
    if (!full) return { text: '<tool_use_error>Error: file_path is required</tool_use_error>', isError: true };
    try {
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) return { text: `<tool_use_error>Error: symlink refused: ${full}</tool_use_error>`, isError: true };
      if (!stat.isFile()) return { text: `<tool_use_error>Error: not a regular file: ${full}</tool_use_error>`, isError: true };
      if (stat.size > LIMITS.PREVIEW_MAX_BYTES) return { text: `<tool_use_error>Error: file too large: ${full}</tool_use_error>`, isError: true };
      const content = memory.normalizeText(await fsp.readFile(full, 'utf8'));
      const lines = content.split('\n');
      const offset = Math.max(0, numberValue(input.offset, 0));
      const limit = Math.max(1, numberValue(input.limit, 2000));
      const slice = lines.slice(offset, offset + limit);
      this.readPaths.add(full);
      const numbered = slice.map((line, index) => `${String(offset + index + 1).padStart(6, ' ')}\t${line}`).join('\n');
      const note = offset + limit < lines.length ? `\n…(${lines.length} lines total)` : '';
      return { text: `${numbered}${note}`, isError: false };
    } catch (error) {
      return { text: `<tool_use_error>Error: ${error.message}</tool_use_error>`, isError: true };
    }
  }

  async grep(input) {
    const pattern = String(input.pattern || '');
    if (!pattern) return { text: '<tool_use_error>Error: pattern is required</tool_use_error>', isError: true };
    let regex;
    try {
      regex = new RegExp(pattern, 'u');
    } catch (error) {
      return { text: `<tool_use_error>Error: invalid regex: ${error.message}</tool_use_error>`, isError: true };
    }
    const root = resolveToolPath(input.path, this.workspaceRoot) || this.memoryRoot;
    const glob = input.glob ? globToRegExp(String(input.glob).replace(/^\*\*\//u, '**/')) : undefined;
    const headLimit = Math.max(1, numberValue(input.head_limit, 100));
    const files = await walkAll(root);
    const hits = [];
    for (const rel of files) {
      if (glob && !glob.test(rel)) continue;
      let content;
      try {
        content = await fsp.readFile(path.join(root, ...rel.split('/')), 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        if (!regex.test(lines[index])) continue;
        hits.push(`${path.join(root, ...rel.split('/'))}:${index + 1}:${lines[index]}`);
        if (hits.length >= headLimit) break;
      }
      if (hits.length >= headLimit) break;
    }
    return { text: hits.length > 0 ? hits.join('\n') : 'No matches found', isError: false };
  }

  async glob(input) {
    const pattern = String(input.pattern || '**/*.md');
    const root = resolveToolPath(input.path, this.workspaceRoot) || this.memoryRoot;
    const regex = globToRegExp(pattern);
    const files = await walkAll(root);
    const matches = files.filter((rel) => regex.test(rel)).slice(0, 500);
    return { text: matches.length > 0 ? matches.join('\n') : 'No files found', isError: false };
  }

  async bash(input) {
    const command = String(input.command || '').trim();
    if (!command) return { text: '<tool_use_error>Error: command is required</tool_use_error>', isError: true };
    if (/[>]/u.test(command)) return { text: `<tool_use_error>${DENY_BASH(this.memoryRoot)}</tool_use_error>`, isError: true };
    const segments = splitShell(command);
    const outputs = [];
    for (const segment of segments) {
      const argv = tokenizeCommand(segment);
      if (argv.length === 0) continue;
      const name = argv[0];
      if (name === 'rm') {
        const result = await this.remove(argv.slice(1));
        if (result.isError) return result;
        outputs.push(result.text);
        continue;
      }
      if (!READ_ONLY_COMMANDS.has(name)) {
        return { text: `<tool_use_error>${DENY_BASH(this.memoryRoot)}</tool_use_error>`, isError: true };
      }
      const result = await this.readOnlyCommand(name, argv.slice(1), segments.length > 1);
      if (result.isError) return result;
      outputs.push(result.text);
    }
    return { text: outputs.filter(Boolean).join('\n') || '(no output)', isError: false };
  }

  async readOnlyCommand(name, args, piped) {
    const positionals = args.filter((arg) => !arg.startsWith('-') && !/^[0-9]+$/u.test(arg));
    const target = positionals.length > 0 ? positionals[positionals.length - 1] : '.';
    const full = resolveToolPath(target, this.workspaceRoot);
    try {
      if (name === 'ls') {
        const stat = await fsp.lstat(full);
        if (!stat.isDirectory()) return { text: path.basename(full), isError: false };
        const entries = await fsp.readdir(full);
        return { text: entries.join('\n'), isError: false };
      }
      if (name === 'cat') {
        const content = await fsp.readFile(full, 'utf8');
        return { text: content, isError: false };
      }
      if (name === 'stat') {
        const stat = await fsp.lstat(full);
        return { text: `${full}\nsize: ${stat.size}\nmtime: ${new Date(stat.mtimeMs).toISOString()}\nkind: ${stat.isDirectory() ? 'directory' : 'file'}`, isError: false };
      }
      if (name === 'wc') {
        const content = await fsp.readFile(full, 'utf8');
        return { text: `${content.split('\n').length} ${Buffer.byteLength(content, 'utf8')} ${full}`, isError: false };
      }
      if (name === 'head' || name === 'tail') {
        const countIndex = args.findIndex((arg) => arg === '-n');
        const count = countIndex >= 0 ? numberValue(args[countIndex + 1], 10) : 10;
        const content = await fsp.readFile(full, 'utf8');
        const lines = content.split('\n');
        return { text: (name === 'head' ? lines.slice(0, count) : lines.slice(-count)).join('\n'), isError: false };
      }
      if (name === 'grep') {
        const pattern = args.find((arg) => !arg.startsWith('-')) || '';
        const pathArg = args.filter((arg) => !arg.startsWith('-'))[1] || '.';
        const root = resolveToolPath(pathArg, this.workspaceRoot);
        const regex = new RegExp(pattern, 'u');
        const files = (await fsp.lstat(root)).isDirectory() ? await walkAll(root) : [''];
        const hits = [];
        for (const rel of files) {
          const file = rel ? path.join(root, ...rel.split('/')) : root;
          let content;
          try {
            content = await fsp.readFile(file, 'utf8');
          } catch {
            continue;
          }
          content.split(/\r?\n/u).forEach((line, index) => {
            if (regex.test(line)) hits.push(`${file}:${index + 1}:${line}`);
          });
          if (hits.length > 200) break;
        }
        return { text: hits.slice(0, 200).join('\n') || 'No matches found', isError: false };
      }
      if (name === 'find') {
        const files = await walkAll(full);
        return { text: files.join('\n') || '(empty)', isError: false };
      }
      if (name === 'pwd') return { text: this.workspaceRoot, isError: false };
      return { text: '(no output)', isError: false };
    } catch (error) {
      return { text: `<tool_use_error>Error: ${error.message}</tool_use_error>`, isError: true };
    } finally {
      void piped;
    }
  }

  async remove(args) {
    let afterOptions = false;
    const targets = [];
    for (const argument of args) {
      if (!afterOptions) {
        if (argument === '--') {
          afterOptions = true;
          continue;
        }
        if (argument.startsWith('-')) {
          if (argument === '--recursive' || /^-[a-zA-Z]*[rR]/u.test(argument)) {
            return { text: `<tool_use_error>${DENY_BASH(this.memoryRoot)}</tool_use_error>`, isError: true };
          }
          continue;
        }
      }
      if (/[*?[]/u.test(argument)) return { text: `<tool_use_error>${DENY_BASH(this.memoryRoot)}</tool_use_error>`, isError: true };
      if (!path.isAbsolute(argument) || !argument.endsWith('.md')) {
        return { text: `<tool_use_error>${DENY_BASH(this.memoryRoot)}</tool_use_error>`, isError: true };
      }
      const rel = safe.relativeInside(this.memoryRoot, path.normalize(argument));
      if (!rel) return { text: `<tool_use_error>${DENY_BASH(this.memoryRoot)}</tool_use_error>`, isError: true };
      targets.push(path.normalize(argument));
    }
    if (targets.length === 0) return { text: `<tool_use_error>${DENY_BASH(this.memoryRoot)}</tool_use_error>`, isError: true };
    const archived = [];
    for (const target of targets) {
      if (this.improveE4) {
        archived.push(await archiveMemoryFile({
          storageRoot: this.storageRoot,
          projectKey: this.projectKey,
          memoryRoot: this.memoryRoot,
          filePath: target,
          reason: 'delete',
        }));
      }
      await fsp.rm(target, { force: true });
      this.touchedPaths.add(target);
    }
    return {
      text: `removed ${targets.map((target) => path.basename(target)).join(', ')}${archived.length > 0 ? ` (archived: ${archived.map((entry) => entry.rel).join(', ')})` : ''}`,
      isError: false,
    };
  }

  /** Write/Edit 只能落在记忆根内的 .md；E4 先归档旧内容。 */
  async writeTarget(input) {
    const full = resolveToolPath(input.file_path, this.workspaceRoot);
    if (!full) return { error: '<tool_use_error>Error: file_path is required</tool_use_error>' };
    if (!full.endsWith('.md')) return { error: `<tool_use_error>${DENY_TOOL(this.memoryRoot)}</tool_use_error>` };
    const rel = safe.relativeInside(this.memoryRoot, full);
    if (!rel) return { error: `<tool_use_error>${DENY_TOOL(this.memoryRoot)}</tool_use_error>` };
    if (safe.containsSensitiveSegment(rel)) return { error: `<tool_use_error>${DENY_TOOL(this.memoryRoot)}</tool_use_error>` };
    return { full, rel };
  }

  async archiveIfExists(full, reason) {
    if (!this.improveE4) return undefined;
    try {
      const stat = await fsp.lstat(full);
      if (!stat.isFile()) return undefined;
    } catch {
      return undefined;
    }
    return archiveMemoryFile({
      storageRoot: this.storageRoot,
      projectKey: this.projectKey,
      memoryRoot: this.memoryRoot,
      filePath: full,
      reason,
    });
  }

  async write(input) {
    const target = await this.writeTarget(input);
    if (target.error) return { text: target.error, isError: true };
    if (typeof input.content !== 'string') return { text: '<tool_use_error>Error: content is required</tool_use_error>', isError: true };
    try {
      const archived = await this.archiveIfExists(target.full, 'overwrite');
      const stamped = memory.stampMemoryOriginSessionId({
        content: input.content,
        filePath: target.full,
        memoryRoot: this.memoryRoot,
        sessionId: this.sessionId,
      });
      await fsp.mkdir(path.dirname(target.full), { recursive: true });
      await fsp.writeFile(target.full, stamped, 'utf8');
      this.readPaths.add(target.full);
      this.touchedPaths.add(target.full);
      return {
        text: `wrote ${target.rel}${archived ? ` (previous version archived as ${archived.rel})` : ''}`,
        isError: false,
      };
    } catch (error) {
      return { text: `<tool_use_error>Error: ${error.message}</tool_use_error>`, isError: true };
    }
  }

  async edit(input) {
    const target = await this.writeTarget(input);
    if (target.error) return { text: target.error, isError: true };
    if (!this.readPaths.has(target.full)) {
      return { text: `<tool_use_error>Error: Edit requires a prior Read of ${target.full}</tool_use_error>`, isError: true };
    }
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
      return { text: '<tool_use_error>Error: old_string and new_string are required</tool_use_error>', isError: true };
    }
    try {
      const current = await fsp.readFile(target.full, 'utf8');
      const occurrences = current.split(input.old_string).length - 1;
      if (occurrences === 0) return { text: '<tool_use_error>Error: old_string not found</tool_use_error>', isError: true };
      if (occurrences > 1 && !input.replace_all) {
        return { text: '<tool_use_error>Error: old_string is not unique; pass replace_all</tool_use_error>', isError: true };
      }
      const next = input.replace_all ? current.split(input.old_string).join(input.new_string) : current.replace(input.old_string, input.new_string);
      const archived = await this.archiveIfExists(target.full, 'overwrite');
      const stamped = memory.stampMemoryOriginSessionId({
        content: next,
        filePath: target.full,
        memoryRoot: this.memoryRoot,
        sessionId: this.sessionId,
      });
      await fsp.writeFile(target.full, stamped, 'utf8');
      this.touchedPaths.add(target.full);
      return {
        text: `edited ${target.rel}${archived ? ` (previous version archived as ${archived.rel})` : ''}`,
        isError: false,
      };
    } catch (error) {
      return { text: `<tool_use_error>Error: ${error.message}</tool_use_error>`, isError: true };
    }
  }
}

// ============================================================
// 循环
// ============================================================

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('memory agent aborted');
    error.name = 'AbortError';
    throw error;
  }
}

/**
 * 一轮后台记忆整理：模型返回文本，工具调用走文本协议。
 * 每一轮都是一次宿主 agent.complete；调用方负责限流与超时。
 * 取消后（关闭插件）迟到的模型结果不执行任何工具、不落盘（上游 memory-agent-loop）。
 */
async function runMemoryAgentLoop(input) {
  const runner = input.toolRunner;
  const messages = [...input.messages];
  let turns = 0;
  let lastText = '';
  for (; turns < input.maxTurns; turns += 1) {
    throwIfAborted(input.signal);
    const response = await input.complete({ system: input.system, messages });
    // 上游 memory-agent-loop：模型返回后再检查一次，迟到的结果不执行任何工具、不落盘
    throwIfAborted(input.signal);
    lastText = response.text || '';
    const calls = parseToolCalls(lastText);
    if (calls.length === 0) {
      turns += 1;
      break;
    }
    messages.push({ role: 'assistant', content: lastText });
    const results = [];
    for (const call of calls) {
      throwIfAborted(input.signal);
      const result = await runner.run(call);
      results.push(formatToolResult(call.name, result.text, result.isError));
    }
    messages.push({ role: 'user', content: results.join('\n\n') });
  }
  return { text: lastText, turns, touchedPaths: [...runner.touchedPaths], messages };
}

module.exports = {
  TOOL_CALL_PATTERN,
  parseToolCalls,
  stripToolCalls,
  parseToolInput,
  formatToolResult,
  archivePaths,
  archiveMemoryFile,
  listArchive,
  restoreArchiveEntry,
  purgeArchiveEntry,
  parseTrashInfo,
  encodeTrashPath,
  trashStamp,
  ToolRunner,
  runMemoryAgentLoop,
  splitShell,
  tokenizeCommand,
  globToRegExp,
  DENY_TOOL,
  DENY_BASH,
};