'use strict';

/**
 * 上游 ZCode 3.16.x 的常量。每一项都对应上游源码里的同一个数字，
 * 改动前先看 docs/对齐矩阵.md 的出处列。
 */
const LIMITS = {
  MEMORY_INDEX_LINE_LIMIT: 200, // core/src/memory/index-content.ts
  MEMORY_INDEX_CHARACTER_LIMIT: 25000,
  MANIFEST_FILE_LIMIT: 200, // core/src/memory/recall/manifest.ts
  MANIFEST_PREVIEW_LINE_LIMIT: 30,
  MEMORY_CONTENT_LINE_LIMIT: 200, // core/src/memory/recall/content.ts
  MEMORY_CONTENT_BYTE_LIMIT: 4096,
  MEMORY_RECALL_SESSION_CHARACTER_LIMIT: 61440, // core/src/memory/recall/index.ts
  MAX_SELECTED_MEMORIES: 5, // core/src/memory/recall/selector.ts
  STALE_DAY_MS: 86400000,
  MINIMUM_USER_WORDS: 3, // core/src/memory/extraction.ts
  EXTRACTION_MAX_TURNS: 5,
  EXTRACTION_DRAIN_TIMEOUT_MS: 60000, // runtime/helpers/project-memory-extraction.ts：关闭会话时最多等这么久
  DREAM_MAX_TURNS: 50, // runtime/helpers/project-memory-dream.ts
  DREAM_MINIMUM_TRANSCRIPT_SESSIONS: 5,
  DREAM_LOCK_FRESH_MS: 3600000, // core/src/memory/dream.ts
  AUTO_DREAM_MINIMUM_INTERVAL_MS: 86400000,
  AUTO_DREAM_SCAN_THROTTLE_MS: 600000,
  PREVIEW_MAX_BYTES: 5 * 1024 * 1024, // 面板只读预览上限
};

/** 宿主 PI-Desktop 0.21.0 的限制，插件按同一套数字自我约束。 */
const HOST_LIMITS = {
  COMPLETE_WINDOW_MS: 60000, // out/main/chunks/index-*.js: MAX_COMPLETE_PER_WINDOW
  COMPLETE_PER_WINDOW: 8,
  COMPLETE_TIMEOUT_MS: 90000,
  COMPLETE_SYSTEM_MAX_CHARS: 32768,
  COMPLETE_MESSAGES_MAX_CHARS: 200000,
  EXTENSION_HANDLER_TIMEOUT_MS: 30000, // out/main/chunks/runner-*.js dispatch(…, 3e4)
};

/** 上游提示词里出现、需要保持逐字的文件名。 */
const MEMORY_INDEX_FILENAME = 'MEMORY.md';
const DREAM_LOCK_FILE = '.consolidate-lock';

/**
 * 允许的替换表：只有这三类差异可以出现在提示词里。
 * npm run check 会核对替换表与源码，防止悄悄改文案。
 */
const PROMPT_SUBSTITUTIONS = [
  {
    id: 'agents-md',
    from: 'CLAUDE.md',
    to: 'AGENTS.md',
    reason: 'PI-Desktop 的项目指令文件叫 AGENTS.md，不叫 CLAUDE.md。',
  },
  {
    id: 'memory-root',
    from: '${memoryRoot}',
    to: '~/.pi-desktop/zcode-memory/memories/projects/<slug>-<hash>/memory',
    reason: '记忆根目录随宿主数据目录变化，属于路径差异。',
  },
  {
    id: 'transcript-root',
    from: '${transcriptRoot}',
    to: '~/.pi-desktop/zcode-memory/transcripts/<projectKey>',
    reason: '转录目录随宿主数据目录变化，属于路径差异。',
  },
];

module.exports = {
  LIMITS,
  HOST_LIMITS,
  MEMORY_INDEX_FILENAME,
  DREAM_LOCK_FILE,
  PROMPT_SUBSTITUTIONS,
};
