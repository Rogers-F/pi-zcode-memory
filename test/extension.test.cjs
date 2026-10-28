'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fsp = require('node:fs/promises');
const core = require('../lib/core');
const prompts = require('../lib/prompts');
const extension = require('../extension');
const { createCtx, makeTempDir } = require('./helpers/host');

/**
 * PI-Desktop 0.21.0 的扩展钩子清单（resources/agent-runtime/chunks/runner-X4ZX2DU4.js 的 `var Z=[...]`）。
 */
const HOST_HOOKS = [
  'session_start', 'session_shutdown', 'session_info_changed', 'project_trust', 'resources_discover',
  'before_agent_start', 'context', 'before_provider_request', 'before_provider_headers', 'after_provider_response',
  'agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'message_start', 'message_update',
  'message_end', 'tool_call', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'tool_result',
  'model_select', 'thinking_level_select', 'session_before_compact', 'session_compact', 'session_compact_failed',
  'session_before_fork', 'input',
];

async function makeRuntime(settings = {}, options = {}) {
  const storageRoot = await makeTempDir('ext-store');
  const workspace = await makeTempDir('ext-ws');
  const homeDir = await makeTempDir('ext-home');
  const store = new core.Store(storageRoot);
  await store.ensure();
  await fsp.writeFile(store.paths.settingsMirror, JSON.stringify(core.normalizeSettings(settings)), 'utf8');
  const runtime = extension._internals.createRuntime({ storageRoot, homeDir, env: {}, now: options.now });
  const memoryRoot = core.projectMemoryRoot(storageRoot, workspace);
  return { runtime, storageRoot, workspace, homeDir, store, memoryRoot, projectKey: core.projectIdentity(workspace).key };
}

