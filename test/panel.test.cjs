'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fsp = require('node:fs/promises');
const core = require('../lib/core');
const agent = require('../lib/agent');
const panelData = require('../lib/panel-data');
const { createFakeHost, makeTempDir } = require('./helpers/host');
const { JSDOM } = require('jsdom');

async function makeProject() {
  const storageRoot = await makeTempDir('panel-store');
  const workspace = await makeTempDir('panel-ws');
  const identity = core.projectIdentity(workspace);
  const memoryRoot = core.projectMemoryRoot(storageRoot, workspace);
  await fsp.mkdir(memoryRoot, { recursive: true });
  await fsp.writeFile(path.join(memoryRoot, 'MEMORY.md'), '- [Deploy](deploy.md) — smoke test', 'utf8');
  await fsp.writeFile(path.join(memoryRoot, 'deploy.md'), '---\nname: deploy\ndescription: release steps\nmetadata:\n  type: project\n---\n\nsmoke test', 'utf8');
  await panelData.writeProjectMeta(storageRoot, identity.key, { workspacePath: workspace });
  return { storageRoot, workspace, identity, memoryRoot };
}

function createApi(storageRoot, host) {
  let settings = core.normalizeSettings({ autoExtract: true });
  return {
    api: panelData.createPanelApi({
      storageRoot,
      getSettings: async () => settings,
      setSettings: async (key, value) => {
        await host.pi.plugin.setSettings({ [key]: value });
        settings = core.normalizeSettings({ ...settings, [key]: value });
      },
      runDream: async () => ({ state: 'success', files: 1 }),
      runExtraction: async () => ({ state: 'no-op' }),
      store: new core.Store(storageRoot),
    }),
    get settings() {
      return settings;
    },
  };
}

test('面板后端：项目列表、文件列表与相对时间', async () => {
  const { storageRoot, identity } = await makeProject();
  const host = createFakeHost();
  const { api } = createApi(storageRoot, host);
  const status = await api.invoke('status.get', {});
  assert.equal(status.projects.length, 1);
  assert.equal(status.projects[0].count, 1);
  assert.equal(status.projects[0].hasIndex, true);
  const files = await api.invoke('files.list', { projectKey: identity.key });
  assert.deepEqual(files.files.map((file) => file.rel), ['MEMORY.md', 'deploy.md']);
  assert.match(files.files[1].updatedAt, /刚刚|分钟前|今天|昨天|周|月/u);
  assert.equal(files.files[1].type, 'project');
  const filtered = await api.invoke('files.list', { projectKey: identity.key, query: 'deploy' });
  assert.equal(filtered.files.length, 1);
});

test('面板后端：只读预览与 5 MiB 上限、路径穿越与大小写别名拒绝', async () => {
  const { storageRoot, identity, memoryRoot } = await makeProject();
  const host = createFakeHost();
  const { api } = createApi(storageRoot, host);
  const preview = await api.invoke('file.read', { projectKey: identity.key, rel: 'deploy.md' });
  assert.match(preview.file.content, /smoke test/u);

  await assert.rejects(() => api.invoke('file.read', { projectKey: identity.key, rel: '../secret.md' }), /invalid relative path/u);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    await assert.rejects(() => api.invoke('file.read', { projectKey: identity.key, rel: 'DEPLOY.MD' }), /case alias refused/u);
  }
  await assert.rejects(() => api.invoke('file.read', { projectKey: identity.key, rel: 'deploy.txt' }), /only \.md/u);
  if (process.platform !== 'win32') {
    await fsp.symlink(path.join(memoryRoot, 'deploy.md'), path.join(memoryRoot, 'link.md'));
    await assert.rejects(() => api.invoke('file.read', { projectKey: identity.key, rel: 'link.md' }), /symlink refused/u);
  }
  await assert.rejects(() => api.invoke('file.read', { projectKey: '..', rel: 'deploy.md' }), /invalid project key/u);

  const big = path.join(memoryRoot, 'big.md');
  await fsp.writeFile(big, 'x'.repeat(5 * 1024 * 1024 + 10));
  await assert.rejects(() => api.invoke('file.read', { projectKey: identity.key, rel: 'big.md' }), /too large/u);
});

test('面板后端：归档恢复与彻底删除通道', async () => {
  const { storageRoot, identity, memoryRoot } = await makeProject();
  const host = createFakeHost();
  const { api } = createApi(storageRoot, host);
  const file = path.join(memoryRoot, 'deploy.md');
  await agent.archiveMemoryFile({ storageRoot, projectKey: identity.key, memoryRoot, filePath: file, reason: 'overwrite' });
  const listed = await api.invoke('archive.list', { projectKey: identity.key });
  assert.equal(listed.entries.length, 1);
  await fsp.rm(file);
  const restored = await api.invoke('archive.restore', { projectKey: identity.key, rel: listed.entries[0].rel });
  assert.ok(restored.ok);
  assert.match(await fsp.readFile(file, 'utf8'), /smoke test/u);
});

test('面板后端：设置写入走宿主 plugin.setSettings', async () => {
  const { storageRoot } = await makeProject();
  const host = createFakeHost();
  const created = createApi(storageRoot, host);
  await created.api.invoke('settings.set', { key: 'semanticRecall', value: true });
  assert.equal(host.settings.semanticRecall, true);
  assert.equal(created.settings.semanticRecall, true);
  await assert.rejects(() => created.api.invoke('settings.set', { key: 'nope', value: 1 }), /unknown setting/u);
  await assert.rejects(() => created.api.invoke('settings.set', { key: 'semanticRecall', value: 'yes' }), /expects boolean/u);
});

