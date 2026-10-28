'use strict';

const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIMITS, HOST_LIMITS, DREAM_LOCK_FILE } = require('./constants');
const { sha256, writeJson, readJson } = require('./fs-safe');

// ============================================================
// 目录与键（上游 memory/project-root.ts 的同一算法）
// ============================================================

function defaultStorageRoot(homeDir) {
  return path.join(homeDir || os.homedir(), '.pi-desktop', 'zcode-memory');
}

function sanitizeProjectSlug(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'project';
}

/** 与上游一致：win32 用小写路径，目录名 = slug + sha256 前 16 位。 */
function projectIdentity(workspacePath, workspaceIdentity) {
  const normalized = path.resolve(workspacePath);
  const identity = workspaceIdentity && workspaceIdentity.trim();
  const keySource = identity || (process.platform === 'win32' ? normalized.toLowerCase() : normalized);
  const hash = sha256(keySource).slice(0, 16);
  const slug = identity ? 'project' : sanitizeProjectSlug(path.basename(normalized) || 'project');
  return { key: `${slug}-${hash}`, slug, hash, workspacePath: normalized };
}

function projectMemoryRoot(storageRoot, workspacePath, workspaceIdentity) {
  const identity = projectIdentity(workspacePath, workspaceIdentity);
  return path.join(storageRoot, 'memories', 'projects', identity.key, 'memory');
}

function transcriptRoot(storageRoot, projectKey) {
  return path.join(storageRoot, 'transcripts', projectKey);
}

function statePaths(storageRoot) {
  const state = path.join(storageRoot, 'state');
  return {
    state,
    sessions: path.join(state, 'sessions'),
    turns: path.join(state, 'turns'),
    recallRequests: path.join(state, 'recall'),
    notices: path.join(state, 'notices'),
    closed: path.join(state, 'closed'),
    sessionModels: path.join(state, 'session-models.json'),
    settingsMirror: path.join(state, 'settings.json'),
    status: path.join(state, 'status.json'),
    taskRewrite: path.join(state, 'task-rewrite.json'),
    modelCache: path.join(state, 'models.json'),
    dreamScan: path.join(state, 'dream-scan.json'),
    archive: path.join(storageRoot, 'archive'),
  };
}

function sanitizeAgentKey(agentName) {
  const key = String(agentName || '').replace(/[^a-zA-Z0-9_-]/g, '-');
  return key === '' ? 'unknown' : key;
}

/** 三种作用域各自的目录；project/local 放在工作区里，user 放在插件数据根。 */
function agentMemoryRoot(input) {
  const agentKey = sanitizeAgentKey(input.agentName);
  if (input.scope === 'user') return path.join(input.storageRoot, 'agent-memory', agentKey);
  const workspace = path.resolve(input.workspaceRoot);
  return input.scope === 'project'
    ? path.join(workspace, '.pi', 'zcode-memory', 'agent-memory', agentKey)
    : path.join(workspace, '.pi', 'zcode-memory', 'agent-memory-local', agentKey);
}

// ============================================================
// 设置
// ============================================================

const DEFAULT_SETTINGS = {
  autoExtract: true,
  semanticRecall: false,
  autoDream: false,
  strictUpstream: false,
  improveE1: true,
  improveE2: true,
  improveE3: true,
  improveE4: true,
  backgroundModel: '',
  agentMemoryScopes: '{}',
  taskRewrite: true,
};

const SETTING_TYPES = Object.fromEntries(
  Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, typeof value]),
);

function normalizeSettings(raw) {
  const values = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const settings = {
    autoExtract: values.autoExtract !== false,
    semanticRecall: values.semanticRecall === true,
    autoDream: values.autoDream === true,
    strictUpstream: values.strictUpstream === true,
    improveE1: values.improveE1 !== false,
    improveE2: values.improveE2 !== false,
    improveE3: values.improveE3 !== false,
    improveE4: values.improveE4 !== false,
    backgroundModel: typeof values.backgroundModel === 'string' ? values.backgroundModel.trim() : '',
    agentMemoryScopes: typeof values.agentMemoryScopes === 'string' ? values.agentMemoryScopes : '{}',
    taskRewrite: values.taskRewrite !== false,
  };
  if (settings.strictUpstream) {
    settings.improveE1 = false;
    settings.improveE2 = false;
    settings.improveE3 = false;
    settings.improveE4 = false;
  }
  return settings;
}

function parseAgentScopes(text) {
  let parsed;
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const scopes = {};
  for (const [agent, scope] of Object.entries(parsed)) {
    if (!agent || !['user', 'project', 'local'].includes(scope)) continue;
    scopes[agent] = scope;
  }
  return scopes;
}

