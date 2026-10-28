'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const memory = require('../lib/memory');
const { LIMITS } = require('../lib/constants');
const { makeTempDir } = require('./helpers/host');

async function writeFile(dir, rel, content) {
  const full = path.join(dir, ...rel.split('/'));
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
}

test('frontmatter 解析 description 与 metadata.type', () => {
  const parsed = memory.parseFrontmatter('---\nname: x\ndescription: release steps\nmetadata:\n  type: project\n---\nbody');
  assert.equal(parsed.data.description, 'release steps');
  assert.equal(parsed.data.metadata.type, 'project');
  assert.equal(parsed.body, 'body');
});

test('写入记忆时补 node_type 与 originSessionId（幂等）', () => {
  const root = 'C:\\mem';
  const filePath = path.join(root, 'deploy.md');
  const content = '---\nname: deploy\ndescription: release\nmetadata:\n  type: project\n---\n\nbody';
  const stamped = memory.stampMemoryOriginSessionId({ content, filePath, memoryRoot: root, sessionId: 's1' });
  assert.match(stamped, /metadata:\n {2}node_type: memory\n {2}originSessionId: s1\n {2}type: project/u);
  const twice = memory.stampMemoryOriginSessionId({ content: stamped, filePath, memoryRoot: root, sessionId: 's2' });
  assert.equal(twice, stamped);
});

test('originSessionId 保留已有值与 CRLF', () => {
  const root = 'C:\\mem';
  const filePath = path.join(root, 'a.md');
  const content = '---\r\nname: a\r\nmetadata:\r\n  originSessionId: keep\r\n---\r\nbody';
  const stamped = memory.stampMemoryOriginSessionId({ content, filePath, memoryRoot: root, sessionId: 'new' });
  assert.equal(stamped, content);
  const crlf = '---\r\nname: b\r\nmetadata:\r\n  type: user\r\n---\r\nbody';
  const next = memory.stampMemoryOriginSessionId({ content: crlf, filePath: path.join(root, 'b.md'), memoryRoot: root, sessionId: 's9' });
  assert.ok(next.includes('\r\n  originSessionId: s9'));
  assert.ok(!/[^\r]\n/u.test(next));
});

test('记忆根外的文件不写 originSessionId', () => {
  const content = '---\nname: x\n---\nbody';
  const outside = memory.stampMemoryOriginSessionId({
    content,
    filePath: 'C:\\other\\x.md',
    memoryRoot: 'C:\\mem',
    sessionId: 's1',
  });
  assert.equal(outside, content);
});

test('索引剥离 frontmatter 与顶层注释，保留列表/引用/代码里的注释', () => {
  const input = [
    '---',
    'name: x',
    '---',
    '<!-- top-level -->',
    '- [A](a.md) — hook <!-- keep in list -->',
    '> <!-- keep in quote -->',
    '```',
    '<!-- keep in code -->',
    '```',
  ].join('\n');
  const formatted = memory.formatProjectMemoryIndexContent(input);
  assert.ok(!formatted.includes('top-level'));
  assert.ok(formatted.includes('<!-- keep in list -->'));
  assert.ok(formatted.includes('<!-- keep in quote -->'));
  assert.ok(formatted.includes('<!-- keep in code -->'));
});

test('索引超过 200 行时截断并附上游警告', () => {
  const lines = Array.from({ length: 201 }, (_, index) => `- item ${index}`);
  const formatted = memory.formatMemoryIndexContent(lines.join('\n'));
  assert.ok(formatted.includes('- item 199'));
  assert.ok(!formatted.includes('- item 200'));
  assert.match(formatted, /> WARNING: MEMORY\.md is 201 lines \(limit: 200\)/u);
});

test('索引超过 25000 字符时按字符限制截断', () => {
  const long = 'x'.repeat(LIMITS.MEMORY_INDEX_CHARACTER_LIMIT + 500);
  const formatted = memory.formatMemoryIndexContent(long);
  assert.ok(formatted.length < LIMITS.MEMORY_INDEX_CHARACTER_LIMIT + 400);
  assert.match(formatted, /WARNING: MEMORY\.md is/u);
  assert.match(formatted, /index entries are too long/u);
});

