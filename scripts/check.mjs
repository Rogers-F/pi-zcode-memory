#!/usr/bin/env node
/**
 * 检查脚本：清单、权限、提示词替换表、运行时依赖、对齐矩阵的测试名。
 * 每条规则都注明宿主或上游源码位置，改规则前先核对那一行。
 *
 * 用法：
 *   node scripts/check.mjs            检查仓库
 *   node scripts/check.mjs <dir>      检查解包后的插件目录
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const argument = process.argv[2];
const targetRoot = argument ? resolve(argument) : repoRoot;
const packageMode = Boolean(argument);

const errors = [];
const notes = [];
function fail(message) {
  errors.push(message);
}
function ok(message) {
  notes.push(message);
}

const manifestPath = join(targetRoot, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`manifest.json 不存在：${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// ---- 宿主：out/main/chunks/index-*.js validateManifest() ----
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/; // 宿主常量在 index-*.js 的 PLUGIN_ID_PATTERN
const PLUGIN_PERMISSIONS = new Set([
  'ui.panel', 'ui.view', 'ui.microphone', 'ui.theme', 'ui.settings', 'ui.window.appearance',
  'clipboard.read', 'clipboard.write', 'notify', 'fs.read', 'fs.write', 'fs.delete',
  'agent.tool.register', 'agent.prompt.inject', 'agent.complete', 'composer.transform',
  'composer.suggest', 'agent.extension', 'renderer.extension', 'provider.register',
  'provider.oauth', 'desktop.control', 'models.list', 'project.create', 'session.read',
  'session.import', 'session.read.own', 'session.update.own', 'session.delete.own',
  'session.autoTitle', 'usage.read', 'net.fetch', 'net.anyHost', 'shell.openExternal',
  'mcp.server.local', 'mcp.server.remote', 'background.service', 'bus.publish', 'bus.subscribe',
  'browser.cdp', 'audio.capture.background', 'audio.playback.background',
  'speech.adapter.register', 'keyboard.globalShortcut', 'net.websocket',
]);

// ---- 清单必填项（宿主 33276-33307） ----
for (const field of ['id', 'name', 'version', 'main', 'schemaVersion']) {
  if (manifest[field] === undefined || manifest[field] === '') fail(`manifest.${field} 缺失（宿主 validateManifest 要求）`);
}
if (typeof manifest.id === 'string' && !PLUGIN_ID_PATTERN.test(manifest.id)) {
  fail(`manifest.id 不符合 PLUGIN_ID_PATTERN：${manifest.id}`);
}
if (manifest.id !== 'local.pi-zcode-memory') fail(`manifest.id 必须是 local.pi-zcode-memory，当前 ${manifest.id}`);
if (manifest.schemaVersion !== 1) fail('manifest.schemaVersion 必须是 1');
if (manifest.license !== 'Apache-2.0') fail('manifest.license 必须是 Apache-2.0（上游 ZCode 为 Apache-2.0）');

// ---- 相对路径（宿主 relativePathError） ----
function relativePathError(value, label) {
  if (typeof value !== 'string' || !value.trim()) return `${label} 必须是非空字符串`;
  if (value.includes('..') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
    return `${label} 必须是包内相对路径：${value}`;
  }
  return undefined;
}
for (const [value, label] of [[manifest.main, 'manifest.main'], [manifest.ui?.panel, 'manifest.ui.panel']]) {
  const error = value === undefined ? undefined : relativePathError(value, label);
  if (error) fail(error);
  else if (value && !existsSync(join(targetRoot, value))) fail(`${label} 指向的文件不存在：${value}`);
}

// ---- 分类必须在宿主已知集合内（out/main/chunks/index-*.js CATALOG_CATEGORIES） ----
const CATALOG_CATEGORIES = new Set(['devtools', 'web', 'docs', 'data', 'productivity']);
if (manifest.categories !== undefined) {
  if (!Array.isArray(manifest.categories) || !manifest.categories.every((category) => CATALOG_CATEGORIES.has(category))) {
    fail(`manifest.categories 必须是宿主已知分类之一：${[...CATALOG_CATEGORIES].join(', ')}`);
  }
}
// ---- 权限（宿主 PLUGIN_PERMISSIONS / 清单交叉校验） ----
const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
if (permissions.length === 0) fail('manifest.permissions 不能为空');
for (const permission of permissions) {
  if (!PLUGIN_PERMISSIONS.has(permission)) fail(`未知权限：${permission}（不在宿主 PLUGIN_PERMISSIONS 列表）`);
  if (permission.startsWith('net.')) fail(`插件不得申请 ${permission}：本插件不建立网络连接`);
}
if (manifest.net !== undefined) fail('manifest.net 必须缺省：插件不申请任何网络域');
if ((manifest.contributes?.agentExtensions?.length ?? 0) > 0 && !permissions.includes('agent.extension')) {
  fail('contributes.agentExtensions 需要 agent.extension 权限（宿主 33344）');
}
const panelDeclared = Boolean(manifest.ui?.panel);
if (panelDeclared && !permissions.includes('ui.panel')) fail('manifest.ui.panel 需要 ui.panel 权限');
if ((manifest.contributes?.settings?.length ?? 0) > 0 && !permissions.includes('ui.settings')) {
  notes.push('设置由宿主设置页渲染，未申请 ui.settings（宿主不要求，插件也不自建设置页）');
}

// ---- contributions（宿主 validateContributions 33399-33555） ----
const settingKeys = new Set();
const settingTypes = new Set(['string', 'number', 'boolean', 'select', 'json', 'shortcut']);
for (const setting of manifest.contributes?.settings ?? []) {
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(setting.key ?? '')) fail(`设置 key 不合法：${setting.key}（宿主 33489）`);
  if (settingKeys.has(setting.key)) fail(`设置 key 重复：${setting.key}`);
  settingKeys.add(setting.key);
  if (typeof setting.title !== 'string' || !setting.title.trim()) fail(`设置 ${setting.key} 缺少 title`);
  if (!settingTypes.has(setting.type)) fail(`设置 ${setting.key} 的类型不受支持：${setting.type}`);
  if (setting.secret === true) fail(`设置 ${setting.key} 不能声明 secret`);
  if (setting.type === 'select' && (!Array.isArray(setting.enum) || setting.enum.length === 0)) {
    fail(`select 设置 ${setting.key} 需要 enum`);
  }
}
for (const entry of manifest.contributes?.agentExtensions ?? []) {
  const error = relativePathError(entry, 'contributes.agentExtensions');
  if (error) fail(error);
  else if (!/\.(ts|mts|js|mjs)$/.test(entry)) fail(`agentExtensions 必须是 .js/.ts：${entry}`);
  else if (!existsSync(join(targetRoot, entry))) fail(`agentExtensions 指向的文件不存在：${entry}`);
}
const commands = manifest.contributes?.commands ?? [];
for (const command of commands) {
  if (typeof command.id !== 'string' || !command.title) fail(`命令需要 id 与 title：${JSON.stringify(command)}`);
}

// ---- 运行时依赖：只允许 Node 内置与包内文件 ----
const runtimeFiles = ['main.js', 'extension.js'];
const libDir = join(targetRoot, 'lib');
if (existsSync(libDir)) {
  for (const name of readdirSync(libDir)) {
    if (extname(name) === '.js') runtimeFiles.push(join('lib', name));
  }
}
// 宿主 Node 24 的权威内置模块清单（含 fs/promises 这类子路径）
const BUILTINS = new Set(builtinModules);
for (const relative of runtimeFiles) {
  const full = join(targetRoot, relative);
  if (!existsSync(full)) {
    fail(`运行时文件缺失：${relative}`);
    continue;
  }
  const source = readFileSync(full, 'utf8');
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1];
    if (specifier.startsWith('node:')) {
      if (!BUILTINS.has(specifier.slice(5))) fail(`${relative} 引用了未知内置模块：${specifier}`);
      continue;
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const resolved = resolve(dirname(full), specifier);
      const candidate = existsSync(resolved) ? resolved : `${resolved}.js`;
      if (!existsSync(candidate)) fail(`${relative} 引用了包内不存在的文件：${specifier}`);
      else if (packageMode && !candidate.startsWith(targetRoot)) fail(`${relative} 越出插件目录：${specifier}`);
      continue;
    }
    fail(`${relative} 引用了外部包：${specifier}（运行时只允许 Node 内置模块与包内文件）`);
  }
  if (/\bnew\s+Function\s*\(/.test(source) || /\beval\s*\(/.test(source)) {
    fail(`${relative} 使用了 eval / new Function`);
  }
  // 运行时不接受环境变量配置（ZCODE_MEMORY_* 只给测试启动器用）
  if (/ZCODE_MEMORY_/.test(source)) fail(`${relative} 读取了 ZCODE_MEMORY_* 环境变量：运行时不接受环境变量配置`);
}

// ---- 面板安全：CSP 与本地资源 ----
const panelPath = manifest.ui?.panel ? join(targetRoot, manifest.ui.panel) : undefined;
if (panelPath && existsSync(panelPath)) {
  const html = readFileSync(panelPath, 'utf8');
  if (!/Content-Security-Policy/.test(html)) fail('面板缺少 Content-Security-Policy');
  if (/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, ''))) fail('面板不得引用远程资源');
  for (const match of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
    if (!existsSync(join(dirname(panelPath), match[1]))) fail(`面板脚本不存在：${match[1]}`);
  }
}
const rendererEntry = join(targetRoot, 'renderer', 'panel.js');
if (existsSync(rendererEntry)) {
  const source = readFileSync(rendererEntry, 'utf8');
  if (/\.innerHTML\s*=/.test(source)) fail('面板不得写 innerHTML（只读渲染必须用 textContent）');
  if (/\bimport\s+.*from\s+['"]/.test(source)) fail('面板必须是经典脚本：file:// 下不加载 ES module');
}

// ---- 提示词替换表 ----
const constantsPath = join(targetRoot, 'lib', 'constants.js');
if (existsSync(constantsPath)) {
  const source = readFileSync(constantsPath, 'utf8');
  for (const token of ['CLAUDE.md', 'AGENTS.md', 'PROMPT_SUBSTITUTIONS']) {
    if (!source.includes(token)) fail(`constants.js 缺少替换表标记：${token}`);
  }
  const allowed = new Set(['CLAUDE.md', '${memoryRoot}', '${transcriptRoot}']);
  for (const match of source.matchAll(/from:\s*'([^']+)'/g)) {
    if (!allowed.has(match[1])) fail(`替换表出现未登记的差异：${match[1]}`);
  }
} else if (!packageMode) {
  fail('lib/constants.js 缺失');
}

// ---- 对齐矩阵：状态取值与测试名 ----
if (!packageMode) {
  const matrixPath = join(targetRoot, 'docs', '对齐矩阵.md');
  if (!existsSync(matrixPath)) {
    fail('docs/对齐矩阵.md 缺失');
  } else {
    const matrix = readFileSync(matrixPath, 'utf8');
    const rows = matrix.split('\n').filter((line) => /^\|\s*\d+\s*\|/.test(line));
    if (rows.length < 25) fail(`对齐矩阵只有 ${rows.length} 行，覆盖不足`);
    const allowedStates = ['已实现', '等效替代', '宿主不支持'];
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      if (!allowedStates.includes(cells[3])) fail(`对齐矩阵状态不合法：${cells[3]}（行 ${cells[1]}）`);
      if (cells[4] && !cells[4]) fail('缺少实现说明');
    }
    const testDir = join(repoRoot, 'test');
    const testSources = new Map();
    if (existsSync(testDir)) {
      for (const name of readdirSync(testDir)) {
        if (!name.endsWith('.test.cjs')) continue;
        testSources.set(name, readFileSync(join(testDir, name), 'utf8'));
      }
    }
    for (const match of matrix.matchAll(/`([a-z0-9-]+\.test\.cjs)\s*›\s*([^`]+)`/g)) {
      const [, file, title] = match;
      const source = testSources.get(file);
      if (!source) {
        fail(`对齐矩阵引用了不存在的测试文件：${file}`);
        continue;
      }
      if (!source.includes(`'${title.trim()}'`) && !source.includes(`"${title.trim()}"`) && !source.includes('`' + title.trim() + '`')) {
        fail(`对齐矩阵引用了不存在的测试名：${file} › ${title.trim()}`);
      }
    }
    if (/宿主不支持/.test(matrix) && !/out\/main/.test(matrix) && !/out\/preload/.test(matrix)) {
      fail('「宿主不支持」的行必须写出宿主源码位置');
    }
  }
}

// ---- 打包体积 ----
function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}
const allFiles = walk(targetRoot);
if (packageMode) {
  if (allFiles.length > 2000) fail(`文件数超过 2000：${allFiles.length}`);
  const total = allFiles.reduce((sum, file) => sum + statSync(file).size, 0);
  if (total > 50 * 1024 * 1024) fail(`总大小超过 50 MiB：${total}`);
  for (const file of allFiles) {
    if (file.includes('node_modules')) fail(`包里不应有 node_modules：${file}`);
    if (/\.env(\.|$)/.test(file)) fail(`包里不应有环境文件：${file}`);
  }
  for (const required of ['main.js', 'extension.js', 'manifest.json', 'LICENSE', 'NOTICE.md']) {
    if (!existsSync(join(targetRoot, required))) fail(`包内缺少 ${required}`);
  }
  ok(`包内文件 ${allFiles.length} 个`);
}

// ---- 打包格式 ----
// 宿主安装器只收不压缩（store）的条目：host-core crates\host-core\src\plugins\install.rs 报
// 「PLUGIN_INVALID: only store-compressed piplug supported」（字符串在 resources/bin/pi-desktop-host-core.exe）。
// 这里检查 dist 里已经生成的包；还没打包时跳过（scripts/pack.mjs 写完会按同一规则自检）。
if (!packageMode) {
  const piplug = join(targetRoot, 'dist', `${manifest.id}-${manifest.version}.piplug`);
  if (existsSync(piplug)) {
    const archive = readFileSync(piplug);
    let offset = 0;
    let count = 0;
    while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
      const method = archive.readUInt16LE(offset + 8);
      const storedSize = archive.readUInt32LE(offset + 18);
      const nameLength = archive.readUInt16LE(offset + 26);
      const extraLength = archive.readUInt16LE(offset + 28);
      const name = archive.toString('utf8', offset + 30, offset + 30 + nameLength);
      if (method !== 0) fail(`dist 包里的 ${name} 是压缩条目（方法 ${method}），宿主安装器只收不压缩的包，请重新 npm run pack`);
      offset += 30 + nameLength + extraLength + storedSize;
      count += 1;
    }
    if (count === 0) fail(`dist 包读不出条目：${piplug}`);
    else ok(`dist 包 ${count} 个条目，全部不压缩`);
  } else {
    ok('dist 里还没有包，跳过包格式检查');
  }
}

// ---- 汇总 ----
for (const note of notes) console.log(`note: ${note}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  console.error(`\n0 errors? no: ${errors.length} errors`);
  process.exit(1);
}
console.log(`check: ${targetRoot}`);
console.log('0 errors');