// ============================================================
// 固定窗口限流（镜像宿主 8 次 / 60 秒）
// ============================================================

/**
 * 宿主对 agent.complete 用固定窗口：窗口从它收到的第一次调用起算，窗口内第 9 次直接 RATE_LIMITED。
 * 本地用滑动记录：任意 windowMs 时间段内最多放行 limit 次。宿主的每个 60 秒窗口都落在某个
 * 本地时间段里，所以不管宿主窗口从哪一刻开始都不会超（windowMs 比 60 秒多留一点余量）。
 * 排队按优先级：召回插到提取与 Dream 前面。
 */
function createRateLimiter(options = {}) {
  const now = options.now || Date.now;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const windowMs = options.windowMs ?? HOST_LIMITS.COMPLETE_WINDOW_MS + (options.marginMs ?? 1500);
  const limit = options.limit ?? HOST_LIMITS.COMPLETE_PER_WINDOW;
  const grants = [];
  const queue = [];
  let draining = false;
  let sequence = 0;

  const prune = () => {
    const cutoff = now() - windowMs;
    while (grants.length > 0 && grants[0] <= cutoff) grants.shift();
  };

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        prune();
        while (grants.length >= limit) {
          await wait(Math.max(1, grants[0] + windowMs - now()));
          prune();
        }
        queue.sort((left, right) => right.priority - left.priority || left.seq - right.seq);
        const item = queue.shift();
        grants.push(now());
        item.resolve();
      }
    } finally {
      draining = false;
    }
  }

  return {
    acquire(priority = 1) {
      return new Promise((resolve) => {
        queue.push({ priority, seq: sequence += 1, resolve });
        void drain();
      });
    },
    stats() {
      prune();
      return { used: grants.length, limit, windowMs, queued: queue.length };
    },
  };
}

// ============================================================
// 模型选择
// ============================================================

// 与宿主 EXTENDED_THINKING_LEVELS 同序（out/main/chunks/index-*.js）
const THINKING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function lowestThinkingLevel(model) {
  const levels = Array.isArray(model?.thinkingLevels) && model.thinkingLevels.length > 0
    ? model.thinkingLevels
    : ['off'];
  for (const level of THINKING_ORDER) {
    if (levels.includes(level)) return level;
  }
  return levels[0];
}

/**
 * 后台模型 = 设置覆盖 → 宿主发来的会话 modelKey（session:modelChanged）→
 * 用会话里看到的 modelId 在 models.list 里找唯一匹配。找不到或有歧义就跳过并说明原因，
 * 不擅自换成别的模型（上游：提取继承产生该工作的那一轮的模型）。
 *
 * 扩展里的 ctx.model.provider 是 vendorKey（resources/agent-runtime/sidecar.js 的
 * `provider:t.extensionAgentKey?t.id:t.vendorKey?.trim()||t.id`），不一定等于宿主的
 * providerId，所以只把它当作消歧依据。
 */
function resolveBackgroundModel(input) {
  const models = Array.isArray(input.models) ? input.models : [];
  const byKey = new Map(models.map((model) => [model.key, model]));
  const override = (input.backgroundModel || '').trim();
  if (override) {
    if (byKey.has(override)) return { model: byKey.get(override), source: 'setting' };
    return { model: null, reason: `设置中的后台模型不在可用模型列表里：${override}` };
  }
  if (models.length === 0) return { model: null, reason: '宿主没有返回可用模型（models.list 为空）' };
  if (input.sessionModelKey) {
    if (byKey.has(input.sessionModelKey)) return { model: byKey.get(input.sessionModelKey), source: 'session' };
    return { model: null, reason: `会话模型不在可用模型列表里：${input.sessionModelKey}` };
  }
  const modelId = typeof input.sessionModelId === 'string' ? input.sessionModelId.trim() : '';
  if (!modelId) return { model: null, reason: '还不知道这个会话用的模型（未收到会话模型信息）' };
  const sameId = models.filter((model) => model.modelId === modelId);
  if (sameId.length === 1) return { model: sameId[0], source: 'session' };
  if (sameId.length > 1) {
    const hint = typeof input.sessionProvider === 'string' ? input.sessionProvider.trim().toLowerCase() : '';
    const narrowed = hint
      ? sameId.filter((model) => [model.providerId, model.providerName].some((value) => String(value || '').toLowerCase() === hint))
      : [];
    if (narrowed.length === 1) return { model: narrowed[0], source: 'session' };
    return { model: null, reason: `会话模型 ${modelId} 对应多个服务商，请在设置里填写后台模型（providerId/modelId）` };
  }
  return { model: null, reason: `会话模型不在可用模型列表里：${modelId}` };
}

