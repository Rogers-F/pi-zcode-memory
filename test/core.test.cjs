'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const core = require('../lib/core');
const safe = require('../lib/fs-safe');
const { makeTempDir } = require('./helpers/host');

test('工作区键与上游一致：slug + sha256 前 16 位', () => {
  const identity = core.projectIdentity('G:\\work\\My-Project');
  assert.match(identity.key, /^[a-z0-9._-]+-[0-9a-f]{16}$/u);
  assert.equal(identity.hash.length, 16);
  assert.equal(identity.slug, 'my-project');
  const again = core.projectIdentity('G:\\work\\My-Project');
  assert.equal(again.key, identity.key);
  if (process.platform === 'win32') {
    assert.equal(core.projectIdentity('g:\\WORK\\my-project').key, identity.key);
  }
});

test('记忆根目录形状与上游一致', () => {
  const root = path.join('C:', 'data');
  const memoryRoot = core.projectMemoryRoot(root, 'G:\\work\\demo');
  assert.match(memoryRoot, /memories[\\/]projects[\\/]demo-[0-9a-f]{16}[\\/]memory$/u);
});

test('代理记忆三种作用域各自独立', () => {
  const storageRoot = path.join('C:', 'data');
  const workspaceRoot = path.join('C:', 'proj');
  const user = core.agentMemoryRoot({ storageRoot, workspaceRoot, agentName: 'reviewer', scope: 'user' });
  const project = core.agentMemoryRoot({ storageRoot, workspaceRoot, agentName: 'reviewer', scope: 'project' });
  const local = core.agentMemoryRoot({ storageRoot, workspaceRoot, agentName: 'reviewer', scope: 'local' });
  assert.equal(new Set([user, project, local]).size, 3);
  assert.ok(user.includes('agent-memory'));
  assert.ok(project.includes(path.join('.pi', 'zcode-memory', 'agent-memory', 'reviewer')));
  assert.ok(local.includes('agent-memory-local'));
  assert.equal(core.sanitizeAgentKey('a/b:c'), 'a-b-c');
});

test('严格上游模式一键关闭 E1–E4', () => {
  const settings = core.normalizeSettings({ strictUpstream: true, improveE1: true });
  assert.equal(settings.improveE1, false);
  assert.equal(settings.improveE2, false);
  assert.equal(settings.improveE3, false);
  assert.equal(settings.improveE4, false);
  assert.equal(core.normalizeSettings({}).autoExtract, true);
  assert.equal(core.normalizeSettings({}).semanticRecall, false);
  assert.equal(core.normalizeSettings({}).autoDream, false);
});

test('代理作用域设置只接受三种合法值', () => {
  assert.deepEqual(core.parseAgentScopes('{"a":"user","b":"project","c":"local","d":"other"}'), {
    a: 'user',
    b: 'project',
    c: 'local',
  });
  assert.deepEqual(core.parseAgentScopes('not json'), {});
});

test('限流器：任意时间段内不超过上限，不管宿主的固定窗口从哪一刻开始', async () => {
  const { createHostRateLimit } = require('./helpers/host');
  let time = 0;
  const host = createHostRateLimit({ limit: 8, windowMs: 60000, now: () => time });
  const limiter = core.createRateLimiter({
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
  });
  // 确定性的伪随机间隔：既有成串的调用，也有跨过 60 秒边界的稀疏调用
  let seed = 12345;
  const nextGap = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const roll = seed % 100;
    return roll < 60 ? 0 : roll < 85 ? 500 + (seed % 3000) : 20000 + (seed % 45000);
  };
  for (let index = 0; index < 400; index += 1) {
    time += nextGap();
    await limiter.acquire(1 + (index % 3));
    assert.equal(host.exceeded(), false, `第 ${index + 1} 次调用（t=${time}ms）撞上宿主限流`);
  }
});

test('限流器在窗口内排队，不会丢请求', async () => {
  let time = 0;
  const waits = [];
  const limiter = core.createRateLimiter({
    now: () => time,
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    limit: 2,
    windowMs: 1000,
  });
  const order = [];
  await Promise.all(
    [0, 1, 2, 3, 4].map((index) => limiter.acquire(1).then(() => order.push(index))),
  );
  assert.equal(order.length, 5);
  assert.ok(waits.length >= 2, `等待次数 ${waits.length}`);
  assert.ok(waits.every((ms) => ms >= 1));
});

test('召回请求排在提取与 Dream 前面', async () => {
  let time = 0;
  const limiter = core.createRateLimiter({
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    limit: 1,
    windowMs: 1000,
  });
  const order = [];
  const first = limiter.acquire(1).then(() => order.push('dream'));
  await first;
  const low = limiter.acquire(1).then(() => order.push('extraction'));
  const high = limiter.acquire(3).then(() => order.push('recall'));
  await Promise.all([low, high]);
  assert.deepEqual(order, ['dream', 'recall', 'extraction']);
});

