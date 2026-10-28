'use strict';

/**
 * Trusted agent extension：跑在会话 sidecar（resources/agent-runtime/sidecar.js）里。
 *
 * 宿主事实（PI-Desktop 0.21.0，源码位置见 docs/对齐矩阵.md）：
 * - `context` 钩子在每次模型请求前都会调用（pi-agent-core 的 transformContext），
 *   返回的消息只用于这一次请求，不写回会话。
 * - 系统提示在会话里以 system 消息记账：每次改动都追加一条并发给模型；路径类工具
 *   （Read/Write/Edit…）执行前宿主会重组系统提示，扩展在 before_agent_start 里加的内容
 *   随即被撤掉。所以本扩展不改系统提示，而是在每次请求的开头放一份「请求前缀」，
 *   对应上游 meta_user / context_prefix 的放法；不进会话记录、位置固定、利于缓存。
 * - `tool_call` 事件在派发前被 structuredClone，原地改写参数不会传到工具执行。
 *
 * 本扩展做的事：
 * - 会话开始时固定工作区、冻结设置、预建记忆目录；MEMORY.md 每会话只读一次。
 * - 每次请求：请求前缀（记忆规则 + 上游 context_prefix 索引）、召回附件、Dream 更新提示。
 * - message_end 记转录；agent_end（成功的回合）留下提取信号，提取在插件主进程做。
 * - Task 委派时把代理持久记忆追到任务文本末尾，并在 tool_result 里核对是否真的生效。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./lib/core');
const prompts = require('./lib/prompts');
const memory = require('./lib/memory');
const { LIMITS } = require('./lib/constants');

const MEMORY_INDEX_FILENAME = 'MEMORY.md';
const TASK_MEMORY_MARKER = '<persistent-agent-memory';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 原子写；Windows 上目标被另一个进程读着时 rename 会短暂失败，重试几次。 */
function writeJsonSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      if (!RENAME_RETRY_CODES.has(error?.code) || attempt >= 4) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      pauseSync(20 * (attempt + 1));
    }
  }
}

function readJsonSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function textPartsOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string' && part.text)
    .map((part) => part.text);
}