test('清单扫描：跳过 MEMORY.md、按时间倒序、读取 description/type', async () => {
  const root = await makeTempDir('manifest');
  await writeFile(root, 'MEMORY.md', '- [A](a.md) — hook');
  await writeFile(root, 'a.md', '---\ndescription: first\nmetadata:\n  type: user\n---\nx');
  await writeFile(root, 'nested/b.md', '---\ndescription: second\n---\ny');
  await writeFile(root, 'notes.txt', 'not memory');
  const old = new Date(Date.now() - 3600000);
  await fsp.utimes(path.join(root, 'a.md'), old, old);
  const manifest = await memory.scanMemoryManifest({ rootDir: root });
  assert.deepEqual(manifest.map((entry) => entry.filename), ['nested/b.md', 'a.md']);
  assert.equal(manifest[1].description, 'first');
  assert.equal(manifest[1].type, 'user');
});

test('E1：中文按 Unicode 词边界计数，英文与上游一致', () => {
  const chinese = '记住：部署前要跑冒烟测试';
  assert.equal(memory.countWords(chinese), 1);
  assert.ok(memory.countWordsCjkAware(chinese) >= 3);
  const english = 'remember that deploys need smoke tests';
  assert.equal(memory.countWords(english), memory.countWordsCjkAware(english));
  assert.equal(memory.countWordsForGate(chinese, false), 1);
  assert.ok(memory.countWordsForGate(chinese, true) >= 3);
});

test('提取门槛：无用户散文跳过、直接写记忆跳过、正常运行', () => {
  const memoryRoot = path.join('C:', 'mem');
  const entries = [
    { id: 'm1', role: 'user', text: 'ok' },
    { id: 'm2', role: 'assistant', text: 'done' },
  ];
  let decision = memory.evaluateMemoryExtraction({ entries, memoryRoot, improveE1: true });
  assert.equal(decision.decision, 'skip');
  assert.equal(decision.reason, 'no-user-prose');

  const prose = [{ id: 'm1', role: 'user', text: '记住：部署前要跑冒烟测试' }];
  decision = memory.evaluateMemoryExtraction({ entries: prose, memoryRoot, improveE1: true });
  assert.equal(decision.decision, 'run');
  decision = memory.evaluateMemoryExtraction({ entries: prose, memoryRoot, improveE1: false });
  assert.equal(decision.decision, 'skip');

  const direct = [
    { id: 'm1', role: 'user', text: 'remember this deploy detail' },
    { id: 'm2', role: 'assistant', text: '', toolCalls: [{ name: 'Write', filePath: path.join(memoryRoot, 'x.md') }] },
  ];
  decision = memory.evaluateMemoryExtraction({ entries: direct, memoryRoot, improveE1: true });
  assert.equal(decision.reason, 'direct-memory-write');
});

test('调度器：一个运行中 + 一个最新待办；判定用处理时的游标；跳过推进游标，出错不推进', async () => {
  const executed = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const scheduler = memory.createMemoryExtractionScheduler(async ({ snapshot, messageCount }) => {
    executed.push([snapshot.boundaryId, messageCount]);
    if (snapshot.boundaryId === 'm1') await gate;
    if (snapshot.boundaryId === 'm5') throw new Error('boom');
    return 'success';
  });
  const memoryRoot = path.join(os.tmpdir(), 'zcode-mem-root');
  const entry = (id, text) => ({ id, role: 'user', text });
  const snap = (entries) => ({ entries, memoryRoot, improveE1: true, boundaryId: entries.at(-1).id });
  const e1 = [entry('m1', 'remember one two three')];
  const e2 = [...e1, entry('m2', 'and four five six')];
  const e3 = [...e2, entry('m3', 'seven eight nine')];
  scheduler.schedule(snap(e1));
  scheduler.schedule(snap(e2));
  scheduler.schedule(snap(e3));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executed.length, 1, '同一时间只跑一个');
  release();
  await scheduler.drain();
  assert.deepEqual(executed, [['m1', 1], ['m3', 2]], '中间的待办被最新的替换；数量按处理时的游标算');
  assert.equal(scheduler.getCursor(), 'm3');

  const e4 = [...e3, entry('m4', 'ok')];
  scheduler.schedule(snap(e4));
  await scheduler.drain();
  assert.equal(executed.length, 2, '没有够长的用户消息：跳过');
  assert.equal(scheduler.getCursor(), 'm4', '跳过也推进游标');

  const e5 = [...e4, entry('m5', 'remember ten eleven twelve')];
  scheduler.schedule(snap(e5));
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), 'm4', '出错不推进');

  const e7 = [
    ...e5,
    { id: 'm6', role: 'assistant', text: '', toolCalls: [{ name: 'Write', filePath: path.join(memoryRoot, 'x.md') }] },
    entry('m7', 'remember thirteen fourteen fifteen'),
  ];
  scheduler.schedule(snap(e7));
  await scheduler.drain();
  assert.equal(executed.length, 3, '本轮已直接写过记忆目录：跳过');
  assert.equal(scheduler.getCursor(), 'm7');
  scheduler.shutdown();
});