test('模型选择：设置覆盖 → 会话 modelKey → 会话 modelId 唯一匹配；找不到或有歧义就跳过并说明原因', () => {
  const models = [
    { key: 'p1/one', providerId: 'p1', providerName: 'Prov One', modelId: 'one', isDefault: false, thinkingLevels: ['high', 'low'] },
    { key: 'p1/two', providerId: 'p1', providerName: 'Prov One', modelId: 'two', isDefault: true, thinkingLevels: ['off', 'high'] },
    { key: 'p2/two', providerId: 'p2', providerName: 'Prov Two', modelId: 'two', thinkingLevels: ['max', 'minimal'] },
  ];
  const pick = (input) => core.resolveBackgroundModel({ models, ...input });
  assert.equal(pick({ backgroundModel: 'p1/one' }).model.key, 'p1/one');
  assert.equal(pick({ backgroundModel: 'p1/one' }).source, 'setting');
  assert.match(pick({ backgroundModel: 'x/y' }).reason, /x\/y/u);
  assert.equal(pick({ sessionModelKey: 'p2/two' }).model.key, 'p2/two');
  const missing = pick({ sessionModelKey: 'missing/x' });
  assert.equal(missing.model, null, '不退回默认模型');
  assert.match(missing.reason, /missing\/x/u);
  assert.equal(pick({ sessionModelId: 'one' }).model.key, 'p1/one');
  assert.match(pick({ sessionModelId: 'two' }).reason, /多个服务商/u);
  assert.equal(pick({ sessionModelId: 'two', sessionProvider: 'p2' }).model.key, 'p2/two');
  assert.equal(pick({ sessionModelId: 'two', sessionProvider: 'prov two' }).model.key, 'p2/two');
  assert.match(pick({ sessionModelId: 'nope' }).reason, /nope/u);
  assert.match(pick({}).reason, /还不知道/u);
  assert.match(core.resolveBackgroundModel({ models: [], sessionModelId: 'one' }).reason, /models\.list 为空/u);
  assert.equal(core.lowestThinkingLevel(models[1]), 'off');
  assert.equal(core.lowestThinkingLevel(models[2]), 'minimal');
  assert.equal(core.lowestThinkingLevel({ thinkingLevels: ['medium', 'high'] }), 'medium');
  assert.equal(core.lowestThinkingLevel({ thinkingLevels: ['max', 'xhigh'] }), 'xhigh');
});

test('没有打开项目的会话：cwd 落在 ~/.pi-desktop/scratch 下（宿主 extensionCwd 的回退）', () => {
  const home = path.join(os.tmpdir(), 'zcode-home');
  assert.equal(core.isScratchWorkspace(path.join(home, '.pi-desktop', 'scratch', 'abc'), {}, home), true);
  assert.equal(core.isScratchWorkspace(path.join(home, 'projects', 'app'), {}, home), false);
  assert.equal(core.isScratchWorkspace(path.join(home, 'data', 'scratch', 'x'), { PI_DESKTOP_DATA_DIR: path.join(home, 'data') }, home), true);
  assert.equal(core.isScratchWorkspace('', {}, home), true);
});

test('相对时间与上游一致（刚刚 / N 分钟前 / 今天 / 昨天 / 周X / 日期）', () => {
  const now = new Date(2026, 7, 7, 22, 32).getTime();
  const format = (date) => core.formatMemoryUpdatedAt({ now, updatedAt: date.getTime(), locale: 'zh-CN' });
  assert.equal(format(new Date(2026, 7, 7, 22, 31, 31)), '刚刚');
  assert.equal(format(new Date(2026, 7, 7, 22, 20)), '12 分钟前');
  assert.equal(format(new Date(2026, 7, 7, 22, 2)), '今天 22:02');
  assert.equal(format(new Date(2026, 7, 6, 22, 32)), '昨天 22:32');
  assert.equal(format(new Date(2026, 7, 3, 9, 5)), '周一 09:05');
  assert.equal(format(new Date(2026, 6, 20, 9, 5)), '7 月 20 日 09:05');
  assert.equal(format(new Date(2025, 11, 18, 9, 5)), '2025 年 12 月 18 日 09:05');
  assert.equal(format(new Date(2026, 7, 7, 22, 40)), '刚刚');
});

test('安全路径：拒绝穿越、符号链接与大小写别名', async () => {
  const dir = await makeTempDir('fs-safe');
  await fsp.mkdir(path.join(dir, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'memory', 'MEMORY.md'), 'index', 'utf8');
  await fsp.writeFile(path.join(dir, 'secret.txt'), 'secret', 'utf8');
  await assert.rejects(() => safe.readFileInside(path.join(dir, 'memory'), '../secret.txt'), /invalid relative path/u);
  await assert.rejects(() => safe.readFileInside(path.join(dir, 'memory'), 'C:/Windows/win.ini'), /invalid relative path/u);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    await assert.rejects(
      () => safe.readFileInside(path.join(dir, 'memory'), 'MEMORY.MD'),
      /case alias refused/u,
    );
  }
  if (process.platform !== 'win32') {
    await fsp.symlink(path.join(dir, 'secret.txt'), path.join(dir, 'memory', 'link.md'));
    await assert.rejects(() => safe.readFileInside(path.join(dir, 'memory'), 'link.md'), /symlink refused/u);
  }
});

test('Store 转录追加与回合排队（每个会话只保留最新待办）', async () => {
  const dir = await makeTempDir('store');
  const store = new core.Store(dir);
  await store.ensure();
  await store.appendTranscript('demo-0000000000000000', 's1', [
    { id: 'm1', role: 'user', text: '记住：发布前要跑冒烟测试' },
    { id: 'm2', role: 'assistant', text: '好' },
  ]);
  const entries = await store.readTranscript('demo-0000000000000000', 's1');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'm1');
  await store.writeTurn({ sessionId: 's1', projectKey: 'demo-0000000000000000', at: 1 });
  await store.writeTurn({ sessionId: 's1', projectKey: 'demo-0000000000000000', at: 2 });
  const turns = await store.listTurns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].at, 2);
  await store.writeStatus({ extraction: { state: 'running' } });
  assert.equal((await store.readStatus()).extraction.state, 'running');
});