// ============================================================
// 相对时间（上游 packages/ui/src/settings/memoryUpdatedAt.ts）
// ============================================================

const MINUTE_MS = 60000;
const RELATIVE_MINUTES_LIMIT = 30;

function startOfLocalDay(timestamp) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatClock(timestamp, locale) {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', hourCycle: 'h23', minute: '2-digit' }).format(timestamp);
}

function formatWeekday(timestamp, locale) {
  if (locale === 'zh-CN') return `周${'日一二三四五六'[new Date(timestamp).getDay()]}`;
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(timestamp);
}

function formatDate(timestamp, locale, includeYear) {
  const date = new Date(timestamp);
  if (locale === 'zh-CN') {
    return includeYear
      ? `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
      : `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(includeYear ? { year: 'numeric' } : {}),
  }).format(timestamp);
}

function formatMemoryUpdatedAt(input) {
  const { now, updatedAt } = input;
  const locale = input.locale || 'zh-CN';
  const elapsedMs = now - updatedAt;
  if (!Number.isFinite(updatedAt) || elapsedMs < MINUTE_MS) return '刚刚';
  const elapsedMinutes = Math.floor(elapsedMs / MINUTE_MS);
  if (elapsedMinutes < RELATIVE_MINUTES_LIMIT) return `${elapsedMinutes} 分钟前`;
  const todayStart = startOfLocalDay(now);
  const updatedDayStart = startOfLocalDay(updatedAt);
  const time = formatClock(updatedAt, locale);
  if (updatedDayStart === todayStart) return `今天 ${time}`;
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  if (updatedDayStart === yesterdayStart.getTime()) return `昨天 ${time}`;
  const today = new Date(todayStart);
  const weekStart = new Date(todayStart);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  if (updatedDayStart >= weekStart.getTime()) return `${formatWeekday(updatedAt, locale)} ${time}`;
  return `${formatDate(updatedAt, locale, new Date(updatedAt).getFullYear() !== today.getFullYear())} ${time}`;
}

// ============================================================
// 跨进程状态目录
// ============================================================

class Store {
  constructor(storageRoot) {
    this.root = storageRoot;
    this.paths = statePaths(storageRoot);
    this.statusChain = Promise.resolve();
  }

  async ensure() {
    await Promise.all([
      fsp.mkdir(this.paths.sessions, { recursive: true }),
      fsp.mkdir(this.paths.turns, { recursive: true }),
      fsp.mkdir(this.paths.recallRequests, { recursive: true }),
      fsp.mkdir(this.paths.notices, { recursive: true }),
      fsp.mkdir(this.paths.closed, { recursive: true }),
      fsp.mkdir(path.join(this.root, 'memories', 'projects'), { recursive: true }),
      fsp.mkdir(path.join(this.root, 'transcripts'), { recursive: true }),
      fsp.mkdir(this.paths.archive, { recursive: true }),
    ]);
  }

  sessionFile(sessionId) {
    return path.join(this.paths.sessions, `${sessionId}.json`);
  }

  async writeSession(info) {
    await writeJson(this.sessionFile(info.sessionId), info);
  }

  async readSession(sessionId) {
    return readJson(this.sessionFile(sessionId), null);
  }