function isInside(root, target) {
  if (!root) return false;
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function createRuntime(options = {}) {
  const homeDir = options.homeDir;
  const storageRoot = options.storageRoot || core.defaultStorageRoot(homeDir);
  const store = new core.Store(storageRoot);
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const sessions = new Map();

  function readSettingsMirror() {
    return core.normalizeSettings(readJsonSync(store.paths.settingsMirror) || {});
  }

  function sessionIdOf(ctx) {
    try {
      return ctx?.sessionManager?.getSessionId?.() || undefined;
    } catch {
      return undefined;
    }
  }

  function modelInfoOf(ctx) {
    try {
      const model = ctx?.model;
      const provider = typeof model?.provider === 'string' ? model.provider : model?.provider?.id || '';
      return { modelId: typeof model?.id === 'string' ? model.id : '', provider };
    } catch {
      return { modelId: '', provider: '' };
    }
  }

  function persistSession(state) {
    if (state.noWorkspace) return;
    try {
      writeJsonSync(store.sessionFile(state.sessionId), {
        sessionId: state.sessionId,
        workspacePath: state.cwd,
        projectKey: state.projectKey,
        memoryRoot: state.memoryRoot,
        settings: state.settings,
        modelId: state.model.modelId,
        provider: state.model.provider,
        startedAt: state.startedAt,
        updatedAt: now(),
      });
    } catch {
      // 状态目录写不进去不影响对话
    }
  }

  function freshRecall() {
    return { requestId: '', consumed: true, pendingBatch: false, recalled: new Set(), characters: 0 };
  }

  /** 上游 disposeProjectMemoryRecallPrefetch：丢掉未消费的预取，已召回记录与预算保留。 */
  function disposeRecall(state) {
    const outstanding = Boolean(state.recall.requestId) && !state.recall.consumed;
    state.recall.requestId = '';
    state.recall.consumed = true;
    state.recall.pendingBatch = false;
    // 还没被主进程认领的请求直接删掉，免得白白占一次后台调用
    if (outstanding) {
      try {
        fs.rmSync(store.recallRequestFile(state.sessionId), { force: true });
      } catch {
        // 删不掉时主进程会照常处理，结果会因 id 不符被忽略
      }
    }
  }

  /** 会话开始：固定工作区、冻结设置（上游：配置在 runtime 创建时捕获，新会话生效）。 */
  function initState(ctx, sessionId) {
    const rawCwd = typeof ctx?.cwd === 'string' ? ctx.cwd : '';
    const cwd = rawCwd ? path.resolve(rawCwd) : '';
    const noWorkspace = core.isScratchWorkspace(cwd, env, homeDir);
    const identity = noWorkspace ? null : core.projectIdentity(cwd);
    const state = {
      sessionId,
      cwd,
      noWorkspace,
      projectKey: identity ? identity.key : '',
      memoryRoot: identity ? core.projectMemoryRoot(storageRoot, cwd) : '',
      settings: readSettingsMirror(),
      startedAt: now(),
      epoch: 1,
      model: modelInfoOf(ctx),
      index: { loaded: false, content: undefined, loadedAt: 0 },
      readPaths: new Set(),
      recall: freshRecall(),
      attachments: [],
      noticesSeen: new Set(),
      taskRewrites: new Map(),
      lastEntryId: '',
    };
    sessions.set(sessionId, state);
    if (!noWorkspace) {
      try {
        // 上游 ensureMemoryDirectoryExists：失败不阻断，真正写入时再报错
        fs.mkdirSync(state.memoryRoot, { recursive: true });
        writeJsonSync(path.join(storageRoot, 'memories', 'projects', state.projectKey, 'project.json'), {
          key: state.projectKey,
          workspacePath: cwd,
          updatedAt: now(),
        });
      } catch {
        // 同上
      }
      persistSession(state);
    }
    return state;
  }

  function stateOf(ctx) {
    const sessionId = sessionIdOf(ctx);
    if (!sessionId) return null;
    const state = sessions.get(sessionId) || initState(ctx, sessionId);
    const model = modelInfoOf(ctx);
    if (model.modelId && (model.modelId !== state.model.modelId || model.provider !== state.model.provider)) {
      state.model = model;
      persistSession(state);
    }
    return state;
  }

  function indexPathOf(state) {
    return path.join(state.memoryRoot, MEMORY_INDEX_FILENAME);
  }

  /** 上游 loadProjectMemoryIndexContent：只在 default-index 分支读，读到即视为已读。 */
  function loadIndex(state) {
    if (state.index.loaded) return state.index.content;
    let content;
    try {
      const stat = fs.lstatSync(indexPathOf(state));
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= LIMITS.PREVIEW_MAX_BYTES) {
        content = fs.readFileSync(indexPathOf(state), 'utf8');
      }
    } catch {
      content = undefined;
    }
    state.index = { loaded: true, content, loadedAt: now() };
    if (content !== undefined && memory.formatProjectMemoryIndexContent(content)) state.readPaths.add(indexPathOf(state));
    return content;
  }

  function branchOf(state) {
    return state.settings.semanticRecall ? 'semantic-recall' : 'default-index';
  }

  /** 请求前缀：第一段是记忆规则原文，第二段是上游 context_prefix（索引）。 */
  function prefixParts(state) {
    const branch = branchOf(state);
    const parts = [prompts.buildMemoryContent(state.memoryRoot, branch)];
    if (branch === 'default-index') {
      const content = loadIndex(state);
      if (content !== undefined) {
        const ruc = prompts.buildRequestUserContextContent(state.memoryRoot, content);
        if (ruc) parts.push(prompts.wrapSystemReminderForSource('context_prefix', prompts.buildContextMetaUserBody([ruc])));
      }
    }
    return parts;
  }

  function insertPrefix(state, messages) {
    let at = 0;
    while (at < messages.length && messages[at]?.role === 'system') at += 1;
    const anchor = messages[at] || messages[messages.length - 1];
    const prefix = {
      role: 'user',
      content: prefixParts(state).map((text) => ({ type: 'text', text })),
      timestamp: typeof anchor?.timestamp === 'number' ? anchor.timestamp : 0,
    };
    return [...messages.slice(0, at), prefix, ...messages.slice(at)];
  }

  function locateAnchor(attachment, messages) {
    return messages.findIndex((message) => message?.role === 'toolResult' && message.toolCallId === attachment.anchor.id);
  }

  /** 附件按锚点插回去：每次请求都插，直到压缩或会话重开。 */
  function insertAttachments(state, messages) {
    if (state.attachments.length === 0) return messages;
    const after = new Map();
    const keep = [];
    for (const attachment of state.attachments) {
      const index = locateAnchor(attachment, messages);
      if (index < 0) continue;
      keep.push(attachment);
      const list = after.get(index) || [];
      list.push(attachment);
      after.set(index, list);
    }
    state.attachments = keep;
    const out = [];
    messages.forEach((message, index) => {
      out.push(message);
      for (const attachment of after.get(index) || []) {
        out.push({
          role: 'user',
          content: [{ type: 'text', text: attachment.text }],
          timestamp: typeof message?.timestamp === 'number' ? message.timestamp : 0,
        });
      }
    });
    return out;
  }

  // ----------------------------------------------------------
  // 召回（上游 runtime/helpers/project-memory-recall.ts）
  // ----------------------------------------------------------

  async function startRecall(state, query) {
    if (!state.settings.semanticRecall) return;
    if (state.recall.characters >= LIMITS.MEMORY_RECALL_SESSION_CHARACTER_LIMIT) return;
    if (!memory.isMemoryRecallQueryEligible(query, state.settings.improveE1)) return;
    const id = crypto.randomUUID();
    state.recall.requestId = id;
    state.recall.consumed = false;
    state.recall.pendingBatch = false;
    try {
      writeJsonSync(store.recallRequestFile(state.sessionId), {
        id,
        epoch: state.epoch,
        sessionId: state.sessionId,
        projectKey: state.projectKey,
        workspacePath: state.cwd,
        memoryRoot: state.memoryRoot,
        query,
        recalledPaths: [...state.recall.recalled],
        readPaths: [...state.readPaths],
        at: now(),
      });
    } catch {
      state.recall.consumed = true;
    }
  }

  /** 一次完整工具批次之后检查一次：已就绪就附加，未就绪等下一个批次，绝不等待。 */
  function consumeRecall(state, messages) {
    const recall = state.recall;
    if (!recall.pendingBatch) return;
    recall.pendingBatch = false;
    if (recall.consumed || !recall.requestId) return;
    const response = readJsonSync(store.recallResponseFile(state.sessionId));
    if (!response || response.id !== recall.requestId) return;
    recall.consumed = true;
    const entries = (Array.isArray(response.entries) ? response.entries : [])
      .filter((entry) => entry && typeof entry.filePath === 'string' && typeof entry.content === 'string')
      .filter((entry) => !recall.recalled.has(entry.filePath) && !state.readPaths.has(entry.filePath))
      .slice(0, LIMITS.MAX_SELECTED_MEMORIES);
    if (entries.length === 0) return;
    let anchorId;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'toolResult' && messages[index].toolCallId) {
        anchorId = messages[index].toolCallId;
        break;
      }
    }
    if (!anchorId) return;
    state.attachments.push({
      kind: 'relevant_memory',
      anchor: { type: 'toolResult', id: anchorId },
      text: prompts.wrapSystemReminderForSource('relevant_memory', prompts.formatRelevantMemoryAttachment(entries)),
    });
    for (const entry of entries) {
      recall.recalled.add(entry.filePath);
      recall.characters += entry.content.length;
      state.readPaths.add(entry.filePath);
    }
  }

  // ----------------------------------------------------------
  // Dream 更新提示（上游 consumePendingProjectMemoryUpdate）
  // ----------------------------------------------------------

  /** 新的 Dream 通知只在已经开着的会话里提示一次；返回本次请求要附加的文本。 */
  function consumeNotice(state) {
    const notice = store.readNoticeSync(state.projectKey);
    if (!notice || typeof notice.id !== 'string' || state.noticesSeen.has(notice.id)) return undefined;
    state.noticesSeen.add(notice.id);
    if (!(notice.at > state.startedAt)) return undefined;
    const paths = Array.isArray(notice.paths) ? notice.paths.filter((item) => typeof item === 'string') : [];
    if (paths.length === 0) return undefined;
    // 上游 createProjectMemoryUpdate：MEMORY.md 总算在上下文里；其余看是否召回过或读过
    const inContextPaths = paths.filter(
      (item) => path.basename(item) === MEMORY_INDEX_FILENAME || state.recall.recalled.has(item) || state.readPaths.has(item),
    );
    // 上游 invalidateProjectMemoryRecallPaths：丢掉未消费的预取，被改动的文件不再算已召回/已读
    disposeRecall(state);
    for (const item of paths) {
      state.recall.recalled.delete(item);
      state.readPaths.delete(item);
    }
    const text = prompts.formatProjectMemoryUpdate({
      summary: typeof notice.summary === 'string' ? notice.summary : `consolidated ${paths.length} memory file${paths.length === 1 ? '' : 's'}`,
      paths,
      inContextPaths,
    });
    return prompts.wrapSystemReminderForSource('memory_update', text);
  }

  // ----------------------------------------------------------
  // 钩子
  // ----------------------------------------------------------

  function onSessionStart(ctx) {
    const sessionId = sessionIdOf(ctx);
    if (!sessionId) return;
    sessions.delete(sessionId);
    initState(ctx, sessionId);
  }

  async function onBeforeAgentStart(event, ctx) {
    const state = stateOf(ctx);
    if (!state || state.noWorkspace) return undefined;
    disposeRecall(state);
    await startRecall(state, typeof event?.prompt === 'string' ? event.prompt : '');
    // 不改系统提示（见文件头）；记忆内容由 context 钩子放进每次请求
    return undefined;
  }

  function onContext(event, ctx) {
    const state = stateOf(ctx);
    if (!state || state.noWorkspace) return undefined;
    const messages = Array.isArray(event?.messages) ? event.messages : null;
    if (!messages) return undefined;
    if (state.settings.semanticRecall) consumeRecall(state, messages);
    let next = insertAttachments(state, messages);
    // 上游：Dream 更新提示只放进紧接着的这一次请求（不进历史）
    const notice = consumeNotice(state);
    if (notice) {
      const last = next[next.length - 1];
      next = [
        ...next,
        {
          role: 'user',
          content: [{ type: 'text', text: notice }],
          timestamp: typeof last?.timestamp === 'number' ? last.timestamp : now(),
        },
      ];
    }
    return { messages: insertPrefix(state, next) };
  }

  function onToolResult(event, ctx) {
    const state = stateOf(ctx);
    if (!state || state.noWorkspace) return undefined;
    const input = event?.input && typeof event.input === 'object' ? event.input : {};
    // 上游的读状态也包含主代理自己 Read / Write / Edit 过的文件：这些不再被召回
    if (['Read', 'Write', 'Edit'].includes(event?.toolName) && !event.isError) {
      const target = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : '';
      if (target) {
        const full = path.resolve(state.cwd, target);
        if (isInside(state.memoryRoot, full)) state.readPaths.add(full);
      }
    }
    if (event?.toolName === 'Task' && state.taskRewrites.has(event.toolCallId)) {
      const pending = state.taskRewrites.get(event.toolCallId);
      state.taskRewrites.delete(event.toolCallId);
      const effective = typeof input.task === 'string' && input.task.includes(TASK_MEMORY_MARKER);
      writeTaskRewrite({ ...pending, effective, checkedAt: now() });
    }
    if (state.settings.semanticRecall && !state.recall.consumed && state.recall.requestId) {
      state.recall.pendingBatch = true;
    }
    return undefined;
  }

  function lookupScope(scopes, agentName) {
    if (!agentName) return undefined;
    if (scopes[agentName]) return { name: agentName, scope: scopes[agentName] };
    const lower = agentName.toLowerCase();
    const match = Object.keys(scopes).find((key) => key.toLowerCase() === lower);
    return match ? { name: match, scope: scopes[match] } : undefined;
  }

  /** Task 改写记录单独一个文件（主进程只读），避免两个进程抢写 status.json。 */
  function writeTaskRewrite(record) {
    try {
      writeJsonSync(store.paths.taskRewrite, { ...record, updatedAt: now() });
    } catch {
      // 记录写不进去不影响任务
    }
  }

  /**
   * Task 字段是 agent / task / resume（resources/agent-runtime/sidecar.js 的 Task 参数定义）。
   * 只有宿主把同一个参数对象交给工具时，原地改写才会生效；结果在 tool_result 里核对。
   */
  function onToolCall(event, ctx) {
    if (event?.toolName !== 'Task') return undefined;
    const state = stateOf(ctx);
    if (!state || state.noWorkspace || !state.settings.taskRewrite) return undefined;
    const input = event.input;
    if (!input || typeof input !== 'object' || typeof input.task !== 'string') return undefined;
    if (typeof input.resume === 'string' && input.resume.trim()) return undefined;
    if (input.task.includes(TASK_MEMORY_MARKER)) return undefined;
    const agentName = typeof input.agent === 'string' ? input.agent.trim() : '';
    const hit = lookupScope(core.parseAgentScopes(state.settings.agentMemoryScopes), agentName);
    if (!hit) return undefined;
    const rootDir = core.agentMemoryRoot({ storageRoot, workspaceRoot: state.cwd, agentName: hit.name, scope: hit.scope });
    try {
      fs.mkdirSync(rootDir, { recursive: true });
    } catch {
      // 上游同样不因目录创建失败而阻断
    }
    let indexContent = '';
    try {
      indexContent = fs.readFileSync(path.join(rootDir, MEMORY_INDEX_FILENAME), 'utf8');
    } catch {
      indexContent = '';
    }
    input.task = `${input.task}${prompts.buildPersistentMemoryTaskBlock({ agentName: hit.name, scope: hit.scope, rootDir, indexContent })}`;
    const record = { agentName: hit.name, scope: hit.scope, rootDir, toolCallId: event.toolCallId, mode: 'in-place', at: now() };
    if (event.toolCallId) state.taskRewrites.set(event.toolCallId, record);
    writeTaskRewrite({ ...record, effective: null });
    return undefined;
  }

  function onMessageEnd(event, ctx) {
    const state = stateOf(ctx);
    if (!state || state.noWorkspace) return;
    const message = event?.message;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return;
    const textParts = textPartsOf(message);
    const text = textParts.join('\n');
    const toolCalls = (Array.isArray(message.content) ? message.content : [])
      .filter((part) => part && part.type === 'toolCall' && typeof part.name === 'string')
      .map((part) => {
        const args = part.arguments && typeof part.arguments === 'object' ? part.arguments : {};
        const target = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : '';
        return { name: part.name, ...(target ? { filePath: path.resolve(state.cwd, target) } : {}) };
      });
    if (!text && toolCalls.length === 0) return;
    const entry = {
      id: crypto.randomUUID(),
      role: message.role,
      text,
      // 上游按文本分段判断「至少 3 个词」，分段原样保留
      ...(message.role === 'user' && textParts.length > 1 ? { textParts } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      at: now(),
    };
    try {
      const dir = core.transcriptRoot(storageRoot, state.projectKey);
      fs.mkdirSync(dir, { recursive: true });
      // 通知类事件不等待处理器完成：同步追加，保证顺序
      fs.appendFileSync(path.join(dir, `${state.sessionId}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
      state.lastEntryId = entry.id;
    } catch {
      // 转录写不进去时只少一次提取，不影响对话
    }
  }

  /** 上游只在回合成功完成后排提取（runtime/methods/turn.ts 的 Turn completed 分支）。 */
  function onAgentEnd(event, ctx) {
    const state = stateOf(ctx);
    if (!state || state.noWorkspace) return;
    // 上游 turn.ts 的 finally：回合结束时丢掉还没消费的召回预取
    disposeRecall(state);
    // 回合信号同时用于自动提取与自动 Dream 的检查，两者互不依赖
    if (!state.settings.autoExtract && !state.settings.autoDream) return;
    const list = Array.isArray(event?.messages) ? event.messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (message?.role !== 'assistant') continue;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
      break;
    }
    try {
      writeJsonSync(store.turnFile(state.sessionId), {
        sessionId: state.sessionId,
        projectKey: state.projectKey,
        workspacePath: state.cwd,
        // 上游在回合完成时记下边界消息（latestConversationMessageId），提取只看到这里为止
        ...(state.lastEntryId ? { boundaryId: state.lastEntryId } : {}),
        at: now(),
      });
    } catch {
      // 同上
    }
  }

  /** 上游 resetProjectMemoryRecall：压缩后召回状态清零；MEMORY.md 不重读（每会话一次）。 */
  function onCompact(ctx) {
    const state = stateOf(ctx);
    if (!state) return;
    state.epoch += 1;
    state.recall = freshRecall();
    state.attachments = [];
    state.readPaths = new Set(state.index.content !== undefined ? [indexPathOf(state)] : []);
  }

  /**
   * 宿主在销毁扩展运行器时发 session_shutdown（runner-*.js 的 dispose()）。
   * 留一个标记，让主进程按上游的「关闭会话」处理：最多等 60 秒在途提取，然后取消。
   */
  function onSessionShutdown(ctx) {
    const sessionId = sessionIdOf(ctx);
    if (!sessionId) return;
    const state = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (!state || state.noWorkspace) return;
    try {
      writeJsonSync(store.closedFile(sessionId), { sessionId, at: now() });
    } catch {
      // 标记写不进去时，提取会在插件卸载时一并取消
    }
  }

  return {
    storageRoot,
    store,
    onSessionStart,
    onBeforeAgentStart,
    onContext,
    onToolResult,
    onToolCall,
    onMessageEnd,
    onAgentEnd,
    onCompact,
    onSessionShutdown,
    _internals: { sessions, prefixParts, readSettingsMirror },
  };
}

module.exports = function zcodeMemoryExtension(pi) {
  const runtime = createRuntime();
  pi.on('session_start', (event, ctx) => runtime.onSessionStart(ctx));
  pi.on('before_agent_start', (event, ctx) => runtime.onBeforeAgentStart(event, ctx));
  pi.on('context', (event, ctx) => runtime.onContext(event, ctx));
  pi.on('tool_call', (event, ctx) => runtime.onToolCall(event, ctx));
  pi.on('tool_result', (event, ctx) => runtime.onToolResult(event, ctx));
  pi.on('message_end', (event, ctx) => runtime.onMessageEnd(event, ctx));
  pi.on('agent_end', (event, ctx) => runtime.onAgentEnd(event, ctx));
  pi.on('session_compact', (event, ctx) => runtime.onCompact(ctx));
  pi.on('session_shutdown', (event, ctx) => runtime.onSessionShutdown(ctx));
};

module.exports._internals = { createRuntime, TASK_MEMORY_MARKER };
