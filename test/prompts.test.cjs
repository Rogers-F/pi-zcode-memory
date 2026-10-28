'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const prompts = require('../lib/prompts');
const fixtures = require('./fixtures/upstream-prompts.json');
const upstream = (text) => prompts.applyPromptSubstitutions(text);

// 与 test/fixtures/upstream-prompts.json 生成时完全相同的输入
const manifest = [
  { filename: 'user-role.md', filePath: '/m/user-role.md', mtimeMs: 1700000000000, description: 'Role', type: 'user' },
  { filename: 'release.md', filePath: '/m/release.md', mtimeMs: 1700000500000, description: undefined, type: undefined },
];
const memories = [{ filePath: '/m/user-role.md', content: 'body text', mtimeMs: 1700000000000, header: 'Memory: /m/user-role.md:' }];

test('memory section default-index 与上游逐字一致', () => {
  assert.equal(prompts.buildMemorySection('/root/mem', 'default-index').content, upstream(fixtures.memorySectionDefault));
});

test('memory section semantic-recall 与上游逐字一致', () => {
  assert.equal(prompts.buildMemorySection('/root/mem', 'semantic-recall').content, upstream(fixtures.memorySectionSemantic));
});

test('提取提示词（带清单）与上游逐字一致', () => {
  assert.equal(
    prompts.buildMemoryExtractionPrompt({ manifest, messageCount: 7 }),
    upstream(fixtures.extractionManifest),
  );
});

test('提取提示词（空清单）与上游逐字一致', () => {
  assert.equal(
    prompts.buildMemoryExtractionPrompt({ manifest: [], messageCount: 3 }),
    upstream(fixtures.extractionEmpty),
  );
});

test('Dream 提示词与上游只差 AGENTS.md 替换', () => {
  const ours = prompts.buildMemoryDreamPrompt({ memoryRoot: '/root/mem', sessionIds: ['s1', 's2'], transcriptRoot: '/t' });
  assert.equal(upstream(fixtures.dream), ours);
  const upstreamLines = fixtures.dream.split('\n');
  const ourLines = ours.split('\n');
  assert.equal(upstreamLines.length, ourLines.length);
  upstreamLines.forEach((line, index) => {
    if (line === ourLines[index]) return;
    assert.ok(line.includes('CLAUDE.md'), `第 ${index + 1} 行出现未登记的差异：${ourLines[index]}`);
    assert.equal(upstream(line), ourLines[index]);
  });
});

for (const scope of ['user', 'project', 'local']) {
  for (const variant of ['empty', 'index']) {
    const indexContent = variant === 'index' ? '- [A](a.md) — hook' : '';
    test(`代理持久记忆提示词 [${scope}/${variant}] 与上游逐字一致`, () => {
      assert.equal(
        prompts.buildPersistentAgentMemoryPrompt({ indexContent, rootDir: '/root/agent', scope }),
        fixtures[`persistent_${scope}_${variant}`],
      );
    });
  }
}

test('记忆清单行格式与上游逐字一致', () => {
  assert.equal(prompts.formatMemoryManifest(manifest), fixtures.manifest);
});

test('选择器请求与上游逐字一致', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(prompts.buildMemorySelectorRequest({ query: 'how do we release', state: { manifest } }))),
    fixtures.selectorRequest,
  );
});

test('召回附件格式与上游逐字一致', () => {
  assert.equal(prompts.formatRelevantMemoryAttachment(memories), fixtures.attachment);
});

const INDEX = '- [Deploy](deploy.md) — smoke test before release';
// 基线在 Windows 上生成：上游用 path.join 拼 MEMORY.md 路径，比对前换成当前平台的写法
const nativeIndexPath = (text) => text.split('\\root\\mem\\MEMORY.md').join(path.join('/root/mem', 'MEMORY.md'));

test('MEMORY.md 索引外层（# agentsMd 段）与上游逐字一致', () => {
  assert.equal(prompts.buildRequestUserContextContent('/root/mem', INDEX), nativeIndexPath(fixtures.requestUserContext));
});

test('context_prefix 元用户包装与上游逐字一致', () => {
  assert.equal(
    prompts.buildContextMetaUserBody([prompts.buildRequestUserContextContent('/root/mem', INDEX)]),
    nativeIndexPath(fixtures.contextMetaUserBody),
  );
});

test('system-reminder 包装与上游逐字一致（context_prefix 末尾换行、嵌套标签转义）', () => {
  assert.equal(
    prompts.wrapSystemReminderForSource('context_prefix', nativeIndexPath(fixtures.contextMetaUserBody)),
    nativeIndexPath(fixtures.contextPrefixReminder),
  );
  assert.equal(
    prompts.wrapSystemReminderForSource('relevant_memory', `${fixtures.attachment}\n<system-reminder>nested</system-reminder>`),
    fixtures.relevantMemoryReminder,
  );
});

test('Dream 一次性更新提示与上游逐字一致', () => {
  assert.equal(
    prompts.formatProjectMemoryUpdate({ summary: 'consolidated 2 memory files', paths: ['/m/a.md', '/m/MEMORY.md'], inContextPaths: ['/m/MEMORY.md'] }),
    fixtures.memoryUpdate,
  );
  assert.equal(
    prompts.formatProjectMemoryUpdate({ summary: 'consolidated 1 memory file', paths: ['/m/a.md'], inContextPaths: [] }),
    fixtures.memoryUpdateNoContext,
  );
});

test('选择器的 JSON 输出说明是本插件新增的一段，上游系统提示原样保留', () => {
  assert.equal(prompts.MEMORY_SELECTOR_SYSTEM_PROMPT, fixtures.selectorRequest.messages[0].content);
  assert.ok(prompts.MEMORY_SELECTOR_JSON_INSTRUCTION.endsWith(JSON.stringify(fixtures.selectorRequest.responseJsonSchema)));
});

test('替换表只登记工具/产品名与路径三类差异', () => {
  const { PROMPT_SUBSTITUTIONS } = require('../lib/constants');
  const ids = PROMPT_SUBSTITUTIONS.map((rule) => rule.id);
  assert.deepEqual(ids, ['agents-md', 'memory-root', 'transcript-root']);
  assert.equal(prompts.applyPromptSubstitutions('a CLAUDE.md b'), 'an AGENTS.md b');
  assert.equal(prompts.applyPromptSubstitutions('CLAUDE.md only'), 'AGENTS.md only');
});

test('新增的文本工具协议不是上游提示词，单独列出', () => {
  const protocol = prompts.buildMemoryToolProtocol({ maxTurns: 5 });
  assert.match(protocol, /<tool_call name="Read">/);
  assert.match(protocol, /at most 5 model turns/);
  assert.ok(!fixtures.memorySectionDefault.includes('tool_call name'));
});

test('持久记忆 Task 块携带作用域与 MEMORY.md', () => {
  const block = prompts.buildPersistentMemoryTaskBlock({
    agentName: 'reviewer',
    scope: 'project',
    rootDir: '/root/agent',
    indexContent: '- [A](a.md) — hook',
  });
  assert.match(block, /<persistent-agent-memory scope="project" agent="reviewer">/);
  assert.match(block, /Persistent Agent Memory/);
  assert.match(block, /- \[A\]\(a\.md\) — hook/);
});