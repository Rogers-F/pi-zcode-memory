/* 面板：经典脚本（file:// 下不加载 ES module），只通过 pluginBridge 与主进程通信。 */
(function () {
  'use strict';

  var SETTING_LABELS = [
    ['autoExtract', '自动提取记忆'],
    ['semanticRecall', '语义召回'],
    ['autoDream', '自动整理（Dream）'],
    ['strictUpstream', '严格上游模式'],
    ['improveE1', 'E1 中文感知门槛'],
    ['improveE2', 'E2 召回混合排序'],
    ['improveE3', 'E3 预载相似记忆'],
    ['improveE4', 'E4 改写前归档'],
    ['taskRewrite', 'Task 注入代理记忆'],
  ];

  var EN = {
    title: 'ZCode Memory',
    subtitle: 'Long-term workspace context, reused in new sessions.',
    refresh: 'Refresh',
    search: 'Search memory files…',
    empty: 'No saved workspace memory yet',
    selectFile: 'Select a memory file to preview it.',
    count: function (n) { return n + ' memories'; },
    archive: 'Archive',
    dream: 'Consolidate now (Dream)',
    restore: 'Restore',
    purge: 'Delete permanently',
    loading: 'Loading…',
    noWorkspace: 'No workspace yet',
    extraction: 'Extraction',
    dreamState: 'Dream',
    model: 'Model',
    idle: 'idle',
    running: 'running',
    skipped: 'skipped',
    error: 'error',
    success: 'done',
    'no-op': 'nothing to save',
    aborted: 'cancelled',
    ok: 'done',
    recall: 'Recall',
    rateLimited: 'host model-call limit reached, will continue shortly',
    taskRewrite: 'Task agent memory',
    taskRewriteOn: 'attached',
    taskRewriteOff: 'not applied (the host copies tool arguments before plugins see them; see README)',
  };

  var ZH = {
    title: 'ZCode 记忆',
    subtitle: '在工作区中保存并复用长期上下文，新会话生效。',
    refresh: '刷新',
    search: '搜索记忆文件…',
    empty: '暂无已保存的工作区记忆',
    selectFile: '选择一个记忆文件以查看内容。',
    count: function (n) { return n + ' 条记忆'; },
    archive: '归档',
    dream: '立即整理（Dream）',
    restore: '恢复',
    purge: '彻底删除',
    loading: '正在加载…',
    noWorkspace: '还没有工作区',
    extraction: '提取',
    dreamState: 'Dream',
    model: '模型',
    idle: '空闲',
    running: '运行中',
    skipped: '已跳过',
    error: '出错',
    success: '完成',
    'no-op': '没有要保存的内容',
    aborted: '已取消',
    ok: '完成',
    recall: '召回',
    rateLimited: '模型调用达到宿主限额，稍后自动继续',
    taskRewrite: 'Task 代理记忆',
    taskRewriteOn: '已附加',
    taskRewriteOff: '未生效（宿主把工具参数复制后才交给插件，见 README）',
  };

  var locale = (navigator.language || 'zh-CN').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  var t = locale === 'zh' ? ZH : EN;

  var state = {
    settings: {},
    projects: [],
    projectKey: '',
    files: [],
    file: null,
    archive: [],
    status: {},
    query: '',
    error: '',
  };

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === 'text') node.textContent = props.text;
        else if (key === 'className') node.className = props[key];
        else if (key === 'style') node.style.cssText = props[key];
        else if (key === 'onClick') node.addEventListener('click', props[key]);
        else if (props[key] !== undefined && props[key] !== null) node.setAttribute(key, String(props[key]));
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  /** 只读 Markdown：全部用 textContent，绝不写 innerHTML，也不加载远程资源。 */
  function renderInline(parent, text) {
    var pattern = /(`[^`]*`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    var last = 0;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      var token = match[0];
      if (token.charAt(0) === '`') parent.appendChild(el('code', { text: token.slice(1, -1) }));
      else if (token.slice(0, 2) === '**') parent.appendChild(el('strong', { text: token.slice(2, -2) }));
      else parent.appendChild(el('em', { text: token.slice(1, -1) }));
      last = match.index + token.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderMarkdown(container, source) {
    container.textContent = '';
    var lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
    var index = 0;
    var currentList = null;
    var paragraph = null;
    function flush() {
      if (paragraph) {
        container.appendChild(paragraph);
        paragraph = null;
      }
      currentList = null;
    }
    while (index < lines.length) {
      var line = lines[index];
      var fence = /^```(.*)$/.exec(line);
      if (fence) {
        flush();
        var code = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        index += 1;
        var pre = el('pre', {}, [el('code', { text: code.join('\n') })]);
        container.appendChild(pre);
        continue;
      }
      if (/^\s*$/.test(line)) { flush(); index += 1; continue; }
      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        var level = Math.min(3, heading[1].length);
        var headingNode = el('h' + level, {});
        renderInline(headingNode, heading[2]);
        container.appendChild(headingNode);
        index += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        flush();
        var quote = el('blockquote', {});
        renderInline(quote, line.replace(/^>\s?/, ''));
        container.appendChild(quote);
        index += 1;
        continue;
      }
      if (/^\s*(?:-|\*|\d+\.)\s+/.test(line)) {
        if (!currentList) {
          if (paragraph) { container.appendChild(paragraph); paragraph = null; }
          currentList = el('ul', {});
          container.appendChild(currentList);
        }
        var item = el('li', {});
        renderInline(item, line.replace(/^\s*(?:-|\*|\d+\.)\s+/, ''));
        currentList.appendChild(item);
        index += 1;
        continue;
      }
      if (/^---+$/.test(line)) {
        flush();
        container.appendChild(el('hr', {}));
        index += 1;
        continue;
      }
      if (!paragraph) paragraph = el('p', {});
      else paragraph.appendChild(document.createTextNode(' '));
      renderInline(paragraph, line);
      index += 1;
    }
    flush();
  }

  function invoke(channel, payload) {
    if (!window.pluginBridge || typeof window.pluginBridge.invoke !== 'function') {
      return Promise.reject(new Error('pluginBridge is unavailable'));
    }
    return window.pluginBridge.invoke(channel, payload || {});
  }

  function setStatus(text, kind) {
    var node = document.getElementById('status');
    if (!node) return;
    node.textContent = text || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }

  function renderSettings() {
    var host = document.getElementById('settings');
    if (!host) return;
    host.textContent = '';
    SETTING_LABELS.forEach(function (pair) {
      var key = pair[0];
      var input = el('input', { type: 'checkbox', id: 'setting-' + key });
      input.checked = state.settings[key] === true;
      input.addEventListener('change', function () {
        var next = input.checked;
        state.settings[key] = next;
        invoke('settings.set', { key: key, value: next })
          .then(function (result) {
            state.settings = result.settings || state.settings;
            renderSettings();
            renderStatus();
          })
          .catch(function (error) {
            input.checked = !next;
            state.settings[key] = !next;
            setStatus(String(error && error.message ? error.message : error), 'error');
          });
      });
      var label = el('label', { className: 'toggle' }, [input, el('span', { text: pair[1] })]);
      host.appendChild(label);
    });
  }

  function renderWorkspaces() {
    var select = document.getElementById('workspace');
    if (!select) return;
    select.textContent = '';
    if (state.projects.length === 0) {
      select.appendChild(el('option', { value: '', text: t.noWorkspace }));
      return;
    }
    state.projects.forEach(function (project) {
      var option = el('option', {
        value: project.key,
        text: (project.name || project.key) + ' · ' + t.count(project.count),
      });
      if (project.key === state.projectKey) option.selected = true;
      select.appendChild(option);
    });
  }

  function renderFiles() {
    var list = document.getElementById('files');
    var empty = document.getElementById('empty');
    var count = document.getElementById('count');
    if (!list) return;
    list.textContent = '';
    if (count) count.textContent = t.count(state.files.filter(function (file) { return !file.isIndex; }).length);
    if (state.files.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    state.files.forEach(function (file) {
      var button = el('button', { type: 'button', 'aria-current': state.file && state.file.rel === file.rel ? 'true' : 'false' }, [
        el('span', { className: 'name', text: file.name }),
        el('span', { className: 'meta', text: (file.type ? '[' + file.type + '] ' : '') + file.updatedAt }),
      ]);
      button.addEventListener('click', function () { openFile(file.rel); });
      list.appendChild(el('li', {}, [button]));
    });
  }

  function renderFile() {
    var preview = document.getElementById('preview');
    var name = document.getElementById('file-name');
    var time = document.getElementById('file-time');
    if (!preview) return;
    if (!state.file) {
      preview.textContent = '';
      if (name) name.textContent = t.selectFile;
      if (time) time.textContent = '';
      return;
    }
    if (name) name.textContent = state.file.rel;
    if (time) time.textContent = state.file.updatedAt || '';
    renderMarkdown(preview, state.file.content);
  }

  function renderArchive() {
    var block = document.getElementById('archive-block');
    var list = document.getElementById('archive');
    if (!block || !list) return;
    list.textContent = '';
    if (state.archive.length === 0) {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    state.archive.forEach(function (entry) {
      var name = el('span', { className: 'name', text: entry.rel });
      var meta = el('span', { className: 'meta', text: (entry.reason || '') + ' · ' + (entry.deletionDate || '') });
      var restore = el('button', { type: 'button', text: t.restore });
      var purge = el('button', { type: 'button', text: t.purge });
      restore.addEventListener('click', function () {
        invoke('archive.restore', { projectKey: state.projectKey, rel: entry.rel })
          .then(function () { return refreshAll(); })
          .catch(function (error) { setStatus(String(error && error.message ? error.message : error), 'error'); });
      });
      purge.addEventListener('click', function () {
        invoke('archive.purge', { projectKey: state.projectKey, rel: entry.rel })
          .then(function () { return refreshAll(); })
          .catch(function (error) { setStatus(String(error && error.message ? error.message : error), 'error'); });
      });
      list.appendChild(el('li', { className: 'row' }, [el('div', { className: 'row-main' }, [name, meta]), restore, purge]));
    });
  }

  function renderStatus() {
    var status = state.status || {};
    var parts = [];
    var extraction = status.extraction || {};
    parts.push(t.extraction + ': ' + (t[extraction.state] || extraction.state || t.idle) + (extraction.reason ? ' (' + extraction.reason + ')' : ''));
    if (extraction.error) parts.push('⚠ ' + extraction.error);
    var dream = status.dream || {};
    parts.push(t.dreamState + ': ' + (t[dream.state] || dream.state || t.idle) + (dream.reason ? ' (' + dream.reason + ')' : ''));
    var recall = status.recall || {};
    if (state.settings.semanticRecall && recall.state && recall.state !== 'idle') {
      parts.push(t.recall + ': ' + (t[recall.state] || recall.state) + (recall.reason ? ' (' + recall.reason + ')' : ''));
    }
    var model = status.model || {};
    if (model.state === 'skipped') parts.push(t.model + ': ' + (model.reason || t.skipped));
    else if (model.modelKey) parts.push(t.model + ': ' + model.modelKey);
    var warn = model.state === 'skipped';
    var rateLimit = status.rateLimit;
    if (rateLimit && rateLimit.waitingSince && Date.now() - rateLimit.waitingSince < 120000) parts.push(t.rateLimited);
    var task = status.taskRewrite;
    if (task && task.effective === false) {
      parts.push(t.taskRewrite + ' ' + task.agentName + ': ' + t.taskRewriteOff);
      warn = true;
    } else if (task && task.effective === true) {
      parts.push(t.taskRewrite + ' ' + task.agentName + ': ' + t.taskRewriteOn);
    }
    if (state.error) {
      setStatus(state.error, 'error');
      return;
    }
    setStatus(parts.join(' · '), warn ? 'warn' : '');
  }

  function render() {
    document.getElementById('title').textContent = t.title;
    document.getElementById('subtitle').textContent = t.subtitle;
    document.getElementById('refresh').textContent = t.refresh;
    document.getElementById('search').placeholder = t.search;
    document.getElementById('dream').textContent = t.dream;
    document.getElementById('empty').textContent = t.empty;
    renderSettings();
    renderWorkspaces();
    renderFiles();
    renderFile();
    renderArchive();
    renderStatus();
  }

  function openFile(rel) {
    if (!state.projectKey) return Promise.resolve();
    return invoke('file.read', { projectKey: state.projectKey, rel: rel })
      .then(function (result) {
        state.file = result.file;
        var row = state.files.filter(function (file) { return file.rel === rel; })[0];
        if (row) state.file.updatedAt = row.updatedAt;
        renderFiles();
        renderFile();
      })
      .catch(function (error) {
        state.file = null;
        renderFile();
        setStatus(String(error && error.message ? error.message : error), 'error');
      });
  }

  function loadFiles() {
    if (!state.projectKey) {
      state.files = [];
      return Promise.resolve();
    }
    return invoke('files.list', { projectKey: state.projectKey, query: state.query })
      .then(function (result) {
        state.files = result.files || [];
        renderFiles();
        return invoke('archive.list', { projectKey: state.projectKey });
      })
      .then(function (result) {
        state.archive = (result && result.entries) || [];
        renderArchive();
      })
      .catch(function (error) {
        state.error = String(error && error.message ? error.message : error);
        renderStatus();
      });
  }

  function refreshAll() {
    state.error = '';
    return invoke('status.get')
      .then(function (result) {
        state.status = result;
        state.settings = result.settings || {};
        state.projects = result.projects || [];
        if (!state.projectKey || !state.projects.some(function (project) { return project.key === state.projectKey; })) {
          state.projectKey = state.projects.length > 0 ? state.projects[0].key : '';
        }
        render();
        return loadFiles();
      });
  }

  function init() {
    var search = document.getElementById('search');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        state.query = search.value;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { loadFiles(); }, 150);
      });
    }
    var select = document.getElementById('workspace');
    if (select) {
      select.addEventListener('change', function () {
        state.projectKey = select.value;
        state.file = null;
        loadFiles().then(renderFile);
      });
    }
    var refresh = document.getElementById('refresh');
    if (refresh) refresh.addEventListener('click', function () { refreshAll(); });
    var dream = document.getElementById('dream');
    if (dream) {
      dream.addEventListener('click', function () {
        if (!state.projectKey) return;
        dream.disabled = true;
        setStatus(t.dreamState + '…');
        invoke('dream.run', { projectKey: state.projectKey })
          .then(function (result) {
            setStatus(t.dreamState + ': ' + (t[result.state] || result.state), result.state === 'error' ? 'error' : '');
            return refreshAll();
          })
          .catch(function (error) { setStatus(String(error && error.message ? error.message : error), 'error'); })
          .then(function () { dream.disabled = false; });
      });
    }
    return refreshAll();
  }

  window.__zcodeMemoryPanel = {
    state: state,
    t: t,
    render: render,
    renderMarkdown: renderMarkdown,
    refreshAll: refreshAll,
    init: init,
    setStatus: setStatus,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();