let clock = 1_000;
function user(text) {
  clock += 1;
  return { role: 'user', content: [{ type: 'text', text }], timestamp: clock };
}
function toolCall(id, name = 'Bash', args = { command: 'ls' }) {
  clock += 1;
  return { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse', timestamp: clock };
}
function toolResult(id, name = 'Bash', text = 'ok') {
  clock += 1;
  return { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: clock };
}
function textOf(message) {
  return (message.content || []).map((part) => part.text || '').join('\n');
}

test('扩展只注册宿主存在的钩子', () => {
  const handlers = new Map();
  extension({ on: (name, handler) => handlers.set(name, handler) });
  const names = [...handlers.keys()].sort();
  assert.deepEqual(names, [
    'agent_end', 'before_agent_start', 'context', 'message_end', 'session_compact', 'session_shutdown', 'session_start', 'tool_call', 'tool_result',
  ]);
  for (const name of names) assert.ok(HOST_HOOKS.includes(name), `宿主没有钩子 ${name}`);
});

test('请求前缀：每次请求开头带 Memory 规则与上游 context_prefix 索引；不改系统提示', async () => {
  const { runtime, workspace, memoryRoot } = await makeRuntime();
  const ctx = createCtx({ cwd: workspace, sessionId: 's1' });
  await fsp.mkdir(memoryRoot, { recursive: true });
  const index = '- [Deploy](deploy.md) — release steps';
  await fsp.writeFile(path.join(memoryRoot, 'MEMORY.md'), index, 'utf8');
  runtime.onSessionStart(ctx);
  assert.equal(await runtime.onBeforeAgentStart({ systemPrompt: 'BASE', prompt: 'how do we deploy?' }, ctx), undefined);

  const base = [user('how do we deploy?')];
  const result = runtime.onContext({ messages: base }, ctx);
  assert.equal(result.messages.length, 2);
  const prefix = result.messages[0];
  assert.equal(prefix.role, 'user');
  assert.equal(prefix.content[0].text, prompts.buildMemoryContent(memoryRoot, 'default-index'));
  const expectedIndex = prompts.wrapSystemReminderForSource(
    'context_prefix',
    prompts.buildContextMetaUserBody([prompts.buildRequestUserContextContent(memoryRoot, index)]),
  );
  assert.equal(prefix.content[1].text, expectedIndex);
  assert.match(prefix.content[1].text, /- \[Deploy\]\(deploy\.md\) — release steps/u);
  assert.ok(prefix.content[1].text.endsWith('</system-reminder>\n'), 'context_prefix 结尾多一个换行（上游 system-reminder/source.ts）');
  assert.strictEqual(result.messages[1], base[0], '原消息不变');

  const withSystem = runtime.onContext({ messages: [{ role: 'system', content: 'S', timestamp: 0 }, ...base] }, ctx);
  assert.equal(withSystem.messages[0].role, 'system');
  assert.match(textOf(withSystem.messages[1]), /# Memory/u, '前缀放在宿主 system 记录之后');
});

test('MEMORY.md 每会话只读一次：改文件、压缩都不重读，新会话才读新内容', async () => {
  const { runtime, workspace, memoryRoot } = await makeRuntime();
  const ctx = createCtx({ cwd: workspace, sessionId: 's-index' });
  await fsp.mkdir(memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(memoryRoot, 'MEMORY.md'), '- [Deploy](deploy.md) — release steps', 'utf8');
  runtime.onSessionStart(ctx);
  const base = [user('hello there friend')];
  assert.match(textOf(runtime.onContext({ messages: base }, ctx).messages[0]), /release steps/u);
  await fsp.writeFile(path.join(memoryRoot, 'MEMORY.md'), '- [Changed](x.md) — new line', 'utf8');
  assert.match(textOf(runtime.onContext({ messages: base }, ctx).messages[0]), /release steps/u);
  runtime.onCompact(ctx);
  assert.match(textOf(runtime.onContext({ messages: base }, ctx).messages[0]), /release steps/u, '压缩后仍是会话开始时的索引');
  const other = createCtx({ cwd: workspace, sessionId: 's-index-2' });
  runtime.onSessionStart(other);
  assert.match(textOf(runtime.onContext({ messages: base }, other).messages[0]), /Changed/u);
});

test('语义召回分支：前缀只有规则（没有索引），规则用 semantic-recall 版本', async () => {
  const { runtime, workspace, memoryRoot } = await makeRuntime({ semanticRecall: true });
  const ctx = createCtx({ cwd: workspace, sessionId: 's-sem' });
  await fsp.mkdir(memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(memoryRoot, 'MEMORY.md'), '- [Deploy](deploy.md) — release steps', 'utf8');
  runtime.onSessionStart(ctx);
  const prefix = runtime.onContext({ messages: [user('hi there you')] }, ctx).messages[0];
  assert.equal(prefix.content.length, 1);
  assert.equal(prefix.content[0].text, prompts.buildMemoryContent(memoryRoot, 'semantic-recall'));
});

test('设置在会话开始时冻结：中途改设置只影响新会话', async () => {
  const { runtime, workspace, store, memoryRoot } = await makeRuntime({ semanticRecall: false });
  const ctx = createCtx({ cwd: workspace, sessionId: 's-frozen' });
  runtime.onSessionStart(ctx);
  await fsp.writeFile(store.paths.settingsMirror, JSON.stringify(core.normalizeSettings({ semanticRecall: true })), 'utf8');
  const prefix = runtime.onContext({ messages: [user('hi there you')] }, ctx).messages[0];
  assert.equal(prefix.content[0].text, prompts.buildMemoryContent(memoryRoot, 'default-index'));
  const session = await store.readSession('s-frozen');
  assert.equal(session.settings.semanticRecall, false, '会话记录里是冻结的设置');
  const fresh = createCtx({ cwd: workspace, sessionId: 's-frozen-2' });
  runtime.onSessionStart(fresh);
  const next = runtime.onContext({ messages: [user('hi there you')] }, fresh).messages[0];
  assert.equal(next.content[0].text, prompts.buildMemoryContent(memoryRoot, 'semantic-recall'));
});

test('语义召回：工具批次后附加一次，之后的请求原位保留；压缩后清空', async () => {
  const { runtime, workspace, store, memoryRoot } = await makeRuntime({ semanticRecall: true });
  const ctx = createCtx({ cwd: workspace, sessionId: 's2' });
  await fsp.mkdir(memoryRoot, { recursive: true });
  const deployPath = path.join(memoryRoot, 'deploy.md');
  await fsp.writeFile(deployPath, 'release uses pnpm', 'utf8');
  runtime.onSessionStart(ctx);
  await runtime.onBeforeAgentStart({ prompt: 'how do we release this?' }, ctx);
  const request = JSON.parse(await fsp.readFile(store.recallRequestFile('s2'), 'utf8'));
  assert.equal(request.query, 'how do we release this?');
  assert.equal(request.epoch, 1);
  assert.deepEqual(request.recalledPaths, []);
  await fsp.writeFile(
    store.recallResponseFile('s2'),
    JSON.stringify({ id: request.id, entries: [{ filePath: deployPath, header: `Memory: ${deployPath}:`, content: 'release uses pnpm' }] }),
    'utf8',
  );

  const turn = [user('how do we release this?')];
  assert.equal(runtime.onContext({ messages: turn }, ctx).messages.length, 2, '还没有工具批次：只有前缀');

  const batch1 = [...turn, toolCall('call-1'), toolResult('call-1')];
  runtime.onToolResult({ toolName: 'Bash', toolCallId: 'call-1', input: { command: 'ls' } }, ctx);
  const attached = runtime.onContext({ messages: batch1 }, ctx).messages;
  assert.equal(attached.length, 5);
  assert.equal(attached[3].toolCallId, 'call-1');
  assert.ok(textOf(attached[4]).startsWith('<system-reminder>\nRetrieved for possible relevance'));
  assert.match(textOf(attached[4]), /release uses pnpm/u);

  const batch2 = [...batch1, toolCall('call-2'), toolResult('call-2')];
  runtime.onToolResult({ toolName: 'Bash', toolCallId: 'call-2', input: { command: 'pwd' } }, ctx);
  const later = runtime.onContext({ messages: batch2 }, ctx).messages;
  const reminders = later.filter((message) => textOf(message).includes('Retrieved for possible relevance'));
  assert.equal(reminders.length, 1, '同一结果只附加一次');
  assert.equal(later.indexOf(reminders[0]), 4, '仍然紧跟在 call-1 的工具结果后');

  await runtime.onAgentEnd({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
  await runtime.onBeforeAgentStart({ prompt: 'and the release notes?' }, ctx);
  const second = JSON.parse(await fsp.readFile(store.recallRequestFile('s2'), 'utf8'));
  assert.deepEqual(second.recalledPaths, [deployPath], '已召回的文件随请求带给选择器');
  assert.ok(second.readPaths.includes(deployPath));

  runtime.onCompact(ctx);
  const compacted = runtime.onContext({ messages: batch2 }, ctx).messages;
  assert.ok(!compacted.some((message) => textOf(message).includes('Retrieved for possible relevance')), '压缩后清空');
  await runtime.onBeforeAgentStart({ prompt: 'release it again please' }, ctx);
  const third = JSON.parse(await fsp.readFile(store.recallRequestFile('s2'), 'utf8'));
  assert.equal(third.epoch, 2);
  assert.deepEqual(third.recalledPaths, []);
});

test('召回不阻塞对话：结果未就绪时这一批次不等，下一批次再附加', async () => {
  const { runtime, workspace, store, memoryRoot } = await makeRuntime({ semanticRecall: true });
  const ctx = createCtx({ cwd: workspace, sessionId: 's-async' });
  runtime.onSessionStart(ctx);
  await runtime.onBeforeAgentStart({ prompt: 'how do we release this?' }, ctx);
  const request = JSON.parse(await fsp.readFile(store.recallRequestFile('s-async'), 'utf8'));
  const batch1 = [user('how do we release this?'), toolCall('a1'), toolResult('a1')];
  runtime.onToolResult({ toolName: 'Bash', toolCallId: 'a1', input: {} }, ctx);
  const started = Date.now();
  const first = runtime.onContext({ messages: batch1 }, ctx).messages;
  assert.ok(Date.now() - started < 1000, '不等待选择器');
  assert.equal(first.length, batch1.length + 1, '未就绪：只有前缀');
  const deployPath = path.join(memoryRoot, 'deploy.md');
  await fsp.writeFile(
    store.recallResponseFile('s-async'),
    JSON.stringify({ id: request.id, entries: [{ filePath: deployPath, header: `Memory: ${deployPath}:`, content: 'release uses pnpm' }] }),
    'utf8',
  );
  const batch2 = [...batch1, toolCall('a2'), toolResult('a2')];
  runtime.onToolResult({ toolName: 'Bash', toolCallId: 'a2', input: {} }, ctx);
  const second = runtime.onContext({ messages: batch2 }, ctx).messages;
  const index = second.findIndex((message) => textOf(message).includes('release uses pnpm'));
  assert.equal(second[index - 1].toolCallId, 'a2', '附加在就绪之后的那个批次后面');
});

test('召回：回合结束丢掉未消费的结果；单个词的查询不发起（E1 关闭时中文无空格也不发起）', async () => {
  const { runtime, workspace, store } = await makeRuntime({ semanticRecall: true, strictUpstream: true });
  const ctx = createCtx({ cwd: workspace, sessionId: 's-dispose' });
  runtime.onSessionStart(ctx);
  await runtime.onBeforeAgentStart({ prompt: 'how do we release?' }, ctx);
  const request = JSON.parse(await fsp.readFile(store.recallRequestFile('s-dispose'), 'utf8'));
  runtime.onAgentEnd({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
  await assert.rejects(fsp.readFile(store.recallRequestFile('s-dispose')), '没被认领的请求随回合结束删掉');
  await fsp.writeFile(
    store.recallResponseFile('s-dispose'),
    JSON.stringify({ id: request.id, entries: [{ filePath: '/x/a.md', header: 'Memory: /x/a.md:', content: 'stale' }] }),
    'utf8',
  );
  await runtime.onBeforeAgentStart({ prompt: 'ok' }, ctx);
  await runtime.onBeforeAgentStart({ prompt: '怎么发布这个项目' }, ctx);
  await assert.rejects(fsp.readFile(store.recallRequestFile('s-dispose')), '不合格的查询不写召回请求');
  const messages = [user('ok'), toolCall('c1'), toolResult('c1')];
  runtime.onToolResult({ toolName: 'Bash', toolCallId: 'c1', input: {} }, ctx);
  assert.ok(!runtime.onContext({ messages }, ctx).messages.some((message) => textOf(message).includes('stale')));
});

test('召回：E1 打开时中文无空格的问题也会发起召回', async () => {
  const { runtime, workspace, store } = await makeRuntime({ semanticRecall: true });
  const ctx = createCtx({ cwd: workspace, sessionId: 's-e1' });
  runtime.onSessionStart(ctx);
  await runtime.onBeforeAgentStart({ prompt: '怎么发布这个项目' }, ctx);
  const request = JSON.parse(await fsp.readFile(store.recallRequestFile('s-e1'), 'utf8'));
  assert.equal(request.query, '怎么发布这个项目');
});

test('选择器失败（空结果）时什么都不附加', async () => {
  const { runtime, workspace, store } = await makeRuntime({ semanticRecall: true });
  const ctx = createCtx({ cwd: workspace, sessionId: 's3' });
  runtime.onSessionStart(ctx);
  await runtime.onBeforeAgentStart({ prompt: 'tell me something' }, ctx);
  const request = JSON.parse(await fsp.readFile(store.recallRequestFile('s3'), 'utf8'));
  await fsp.writeFile(store.recallResponseFile('s3'), JSON.stringify({ id: request.id, entries: [], error: 'selector-invalid' }), 'utf8');
  const messages = [user('tell me something'), toolCall('c1'), toolResult('c1')];
  runtime.onToolResult({ toolName: 'Bash', toolCallId: 'c1', input: {} }, ctx);
  const result = runtime.onContext({ messages }, ctx).messages;
  assert.equal(result.length, messages.length + 1, '只有前缀');
});

test('Dream 更新提示只进紧接着的一次请求；MEMORY.md 总算已在上下文里', async () => {
  let now = 50_000;
  const { runtime, workspace, store, memoryRoot, projectKey } = await makeRuntime({}, { now: () => now });
  const ctx = createCtx({ cwd: workspace, sessionId: 's-notice' });
  runtime.onSessionStart(ctx);
  const indexPath = path.join(memoryRoot, 'MEMORY.md');
  const factPath = path.join(memoryRoot, 'deploy.md');
  await store.writeNotice(projectKey, { id: 'old', at: now - 10, paths: [factPath], summary: 'consolidated 1 memory file' });
  assert.ok(!textOf(runtime.onContext({ messages: [user('a b c')] }, ctx).messages.at(-1)).includes('Background memory'), '会话开始前的通知不提示');
  now += 1000;
  await store.writeNotice(projectKey, { id: 'n1', at: now, paths: [indexPath, factPath], summary: 'consolidated 2 memory files' });
  const first = runtime.onContext({ messages: [user('a b c')] }, ctx).messages;
  const notice = textOf(first.at(-1));
  assert.ok(notice.startsWith('<system-reminder>\nBackground memory consolidation updated your memory directory: consolidated 2 memory files'));
  assert.match(notice, new RegExp(`Your loaded copy of ${indexPath.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')} is now stale`, 'u'));
  const second = runtime.onContext({ messages: [user('a b c')] }, ctx).messages;
  assert.ok(!second.some((message) => textOf(message).includes('Background memory')), '只提示一次');
});

test('message_end 写转录（文本分段、工具路径）；agent_end 只在成功的回合留下提取信号', async () => {
  const { runtime, workspace, store } = await makeRuntime();
  const ctx = createCtx({ cwd: workspace, sessionId: 's4' });
  runtime.onSessionStart(ctx);
  runtime.onMessageEnd({ message: { role: 'user', content: [{ type: 'text', text: '记住' }, { type: 'text', text: '部署前要跑冒烟测试' }] } }, ctx);
  runtime.onMessageEnd({ message: toolCall('w1', 'Write', { path: 'notes/a.md', content: 'x' }) }, ctx);
  runtime.onMessageEnd({ message: toolResult('w1', 'Write') }, ctx);
  const session = await store.readSession('s4');
  assert.equal(session.workspacePath, path.resolve(workspace));
  assert.equal(session.modelId, 'model-a');
  assert.equal(session.provider, 'fake');
  const entries = await store.readTranscript(session.projectKey, 's4');
  assert.equal(entries.length, 2, '工具结果不进转录');
  assert.deepEqual(entries[0].textParts, ['记住', '部署前要跑冒烟测试']);
  assert.deepEqual(entries[1].toolCalls, [{ name: 'Write', filePath: path.resolve(workspace, 'notes/a.md') }]);
  assert.ok(entries[0].id && entries[0].id !== entries[1].id);

  runtime.onAgentEnd({ messages: [{ role: 'assistant', stopReason: 'error' }] }, ctx);
  assert.equal((await store.listTurns()).length, 0, '出错的回合不提取');
  runtime.onAgentEnd({ messages: [{ role: 'assistant', stopReason: 'aborted' }] }, ctx);
  assert.equal((await store.listTurns()).length, 0, '中止的回合不提取');
  runtime.onAgentEnd({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
  const turns = await store.listTurns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].sessionId, 's4');
  assert.equal(turns[0].boundaryId, entries[1].id, '提取边界是回合结束时的最后一条消息');
});

test('session_shutdown 留下会话关闭标记（主进程据此按上游有界等待后取消提取）', async () => {
  const { runtime, workspace, store } = await makeRuntime();
  const ctx = createCtx({ cwd: workspace, sessionId: 's-close' });
  runtime.onSessionStart(ctx);
  runtime.onSessionShutdown(ctx);
  const marker = JSON.parse(await fsp.readFile(store.closedFile('s-close'), 'utf8'));
  assert.equal(marker.sessionId, 's-close');
});

test('工作区在会话开始时固定：之后 ctx.cwd 变化不换记忆目录', async () => {
  const { runtime, workspace, store, memoryRoot } = await makeRuntime();
  const ctx = createCtx({ cwd: workspace, sessionId: 's-cwd' });
  runtime.onSessionStart(ctx);
  const moved = { ...ctx, cwd: path.join(workspace, 'packages', 'sub') };
  const prefix = runtime.onContext({ messages: [user('hi there you')] }, moved).messages[0];
  assert.equal(prefix.content[0].text, prompts.buildMemoryContent(memoryRoot, 'default-index'));
  assert.equal((await store.readSession('s-cwd')).workspacePath, path.resolve(workspace));
});

test('关闭自动提取时不留提取信号', async () => {
  const { runtime, workspace, store } = await makeRuntime({ autoExtract: false });
  const ctx = createCtx({ cwd: workspace, sessionId: 's-off' });
  runtime.onSessionStart(ctx);
  runtime.onMessageEnd({ message: user('please remember this fact') }, ctx);
  runtime.onAgentEnd({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
  assert.equal((await store.listTurns()).length, 0);
});

test('没有打开项目（cwd 是会话临时目录）时不启用记忆', async () => {
  const { runtime, homeDir, store } = await makeRuntime();
  const scratch = path.join(homeDir, '.pi-desktop', 'scratch', 'abc');
  await fsp.mkdir(scratch, { recursive: true });
  const ctx = createCtx({ cwd: scratch, sessionId: 's-scratch' });
  runtime.onSessionStart(ctx);
  assert.equal(runtime.onContext({ messages: [user('hi there you')] }, ctx), undefined);
  runtime.onMessageEnd({ message: user('please remember this fact') }, ctx);
  runtime.onAgentEnd({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx);
  assert.equal(await store.readSession('s-scratch'), null);
  assert.equal((await store.listTurns()).length, 0);
});

test('Task 改写：同一参数对象时任务末尾带上代理记忆，tool_result 核对为已生效', async () => {
  const { runtime, workspace, storageRoot, store } = await makeRuntime({ agentMemoryScopes: '{"reviewer":"project"}' });
  const ctx = createCtx({ cwd: workspace, sessionId: 's5' });
  runtime.onSessionStart(ctx);
  const rootDir = core.agentMemoryRoot({ storageRoot, workspaceRoot: workspace, agentName: 'reviewer', scope: 'project' });
  await fsp.mkdir(rootDir, { recursive: true });
  await fsp.writeFile(path.join(rootDir, 'MEMORY.md'), '- [A](a.md) — hook', 'utf8');
  const input = { agent: 'reviewer', task: 'review the change' };
  runtime.onToolCall({ toolName: 'Task', toolCallId: 't1', input }, ctx);
  assert.ok(input.task.startsWith('review the change'));
  assert.match(input.task, /<persistent-agent-memory scope="project" agent="reviewer">/u);
  assert.match(input.task, /- \[A\]\(a\.md\) — hook/u);
  runtime.onToolResult({ toolName: 'Task', toolCallId: 't1', input, isError: false }, ctx);
  const record = await store.readTaskRewrite();
  assert.equal(record.agentName, 'reviewer');
  assert.equal(record.effective, true);

  const again = { agent: 'reviewer', task: input.task };
  runtime.onToolCall({ toolName: 'Task', toolCallId: 't2', input: again }, ctx);
  assert.equal(again.task, input.task, '已带记忆块的任务不重复追加');
  const resumed = { agent: 'reviewer', task: 'continue', resume: 'd-1' };
  runtime.onToolCall({ toolName: 'Task', toolCallId: 't3', input: resumed }, ctx);
  assert.equal(resumed.task, 'continue', '续跑已有子代理时不改写');
  const unknown = { agent: 'explorer', task: 'look around' };
  runtime.onToolCall({ toolName: 'Task', toolCallId: 't4', input: unknown }, ctx);
  assert.equal(unknown.task, 'look around', '没配置作用域的代理不改写');
});

test('Task 改写：宿主把克隆交给扩展时（PI-Desktop 0.21.0 runner）原参数不变，记录为未生效', async () => {
  const { runtime, workspace, store } = await makeRuntime({ agentMemoryScopes: '{"reviewer":"user"}' });
  const ctx = createCtx({ cwd: workspace, sessionId: 's6' });
  runtime.onSessionStart(ctx);
  const original = { agent: 'reviewer', task: 'review the change' };
  // runner-X4ZX2DU4.js：tool_call 是 "result" 类事件，dispatch 先 structuredClone 再交给处理器
  runtime.onToolCall({ toolName: 'Task', toolCallId: 't9', input: structuredClone(original) }, ctx);
  assert.equal(original.task, 'review the change');
  runtime.onToolResult({ toolName: 'Task', toolCallId: 't9', input: structuredClone(original), isError: false }, ctx);
  const record = await store.readTaskRewrite();
  assert.equal(record.effective, false);
});