test('调度器：关闭后取消运行中的任务，迟到的结果不推进游标，之后的排队被忽略', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let sawAbort = false;
  const scheduler = memory.createMemoryExtractionScheduler(async ({ abortSignal }) => {
    await gate;
    sawAbort = abortSignal.aborted;
    return 'success';
  });
  const entries = [{ id: 'm1', role: 'user', text: 'remember one two three' }];
  scheduler.schedule({ entries, memoryRoot: os.tmpdir(), improveE1: true, boundaryId: 'm1' });
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.shutdown();
  release();
  await scheduler.drain();
  assert.ok(sawAbort, '执行函数拿到的是已取消的信号');
  assert.equal(scheduler.getCursor(), undefined);
  scheduler.schedule({ entries, memoryRoot: os.tmpdir(), improveE1: true, boundaryId: 'm1' });
  assert.equal(scheduler.hasPendingWork(), false);
});

test('提取判定：游标找不到时按全部消息计数；按文本分段判断 3 个词', () => {
  const memoryRoot = path.join(os.tmpdir(), 'zcode-mem-root');
  const entries = [
    { id: 'a', role: 'user', text: 'hello there friend' },
    { id: 'b', role: 'assistant', text: 'hi' },
  ];
  assert.deepEqual(memory.evaluateMemoryExtraction({ entries, cursorId: 'gone', memoryRoot }), { decision: 'run', messageCount: 2 });
  assert.equal(memory.evaluateMemoryExtraction({ entries, cursorId: 'a', memoryRoot }).reason, 'no-user-prose');
  const split = [{ id: 'c', role: 'user', text: 'one two\nthree', textParts: ['one two', 'three'] }];
  assert.equal(memory.evaluateMemoryExtraction({ entries: split, memoryRoot }).decision, 'skip', '每段都不到 3 个词');
});

test('Dream 时间门槛：24 小时内不扫，10 分钟内不重复扫', () => {
  const nowMs = 10 * 86400000;
  assert.equal(memory.evaluateAutoDreamTiming({ lastConsolidatedAtMs: nowMs - 3600000, lastScanAtMs: 0, nowMs }).reason, 'minimum-interval');
  assert.equal(memory.evaluateAutoDreamTiming({ lastConsolidatedAtMs: nowMs - 2 * 86400000, lastScanAtMs: nowMs - 60000, nowMs }).reason, 'scan-throttled');
  assert.equal(memory.evaluateAutoDreamTiming({ lastConsolidatedAtMs: nowMs - 2 * 86400000, lastScanAtMs: nowMs - 700000, nowMs }).decision, 'scan');
});

test('Dream 锁：活进程未过期时拒绝，失败可恢复原 mtime', async () => {
  const root = await makeTempDir('dream');
  const first = await memory.acquireDreamLock({ memoryRoot: root, nowMs: Date.now(), pid: process.ppid });
  assert.notEqual(first, null);
  const blocked = await memory.acquireDreamLock({ memoryRoot: root, nowMs: Date.now(), pid: process.pid });
  assert.equal(blocked, null);
  await memory.restoreDreamLockAfterFailure({ memoryRoot: root, priorMtimeMs: first });
  const third = await memory.acquireDreamLock({ memoryRoot: root, nowMs: Date.now(), pid: process.pid });
  assert.notEqual(third, null);
  assert.equal(await memory.readDreamLastConsolidatedAt(root) > 0, true);
});

