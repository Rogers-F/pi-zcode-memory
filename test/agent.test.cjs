'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fsp = require('node:fs/promises');
const agent = require('../lib/agent');
const { makeTempDir } = require('./helpers/host');

async function makeLayout() {
  const dir = await makeTempDir('agent');
  const memoryRoot = path.join(dir, 'mem');
  const storageRoot = path.join(dir, 'store');
  await fsp.mkdir(memoryRoot, { recursive: true });
  return { dir, memoryRoot, storageRoot };
}

function runner(layout, overrides = {}) {
  return new agent.ToolRunner({
    memoryRoot: layout.memoryRoot,
    workspaceRoot: layout.dir,
    storageRoot: layout.storageRoot,
    projectKey: 'demo',
    sessionId: 's1',
    improveE4: true,
    ...overrides,
  });
}

test('解析文本工具调用，容忍 JSON 前后的解释文字', () => {
  const text = 'Thinking.\n<tool_call name="Read">{"file_path":"C:/mem/a.md"}</tool_call>\n<tool_call name="Grep">{"pattern":"x","path":"C:/mem"}</tool_call>';
  const calls = agent.parseToolCalls(text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'Read');
  assert.deepEqual(agent.parseToolInput(calls[0]), { file_path: 'C:/mem/a.md' });
  assert.equal(agent.stripToolCalls(text), 'Thinking.');
  assert.deepEqual(
    agent.parseToolInput({ name: 'Write', raw: 'here: {"file_path":"a.md","content":"x"} done' }),
    { file_path: 'a.md', content: 'x' },
  );
});

test('Read 返回带行号内容，Edit 需要先 Read', async () => {
  const layout = await makeLayout();
  const file = path.join(layout.memoryRoot, 'note.md');
  await fsp.writeFile(file, '---\nname: note\nmetadata:\n  type: user\n---\n\nbody\n', 'utf8');
  const tools = runner(layout);
  const read = await tools.run({ name: 'Read', raw: JSON.stringify({ file_path: file }) });
  assert.equal(read.isError, false);
  assert.match(read.text, /1\t---/u);

  const edit = await tools.run({ name: 'Edit', raw: JSON.stringify({ file_path: file, old_string: 'body', new_string: 'new body' }) });
  assert.equal(edit.isError, false);
  const content = await fsp.readFile(file, 'utf8');
  assert.match(content, /new body/u);
  assert.match(content, /originSessionId: s1/u);
});

test('未读先改与越界写入都被拒绝', async () => {
  const layout = await makeLayout();
  const file = path.join(layout.memoryRoot, 'note.md');
  await fsp.writeFile(file, 'body', 'utf8');
  const tools = runner(layout);
  const edit = await tools.run({ name: 'Edit', raw: JSON.stringify({ file_path: file, old_string: 'body', new_string: 'x' }) });
  assert.equal(edit.isError, true);
  assert.match(edit.text, /requires a prior Read/u);

  const outside = await tools.run({ name: 'Write', raw: JSON.stringify({ file_path: path.join(layout.dir, 'outside.md'), content: 'x' }) });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /only Read, Grep, Glob/u);

  const txt = await tools.run({ name: 'Write', raw: JSON.stringify({ file_path: path.join(layout.memoryRoot, 'x.txt'), content: 'x' }) });
  assert.equal(txt.isError, true);
});

