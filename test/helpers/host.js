'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');

/**
 * 宿主 agent.complete 的固定窗口限流，与 PI-Desktop 0.21.0 的 completeRateExceeded 同一算法
 * （out/main/chunks/index-*.js）：窗口从第一次调用开始，超出后仍计数，直到窗口过期。
 */
function createHostRateLimit({ limit = 8, windowMs = 60000, now = () => Date.now() } = {}) {
  let current;
  return {
    exceeded() {
      const at = now();
      if (!current || at - current.windowStart >= windowMs) {
        current = { windowStart: at, count: 1 };
        return false;
      }
      current.count += 1;
      return current.count > limit;
    },
  };
}

/** 假宿主：只实现插件用到的通道，并记录每次 agent.complete。 */
function createFakeHost(options = {}) {
  const settings = { ...(options.settings || {}) };
  const calls = [];
  const rejected = [];
  const commands = [];
  const handlers = new Map();
  const responses = [...(options.responses || [])];
  const errors = [...(options.errors || [])];
  const rateLimit = options.rateLimit ? createHostRateLimit(options.rateLimit) : null;
  const models = options.models || [
    {
      key: 'fake/model-a',
      providerId: 'fake',
      providerName: 'Fake',
      modelId: 'model-a',
      label: 'model-a (Fake)',
      isDefault: true,
      thinkingLevels: ['low', 'high'],
    },
  ];
  const emit = (name, payload) => {
    for (const handler of handlers.get(name) || []) handler(payload);
  };
  const pi = {
    plugin: {
      getSettings: async () => ({ ...settings }),
      setSettings: async (partial) => {
        Object.assign(settings, partial);
        emit('plugin:settingsChanged', { ...settings });
      },
      getDataPath: () => options.dataPath || '',
    },
    models: { list: async () => models },
    agent: {
      complete: async (input) => {
        if (rateLimit && rateLimit.exceeded()) {
          rejected.push(input);
          const error = new Error('plugin completion rate exceeded');
          error.code = 'RATE_LIMITED';
          throw error;
        }
        calls.push(input);
        if (errors.length > 0) throw errors.shift();
        const next = responses.length > 0 ? responses.shift() : options.defaultText ?? 'Nothing to save.';
        return { text: typeof next === 'function' ? next(input) : next, modelKey: input.modelKey, usage: {} };
      },
    },
    commands: { register: async (command) => commands.push(command) },
    ui: { openPanel: async () => {}, showToast: async () => {} },
    events: {
      on: (name, handler) => {
        const list = handlers.get(name) || [];
        list.push(handler);
        handlers.set(name, list);
      },
    },
    log: () => {},
  };
  return {
    pi,
    settings,
    calls,
    rejected,
    commands,
    handlers,
    pushResponses: (...items) => responses.push(...items),
    emit,
  };
}

/** 假 sidecar：收集扩展注册的钩子，按宿主的方式触发。 */
function createExtensionHost() {
  const handlers = new Map();
  const api = {
    on: (name, handler) => {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  return {
    api,
    handlers,
    async emit(name, event, ctx) {
      let result;
      for (const handler of handlers.get(name) || []) {
        const value = await handler(event, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    },
  };
}

/**
 * pi sidecar 的 ctx 形状（runner createContext）。model.provider 是字符串：
 * resources/agent-runtime/sidecar.js 里 `provider:t.extensionAgentKey?t.id:t.vendorKey?.trim()||t.id`。
 */
function createCtx({ cwd, sessionId, model = { provider: 'fake', id: 'model-a' } }) {
  return {
    cwd,
    model,
    sessionManager: { getSessionId: () => sessionId, getCwd: () => cwd },
    isIdle: () => true,
  };
}

async function makeTempDir(prefix) {
  const base = process.env.PI_SCRATCH_DIR || require('node:os').tmpdir();
  return fsp.mkdtemp(path.join(base, `${prefix}-`));
}

/** 等到条件成立（后台轮询是异步的）。 */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = { createFakeHost, createHostRateLimit, createExtensionHost, createCtx, makeTempDir, waitFor };