test('Dream 锁：自己持有的新鲜锁按上游拒绝重入；手动 Dream 可以重入', async () => {
  const root = await makeTempDir('dream-own');
  assert.notEqual(await memory.acquireDreamLock({ memoryRoot: root, nowMs: Date.now(), pid: process.pid }), null);
  assert.equal(await memory.acquireDreamLock({ memoryRoot: root, nowMs: Date.now(), pid: process.pid }), null, '与上游一致');
  assert.notEqual(await memory.acquireDreamLock({ memoryRoot: root, nowMs: Date.now(), pid: process.pid, reentrant: true }), null);
  await fsp.writeFile(path.join(root, '.consolidate-lock'), String(process.ppid), 'utf8');
  assert.equal(
    await memory.acquireDreamLock({ memoryRoot: root, nowMs: Date.now(), pid: process.pid, reentrant: true }),
    null,
    '别的活进程持有的锁仍然拒绝',
  );
});

test('召回：4096 字节截断提示、过期提醒与最多 5 个', async () => {
  const root = await makeTempDir('recall');
  await writeFile(root, 'big.md', ('x'.repeat(99) + '\n').repeat(60));
  await writeFile(root, 'old.md', 'old fact');
  const past = new Date(Date.now() - 5 * 86400000);
  await fsp.utimes(path.join(root, 'old.md'), past, past);
  const manifest = await memory.scanMemoryManifest({ rootDir: root });
  const memories = await memory.readRecalledMemories({ entries: manifest, rootDir: root, nowMs: Date.now() });
  const big = memories.find((item) => item.filePath.endsWith('big.md'));
  assert.match(big.content, /This memory file was truncated \(4096 byte limit\)/u);
  const old = memories.find((item) => item.filePath.endsWith('old.md'));
  assert.match(old.header, /This memory is 5 days old/u);
  const many = Array.from({ length: 8 }, (_, index) => ({ filename: `f${index}.md`, filePath: `f${index}.md`, mtimeMs: index }));
  const filtered = memory.filterMemorySelections({
    manifest: many,
    selectedFilenames: many.map((entry) => entry.filename),
    recalledPaths: new Set(),
  });
  assert.equal(filtered.length, 5);
});

test('召回预算 61440 字符用尽后停止', () => {
  const state = memory.createRecallState();
  assert.equal(memory.canStartMemoryRecall(state), true);
  memory.recordRecalledMemories(state, [{ filePath: 'a.md', content: 'x'.repeat(60000) }]);
  assert.equal(memory.canStartMemoryRecall(state), true);
  memory.recordRecalledMemories(state, [{ filePath: 'b.md', content: 'x'.repeat(2000) }]);
  assert.equal(memory.canStartMemoryRecall(state), false);
});

test('E2 混合排序把相关旧记忆排进前 5', () => {
  const dataset = require('./fixtures/eval-dataset.json');
  const order = memory.rankManifestCandidates(dataset.e2.memories, dataset.e2.queries[0].query);
  assert.ok(order.slice(0, 5).some((entry) => entry.filename === 'deploy.md'), order.slice(0, 5).map((e) => e.filename).join(','));
  const recency = [...dataset.e2.memories].sort((a, b) => b.mtimeMs - a.mtimeMs);
  assert.ok(!recency.slice(0, 5).some((entry) => entry.filename === 'deploy.md'));
});
test('清单最多 200 条，预览只读前 30 行', async () => {
  const root = await makeTempDir('manifest-cap');
  for (let index = 0; index < 205; index += 1) {
    await fsp.writeFile(path.join(root, `f${String(index).padStart(3, '0')}.md`), `body ${index}`, 'utf8');
  }
  const late = path.join(root, 'late.md');
  await fsp.writeFile(late, ['---', 'name: late', ...Array.from({ length: 30 }, (_, index) => `# line ${index}`), 'description: too late', '---', 'body'].join('\n'), 'utf8');
  const manifest = await memory.scanMemoryManifest({ rootDir: root });
  assert.equal(manifest.length, 200);
  const lateEntry = manifest.find((entry) => entry.filename === 'late.md');
  assert.ok(lateEntry);
  assert.equal(lateEntry.description, undefined);
});