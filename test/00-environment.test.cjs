'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

test('运行环境：PI-Desktop 自带的 Node 24（ELECTRON_RUN_AS_NODE=1）', () => {
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`node ${process.version} electron ${process.versions.electron || '-'} ${process.platform} ${process.arch}`);
  assert.strictEqual(major, 24, `测试必须跑在 PI-Desktop 的 Node 24 上，当前 ${process.version}`);
  assert.ok(process.versions.electron, '应由 PI-Desktop.exe（Electron）以 Node 方式运行，而不是系统 node');
  assert.strictEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
});

test('运行环境：HOME / USERPROFILE 指向临时目录', () => {
  const tempHome = process.env.ZCODE_MEMORY_TEST_HOME;
  assert.ok(tempHome, '请用 npm test（scripts/test.mjs）运行，它会把 HOME / USERPROFILE 换成临时目录');
  assert.strictEqual(path.resolve(os.homedir()), path.resolve(tempHome));
  if (process.platform === 'win32') assert.strictEqual(path.resolve(process.env.USERPROFILE), path.resolve(tempHome));
  else assert.strictEqual(path.resolve(process.env.HOME), path.resolve(tempHome));
  const realData = process.env.ZCODE_MEMORY_REAL_DATA;
  assert.ok(realData && !path.resolve(realData).startsWith(path.resolve(tempHome)), '真实数据目录不能落在临时 HOME 里');
});
