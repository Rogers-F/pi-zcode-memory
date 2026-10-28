#!/usr/bin/env node
/**
 * npm test 的入口：用 PI-Desktop 自带的 Node 跑全部测试。
 *
 * - 运行时：PI-Desktop.exe + ELECTRON_RUN_AS_NODE=1（Electron 以纯 Node 方式运行）。
 *   路径取 PI_DESKTOP_EXE，否则按常见安装位置查找。
 * - 隔离：HOME / USERPROFILE 指向一次性临时目录，测试结束后删除。
 * - 断言：输出里 fail、skipped、todo 都必须是 0；真实 ~/.pi-desktop/zcode-memory 的
 *   存在状态在测试前后不能变化。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function candidates() {
  if (process.platform === 'win32') {
    return [
      'G:\\PI-Desktop\\PI-Desktop.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'PI-Desktop', 'PI-Desktop.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PI-Desktop', 'PI-Desktop.exe'),
    ];
  }
  if (process.platform === 'darwin') return ['/Applications/PI-Desktop.app/Contents/MacOS/PI-Desktop'];
  return ['/opt/PI-Desktop/pi-desktop', '/usr/bin/pi-desktop'];
}

const runtime = process.env.PI_DESKTOP_EXE || candidates().find((file) => file && existsSync(file));
if (!runtime || !existsSync(runtime)) {
  console.error('找不到 PI-Desktop 可执行文件；请用环境变量 PI_DESKTOP_EXE 指定 PI-Desktop.exe 的路径。');
  process.exit(1);
}

const realData = path.join(os.homedir(), '.pi-desktop', 'zcode-memory');
const realDataBefore = existsSync(realData);
const tempHome = mkdtempSync(path.join(os.tmpdir(), 'pi-zcode-memory-home-'));
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  HOME: tempHome,
  USERPROFILE: tempHome,
  ZCODE_MEMORY_TEST_HOME: tempHome,
  ZCODE_MEMORY_REAL_DATA: realData,
};
delete env.PI_DESKTOP_DATA_DIR;

const probe = spawnSync(runtime, ['-p', 'JSON.stringify({ node: process.versions.node, electron: process.versions.electron })'], {
  env,
  encoding: 'utf8',
});
let versions = {};
try {
  versions = JSON.parse(String(probe.stdout || '').trim());
} catch {
  versions = {};
}
console.log(`运行时：${runtime}`);
console.log(`Node ${versions.node || '未知'}（Electron ${versions.electron || '未知'}），ELECTRON_RUN_AS_NODE=1`);
console.log(`临时 HOME / USERPROFILE：${tempHome}`);

const child = spawn(runtime, ['--test', '--test-reporter=spec', 'test/*.test.cjs'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});

child.on('close', (code) => {
  rmSync(tempHome, { recursive: true, force: true });
  const counter = (name) => {
    const match = new RegExp(`^\\S*\\s*${name}\\s+(\\d+)\\s*$`, 'mu').exec(output);
    return match ? Number(match[1]) : undefined;
  };
  const summary = {
    tests: counter('tests'),
    pass: counter('pass'),
    fail: counter('fail'),
    skipped: counter('skipped'),
    todo: counter('todo'),
  };
  const problems = [];
  if (code !== 0) problems.push(`测试进程退出码 ${code}`);
  if (summary.tests === undefined || summary.tests === 0) problems.push('没有读到测试汇总');
  if (summary.fail !== 0) problems.push(`失败 ${summary.fail}`);
  if (summary.skipped !== 0) problems.push(`跳过 ${summary.skipped}`);
  if (summary.todo !== 0) problems.push(`待办 ${summary.todo}`);
  if (existsSync(realData) !== realDataBefore) problems.push(`真实数据目录的存在状态变了：${realData}`);
  console.log(
    `\n汇总：Node ${versions.node || '未知'}，测试 ${summary.tests ?? '?'}，通过 ${summary.pass ?? '?'}，失败 ${summary.fail ?? '?'}，跳过 ${summary.skipped ?? '?'}，待办 ${summary.todo ?? '?'}`,
  );
  console.log(`真实 ~/.pi-desktop/zcode-memory：测试前${realDataBefore ? '存在' : '不存在'}，测试后${existsSync(realData) ? '存在' : '不存在'}`);
  if (problems.length > 0) {
    console.error(`npm test 未通过：${problems.join('；')}`);
    process.exit(1);
  }
});