  async listSessions() {
    let names;
    try {
      names = await fsp.readdir(this.paths.sessions);
    } catch {
      return [];
    }
    const sessions = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const info = await readJson(path.join(this.paths.sessions, name), null);
      if (info && info.sessionId) sessions.push(info);
    }
    return sessions;
  }

  turnFile(sessionId) {
    return path.join(this.paths.turns, `${sessionId}.json`);
  }

  async writeTurn(job) {
    await writeJson(this.turnFile(job.sessionId), job);
  }

  async listTurns() {
    let names;
    try {
      names = await fsp.readdir(this.paths.turns);
    } catch {
      return [];
    }
    const jobs = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const job = await readJson(path.join(this.paths.turns, name), null);
      if (job && job.sessionId) jobs.push(job);
    }
    return jobs;
  }

  async clearTurn(sessionId) {
    await fsp.rm(this.turnFile(sessionId), { force: true });
  }

  /** 转录：一行一条消息，追加写。 */
  async appendTranscript(projectKey, sessionId, entries) {
    if (!entries.length) return;
    const dir = transcriptRoot(this.root, projectKey);
    await fsp.mkdir(dir, { recursive: true });
    const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await fsp.appendFile(path.join(dir, `${sessionId}.jsonl`), `${lines}\n`, 'utf8');
  }

  async readTranscript(projectKey, sessionId) {
    try {
      const text = await fsp.readFile(path.join(transcriptRoot(this.root, projectKey), `${sessionId}.jsonl`), 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  async transcriptMtimes(projectKey) {
    const dir = transcriptRoot(this.root, projectKey);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const stat = await fsp.lstat(path.join(dir, name));
        if (stat.isFile()) entries.push({ name, mtimeMs: stat.mtimeMs });
      } catch {
        // 单个转录读不到不影响门槛判断
      }
    }
    return entries;
  }

  /** 主进程内串行：并发的状态补丁不会互相覆盖。 */
  writeStatus(patch) {
    const next = this.statusChain.then(async () => {
      const current = await readJson(this.paths.status, {});
      const merged = { ...current, ...patch, updatedAt: Date.now() };
      await writeJson(this.paths.status, merged);
      return merged;
    });
    this.statusChain = next.catch(() => undefined);
    return next;
  }

  async readStatus() {
    return readJson(this.paths.status, {});
  }

  /** 扩展写的 Task 改写记录（单独一个文件，不和主进程抢 status.json）。 */
  async readTaskRewrite() {
    return readJson(this.paths.taskRewrite, null);
  }

  async writeModelCache(entries) {
    await writeJson(this.paths.modelCache, { entries, at: Date.now() });
  }

  async readModelCache() {
    return readJson(this.paths.modelCache, { entries: [], at: 0 });
  }

  recallRequestFile(sessionId) {
    return path.join(this.paths.recallRequests, `${sessionId}.req.json`);
  }

  recallResponseFile(sessionId) {
    return path.join(this.paths.recallRequests, `${sessionId}.res.json`);
  }

  dreamLockPath(memoryRoot) {
    return path.join(memoryRoot, DREAM_LOCK_FILE);
  }

  /** Dream 改动通知：按项目一份，扩展按会话各消费一次。 */
  /** 扩展在 session_shutdown 时留下的「会话已关闭」标记。 */
  closedFile(sessionId) {
    return path.join(this.paths.closed, `${sessionId}.json`);
  }

  noticeFile(projectKey) {
    return path.join(this.paths.notices, `${projectKey}.json`);
  }

  async writeNotice(projectKey, notice) {
    await writeJson(this.noticeFile(projectKey), notice);
  }

  readNoticeSync(projectKey) {
    try {
      return JSON.parse(fs.readFileSync(this.noticeFile(projectKey), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 宿主 session:modelChanged 给的 modelKey（providerId/modelId），按会话记一份；串行写。 */
  writeSessionModel(sessionId, info) {
    const next = this.statusChain.then(async () => {
      const current = await readJson(this.paths.sessionModels, {});
      current[sessionId] = { ...info, at: Date.now() };
      await writeJson(this.paths.sessionModels, current);
    });
    this.statusChain = next.catch(() => undefined);
    return next;
  }

  async readSessionModels() {
    return readJson(this.paths.sessionModels, {});
  }
}

/**
 * 没有打开项目的会话：宿主把 ctx.cwd 退回到会话临时目录（resources/agent-runtime/sidecar.js
 * 的 extensionCwd()）。这种会话没有工作区，不启用记忆（上游的记忆以工作区为单位）。
 */
function isScratchWorkspace(cwd, env = process.env, homeDir) {
  if (typeof cwd !== 'string' || !cwd) return true;
  const dataDir = env.PI_DESKTOP_DATA_DIR || path.join(homeDir || os.homedir(), '.pi-desktop');
  const scratch = path.resolve(dataDir, 'scratch');
  const target = path.resolve(cwd);
  const rel = path.relative(scratch, target);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) return true;
  return process.platform === 'win32' && target.toLowerCase().startsWith(`${scratch.toLowerCase()}${path.sep}`);
}

module.exports = {
  defaultStorageRoot,
  sanitizeProjectSlug,
  projectIdentity,
  projectMemoryRoot,
  transcriptRoot,
  statePaths,
  sanitizeAgentKey,
  agentMemoryRoot,
  DEFAULT_SETTINGS,
  SETTING_TYPES,
  normalizeSettings,
  parseAgentScopes,
  createRateLimiter,
  THINKING_ORDER,
  lowestThinkingLevel,
  resolveBackgroundModel,
  formatMemoryUpdatedAt,
  formatClock,
  formatWeekday,
  isScratchWorkspace,
  Store,
  LIMITS,
};
