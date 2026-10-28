'use strict';

/**
 * 插件主进程：后台提取、召回选择器、Dream、面板 API 与状态。
 *
 * sidecar 里的扩展（extension.js）拿不到 pi.* 插件 API，两边只通过
 * ~/.pi-desktop/zcode-memory/state 下的文件交换数据：
 * - settings.json      主进程 → 扩展：有效设置（扩展在会话开始时读一次并冻结）
 * - sessions/<id>.json 扩展 → 主进程：工作区、冻结的设置、会话模型
 * - turns/<id>.json    扩展 → 主进程：一个成功结束的回合（提取信号）
 * - recall/<id>.req    扩展 → 主进程：召回请求；<id>.res 为结果
 * - notices/<key>.json 主进程 → 扩展：Dream 改动通知
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIMITS, HOST_LIMITS } = require('./lib/constants');
const core = require('./lib/core');
const memory = require('./lib/memory');
const prompts = require('./lib/prompts');
const agent = require('./lib/agent');
const panelData = require('./lib/panel-data');
const { readJson, writeJson } = require('./lib/fs-safe');

const POLL_MS = 800;
const MODEL_CACHE_MS = 60000;
// 宿主 agent.complete 的 messages 总字符上限是 200000；留一点余量给宿主自己的包装
const MESSAGE_CHAR_BUDGET = HOST_LIMITS.COMPLETE_MESSAGES_MAX_CHARS - 8000;
// 选择器对话里给下一个问题留的余量
const SELECTOR_HISTORY_BUDGET = MESSAGE_CHAR_BUDGET - 16000;

const PRIORITY = { recall: 3, extraction: 2, dream: 1 };

let state = null;

function getPi() {
  return globalThis.pi;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function errorText(error) {
  return String(error?.message || error);
}

/** 可被 AbortSignal 打断的等待。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function createPluginRuntime(options = {}) {
  const pi = options.pi || getPi();
  const now = options.now || (() => Date.now());
  const homeDir = options.homeDir;
  const storageRoot = options.storageRoot || core.defaultStorageRoot(homeDir);
  const store = new core.Store(storageRoot);
  const limiter = options.limiter || core.createRateLimiter();
  const rateLimitBackoffMs = options.rateLimitBackoffMs ?? 15000;
  // 测试可注入假时钟的等待；默认是可被关闭打断的真实等待
  const backoff = options.sleep || ((ms) => sleep(ms, lifecycle.signal));
  const pollMs = options.pollMs ?? POLL_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? LIMITS.EXTRACTION_DRAIN_TIMEOUT_MS;
  const schedulers = new Map();
  const closing = new Map();
  const recallStates = new Map();
  const modelCache = { at: 0, models: [] };
  const lifecycle = new AbortController();
  let settings = core.normalizeSettings({});
  let timers = [];
  let shuttingDown = false;
  // 上游的扫描节流挂在各自的运行时上（各自的项目）：按项目记
  const dreamScanAt = new Map();
  // 会话关闭标记的时间：关闭之前发出的召回请求不再处理
  const closedAt = new Map();
  const busy = { dream: false };
  const runningDreams = new Map();

  function log(message) {
    try {
      if (pi?.log) pi.log(`[zcode-memory] ${message}`);
    } catch {
      // 记录失败不影响主流程
    }
  }

  /** 状态只给面板看：写不进去只记日志，不影响提取、召回与 Dream 本身。 */
  async function setStatus(patch) {
    try {
      await store.writeStatus(patch);
    } catch (error) {
      log(`状态写入失败：${errorText(error)}`);
    }
  }

  /**
   * 同一时间只跑一轮；运行中再被调用时，等这一轮结束再跑一轮（多次调用合并成一轮）。
   * 轮询用 isRunning() 跳过，面板或测试的显式调用一定能等到结果。
   */
  function serialized(fn) {
    let running = null;
    let again = null;
    const runner = () => {
      if (shuttingDown) return Promise.resolve();
      if (running) {
        if (!again) {
          again = running
            .catch(() => undefined)
            .then(() => {
              again = null;
              return runner();
            });
        }
        return again;
      }
      running = fn().finally(() => {
        running = null;
      });
      return running;
    };
    runner.isRunning = () => running !== null;
    return runner;
  }

  // ----------------------------------------------------------
  // 设置与宿主
  // ----------------------------------------------------------

  /** 把有效设置镜像给扩展（扩展不能调用 pi.plugin.getSettings）。 */
  async function mirrorSettings() {
    try {
      await writeJson(store.paths.settingsMirror, settings);
    } catch (error) {
      log(`设置镜像写入失败：${errorText(error)}`);
    }
  }

  async function refreshSettings() {
    try {
      settings = core.normalizeSettings(await pi.plugin.getSettings());
    } catch (error) {
      log(`读取设置失败：${errorText(error)}`);
      settings = core.normalizeSettings({});
    }
    await mirrorSettings();
    return settings;
  }

  async function setSettings(key, value) {
    if (!Object.hasOwn(core.DEFAULT_SETTINGS, key)) throw new Error(`unknown setting: ${key}`);
    const expected = typeof core.DEFAULT_SETTINGS[key];
    if (typeof value !== expected) throw new Error(`setting ${key} expects ${expected}`);
    if (key === 'agentMemoryScopes') core.parseAgentScopes(value);
    await pi.plugin.setSettings({ [key]: value });
    await refreshSettings();
  }

  /** 会话开始时冻结的设置；没有会话记录时用当前设置。 */
  function settingsOf(session) {
    return session?.settings ? core.normalizeSettings(session.settings) : settings;
  }

  async function listModels() {
    if (now() - modelCache.at < MODEL_CACHE_MS && modelCache.models.length > 0) return modelCache.models;
    try {
      const models = await pi.models.list();
      if (Array.isArray(models) && models.length > 0) {
        modelCache.models = models;
        modelCache.at = now();
        await store.writeModelCache(models);
        return models;
      }
    } catch (error) {
      log(`模型列表读取失败：${errorText(error)}`);
    }
    if (modelCache.models.length === 0) {
      const cached = await store.readModelCache();
      modelCache.models = Array.isArray(cached.entries) ? cached.entries : [];
    }
    return modelCache.models;
  }

  /**
   * 后台调用用的模型：设置覆盖 → 会话模型。找不到就跳过，原因写进状态给面板看。
   * session:modelChanged 只在用户改模型时广播（宿主 sessionConfigure / configureModel），
   * 平时靠扩展记下的 ctx.model.id 在 models.list 里匹配。
   */
  async function resolveModel(session, operation) {
    const models = await listModels();
    const changed = session?.sessionId ? (await store.readSessionModels())[session.sessionId] : undefined;
    let sessionModelKey;
    if (typeof changed?.modelKey === 'string' && changed.modelKey) {
      // 两个来源取较新的：用户刚换了模型时，事件比扩展记下的 ctx.model 新
      const agrees = !session?.modelId || changed.modelKey.endsWith(`/${session.modelId}`);
      const newer = (changed.at || 0) >= (session?.updatedAt || 0);
      if (agrees || newer) sessionModelKey = changed.modelKey;
    }
    const resolved = core.resolveBackgroundModel({
      models,
      backgroundModel: settings.backgroundModel,
      sessionModelKey,
      sessionModelId: session?.modelId,
      sessionProvider: session?.provider,
    });
    if (!resolved.model) {
      await setStatus({ model: { state: 'skipped', reason: resolved.reason, operation, at: now() } });
      return null;
    }
    await setStatus({
      model: { state: 'ok', modelKey: resolved.model.key, source: resolved.source, operation, at: now() },
    });
    return { ...resolved.model, thinkingLevel: core.lowestThinkingLevel(resolved.model) };
  }

  /**
   * 宿主 messages 总字符上限 200 000：超出时从最早的消息开始丢，
   * 但调用方钉住的消息（Dream 指令、提取指令、召回清单）与最后一条始终保留。
   */
  function fitMessages(messages, pinned = []) {
    const keep = new Set(pinned);
    const list = messages.map((message, index) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content ?? ''),
      pinned: keep.has(message) || index === messages.length - 1,
    }));
    let total = list.reduce((sum, message) => sum + message.content.length, 0);
    for (let index = 0; total > MESSAGE_CHAR_BUDGET && index < list.length; ) {
      if (list[index].pinned) {
        index += 1;
        continue;
      }
      total -= list[index].content.length;
      list.splice(index, 1);
    }
    if (total > MESSAGE_CHAR_BUDGET) {
      // 只剩钉住的消息仍超限：截最后一条的开头（保留最新内容）
      const last = list[list.length - 1];
      const excess = total - MESSAGE_CHAR_BUDGET;
      last.content = last.content.slice(Math.min(last.content.length, excess));
    }
    return list.map(({ role, content }) => ({ role, content }));
  }

  /**
   * 宿主 agent.complete：本地按优先级排队限流；宿主仍报 RATE_LIMITED 时退避重试，
   * 不丢弃、不当作失败（直到关闭或调用方取消）。
   */
  async function complete(input) {
    const signal = input.signal;
    const messages = fitMessages(Array.isArray(input.messages) ? input.messages : [], input.pinned);
    let system = String(input.system ?? '');
    if (system.length > HOST_LIMITS.COMPLETE_SYSTEM_MAX_CHARS) system = system.slice(0, HOST_LIMITS.COMPLETE_SYSTEM_MAX_CHARS);
    for (let attempt = 0; ; attempt += 1) {
      if (shuttingDown || signal?.aborted) throw abortError();
      await limiter.acquire(input.priority ?? PRIORITY.extraction);
      if (shuttingDown || signal?.aborted) throw abortError();
      try {
        const result = await pi.agent.complete({
          modelKey: input.modelKey,
          thinkingLevel: input.thinkingLevel,
          system,
          messages,
        });
        if (shuttingDown || signal?.aborted) throw abortError();
        return { text: typeof result?.text === 'string' ? result.text : '' };
      } catch (error) {
        if (isAbortError(error)) throw error;
        const code = error?.code || error?.data?.code || error?.errorCode;
        if (code !== 'RATE_LIMITED') throw error;
        await setStatus({ rateLimit: { waitingSince: now(), attempts: attempt + 1 } });
        await backoff(Math.min(rateLimitBackoffMs * (attempt + 1), HOST_LIMITS.COMPLETE_WINDOW_MS));
      }
    }
  }

  // ----------------------------------------------------------
  // 提取（上游 runtime/helpers/project-memory-extraction.ts）
  // ----------------------------------------------------------

  /**
   * 上游把主对话整段分叉给提取代理；这里用插件自己的转录重建同一段对话
   * （宿主 agent.complete 只收纯文本消息，工具结果不在其中）。
   */
  function renderTranscript(entries) {
    const messages = [];
    for (const entry of entries) {
      const text = String(entry.text || '').trim();
      const toolNote = (entry.toolCalls || [])
        .map((call) => `${call.name}${call.filePath ? ` ${call.filePath}` : ''}`)
        .join(', ');
      const body = [text, toolNote ? `(tool calls: ${toolNote})` : ''].filter(Boolean).join('\n');
      if (!body) continue;
      messages.push({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: body });
    }
    return messages;
  }

  function memorySystemPrompt(memoryRoot, branch, maxTurns) {
    const section = prompts.buildMemoryContent(memoryRoot, branch);
    const protocol = prompts.buildMemoryToolProtocol({ maxTurns });
    return `${section}\n\n${protocol}`;
  }

  /** E3：把最相似的已有记忆正文放到提取上下文里，并在工具执行器里标记为已读。 */
  async function preloadSimilarMemories({ memoryRoot, manifest, query, toolRunner }) {
    if (manifest.length === 0) return '';
    // E3 自带相似度排序（与 E2 同一个 BM25 + RRF 函数），不依赖 E2 开关
    const ranked = memory.rankManifestCandidates(manifest, query);
    const recalled = await memory.readRecalledMemories({ entries: ranked.slice(0, 3), rootDir: memoryRoot, nowMs: now() });
    if (recalled.length === 0) return '';
    for (const item of recalled) {
      if (item.limit === undefined) toolRunner.readPaths.add(item.filePath);
    }
    return [
      '',
      '',
      '## Existing memory files already loaded for you',
      '',
      'The bodies below are the most similar existing memories. Do not read them again; update them instead of creating near-duplicates.',
      '',
      prompts.formatRelevantMemoryAttachment(recalled),
    ].join('\n');
  }

  async function executeExtraction({ abortSignal, messageCount, snapshot }) {
    const { sessionId, projectKey, workspacePath, memoryRoot, entries } = snapshot;
    const sessionSettings = snapshot.settings || settings;
    if (abortSignal?.aborted) return 'aborted';
    const model = await resolveModel(snapshot.session, 'extraction');
    if (!model) {
      await setStatus({ extraction: { state: 'skipped', sessionId, reason: 'no-model', at: now() } });
      // 不推进游标：模型问题修好之后，这段对话还会被提取
      return 'skipped';
    }
    try {
      await fsp.mkdir(memoryRoot, { recursive: true });
      const manifest = await memory.scanMemoryManifest({ rootDir: memoryRoot });
      if (abortSignal?.aborted) return 'aborted';
      const toolRunner = new agent.ToolRunner({
        memoryRoot,
        workspaceRoot: workspacePath,
        storageRoot,
        projectKey,
        sessionId,
        improveE4: sessionSettings.improveE4,
        now,
      });
      const recentUserText = entries
        .slice(Math.max(0, entries.length - messageCount))
        .filter((entry) => entry.role === 'user')
        .map((entry) => entry.text || '')
        .join('\n');
      const preload = sessionSettings.improveE3
        ? await preloadSimilarMemories({ memoryRoot, manifest, query: recentUserText, toolRunner })
        : '';
      const userContent = `${prompts.buildMemoryExtractionPrompt({ manifest, messageCount })}${preload}`;
      const instruction = { role: 'user', content: userContent };
      const branch = sessionSettings.semanticRecall ? 'semantic-recall' : 'default-index';
      await setStatus({ extraction: { state: 'running', sessionId, startedAt: now(), modelKey: model.key } });
      const loop = await agent.runMemoryAgentLoop({
        complete: (input) =>
          complete({
            ...input,
            pinned: [instruction],
            modelKey: model.key,
            thinkingLevel: model.thinkingLevel,
            priority: PRIORITY.extraction,
            signal: abortSignal,
          }),
        system: memorySystemPrompt(memoryRoot, branch, LIMITS.EXTRACTION_MAX_TURNS),
        messages: [...renderTranscript(entries), instruction],
        maxTurns: LIMITS.EXTRACTION_MAX_TURNS,
        toolRunner,
        signal: abortSignal,
      });
      const summary = agent.stripToolCalls(loop.text).slice(0, 400);
      await setStatus({
        extraction: {
          state: loop.touchedPaths.length > 0 ? 'success' : 'no-op',
          sessionId,
          files: loop.touchedPaths,
          turns: loop.turns,
          summary,
          modelKey: model.key,
          at: now(),
        },
      });
      return 'success';
    } catch (error) {
      if (abortSignal?.aborted || isAbortError(error)) {
        // 卸载时不再写状态；按会话关闭取消时面板要看到「已取消」，而不是一直「运行中」
        if (!shuttingDown) await setStatus({ extraction: { state: 'aborted', sessionId, at: now() } });
        return 'aborted';
      }
      await setStatus({
        extraction: { state: 'error', sessionId, error: errorText(error), modelKey: model.key, at: now() },
      });
      return 'error';
    }
  }

  function schedulerFor(sessionId) {
    let scheduler = schedulers.get(sessionId);
    if (!scheduler) {
      scheduler = memory.createMemoryExtractionScheduler(executeExtraction);
      schedulers.set(sessionId, scheduler);
    }
    return scheduler;
  }

  /**
   * 读取会话转录，交给该会话的调度器（一个运行中 + 一个最新待办）。
   * 边界是回合结束时扩展记下的最后一条消息（上游 latestConversationMessageId），
   * 轮询之前新写进来的下一回合消息不算进这一次。
   */
  async function scheduleSessionExtraction(sessionId, boundaryId) {
    const session = await store.readSession(sessionId);
    if (!session?.workspacePath || !session.projectKey) return false;
    const sessionSettings = settingsOf(session);
    const all = await store.readTranscript(session.projectKey, sessionId);
    const boundaryIndex = boundaryId ? all.findIndex((entry) => entry.id === boundaryId) : -1;
    const entries = boundaryIndex >= 0 ? all.slice(0, boundaryIndex + 1) : all;
    if (entries.length === 0) return false;
    schedulerFor(sessionId).schedule({
      sessionId,
      session,
      projectKey: session.projectKey,
      workspacePath: session.workspacePath,
      memoryRoot: core.projectMemoryRoot(storageRoot, session.workspacePath),
      entries,
      boundaryId: entries[entries.length - 1].id,
      improveE1: sessionSettings.improveE1,
      settings: sessionSettings,
    });
    return true;
  }

  /**
   * 上游关闭会话：drainMemoryExtractions 最多等 60 秒在途提取，然后 shutdown
   * （runtime/helpers/project-memory-extraction.ts）。取消后迟到的结果不落盘。
   */
  async function closeSession(sessionId) {
    recallStates.delete(sessionId);
    // 关闭前没来得及处理的召回请求不再处理
    await fsp.rm(store.recallRequestFile(sessionId), { force: true }).catch(() => {});
    const scheduler = schedulers.get(sessionId);
    if (!scheduler) return;
    let timer;
    await Promise.race([
      scheduler.drain(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, drainTimeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);
    clearTimeout(timer);
    scheduler.shutdown();
    await scheduler.drain();
    if (schedulers.get(sessionId) === scheduler) schedulers.delete(sessionId);
  }

  const processTurnJobs = serialized(async () => {
    const jobs = await store.listTurns();
    for (const job of jobs) {
      if (shuttingDown) return;
      // 这个会话正在按关闭收尾：信号留着，收尾结束后由新的调度器处理（与上游恢复会话时新建运行时一致）
      if (closing.has(job.sessionId)) continue;
      // 新回合说明会话又在用了（恢复会话时会话 id 不变）
      closedAt.delete(job.sessionId);
      try {
        // 先清掉信号再排队：排队期间新到的回合会写一个新信号，不会被这里误删
        await store.clearTurn(job.sessionId);
        const session = await store.readSession(job.sessionId);
        if (settingsOf(session).autoExtract) await scheduleSessionExtraction(job.sessionId, job.boundaryId);
        // 自动 Dream 与提取互不依赖（上游各有各的入口）
        if (settings.autoDream) void maybeAutoDream(session);
      } catch (error) {
        log(`提取排队失败：${errorText(error)}`);
      }
    }
    // 关闭标记放在回合信号之后处理：会话最后一个回合的提取先排上，再按上游的有界等待收尾
    let closed = [];
    try {
      closed = await fsp.readdir(store.paths.closed);
    } catch {
      closed = [];
    }
    for (const name of closed) {
      if (!name.endsWith('.json')) continue;
      const markerPath = path.join(store.paths.closed, name);
      const marker = await readJson(markerPath, null);
      await fsp.rm(markerPath, { force: true });
      const sessionId = name.slice(0, -'.json'.length);
      if (closing.has(sessionId)) continue;
      closedAt.set(sessionId, typeof marker?.at === 'number' ? marker.at : now());
      const task = closeSession(sessionId)
        .catch((error) => log(`关闭会话收尾失败：${errorText(error)}`))
        .finally(() => closing.delete(sessionId));
      closing.set(sessionId, task);
    }
  });

  // ----------------------------------------------------------
  // 召回选择器（上游 memory/recall/*.ts + runtime/helpers/project-memory-recall.ts）
  // ----------------------------------------------------------

  /** 每个会话一份：清单与选择器对话「粘」在会话上，压缩后（epoch 变化）清空。 */
  function recallStateOf(sessionId, epoch, projectKey) {
    let current = recallStates.get(sessionId);
    if (!current || current.epoch !== epoch) {
      current = { epoch, projectKey, manifest: undefined, selectorMessages: undefined };
      recallStates.set(sessionId, current);
    }
    return current;
  }

  /** 上游 getMemoryRecallManifest；E2 只在建清单时按当前查询排序，建好后整段复用。 */
  async function recallManifest(recallState, memoryRoot, query, improveE2) {
    if (recallState.manifest && recallState.manifest.length > 0) return recallState.manifest;
    const scanned = await memory.scanMemoryManifest({
      rootDir: memoryRoot,
      limit: improveE2 ? Number.POSITIVE_INFINITY : LIMITS.MANIFEST_FILE_LIMIT,
    });
    const manifest = improveE2
      ? memory.rankManifestCandidates(scanned, query).slice(0, LIMITS.MANIFEST_FILE_LIMIT)
      : scanned;
    if (manifest.length > 0) {
      recallState.manifest = manifest;
      recallState.selectorMessages = undefined;
    }
    return manifest;
  }

  async function handleRecall(request) {
    const responseFile = store.recallResponseFile(request.sessionId);
    const respond = async (body) => {
      await writeJson(responseFile, { id: request.id, at: now(), entries: [], ...body });
      await setStatus({
        recall: { state: body.error ? 'skipped' : 'ok', reason: body.error, count: body.entries?.length || 0, at: now() },
      });
    };
    // 会话关闭之前发出的请求没人等了：不处理，也不为它建状态
    const closedTime = closedAt.get(request.sessionId);
    if (closedTime !== undefined) {
      if (!(request.at > closedTime)) return undefined;
      closedAt.delete(request.sessionId);
    }
    const session = await store.readSession(request.sessionId);
    if (!session?.workspacePath) return respond({ error: 'no-session' });
    const sessionSettings = settingsOf(session);
    if (!sessionSettings.semanticRecall) return respond({ error: 'disabled' });
    const memoryRoot = core.projectMemoryRoot(storageRoot, session.workspacePath);
    const query = typeof request.query === 'string' ? request.query : '';
    const recallState = recallStateOf(request.sessionId, request.epoch, session.projectKey);
    const recalledPaths = new Set(Array.isArray(request.recalledPaths) ? request.recalledPaths : []);
    const readPaths = new Set(Array.isArray(request.readPaths) ? request.readPaths : []);
    const manifest = await recallManifest(recallState, memoryRoot, query, sessionSettings.improveE2);
    if (manifest.length === 0 || manifest.every((entry) => recalledPaths.has(entry.filePath))) return respond({});
    const model = await resolveModel(session, 'recall');
    if (!model) return respond({ error: 'no-model' });
    const request0 = prompts.buildMemorySelectorRequest({ query, state: recallState });
    const [systemMessage, ...conversation] = request0.messages;
    let response;
    try {
      response = await complete({
        modelKey: model.key,
        thinkingLevel: model.thinkingLevel,
        priority: PRIORITY.recall,
        // 本插件新增的最后一段：宿主不能传 responseJsonSchema（见对齐矩阵）
        system: `${systemMessage.content}\n${prompts.MEMORY_SELECTOR_JSON_INSTRUCTION}`,
        messages: conversation,
        pinned: [conversation[0]],
      });
    } catch (error) {
      if (isAbortError(error)) return undefined;
      return respond({ error: 'selector-failed', detail: errorText(error) });
    }
    // 压缩发生在选择期间：旧 epoch 的结果不能污染新的选择器对话
    if (recallStates.get(request.sessionId) !== recallState) return respond({ error: 'stale' });
    const parsed = memory.parseSelectorText(response.text);
    if (!parsed) return respond({ error: 'selector-invalid' });
    const nextConversation = [
      ...conversation.slice(0, -1).map(({ role, content }) => ({ role, content })),
      { role: 'user', content: `Select memories relevant to:\n${query}` },
      { role: 'assistant', content: response.text },
    ];
    // 宿主限制消息总量：清单（第一条）始终保留，超出时丢最早的一问一答，内存也不会无限增长
    let size = nextConversation.reduce((sum, message) => sum + message.content.length, 0);
    while (size > SELECTOR_HISTORY_BUDGET && nextConversation.length > 3) {
      size -= nextConversation[1].content.length + nextConversation[2].content.length;
      nextConversation.splice(1, 2);
    }
    recallState.selectorMessages = nextConversation;
    const entries = memory.filterMemorySelections({
      manifest,
      selectedFilenames: parsed.selectedMemories,
      recalledPaths,
      readPaths,
    });
    const memories = await memory.readRecalledMemories({ entries, rootDir: memoryRoot, nowMs: now() });
    return respond({ entries: memories });
  }

  const processRecallRequests = serialized(async () => {
    let names;
    try {
      names = await fsp.readdir(store.paths.recallRequests);
    } catch {
      return;
    }
    for (const name of names) {
      if (shuttingDown) return;
      if (!name.endsWith('.req.json')) continue;
      const requestPath = path.join(store.paths.recallRequests, name);
      // 原子认领：改名后再读。认领之后扩展写来的新请求是一个新文件，留给下一轮
      const claimedPath = `${requestPath}.${crypto.randomUUID()}.claimed`;
      try {
        await fsp.rename(requestPath, claimedPath);
      } catch {
        continue;
      }
      const request = await readJson(claimedPath, null);
      await fsp.rm(claimedPath, { force: true });
      if (!request || typeof request.sessionId !== 'string' || typeof request.id !== 'string') continue;
      try {
        await handleRecall(request);
      } catch (error) {
        await setStatus({ recall: { state: 'error', error: errorText(error), at: now() } });
        await writeJson(store.recallResponseFile(request.sessionId), { id: request.id, at: now(), entries: [], error: 'internal' }).catch(() => {});
      }
    }
  });

  // ----------------------------------------------------------
  // Dream（上游 memory/dream.ts + runtime/helpers/project-memory-dream.ts）
  // ----------------------------------------------------------

  async function recentTranscriptSessions(projectKey, lastConsolidatedAt, excludeSessionId) {
    const mtimes = await store.transcriptMtimes(projectKey);
    return mtimes
      .filter((entry) => entry.mtimeMs > lastConsolidatedAt)
      .map((entry) => entry.name.replace(/\.jsonl$/u, ''))
      .filter((sessionId) => sessionId && sessionId !== excludeSessionId);
  }

  async function modelSessionFor(projectKey, preferred) {
    if (preferred?.projectKey === projectKey) return preferred;
    const sessions = (await store.listSessions())
      .filter((session) => session.projectKey === projectKey)
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
    return sessions[0] || null;
  }

  function invalidateRecall(projectKey) {
    for (const recallState of recallStates.values()) {
      if (recallState.projectKey !== projectKey) continue;
      recallState.manifest = undefined;
      recallState.selectorMessages = undefined;
    }
  }

  async function runDream(projectKey, { manual = false, session: triggerSession = null } = {}) {
    if (runningDreams.has(projectKey)) return { state: 'skipped', reason: 'running' };
    const controller = new AbortController();
    const onShutdown = () => controller.abort();
    lifecycle.signal.addEventListener('abort', onShutdown, { once: true });
    const task = runDreamInner(projectKey, { manual, triggerSession, signal: controller.signal });
    runningDreams.set(projectKey, { controller, task });
    try {
      return await task;
    } finally {
      runningDreams.delete(projectKey);
      lifecycle.signal.removeEventListener('abort', onShutdown);
    }
  }

  async function runDreamInner(projectKey, { manual, triggerSession, signal }) {
    const projects = await panelData.listProjects(storageRoot);
    const project = projects.find((entry) => entry.key === projectKey);
    if (!project || !project.workspacePath) throw new Error(`找不到工作区：${projectKey}`);
    const memoryRoot = project.memoryRoot;
    await fsp.mkdir(memoryRoot, { recursive: true });
    const lastConsolidatedAt = await memory.readDreamLastConsolidatedAt(memoryRoot);
    if (!manual) {
      const timing = memory.evaluateAutoDreamTiming({
        lastConsolidatedAtMs: lastConsolidatedAt,
        lastScanAtMs: dreamScanAt.get(projectKey) ?? 0,
        nowMs: now(),
      });
      if (timing.decision === 'skip') return { state: 'skipped', reason: timing.reason };
      dreamScanAt.set(projectKey, now());
    }
    const sessionIds = await recentTranscriptSessions(projectKey, lastConsolidatedAt, manual ? undefined : triggerSession?.sessionId);
    if (!manual && sessionIds.length < LIMITS.DREAM_MINIMUM_TRANSCRIPT_SESSIONS) {
      return { state: 'skipped', reason: 'not-enough-sessions', sessions: sessionIds.length };
    }
    const model = await resolveModel(await modelSessionFor(projectKey, triggerSession), 'dream');
    if (!model) {
      await setStatus({ dream: { state: 'skipped', reason: 'no-model', at: now() } });
      return { state: 'skipped', reason: 'no-model' };
    }
    // 锁与上游相同；手动 Dream（本插件的面板按钮）允许本进程自己留下的锁重入，
    // 同一进程内的并发已由 runningDreams 挡住
    const priorMtimeMs = await memory.acquireDreamLock({ memoryRoot, nowMs: now(), reentrant: manual });
    if (priorMtimeMs === null) {
      await setStatus({ dream: { state: 'skipped', reason: 'locked', at: now() } });
      return { state: 'skipped', reason: 'locked' };
    }
    const toolRunner = new agent.ToolRunner({
      memoryRoot,
      workspaceRoot: project.workspacePath,
      storageRoot,
      projectKey,
      sessionId: `dream-${now()}`,
      improveE4: settings.improveE4,
      now,
    });
    const dreamPrompt = prompts.buildMemoryDreamPrompt({
      memoryRoot,
      sessionIds,
      transcriptRoot: core.transcriptRoot(storageRoot, projectKey),
    });
    const branch = settings.semanticRecall ? 'semantic-recall' : 'default-index';
    await setStatus({ dream: { state: 'running', projectKey, startedAt: now(), modelKey: model.key } });
    try {
      const instruction = { role: 'user', content: dreamPrompt };
      const loop = await agent.runMemoryAgentLoop({
        complete: (input) =>
          complete({ ...input, pinned: [instruction], modelKey: model.key, thinkingLevel: model.thinkingLevel, priority: PRIORITY.dream, signal }),
        system: memorySystemPrompt(memoryRoot, branch, LIMITS.DREAM_MAX_TURNS),
        messages: [instruction],
        maxTurns: LIMITS.DREAM_MAX_TURNS,
        toolRunner,
        signal,
      });
      const paths = loop.touchedPaths;
      if (paths.length > 0) {
        // 上游：只有真的改了文件才留一次性更新提示，并让召回清单失效
        await store.writeNotice(projectKey, {
          id: crypto.randomUUID(),
          at: now(),
          paths,
          summary: `consolidated ${paths.length} memory file${paths.length === 1 ? '' : 's'}`,
        });
        invalidateRecall(projectKey);
      }
      const summary = agent.stripToolCalls(loop.text).slice(0, 400);
      await setStatus({
        dream: { state: 'success', projectKey, files: paths, turns: loop.turns, summary, modelKey: model.key, at: now() },
      });
      return { state: 'success', files: paths.length };
    } catch (error) {
      await memory.restoreDreamLockAfterFailure({ memoryRoot, priorMtimeMs }).catch(() => {});
      if (signal.aborted || isAbortError(error)) {
        if (!shuttingDown) await setStatus({ dream: { state: 'aborted', projectKey, at: now() } });
        return { state: 'aborted' };
      }
      await setStatus({ dream: { state: 'error', projectKey, error: errorText(error), at: now() } });
      return { state: 'error', error: errorText(error) };
    }
  }

  /** 自动 Dream（默认关）：在回合结束后按上游门槛检查一次。 */
  async function maybeAutoDream(session) {
    if (!settings.autoDream || shuttingDown || busy.dream || !session?.projectKey) return;
    busy.dream = true;
    try {
      const result = await runDream(session.projectKey, { manual: false, session });
      if (result.state === 'skipped') {
        await setStatus({ dreamAuto: { state: 'skipped', reason: result.reason, at: now() } });
      }
    } catch (error) {
      log(`自动 Dream 失败：${errorText(error)}`);
    } finally {
      busy.dream = false;
    }
  }

  // ----------------------------------------------------------
  // 生命周期
  // ----------------------------------------------------------

  function startLoop(runner) {
    const tick = () => {
      if (shuttingDown || runner.isRunning()) return;
      void runner().catch((error) => log(`后台轮询失败：${errorText(error)}`));
    };
    const timer = setInterval(tick, pollMs);
    if (timer.unref) timer.unref();
    timers.push(timer);
    tick();
  }

  /** 上次进程退出时还在跑的任务：标成已取消，面板不会一直显示「运行中」。 */
  async function settleStaleStatus() {
    const status = await store.readStatus();
    const patch = {};
    for (const key of ['extraction', 'dream']) {
      if (status?.[key]?.state === 'running') patch[key] = { ...status[key], state: 'aborted', at: now() };
    }
    if (Object.keys(patch).length > 0) await setStatus(patch);
  }

  async function start() {
    await store.ensure();
    await settleStaleStatus();
    await refreshSettings();
    // 召回与提取各走一条轮询：提取或 Dream 再慢也不会挡住召回
    startLoop(processRecallRequests);
    startLoop(processTurnJobs);
    pi?.events?.on?.('plugin:settingsChanged', () => {
      void refreshSettings();
    });
    pi?.events?.on?.('session:modelChanged', (payload) => {
      if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId) return;
      void store
        .writeSessionModel(payload.sessionId, {
          modelKey: typeof payload.modelKey === 'string' ? payload.modelKey : '',
          thinkingLevel: payload.thinkingLevel,
        })
        .catch((error) => log(`会话模型记录失败：${errorText(error)}`));
    });
    log(`已启动，数据目录：${storageRoot}`);
    return { storageRoot, settings };
  }

  /** 上游关闭语义：取消运行中的提取与 Dream，迟到的结果不落盘、不推进游标。 */
  function stop() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const timer of timers) clearInterval(timer);
    timers = [];
    for (const scheduler of schedulers.values()) scheduler.shutdown();
    lifecycle.abort();
  }

  async function drainAll() {
    await Promise.all([...schedulers.values()].map((scheduler) => scheduler.drain()));
    await Promise.all([...closing.values()]);
    await Promise.all([...runningDreams.values()].map((entry) => entry.task.catch(() => {})));
  }

  async function latestProjectSession(projectKey) {
    const sessions = (await store.listSessions())
      .filter((session) => session.projectKey === projectKey)
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
    return sessions[0] || null;
  }

  /** 面板「立即提取」：走同一个调度器，游标语义不变。 */
  async function runExtraction(projectKey) {
    const session = await latestProjectSession(projectKey);
    if (!session) throw new Error('该项目还没有会话转录');
    if (closing.has(session.sessionId)) await closing.get(session.sessionId);
    const scheduled = await scheduleSessionExtraction(session.sessionId);
    if (!scheduled) throw new Error('该项目还没有会话转录');
    const scheduler = schedulerFor(session.sessionId);
    await scheduler.drain();
    // 已关闭的会话：用完就释放，不留调度器
    if (closedAt.has(session.sessionId) && schedulers.get(session.sessionId) === scheduler) {
      scheduler.shutdown();
      schedulers.delete(session.sessionId);
    }
    const status = await store.readStatus();
    return { state: status.extraction?.state || 'idle', sessionId: session.sessionId };
  }

  return {
    storageRoot,
    store,
    start,
    stop,
    drainAll,
    runDream,
    runExtraction,
    panel: panelData.createPanelApi({
      storageRoot,
      getSettings: async () => settings,
      setSettings,
      runDream: (projectKey) => runDream(projectKey, { manual: true }),
      runExtraction,
      store,
    }),
    processTurnJobs,
    processRecallRequests,
    _internals: {
      get settings() {
        return settings;
      },
      store,
      limiter,
      modelCache,
      recallStates,
      schedulers,
      resolveModel,
      complete,
      handleRecall,
      renderTranscript,
    },
  };
}

async function onLoad() {
  const runtime = createPluginRuntime();
  state = runtime;
  await runtime.start();
  const pi = getPi();
  await pi.commands.register({
    id: 'zcode-memory.open',
    title: 'ZCode 记忆：打开管理面板',
    run: async () => {
      await pi.ui.openPanel();
    },
  });
  return runtime;
}

async function onPanelInvoke(channel, payload) {
  if (!state) throw new Error('plugin is not loaded');
  return state.panel.invoke(channel, payload);
}

function onUnload() {
  state?.stop();
  state = null;
}

module.exports = {
  onLoad,
  onPanelInvoke,
  onUnload,
  _internals: { createPluginRuntime, getState: () => state },
};