test('E4：改写前把旧版本放进 FreeDesktop 回收站布局并可恢复', async () => {
  const layout = await makeLayout();
  const file = path.join(layout.memoryRoot, 'deploy.md');
  await fsp.writeFile(file, '---\nname: deploy\nmetadata:\n  type: project\n---\n\nold body\n', 'utf8');
  const tools = runner(layout);
  await tools.run({ name: 'Write', raw: JSON.stringify({ file_path: file, content: '---\nname: deploy\nmetadata:\n  type: project\n---\n\nnew body\n' }) });
  const entries = await agent.listArchive({ storageRoot: layout.storageRoot, projectKey: 'demo' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, 'overwrite');
  assert.equal(path.normalize(entries[0].originalPath), path.normalize(file));
  assert.match(entries[0].deletionDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u);
  const archived = await fsp.readFile(path.join(layout.storageRoot, 'archive', 'demo', 'files', ...entries[0].rel.split('/')), 'utf8');
  assert.match(archived, /old body/u);

  await fsp.rm(file);
  const restored = await agent.restoreArchiveEntry({ storageRoot: layout.storageRoot, projectKey: 'demo', rel: entries[0].rel });
  assert.equal(path.normalize(restored.restoredTo), path.normalize(file));
  assert.match(await fsp.readFile(file, 'utf8'), /old body/u);
});

test('关闭 E4 时改写不归档', async () => {
  const layout = await makeLayout();
  const file = path.join(layout.memoryRoot, 'a.md');
  await fsp.writeFile(file, 'body', 'utf8');
  const tools = runner(layout, { improveE4: false });
  await tools.run({ name: 'Write', raw: JSON.stringify({ file_path: file, content: 'next' }) });
  assert.deepEqual(await agent.listArchive({ storageRoot: layout.storageRoot, projectKey: 'demo' }), []);
});

test('Bash：只读子集可用，写操作与目录参数受限', async () => {
  const layout = await makeLayout();
  const file = path.join(layout.memoryRoot, 'a.md');
  await fsp.writeFile(file, 'alpha\nbeta\n', 'utf8');
  const tools = runner(layout);
  assert.equal((await tools.run({ name: 'Bash', raw: JSON.stringify({ command: `cat "${file}"` }) })).isError, false);
  assert.equal((await tools.run({ name: 'Bash', raw: JSON.stringify({ command: `wc "${file}"` }) })).isError, false);
  assert.match((await tools.run({ name: 'Bash', raw: JSON.stringify({ command: `head -n 1 "${file}"` }) })).text, /alpha/u);
  assert.equal((await tools.run({ name: 'Bash', raw: JSON.stringify({ command: 'echo x > out.txt' }) })).isError, true);
  assert.equal((await tools.run({ name: 'Bash', raw: JSON.stringify({ command: `python "${file}"` }) })).isError, true);
  assert.equal((await tools.run({ name: 'Bash', raw: JSON.stringify({ command: `rm -r "${file}"` }) })).isError, true);
  assert.equal((await tools.run({ name: 'Bash', raw: JSON.stringify({ command: `rm "${path.join(layout.dir, 'nope.md')}"` }) })).isError, true);
});

test('Bash rm 记忆目录内 .md 时先归档', async () => {
  const layout = await makeLayout();
  const file = path.join(layout.memoryRoot, 'gone.md');
  await fsp.writeFile(file, 'content', 'utf8');
  const tools = runner(layout);
  const result = await tools.run({ name: 'Bash', raw: JSON.stringify({ command: `rm "${file}"` }) });
  assert.equal(result.isError, false, result.text);
  await assert.rejects(() => fsp.stat(file));
  const entries = await agent.listArchive({ storageRoot: layout.storageRoot, projectKey: 'demo' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, 'delete');
  await agent.purgeArchiveEntry({ storageRoot: layout.storageRoot, projectKey: 'demo', rel: entries[0].rel });
  assert.deepEqual(await agent.listArchive({ storageRoot: layout.storageRoot, projectKey: 'demo' }), []);
});

test('Grep 与 Glob 在记忆目录内检索', async () => {
  const layout = await makeLayout();
  await fsp.mkdir(path.join(layout.memoryRoot, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(layout.memoryRoot, 'a.md'), 'release notes\nsmoke test', 'utf8');
  await fsp.writeFile(path.join(layout.memoryRoot, 'nested', 'b.md'), 'nothing here', 'utf8');
  const tools = runner(layout);
  const grep = await tools.run({ name: 'Grep', raw: JSON.stringify({ pattern: 'smoke\\s+test', path: layout.memoryRoot, glob: '**/*.md' }) });
  assert.equal(grep.isError, false);
  assert.match(grep.text, /a\.md:2:smoke test/u);
  const glob = await tools.run({ name: 'Glob', raw: JSON.stringify({ pattern: '**/*.md', path: layout.memoryRoot }) });
  assert.match(glob.text, /a\.md/u);
  assert.match(glob.text, /nested\/b\.md/u);
});

test('回收站 info 解析 Path 百分比编码', () => {
  const info = agent.parseTrashInfo('[Trash Info]\nPath=C:/Users/me/.pi-desktop/zcode-memory/memories/a%20b/x.md\nDeletionDate=2026-01-02T03:04:05\nX-ZCodeMemory-Reason=delete\n');
  assert.equal(info.originalPath, 'C:/Users/me/.pi-desktop/zcode-memory/memories/a b/x.md');
  assert.equal(info.reason, 'delete');
});
test('记忆整理循环不超过 maxTurns', async () => {
  const layout = await makeLayout();
  let calls = 0;
  const loop = await agent.runMemoryAgentLoop({
    complete: async () => {
      calls += 1;
      return { text: '<tool_call name="Read">{"file_path":"' + path.join(layout.memoryRoot, 'missing.md') + '"}</tool_call>' };
    },
    system: 'system',
    messages: [{ role: 'user', content: 'go' }],
    maxTurns: 3,
    toolRunner: runner(layout),
  });
  assert.equal(calls, 3);
  assert.equal(loop.turns, 3);
});