// ------------------------------------------------------------
// 前端（jsdom）
// ------------------------------------------------------------

function makeDom(overrides = {}) {
  const root = path.join(__dirname, '..', 'renderer');
  const html = fs
    .readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace('<script src="panel.js"></script>', '');
  const calls = [];
  const responses = {
    'status.get': async () => ({
      settings: { autoExtract: true, semanticRecall: false, improveE1: true },
      projects: [{ key: 'demo-0000000000000000', name: 'demo', count: 2 }],
      extraction: { state: 'idle' },
      dream: { state: 'idle' },
      model: { state: 'ok', modelKey: 'fake/model-a' },
    }),
    'files.list': async () => ({
      files: [
        { rel: 'MEMORY.md', name: 'MEMORY.md', isIndex: true, updatedAt: '刚刚', type: '', description: '' },
        { rel: 'deploy.md', name: 'deploy.md', isIndex: false, updatedAt: '今天 10:00', type: 'project', description: 'release steps' },
      ],
    }),
    'file.read': async () => ({
      file: {
        rel: 'deploy.md',
        content: '# Title\n<script>window.hacked = 1</script>\n**bold** and `code`\n- item',
        updatedAt: '今天 10:00',
      },
    }),
    'archive.list': async () => ({ entries: [] }),
    'settings.set': async (payload) => ({ settings: { ...(await responses['status.get']()).settings, [payload.key]: payload.value } }),
    'dream.run': async () => ({ state: 'success' }),
    ...overrides,
  };
  const dom = new JSDOM(html, {
    url: 'file:///panel/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true });
  dom.window.pluginBridge = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      const handler = responses[channel];
      if (!handler) throw new Error(`unexpected channel ${channel}`);
      return handler(payload || {});
    },
  };
  dom.window.eval(fs.readFileSync(path.join(root, 'panel.js'), 'utf8'));
  return { dom, calls, responses };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('面板前端：渲染开关与文件列表，点击文件安全预览', async () => {
  const { dom } = makeDom();
  await dom.window.__zcodeMemoryPanel.refreshAll();
  await tick();
  const document = dom.window.document;
  assert.equal(document.querySelectorAll('#settings .toggle').length, 9);
  assert.equal(document.getElementById('setting-autoExtract').checked, true);
  assert.equal(document.getElementById('setting-semanticRecall').checked, false);
  const buttons = [...document.querySelectorAll('#files button')];
  assert.equal(buttons.length, 2);
  assert.match(document.getElementById('count').textContent, /1 条记忆/u);
  assert.equal(document.getElementById('empty').hidden, true);

  buttons[1].click();
  await tick();
  await tick();
  const preview = document.getElementById('preview');
  assert.match(preview.textContent, /Title/u);
  assert.match(preview.textContent, /bold/u);
  assert.match(preview.textContent, /code/u);
  assert.equal(preview.querySelectorAll('script').length, 0);
  assert.equal(dom.window.hacked, undefined);
  assert.equal(preview.querySelector('strong').textContent, 'bold');
  assert.equal(preview.querySelector('code').textContent, 'code');
  assert.equal(document.getElementById('file-name').textContent, 'deploy.md');
});

test('面板前端：切换开关调用 settings.set，Dream 按钮调用 dream.run', async () => {
  const { dom, calls } = makeDom();
  await dom.window.__zcodeMemoryPanel.refreshAll();
  await tick();
  const toggle = dom.window.document.getElementById('setting-semanticRecall');
  toggle.checked = true;
  toggle.dispatchEvent(new dom.window.Event('change'));
  await tick();
  assert.ok(calls.some((call) => call.channel === 'settings.set' && call.payload.key === 'semanticRecall' && call.payload.value === true));

  dom.window.document.getElementById('dream').click();
  await tick();
  assert.ok(calls.some((call) => call.channel === 'dream.run'));
});

test('面板前端：归档条目可恢复与彻底删除', async () => {
  const entry = { rel: 'deploy.1.md', reason: 'overwrite', deletionDate: '2026-01-02T03:04:05' };
  const { dom, calls } = makeDom({
    'archive.list': async () => ({ entries: [entry] }),
    'archive.restore': async () => ({ ok: true }),
    'archive.purge': async () => ({ ok: true }),
  });
  await dom.window.__zcodeMemoryPanel.refreshAll();
  await tick();
  const block = dom.window.document.getElementById('archive-block');
  assert.equal(block.hidden, false);
  const buttons = [...block.querySelectorAll('button')];
  buttons[0].click();
  await tick();
  assert.ok(calls.some((call) => call.channel === 'archive.restore' && call.payload.rel === entry.rel));
  buttons[1].click();
  await tick();
  assert.ok(calls.some((call) => call.channel === 'archive.purge' && call.payload.rel === entry.rel));
});

test('面板前端：状态栏显示提取、Dream 与模型跳过原因', async () => {
  const { dom } = makeDom({
    'status.get': async () => ({
      settings: { autoExtract: true },
      projects: [],
      extraction: { state: 'error', error: 'boom' },
      dream: { state: 'skipped', reason: 'not-enough-sessions' },
      model: { state: 'skipped', reason: '没有可用的模型' },
    }),
  });
  await dom.window.__zcodeMemoryPanel.refreshAll();
  await tick();
  const status = dom.window.document.getElementById('status');
  assert.match(status.textContent, /error|出错/u);
  assert.match(status.textContent, /没有可用的模型/u);
});

test('面板 HTML 带 CSP，且不引用远程资源', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /default-src 'none'/u);
  assert.ok(!/https?:\/\//.test(html));
});