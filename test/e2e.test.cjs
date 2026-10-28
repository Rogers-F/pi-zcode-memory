'use strict';

/**
 * 端到端：真实的 main.js（插件主进程）+ 真实的 extension.js（sidecar 扩展），
 * 假宿主（pi.*）与脚本化模型。数据目录放在临时 HOME 下（npm test 由 scripts/test.mjs 重定向）。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const core = require('../lib/core');
const prompts = require('../lib/prompts');
const agent = require('../lib/agent');
const extension = require('../extension');
const main = require('../main');
const { createFakeHost, createExtensionHost, createCtx, makeTempDir, waitFor } = require('./helpers/host');

async function tempHome(prefix) {
  if (process.env.ZCODE_MEMORY_TEST_HOME) return fsp.mkdtemp(path.join(os.homedir(), `${prefix}-`));
  return makeTempDir(prefix);
}

async function makeE2E(options = {}) {
  const homeDir = await tempHome('e2e');
  const storageRoot = core.defaultStorageRoot(homeDir);
  const workspace = path.join(homeDir, 'projects', 'demo-app');
  await fsp.mkdir(workspace, { recursive: true });
  const host = createFakeHost({
    settings: { autoExtract: true, semanticRecall: false, autoDream: false, ...(options.settings || {}) },
    models: options.models,
    rateLimit: options.hostRateLimit,
  });
  const runtime = main._internals.createPluginRuntime({
    pi: host.pi,
    homeDir,
    limiter: options.limiter || core.createRateLimiter({ limit: 1000 }),
    rateLimitBackoffMs: options.rateLimitBackoffMs ?? 1,
    sleep: options.sleep,
    pollMs: 60_000,
    drainTimeoutMs: options.drainTimeoutMs,
  });
  await runtime.start();
  const newExt = () => extension._internals.createRuntime({ homeDir, env: {} });
  return {
    homeDir,
    storageRoot,
    workspace,
    host,
    runtime,
    ext: newExt(),
    newExt,
    memoryRoot: core.projectMemoryRoot(storageRoot, workspace),
    projectKey: core.projectIdentity(workspace).key,
  };
}

let clock = 10_000;
function user(text) {
  clock += 1;
  return { role: 'user', content: [{ type: 'text', text }], timestamp: clock };
}
function assistant(text) {
  clock += 1;
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: clock };
}
function toolCall(id, name = 'Bash', args = { command: 'ls' }) {
  clock += 1;
  return { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse', timestamp: clock };
}
function toolResult(id, name = 'Bash') {
  clock += 1;
  return { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: clock };
}
function textOf(message) {
  return (message.content || []).map((part) => part.text || '').join('\n');
}

function openSession(ext, workspace, sessionId, model) {
  const ctx = createCtx({ cwd: workspace, sessionId, ...(model ? { model } : {}) });
  ext.onSessionStart(ctx);
  return ctx;
}

/** 一个成功结束的回合：用户消息 → 助手回复 → agent_end。 */
function completeTurn(ext, ctx, userText, assistantText = '好的') {
  ext.onMessageEnd({ message: user(userText) }, ctx);
  ext.onMessageEnd({ message: assistant(assistantText) }, ctx);
  ext.onAgentEnd({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
}

async function settle(runtime) {
  await runtime.processTurnJobs();
  await runtime.drainAll();
}

function toolCalls(...calls) {
  return calls.map(([name, input]) => `<tool_call name="${name}">${JSON.stringify(input)}</tool_call>`).join('\n');
}

const DEPLOY_MEMORY = '---\nname: deploy\ndescription: deploy needs a smoke test\nmetadata:\n  type: project\n---\n\nRelease goes through a smoke test first.';
const DEPLOY_INDEX_LINE = '- [Deploy](deploy.md) — smoke test before release';

function scriptDeployWrite(e) {
  e.host.pushResponses(
    toolCalls(
      ['Write', { file_path: path.join(e.memoryRoot, 'deploy.md'), content: DEPLOY_MEMORY }],
      ['Write', { file_path: path.join(e.memoryRoot, 'MEMORY.md'), content: DEPLOY_INDEX_LINE }],
    ),
    'Saved the deploy rule.',
  );
}

test('写入：会话 A 发一句不含空格的中文「记住……」，回合结束后在临时 HOME 下写出记忆文件与 MEMORY.md 行', async (t) => {
  const e = await makeE2E();
  t.after(() => e.runtime.stop());
  if (process.env.ZCODE_MEMORY_TEST_HOME) assert.ok(e.storageRoot.startsWith(os.homedir()), '数据目录在临时 HOME 下');
  const ctx = openSession(e.ext, e.workspace, 'sA');
  scriptDeployWrite(e);
  completeTurn(e.ext, ctx, '记住：部署前要跑冒烟测试');
  await settle(e.runtime);

  const saved = await fsp.readFile(path.join(e.memoryRoot, 'deploy.md'), 'utf8');
  assert.match(saved, /smoke test first/u);
  assert.match(saved, /originSessionId: sA/u, '上游：新记忆补上来源会话');
  const index = await fsp.readFile(path.join(e.memoryRoot, 'MEMORY.md'), 'utf8');
  assert.ok(index.includes(DEPLOY_INDEX_LINE));
  assert.equal((await e.runtime.store.readStatus()).extraction.state, 'success');

  assert.equal(e.host.calls.length, 2);
  const call = e.host.calls[0];
  assert.equal(call.modelKey, 'fake/model-a');
  assert.equal(call.thinkingLevel, 'low');
  assert.ok(call.system.includes(prompts.buildMemoryContent(e.memoryRoot, 'default-index')));
  assert.ok(call.system.length <= 32768);
  assert.deepEqual(call.messages.slice(0, 2), [
    { role: 'user', content: '记住：部署前要跑冒烟测试' },
    { role: 'assistant', content: '好的' },
  ]);
  assert.ok(call.messages[2].content.startsWith(prompts.buildMemoryExtractionPrompt({ manifest: [], messageCount: 2 })));
});

test('写入（严格上游模式）：同一句中文按空白只算 1 个词，不触发提取', async (t) => {
  const e = await makeE2E({ settings: { strictUpstream: true } });
  t.after(() => e.runtime.stop());
  const ctx = openSession(e.ext, e.workspace, 'sA-strict');
  completeTurn(e.ext, ctx, '记住：部署前要跑冒烟测试');
  await settle(e.runtime);
  assert.equal(e.host.calls.length, 0);
});

test('注入：新会话 B 的请求包含这一行索引；会话压缩后的下一次请求仍然包含', async (t) => {
  const e = await makeE2E();
  t.after(() => e.runtime.stop());
  const ctxA = openSession(e.ext, e.workspace, 'sA');
  scriptDeployWrite(e);
  completeTurn(e.ext, ctxA, '记住：部署前要跑冒烟测试');
  await settle(e.runtime);

  const extB = e.newExt();
  const ctxB = openSession(extB, e.workspace, 'sB');
  assert.equal(await extB.onBeforeAgentStart({ systemPrompt: 'BASE', prompt: '部署流程是什么？' }, ctxB), undefined);
  const first = extB.onContext({ messages: [user('部署流程是什么？')] }, ctxB).messages;
  assert.ok(textOf(first[0]).includes(DEPLOY_INDEX_LINE));
  extB.onCompact(ctxB);
  const summary = { role: 'user', content: [{ type: 'text', text: 'Summary of the earlier conversation.' }], timestamp: clock };
  const afterCompact = extB.onContext({ messages: [summary, user('继续')] }, ctxB).messages;
  assert.ok(textOf(afterCompact[0]).includes(DEPLOY_INDEX_LINE));
  assert.equal(afterCompact[1], summary, '压缩后的消息原样保留');
  assert.equal(e.host.calls.length, 2, '注入不调用模型');
});

test('召回：选中记忆的正文在一次完整工具批次后附加且只附加一次；同一会话的选择器对话持续累积', async (t) => {
  const e = await makeE2E({ settings: { semanticRecall: true } });
  t.after(() => e.runtime.stop());
  await fsp.mkdir(e.memoryRoot, { recursive: true });
  await fsp.writeFile(
    path.join(e.memoryRoot, 'deploy.md'),
    '---\nname: deploy\ndescription: release steps\nmetadata:\n  type: project\n---\n\nrelease uses pnpm build',
    'utf8',
  );
  await fsp.writeFile(path.join(e.memoryRoot, 'changelog.md'), '---\ndescription: changelog conventions\n---\n\nkeep a changelog', 'utf8');
  const ctx = openSession(e.ext, e.workspace, 'sC');
  await e.ext.onBeforeAgentStart({ prompt: 'how do we release this?' }, ctx);
  e.host.pushResponses('```json\n{"selected_memories":["deploy.md"]}\n```');
  await e.runtime.processRecallRequests();

  const call = e.host.calls[0];
  assert.equal(call.system, `${prompts.MEMORY_SELECTOR_SYSTEM_PROMPT}\n${prompts.MEMORY_SELECTOR_JSON_INSTRUCTION}`);
  assert.equal(call.messages.length, 2);
  assert.ok(call.messages[0].content.startsWith('Available memories:\n- '));
  assert.match(call.messages[0].content, /^- \[project\] deploy\.md \(\d{4}-\d\d-\d\dT[^)]+\): release steps$/mu);
  assert.match(call.messages[0].content, /^- changelog\.md \(\d{4}-\d\d-\d\dT[^)]+\): changelog conventions$/mu);
  assert.equal(call.messages[1].content, 'Select memories relevant to:\nhow do we release this?');

  const turn = [user('how do we release this?')];
  assert.equal(e.ext.onContext({ messages: turn }, ctx).messages.length, 2, '工具批次之前不附加');
  const batch1 = [...turn, toolCall('c1'), toolResult('c1')];
  e.ext.onToolResult({ toolName: 'Bash', toolCallId: 'c1', input: { command: 'ls' } }, ctx);
  const first = e.ext.onContext({ messages: batch1 }, ctx).messages;
  const batch2 = [...batch1, toolCall('c2'), toolResult('c2')];
  e.ext.onToolResult({ toolName: 'Bash', toolCallId: 'c2', input: { command: 'pwd' } }, ctx);
  const second = e.ext.onContext({ messages: batch2 }, ctx).messages;
  for (const request of [first, second]) {
    const hits = request.filter((message) => textOf(message).includes('release uses pnpm build'));
    assert.equal(hits.length, 1);
  }

  e.ext.onAgentEnd({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
  await e.ext.onBeforeAgentStart({ prompt: 'what about the changelog?' }, ctx);
  e.host.pushResponses('{"selected_memories":[]}');
  await e.runtime.processRecallRequests();
  const sticky = e.host.calls[1];
  assert.deepEqual(
    sticky.messages.map((message) => message.role),
    ['user', 'user', 'assistant', 'user'],
  );
  assert.equal(sticky.messages[0].content, call.messages[0].content, '清单整段复用');
  assert.equal(sticky.messages[3].content, 'Select memories relevant to:\nwhat about the changelog?');
});

test('召回：选择器失败（返回不是 JSON）时什么都不附加', async (t) => {
  const e = await makeE2E({ settings: { semanticRecall: true } });
  t.after(() => e.runtime.stop());
  await fsp.mkdir(e.memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(e.memoryRoot, 'deploy.md'), 'release uses pnpm build', 'utf8');
  const ctx = openSession(e.ext, e.workspace, 'sD');
  await e.ext.onBeforeAgentStart({ prompt: 'again about release' }, ctx);
  e.host.pushResponses('I think deploy.md is relevant.');
  await e.runtime.processRecallRequests();
  const messages = [user('again about release'), toolCall('c1'), toolResult('c1')];
  e.ext.onToolResult({ toolName: 'Bash', toolCallId: 'c1', input: {} }, ctx);
  const request = e.ext.onContext({ messages }, ctx).messages;
  assert.equal(request.length, messages.length + 1, '只有请求前缀');
  assert.equal((await e.runtime.store.readStatus()).recall.reason, 'selector-invalid');
});

test('整理：手动 Dream 把两条重复记忆合并为一条，旧内容进归档并能恢复；打开着的会话收到一次性提示', async (t) => {
  const e = await makeE2E();
  t.after(() => e.runtime.stop());
  await fsp.mkdir(e.memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(e.memoryRoot, 'a.md'), '---\nname: deploy\nmetadata:\n  type: project\n---\n\nrelease needs pnpm', 'utf8');
  await fsp.writeFile(path.join(e.memoryRoot, 'b.md'), '---\nname: deploy-dup\nmetadata:\n  type: project\n---\n\nrelease needs pnpm build', 'utf8');
  const ctx = openSession(e.ext, e.workspace, 'sE');

  e.host.pushResponses(
    toolCalls(
      ['Write', { file_path: path.join(e.memoryRoot, 'a.md'), content: '---\nname: deploy\nmetadata:\n  type: project\n---\n\nrelease needs pnpm build' }],
      ['Bash', { command: `rm "${path.join(e.memoryRoot, 'b.md')}"` }],
    ),
    'Consolidated the duplicate deploy memories.',
  );
  const result = await e.runtime.panel.invoke('dream.run', { projectKey: e.projectKey });
  assert.equal(result.state, 'success', JSON.stringify(result));
  assert.ok(e.host.calls[0].messages[0].content.startsWith('# Dream: Memory Consolidation'));
  const files = (await fsp.readdir(e.memoryRoot)).filter((name) => name.endsWith('.md'));
  assert.deepEqual(files, ['a.md'], '两条合并成一条');

  const archived = await agent.listArchive({ storageRoot: e.storageRoot, projectKey: e.projectKey });
  assert.deepEqual(archived.map((entry) => entry.reason).sort(), ['delete', 'overwrite']);
  const restore = archived.find((entry) => entry.reason === 'delete');
  await e.runtime.panel.invoke('archive.restore', { projectKey: e.projectKey, rel: restore.rel });
  assert.match(await fsp.readFile(path.join(e.memoryRoot, 'b.md'), 'utf8'), /release needs pnpm build/u);

  const next = e.ext.onContext({ messages: [user('hello there friend')] }, ctx).messages;
  assert.match(textOf(next.at(-1)), /^<system-reminder>\nBackground memory consolidation updated your memory directory: consolidated 2 memory files/u);
  const after = e.ext.onContext({ messages: [user('hello there friend')] }, ctx).messages;
  assert.ok(!after.some((message) => textOf(message).includes('Background memory consolidation')), '一次性');
});

test('限流：假宿主每 60 秒 8 次；后台任务撞到限流时延后完成，不丢弃、不报失败', async (t) => {
  let time = 0;
  const e = await makeE2E({
    hostRateLimit: { limit: 8, windowMs: 60_000, now: () => time },
    // 本地限流放宽，逼出宿主的 RATE_LIMITED
    limiter: core.createRateLimiter({ limit: 1000, now: () => time, wait: async (ms) => { time += ms; } }),
    sleep: async (ms) => {
      time += ms;
    },
    rateLimitBackoffMs: 15_000,
  });
  t.after(() => e.runtime.stop());
  await fsp.mkdir(e.memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(e.memoryRoot, 'MEMORY.md'), '- [A](a.md) — a', 'utf8');
  openSession(e.ext, e.workspace, 'sF');
  for (let index = 0; index < 9; index += 1) {
    e.host.pushResponses(toolCalls(['Read', { file_path: path.join(e.memoryRoot, 'MEMORY.md') }]));
  }
  e.host.pushResponses('Nothing to consolidate.');
  const result = await e.runtime.runDream(e.projectKey, { manual: true });
  assert.equal(result.state, 'success');
  assert.equal(e.host.calls.length, 10, '十次调用都完成了');
  assert.ok(e.host.rejected.length >= 1, '途中撞到过宿主限流');
  assert.ok(time >= 60_000, '等到了下一个窗口');
  const status = await e.runtime.store.readStatus();
  assert.equal(status.dream.state, 'success');
  assert.ok(status.rateLimit.attempts >= 1);
});

test('限流：本地按宿主同样的窗口排队，不触发宿主的 RATE_LIMITED', async (t) => {
  let time = 0;
  const e = await makeE2E({
    hostRateLimit: { limit: 8, windowMs: 60_000, now: () => time },
    limiter: core.createRateLimiter({ now: () => time, wait: async (ms) => { time += ms; } }),
  });
  t.after(() => e.runtime.stop());
  await fsp.mkdir(e.memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(e.memoryRoot, 'MEMORY.md'), '- [A](a.md) — a', 'utf8');
  openSession(e.ext, e.workspace, 'sF2');
  for (let index = 0; index < 11; index += 1) {
    e.host.pushResponses(toolCalls(['Read', { file_path: path.join(e.memoryRoot, 'MEMORY.md') }]));
  }
  e.host.pushResponses('Done.');
  const result = await e.runtime.runDream(e.projectKey, { manual: true });
  assert.equal(result.state, 'success');
  assert.equal(e.host.calls.length, 12);
  assert.equal(e.host.rejected.length, 0);
});

test('限流：召回请求不排在 Dream 后面', async (t) => {
  let time = 0;
  const sleepers = [];
  const limiter = core.createRateLimiter({
    limit: 1,
    windowMs: 1000,
    now: () => time,
    wait: (ms) => new Promise((resolve) => sleepers.push({ until: time + ms, resolve })),
  });
  const advance = (ms) => {
    time += ms;
    for (const sleeper of sleepers.splice(0)) {
      if (sleeper.until <= time) sleeper.resolve();
      else sleepers.push(sleeper);
    }
  };
  const e = await makeE2E({ settings: { semanticRecall: true }, limiter });
  t.after(() => e.runtime.stop());
  await fsp.mkdir(e.memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(e.memoryRoot, 'deploy.md'), '---\ndescription: release steps\n---\nrelease uses pnpm', 'utf8');
  const ctx = openSession(e.ext, e.workspace, 'sR');
  e.host.pushResponses(toolCalls(['Read', { file_path: path.join(e.memoryRoot, 'deploy.md') }]));
  const dream = e.runtime.runDream(e.projectKey, { manual: true });
  await waitFor(() => e.host.calls.length === 1);
  await waitFor(() => limiter.stats().queued === 1, { timeoutMs: 2000 });

  await e.ext.onBeforeAgentStart({ prompt: 'how do we release this?' }, ctx);
  e.host.pushResponses('{"selected_memories":["deploy.md"]}', 'Done.');
  const recall = e.runtime.processRecallRequests();
  await waitFor(() => limiter.stats().queued === 2, { timeoutMs: 2000 });

  advance(1000);
  await waitFor(() => e.host.calls.length === 2);
  assert.ok(e.host.calls[1].system.startsWith(prompts.MEMORY_SELECTOR_SYSTEM_PROMPT), '下一个窗口先给召回');
  await recall;
  advance(1000);
  await dream;
  assert.equal(e.host.calls.length, 3);
  assert.ok(e.host.calls[2].messages[0].content.startsWith('# Dream'));
});

test('模型：后台调用用会话模型和最低思考档；设置可覆盖；模型未知时跳过并在面板显示原因', async (t) => {
  const models = [
    { key: 'fake/model-a', providerId: 'fake', providerName: 'Fake', modelId: 'model-a', thinkingLevels: ['low', 'high'], isDefault: true },
    { key: 'fake/model-b', providerId: 'fake', providerName: 'Fake', modelId: 'model-b', thinkingLevels: ['high', 'minimal', 'medium'] },
  ];
  const e = await makeE2E({ models });
  t.after(() => e.runtime.stop());
  const ctx = openSession(e.ext, e.workspace, 'sG', { provider: 'fake', id: 'model-b' });
  completeTurn(e.ext, ctx, 'please remember the release rule');
  await settle(e.runtime);
  assert.equal(e.host.calls[0].modelKey, 'fake/model-b', '用会话模型，不用默认模型');
  assert.equal(e.host.calls[0].thinkingLevel, 'minimal');

  await e.runtime.panel.invoke('settings.set', { key: 'backgroundModel', value: 'fake/model-a' });
  completeTurn(e.ext, ctx, 'please remember the deploy rule too');
  await settle(e.runtime);
  assert.equal(e.host.calls[1].modelKey, 'fake/model-a', '设置覆盖');
  assert.equal(e.host.calls[1].thinkingLevel, 'low');

  const u = await makeE2E({ models });
  t.after(() => u.runtime.stop());
  const unknown = openSession(u.ext, u.workspace, 'sH', { provider: 'fake', id: 'model-x' });
  completeTurn(u.ext, unknown, 'please remember the release rule');
  await settle(u.runtime);
  assert.equal(u.host.calls.length, 0, '模型未知时跳过');
  const status = await u.runtime.panel.invoke('status.get');
  assert.equal(status.model.state, 'skipped');
  assert.match(status.model.reason, /model-x/u);
  assert.equal(status.extraction.state, 'skipped');

  // 用户在宿主里换了模型：session:modelChanged 带来 providerId/modelId，之前的对话没有丢
  u.host.emit('session:modelChanged', { sessionId: 'sH', modelKey: 'fake/model-a', thinkingLevel: 'high' });
  await waitFor(async () => Boolean((await u.runtime.store.readSessionModels()).sH));
  completeTurn(u.ext, unknown, 'and remember the deploy rule');
  await settle(u.runtime);
  assert.equal(u.host.calls.length, 1);
  assert.equal(u.host.calls[0].modelKey, 'fake/model-a');
  assert.match(u.host.calls[0].messages.at(-1).content, /most recent ~4 messages/u, '跳过的那一回合仍在提取范围里');
});

test('计划模式下仍能写记忆文件（写入由插件主进程完成，不经过主代理的工具）', async (t) => {
  const e = await makeE2E();
  t.after(() => e.runtime.stop());
  const ctx = { ...openSession(e.ext, e.workspace, 'sI'), mode: 'plan' };
  e.host.pushResponses(
    toolCalls(['Write', { file_path: path.join(e.memoryRoot, 'plan.md'), content: '---\nname: plan\n---\n\nsmoke test before release' }]),
    'Saved.',
  );
  completeTurn(e.ext, ctx, '记住：发布前必须跑冒烟测试');
  await settle(e.runtime);
  assert.match(await fsp.readFile(path.join(e.memoryRoot, 'plan.md'), 'utf8'), /smoke test before release/u);
});

test('关闭时取消运行中的提取：迟到的结果不落盘，之后的回合不再处理', async (t) => {
  const e = await makeE2E();
  t.after(() => e.runtime.stop());
  const late = path.join(e.memoryRoot, 'late.md');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  e.host.pi.agent.complete = async (input) => {
    e.host.calls.push(input);
    await gate;
    return { text: toolCalls(['Write', { file_path: late, content: '---\nname: late\n---\n\nlate' }]) };
  };
  const ctx = openSession(e.ext, e.workspace, 'sK');
  completeTurn(e.ext, ctx, 'please remember the late rule');
  await e.runtime.processTurnJobs();
  await waitFor(() => e.host.calls.length === 1);
  e.runtime.stop();
  release();
  await e.runtime.drainAll();
  await assert.rejects(() => fsp.stat(late), '迟到的结果不落盘');
  completeTurn(e.ext, ctx, 'please remember another rule');
  await e.runtime.processTurnJobs();
  assert.equal(e.host.calls.length, 1);
});

test('关闭会话：最多等在途提取一段时间（上游 60 秒），然后取消；迟到的结果不落盘', async (t) => {
  const e = await makeE2E({ drainTimeoutMs: 200 });
  t.after(() => e.runtime.stop());
  const late = path.join(e.memoryRoot, 'closed-late.md');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  e.host.pi.agent.complete = async (input) => {
    e.host.calls.push(input);
    if (e.host.calls.length > 1) return { text: 'Nothing to save.' };
    await gate;
    return { text: toolCalls(['Write', { file_path: late, content: '---\nname: late\n---\n\nlate' }]) };
  };
  const ctx = openSession(e.ext, e.workspace, 'sClose');
  completeTurn(e.ext, ctx, 'please remember the closing rule');
  await e.runtime.processTurnJobs();
  await waitFor(() => e.host.calls.length === 1);
  e.ext.onSessionShutdown(ctx);
  await e.runtime.processTurnJobs();
  // 收尾期间会话被恢复（会话 id 不变）并完成一个新回合：信号保留，等收尾结束再处理
  const resumed = e.newExt();
  const ctx2 = openSession(resumed, e.workspace, 'sClose');
  completeTurn(resumed, ctx2, 'please remember the resumed rule');
  await e.runtime.processTurnJobs();
  assert.ok((await e.runtime.store.listTurns()).some((job) => job.sessionId === 'sClose'), '收尾期间的回合没有被丢掉');
  // 等待时限先到：调度器被取消；之后模型才返回
  await new Promise((resolve) => setTimeout(resolve, 400));
  release();
  await e.runtime.drainAll();
  await assert.rejects(() => fsp.stat(late), '取消后迟到的结果不落盘');
  assert.equal(e.runtime._internals.schedulers.has('sClose'), false, '关闭的会话不再占用调度器');
  assert.equal((await e.runtime.store.readStatus()).extraction.state, 'aborted', '面板看到「已取消」');
  // 收尾结束后，恢复的会话的回合照常提取
  await settle(e.runtime);
  assert.equal(e.host.calls.length, 2);
  assert.match(e.host.calls[1].messages.map((message) => message.content).join('\n'), /resumed rule/u);
});

test('自动 Dream：其它会话不足 5 个时跳过并记录原因；10 分钟内不重复扫描（按项目各自节流）', async (t) => {
  const e = await makeE2E({ settings: { autoDream: true, autoExtract: false } });
  t.after(() => e.runtime.stop());
  const ctx = openSession(e.ext, e.workspace, 'sJ');
  completeTurn(e.ext, ctx, 'remember the release smoke test rule');
  await e.runtime.processTurnJobs();
  const status = await waitFor(async () => (await e.runtime.store.readStatus()).dreamAuto);
  assert.equal(status.reason, 'not-enough-sessions');
  const again = await e.runtime.runDream(e.projectKey, { manual: false });
  assert.deepEqual(again, { state: 'skipped', reason: 'scan-throttled' });
  // 另一个项目不受这个项目的扫描节流影响（上游的节流挂在各自的运行时上）
  const otherWorkspace = path.join(e.homeDir, 'projects', 'other-app');
  await fsp.mkdir(otherWorkspace, { recursive: true });
  openSession(e.ext, otherWorkspace, 'sJ2');
  const other = await e.runtime.runDream(core.projectIdentity(otherWorkspace).key, { manual: false });
  assert.equal(other.reason, 'not-enough-sessions');
  assert.equal(e.host.calls.length, 0);
});

test('手动 Dream 可以连着跑：第二次不会被自己刚留下的锁挡住', async (t) => {
  const e = await makeE2E();
  t.after(() => e.runtime.stop());
  await fsp.mkdir(e.memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(e.memoryRoot, 'a.md'), '---\nname: a\n---\n\nfact', 'utf8');
  openSession(e.ext, e.workspace, 'sDream2');
  e.host.pushResponses('Nothing to consolidate.', 'Still nothing to consolidate.');
  assert.equal((await e.runtime.panel.invoke('dream.run', { projectKey: e.projectKey })).state, 'success');
  assert.equal((await e.runtime.panel.invoke('dream.run', { projectKey: e.projectKey })).state, 'success');
  assert.equal(e.host.calls.length, 2);
});

test('消息超出宿主上限时丢最早的消息，但钉住的指令与最后一条始终保留', async (t) => {
  const e = await makeE2E();
  t.after(() => e.runtime.stop());
  const instruction = { role: 'user', content: `# Dream: Memory Consolidation ${'i'.repeat(1000)}` };
  const middle = { role: 'assistant', content: 'm'.repeat(120000) };
  const latest = { role: 'user', content: 'l'.repeat(90000) };
  await e.runtime._internals.complete({
    modelKey: 'fake/model-a',
    thinkingLevel: 'low',
    system: 'S',
    messages: [instruction, middle, latest],
    pinned: [instruction],
  });
  const sent = e.host.calls[0].messages;
  assert.deepEqual(sent.map((message) => message.content.slice(0, 1)), ['#', 'l']);
  assert.ok(sent.reduce((sum, message) => sum + message.content.length, 0) <= 200000);
});

test('提取边界固定在回合结束时：之后才写进来的下一条消息不算进这一次', async (t) => {
  const e = await makeE2E();
  t.after(() => e.runtime.stop());
  const ctx = openSession(e.ext, e.workspace, 'sBoundary');
  completeTurn(e.ext, ctx, 'please remember the release rule');
  // 主进程还没轮询到，用户已经发出下一条消息
  e.ext.onMessageEnd({ message: user('and here is my next question') }, ctx);
  await settle(e.runtime);
  const transcript = e.host.calls[0].messages.slice(0, -1).map((message) => message.content);
  assert.deepEqual(transcript, ['please remember the release rule', '好的']);
});

test('召回：会话关闭之前发出、还没处理的请求不再调用选择器', async (t) => {
  const e = await makeE2E({ settings: { semanticRecall: true } });
  t.after(() => e.runtime.stop());
  await fsp.mkdir(e.memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(e.memoryRoot, 'deploy.md'), 'release uses pnpm build', 'utf8');
  const ctx = openSession(e.ext, e.workspace, 'sClosedRecall');
  await e.ext.onBeforeAgentStart({ prompt: 'how do we release this?' }, ctx);
  e.ext.onSessionShutdown(ctx);
  await e.runtime.processTurnJobs();
  await e.runtime.processRecallRequests();
  await e.runtime.drainAll();
  assert.equal(e.host.calls.length, 0);
  assert.equal(e.runtime._internals.recallStates.has('sClosedRecall'), false);
});

test('E3：提取时预载最相似的记忆正文；严格上游模式不预载', async (t) => {
  const first = await makeE2E();
  t.after(() => first.runtime.stop());
  await fsp.mkdir(first.memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(first.memoryRoot, 'deploy.md'), '---\nname: deploy\ndescription: release steps\n---\n\nrelease uses pnpm build', 'utf8');
  const ctx = openSession(first.ext, first.workspace, 'sM');
  first.host.pushResponses('Nothing to save.');
  completeTurn(first.ext, ctx, 'remember the release build steps for deploy');
  await settle(first.runtime);
  const lastMessage = first.host.calls[0].messages.at(-1).content;
  assert.match(lastMessage, /Existing memory files already loaded for you/u);
  assert.match(lastMessage, /release uses pnpm build/u);

  const strict = await makeE2E({ settings: { strictUpstream: true } });
  t.after(() => strict.runtime.stop());
  await fsp.mkdir(strict.memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(strict.memoryRoot, 'deploy.md'), 'release uses pnpm build', 'utf8');
  const ctx2 = openSession(strict.ext, strict.workspace, 'sN');
  strict.host.pushResponses('Nothing to save.');
  completeTurn(strict.ext, ctx2, 'remember the release build steps for deploy');
  await settle(strict.runtime);
  assert.ok(!strict.host.calls[0].messages.at(-1).content.includes('already loaded for you'));
});

test('自定义代理持久记忆：Task 委派时任务末尾附上该代理的记忆提示与 MEMORY.md（假宿主交出同一参数对象）', async (t) => {
  const e = await makeE2E({ settings: { agentMemoryScopes: '{"reviewer":"project","planner":"user","scout":"local"}' } });
  t.after(() => e.runtime.stop());
  // 真实的 extension.js 入口：通过假 sidecar 注册钩子
  const sidecar = createExtensionHost();
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = e.homeDir;
  process.env.USERPROFILE = e.homeDir;
  t.after(() => {
    process.env.HOME = previousHome.HOME;
    process.env.USERPROFILE = previousHome.USERPROFILE;
  });
  extension(sidecar.api);
  const ctx = createCtx({ cwd: e.workspace, sessionId: 'sTask' });
  await sidecar.emit('session_start', { type: 'session_start' }, ctx);

  const roots = {};
  for (const [agentName, scope] of [['reviewer', 'project'], ['planner', 'user'], ['scout', 'local']]) {
    roots[scope] = core.agentMemoryRoot({ storageRoot: e.storageRoot, workspaceRoot: e.workspace, agentName, scope });
    await fsp.mkdir(roots[scope], { recursive: true });
    await fsp.writeFile(path.join(roots[scope], 'MEMORY.md'), `- [${agentName}](notes.md) — ${scope} notes`, 'utf8');
    const input = { agent: agentName, task: `do the ${scope} job` };
    await sidecar.emit('tool_call', { type: 'tool_call', toolName: 'Task', toolCallId: `t-${scope}`, input }, ctx);
    assert.ok(input.task.startsWith(`do the ${scope} job\n\n---\n\n<persistent-agent-memory scope="${scope}" agent="${agentName}">`));
    assert.ok(input.task.includes(prompts.buildPersistentAgentMemoryPrompt({
      agentName,
      scope,
      rootDir: roots[scope],
      indexContent: `- [${agentName}](notes.md) — ${scope} notes`,
    })));
    assert.ok(input.task.endsWith('</persistent-agent-memory>'));
    await sidecar.emit('tool_result', { type: 'tool_result', toolName: 'Task', toolCallId: `t-${scope}`, input, isError: false }, ctx);
  }
  assert.equal(new Set(Object.values(roots)).size, 3, '三种作用域各有独立目录');
  assert.ok(roots.user.startsWith(e.storageRoot));
  assert.ok(roots.project.startsWith(e.workspace) && roots.local.startsWith(e.workspace));
  const status = await e.runtime.panel.invoke('status.get');
  assert.equal(status.taskRewrite.effective, true);
});
