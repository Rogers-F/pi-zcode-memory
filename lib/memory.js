'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { LIMITS, DREAM_LOCK_FILE } = require('./constants');
const prompts = require('./prompts');
const safe = require('./fs-safe');

// ============================================================
// 前置元数据（只支持记忆文件用到的 YAML 子集）
// ============================================================

/** 去掉 BOM、统一换行。 */
function normalizeText(content) {
  return String(content).replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '' || value === '~' || value === 'null') return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replace(/\\"/gu, '"').replace(/\\n/gu, '\n') : inner.replace(/''/gu, "'");
  }
  return value.replace(/\s+#.*$/u, '').trim();
}

/**
 * 解析 `key: value` 与一层嵌套（metadata:）。上游用 yaml 包，
 * 这里只覆盖记忆文件实际出现的结构；矩阵记为等效替代。
 */
function parseFrontmatter(content) {
  const lines = normalizeText(content).split('\n');
  if (lines[0] !== '---') return { data: {}, hasFrontmatter: false, body: normalizeText(content) };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { data: {}, hasFrontmatter: false, body: normalizeText(content) };
  const data = {};
  let current = null;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const nested = /^ {2,}([^:#]+):(.*)$/u.exec(line);
    if (nested && current) {
      const value = parseScalar(nested[2]);
      if (value !== undefined) data[current][nested[1].trim()] = value;
      continue;
    }
    const pair = /^([^:#]+):(.*)$/u.exec(line);
    if (!pair) continue;
    const key = pair[1].trim();
    const value = parseScalar(pair[2]);
    if (value === undefined) {
      data[key] = {};
      current = key;
    } else {
      data[key] = value;
      current = null;
    }
  }
  return { data, hasFrontmatter: true, body: lines.slice(end + 1).join('\n') };
}

const MEMORY_FRONTMATTER_PATTERN = /^(\uFEFF?---(?:\r\n|\n))([\s\S]*?)((?:\r\n|\n)---)(?=(?:\r\n|\n)|$)/u;

/**
 * 上游用 yaml Document：缺 originSessionId 时把 node_type: memory 放到 metadata 首位，
 * 再写入 originSessionId。这里按行重建，保留其它字段与原有顺序。
 */
function stampMemoryOriginSessionId(input) {
  const { content, filePath, memoryRoot, sessionId } = input;
  if (!memoryRoot || !filePath.endsWith('.md')) return content;
  if (safe.relativeInside(memoryRoot, filePath) === undefined) return content;
  const match = MEMORY_FRONTMATTER_PATTERN.exec(content);
  if (!match) return content;
  const opening = match[1];
  const frontmatter = match[2];
  const closing = match[3];
  const lineEnding = opening.endsWith('\r\n') ? '\r\n' : '\n';
  const lines = frontmatter.split(/\r\n|\n/u);
  const metadataIndex = lines.findIndex((line) => /^metadata:\s*(?:#.*)?$/u.test(line));
  const metadataChildren = [];
  let endIndex = lines.length;
  if (metadataIndex >= 0) {
    endIndex = metadataIndex + 1;
    while (endIndex < lines.length && /^\s+/u.test(lines[endIndex])) {
      metadataChildren.push(lines[endIndex]);
      endIndex += 1;
    }
  }
  const hasOrigin = metadataChildren.some((line) => /^\s+originSessionId:\s*\S/u.test(line));
  if (hasOrigin) return content;
  const childKeys = new Set(
    metadataChildren
      .map((line) => /^\s+([A-Za-z0-9_.-]+):/u.exec(line)?.[1])
      .filter(Boolean),
  );
  const kept = metadataChildren.filter((line) => !/^\s+node_type:/u.test(line));
  const rebuilt = [
    '  node_type: memory',
    `  originSessionId: ${sessionId}`,
    ...kept,
  ];
  let nextLines;
  if (metadataIndex >= 0) {
    nextLines = [
      ...lines.slice(0, metadataIndex),
      'metadata:',
      ...rebuilt,
      ...lines.slice(endIndex),
    ];
  } else {
    nextLines = [...lines, 'metadata:', ...rebuilt];
  }
  const stamped = nextLines.join(lineEnding).replace(/\n$/u, '').replace(/\n/gu, lineEnding);
  return `${opening}${stamped}${closing}${content.slice(match[0].length)}`;
}

// ============================================================
// MEMORY.md 索引
// ============================================================

const LEADING_FRONTMATTER_PATTERN = /^---\s*\n[\s\S]*?---\s*\n?/u;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;
const LIST_MARKER_PATTERN = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/u;
const FENCE_PATTERN = /^ {0,3}(```+|~~~+)/u;

/**
 * 上游用 marked 的 Lexer：只删「顶层 html token」里的注释，
 * list / blockquote / paragraph / code 里的注释必须保持可见。
 * 这里用行扫描实现同一判定（等效替代，测试覆盖这些位置）。
 */
function stripTopLevelMarkdownHtmlComments(content) {
  if (!content.includes('<!--')) return content;
  const lines = content.split('\n');
  const out = [];
  let fence = null;
  let listOpen = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fence) {
      out.push(line);
      if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`, 'u').test(line)) fence = null;
      i += 1;
      continue;
    }
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1];
      listOpen = false;
      out.push(line);
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      listOpen = false;
      out.push(line);
      i += 1;
      continue;
    }
    if (LIST_MARKER_PATTERN.test(line)) listOpen = true;
    const isCommentStart = /^ {0,3}<!--/u.test(line) && fence === null;
    if (isCommentStart && !listOpen) {
      const buffer = [];
      while (i < lines.length) {
        buffer.push(lines[i]);
        const done = lines[i].includes('-->');
        i += 1;
        if (done) break;
      }
      const without = buffer.join('\n').replace(HTML_COMMENT_PATTERN, '');
      if (without.trim().length > 0) out.push(without);
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

function formatBytes(value) {
  const kilobytes = value / 1024;
  if (kilobytes < 1) return `${value} bytes`;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1).replace(/\.0$/u, '')}KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${megabytes.toFixed(1).replace(/\.0$/u, '')}MB`;
  return `${(megabytes / 1024).toFixed(1).replace(/\.0$/u, '')}GB`;
}

function formatMemoryIndexContent(content) {
  const normalized = normalizeText(content);
  const trimmed = normalized.trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  const lineCount = lines.length;
  const characterCount = trimmed.length;
  const lineTruncated = lineCount > LIMITS.MEMORY_INDEX_LINE_LIMIT;
  const characterTruncated = characterCount > LIMITS.MEMORY_INDEX_CHARACTER_LIMIT;
  if (!lineTruncated && !characterTruncated) return trimmed;
  let truncated = lineTruncated ? lines.slice(0, LIMITS.MEMORY_INDEX_LINE_LIMIT).join('\n') : trimmed;
  if (truncated.length > LIMITS.MEMORY_INDEX_CHARACTER_LIMIT) {
    const finalNewline = truncated.lastIndexOf('\n', LIMITS.MEMORY_INDEX_CHARACTER_LIMIT);
    truncated = truncated.slice(0, finalNewline > 0 ? finalNewline : LIMITS.MEMORY_INDEX_CHARACTER_LIMIT);
  }
  const sizeDescription =
    characterTruncated && !lineTruncated
      ? `${formatBytes(characterCount)} (limit: ${formatBytes(LIMITS.MEMORY_INDEX_CHARACTER_LIMIT)}) — index entries are too long`
      : lineTruncated && !characterTruncated
        ? `${lineCount} lines (limit: ${LIMITS.MEMORY_INDEX_LINE_LIMIT})`
        : `${lineCount} lines and ${formatBytes(characterCount)}`;
  return `${truncated}\n\n> WARNING: MEMORY.md is ${sizeDescription}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

function formatProjectMemoryIndexContent(content) {
  const withoutFrontmatter = normalizeText(content).replace(LEADING_FRONTMATTER_PATTERN, '');
  return formatMemoryIndexContent(stripTopLevelMarkdownHtmlComments(withoutFrontmatter));
}

// ============================================================
// 记忆清单（manifest）
// ============================================================

async function readManifestEntry(rootDir, rel) {
  const { content, stat } = await safe.readFileInside(rootDir, rel);
  const { data } = parseFrontmatter(content.split('\n').slice(0, LIMITS.MANIFEST_PREVIEW_LINE_LIMIT).join('\n'));
  const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const type = metadata.type || data.type;
  return {
    filePath: path.join(rootDir, ...rel.split('/')),
    filename: rel,
    mtimeMs: stat.mtimeMs,
    ...(typeof data.description === 'string' && data.description ? { description: data.description } : {}),
    ...(['user', 'feedback', 'project', 'reference'].includes(type) ? { type } : {}),
  };
}

/**
 * 上游 scanMemoryManifest：按修改时间倒序，最多 200 条。
 * limit 只给 E2 用：先在更大的候选集里排序，再截到 200 条交给选择器。
 */
async function scanMemoryManifest(input) {
  const limit = input.limit ?? LIMITS.MANIFEST_FILE_LIMIT;
  try {
    const files = await safe.listFilesInside(input.rootDir);
    const candidates = files.filter((file) => file.rel.endsWith('.md') && path.basename(file.rel) !== 'MEMORY.md');
    const settled = await Promise.allSettled(candidates.map((file) => readManifestEntry(input.rootDir, file.rel)));
    return settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

// ============================================================
// E2：BM25 + 时间衰减的 RRF 混合排序
// ============================================================

const RRF_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = [];
  for (const match of lower.matchAll(/[a-z0-9_]+/gu)) tokens.push(match[0]);
  for (const match of lower.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu)) {
    const run = match[0];
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function bm25Scores(docs, queryTokens) {
  const termFrequencies = docs.map((doc) => {
    const counts = new Map();
    for (const token of tokenize(doc)) counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  });
  const lengths = docs.map((doc) => tokenize(doc).length);
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, docs.length);
  const unique = [...new Set(queryTokens)];
  return docs.map((_, index) => {
    let score = 0;
    for (const term of unique) {
      const frequency = termFrequencies[index].get(term) || 0;
      if (frequency === 0) continue;
      const documentFrequency = termFrequencies.filter((counts) => (counts.get(term) || 0) > 0).length;
      const idf = Math.log(1 + (docs.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * lengths[index]) / Math.max(1, averageLength));
      score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
    }
    return score;
  });
}

/**
 * E2：把「词面相关」与「修改时间」用 Reciprocal Rank Fusion 融合。
 * 出处：Cormack, Clarke, Buettcher, SIGIR 2009；BM25：Robertson & Zaragoza 2009。
 */
function rankManifestCandidates(manifest, query) {
  const entries = [...manifest];
  if (entries.length === 0) return entries;
  const queryTokens = tokenize(query);
  const byRecency = [...entries].sort((left, right) => right.mtimeMs - left.mtimeMs);
  const recencyRank = new Map(byRecency.map((entry, index) => [entry.filename, index + 1]));
  const scores = queryTokens.length === 0
    ? new Array(entries.length).fill(0)
    : bm25Scores(entries.map((entry) => `${entry.filename} ${entry.description || ''}`), queryTokens);
  const order = entries.map((entry, index) => ({ entry, index })).sort((left, right) => scores[right.index] - scores[left.index]);
  const lexicalRank = new Map(order.map((item, index) => [item.entry.filename, index + 1]));
  const fused = entries.map((entry) => ({
    entry,
    score:
      (queryTokens.length === 0 ? 0 : 1 / (RRF_K + (lexicalRank.get(entry.filename) || entries.length))) +
      1 / (RRF_K + (recencyRank.get(entry.filename) || entries.length)),
  }));
  fused.sort((left, right) => right.score - left.score || right.entry.mtimeMs - left.entry.mtimeMs);
  return fused.map((item) => item.entry);
}

// ============================================================
// 召回
// ============================================================

function createRecallState() {
  return {
    manifest: undefined,
    selectorMessages: undefined,
    recalledPaths: new Set(),
    recalledContentCharacters: 0,
  };
}

function canStartMemoryRecall(state) {
  return state.recalledContentCharacters < LIMITS.MEMORY_RECALL_SESSION_CHARACTER_LIMIT;
}

function recordRecalledMemories(state, memories) {
  for (const memory of memories) {
    state.recalledPaths.add(memory.filePath);
    state.recalledContentCharacters += memory.content.length;
  }
}

function limitCompleteLinesByBytes(content) {
  const lines = content === '' ? [''] : content.split('\n');
  const selected = [];
  let selectedBytes = 0;
  for (const line of lines) {
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const nextBytes = selectedBytes + separatorBytes + Buffer.byteLength(line, 'utf8');
    if (nextBytes > LIMITS.MEMORY_CONTENT_BYTE_LIMIT) {
      return { content: selected.join('\n'), lineCount: selected.length, truncated: true };
    }
    selected.push(line);
    selectedBytes = nextBytes;
  }
  return { content: selected.join('\n'), lineCount: selected.length, truncated: false };
}

function memoryHeader(filePath, mtimeMs, nowMs) {
  const daysOld = Math.max(0, Math.floor((nowMs - mtimeMs) / LIMITS.STALE_DAY_MS));
  if (daysOld <= 1) return `Memory: ${filePath}:`;
  return `This memory is ${daysOld} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.\n\nMemory: ${filePath}:`;
}

async function readRecalledMemories(input) {
  const settled = await Promise.allSettled(
    input.entries.map(async (entry) => {
      const { content: raw } = await safe.readFileInside(input.rootDir, entry.filename, {
        maxBytes: LIMITS.PREVIEW_MAX_BYTES,
      });
      const normalized = normalizeText(raw);
      const lines = normalized.split('\n');
      let selectedText = lines.slice(0, LIMITS.MEMORY_CONTENT_LINE_LIMIT).join('\n');
      const lineTruncated = lines.length > LIMITS.MEMORY_CONTENT_LINE_LIMIT;
      const byteLimited = limitCompleteLinesByBytes(selectedText);
      selectedText = byteLimited.content;
      const truncated = byteLimited.truncated || lineTruncated;
      const content = truncated
        ? `${selectedText}\n\n> This memory file was truncated (${
            byteLimited.truncated
              ? `${LIMITS.MEMORY_CONTENT_BYTE_LIMIT} byte limit`
              : `first ${LIMITS.MEMORY_CONTENT_LINE_LIMIT} lines`
          }). Use the Read tool to view the complete file at: ${entry.filePath}`
        : selectedText;
      return {
        content,
        filePath: entry.filePath,
        header: memoryHeader(entry.filePath, entry.mtimeMs, input.nowMs),
        limit: truncated ? byteLimited.lineCount : undefined,
        mtimeMs: entry.mtimeMs,
        sizeBytes: Buffer.byteLength(normalized, 'utf8'),
      };
    }),
  );
  return settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
}

function filterMemorySelections(input) {
  const byFilename = new Map(input.manifest.map((entry) => [entry.filename, entry]));
  const limit = input.limit ?? LIMITS.MAX_SELECTED_MEMORIES;
  return input.selectedFilenames
    .map((filename) => byFilename.get(filename))
    .filter((entry) => entry !== undefined)
    .filter((entry) => !input.recalledPaths.has(entry.filePath))
    .filter((entry) => !(input.readPaths ? input.readPaths.has(entry.filePath) : false))
    .slice(0, limit);
}

function parseSelectorResponse(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (Object.keys(parsed).some((key) => key !== 'selected_memories' && key !== 'selected_knowledge_ids')) return undefined;
  const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (!isStringArray(parsed.selected_memories)) return undefined;
  if (parsed.selected_knowledge_ids !== undefined && !isStringArray(parsed.selected_knowledge_ids)) return undefined;
  return {
    selectedMemories: [...parsed.selected_memories],
    selectedKnowledgeIds: parsed.selected_knowledge_ids ? [...parsed.selected_knowledge_ids] : [],
  };
}

/**
 * 宿主 agent.complete 不能强制 JSON Schema 输出（上游用 responseJsonSchema）。
 * 先按上游严格解析；不行时只剥掉代码围栏或前后说明文字再严格解析一次，
 * 校验规则（键名、类型）与上游完全相同。
 */
function parseSelectorText(text) {
  const raw = String(text ?? '').trim();
  const strict = parseSelectorResponse(raw);
  if (strict) return strict;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(raw);
  if (fenced) {
    const parsed = parseSelectorResponse(fenced[1]);
    if (parsed) return parsed;
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  return parseSelectorResponse(raw.slice(start, end + 1));
}

// ============================================================
// 提取：门槛与调度
// ============================================================

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

function countWords(text) {
  return String(text).split(/\s+/u).filter(Boolean).length;
}

/** E1：带 CJK 的消息按 Unicode 词边界计数（UAX #29 / Intl.Segmenter）。 */
function countWordsCjkAware(text) {
  const value = String(text);
  if (!CJK_PATTERN.test(value)) return countWords(value);
  try {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    let count = 0;
    for (const segment of segmenter.segment(value)) {
      if (segment.isWordLike) count += 1;
    }
    return count;
  } catch {
    return countWords(value);
  }
}

function countWordsForGate(text, improveE1) {
  return improveE1 ? countWordsCjkAware(text) : countWords(text);
}

/**
 * 上游 isMemoryRecallQueryEligible：查询里要有空白（至少两个词）。
 * E1 打开时，带中日韩字符的查询改按 Unicode 词边界数至少 2 个词——与提取门槛同一依据。
 */
function isMemoryRecallQueryEligible(query, improveE1) {
  if (typeof query !== 'string' || !query) return false;
  const trimmed = query.trim();
  if (/\s/u.test(trimmed)) return true;
  return Boolean(improveE1) && CJK_PATTERN.test(trimmed) && countWordsCjkAware(trimmed) >= 2;
}

/**
 * 上游 messagesAfterFoundCursor：没有游标 → 全部；游标找不到 → undefined。
 */
function messagesAfterFoundCursor(entries, cursorId) {
  if (!cursorId) return entries;
  const index = entries.findIndex((entry) => entry.id === cursorId);
  return index < 0 ? undefined : entries.slice(index + 1);
}

/** 上游 countMessagesAfterCursor：游标找不到时按全部消息计数。 */
function countMessagesAfterCursor(entries, cursorId) {
  if (!cursorId) return entries.length;
  const index = entries.findIndex((entry) => entry.id === cursorId);
  return index < 0 ? entries.length : entries.length - index - 1;
}

/**
 * 上游：本轮已有对记忆目录的 Write/Edit 时跳过提取。
 * PI-Desktop 的 Write/Edit 参数名是 `path`（上游是 `file_path`），转录里统一存成 filePath。
 */
function containsDirectMemoryWrite(entries, memoryRoot) {
  if (!entries) return false;
  for (const entry of entries) {
    if (entry.role !== 'assistant') continue;
    for (const call of entry.toolCalls || []) {
      if (call.name !== 'Write' && call.name !== 'Edit') continue;
      if (typeof call.filePath !== 'string' || call.filePath.length === 0) continue;
      if (safe.relativeInside(memoryRoot, path.resolve(call.filePath)) !== undefined) return true;
    }
  }
  return false;
}

/** 上游按消息里的每个文本分段分别判断（part.text），任一段够 3 个词即可。 */
function containsEligibleUserProse(entries, improveE1) {
  for (const entry of entries) {
    if (entry.role !== 'user') continue;
    if (entry.synthetic === true || entry.visibility === 'model-only') continue;
    const parts = Array.isArray(entry.textParts) ? entry.textParts : [entry.text || ''];
    for (const part of parts) {
      if (typeof part === 'string' && countWordsForGate(part, improveE1) >= LIMITS.MINIMUM_USER_WORDS) return true;
    }
  }
  return false;
}

/** 上游 evaluateMemoryExtraction(snapshot, cursor)：游标是消息 id。 */
function evaluateMemoryExtraction(input) {
  const entries = input.entries;
  const messageCount = countMessagesAfterCursor(entries, input.cursorId);
  if (containsDirectMemoryWrite(messagesAfterFoundCursor(entries, input.cursorId), input.memoryRoot)) {
    return { decision: 'skip', messageCount, reason: 'direct-memory-write' };
  }
  const afterCursor = messagesAfterFoundCursor(entries, input.cursorId) ?? entries;
  if (!containsEligibleUserProse(afterCursor, input.improveE1)) {
    return { decision: 'skip', messageCount, reason: 'no-user-prose' };
  }
  return { decision: 'run', messageCount };
}

/**
 * 上游 createMemoryExtractionScheduler 的同一语义：
 * 一个运行中任务 + 一个最新待办；判定用处理时刻的游标；skip 立即推进游标；
 * error / aborted 不推进；shutdown 之后迟到的结果不推进。
 */
function createMemoryExtractionScheduler(execute) {
  let cursor;
  let latestPending;
  let running;
  let shuttingDown = false;
  const shutdownController = new AbortController();

  const processSnapshot = async (snapshot) => {
    const decision = evaluateMemoryExtraction({
      entries: snapshot.entries,
      cursorId: cursor,
      memoryRoot: snapshot.memoryRoot,
      improveE1: snapshot.improveE1,
    });
    const boundaryId = snapshot.boundaryId;
    if (decision.decision === 'skip') {
      if (boundaryId) cursor = boundaryId;
      return decision;
    }
    let status;
    try {
      status = await execute({
        abortSignal: shutdownController.signal,
        messageCount: decision.messageCount,
        snapshot,
      });
    } catch {
      return decision;
    }
    if (!shuttingDown && (status === 'success' || status === 'no-op') && boundaryId) cursor = boundaryId;
    return decision;
  };

  const run = async (first) => {
    try {
      let current = first;
      while (current && !shuttingDown) {
        const snapshot = await current;
        current = undefined;
        if (snapshot) {
          try {
            await processSnapshot(snapshot);
          } catch {
            // 本次失败不推进游标
          }
        }
        if (shuttingDown) break;
        current = latestPending;
        latestPending = undefined;
      }
    } finally {
      if (shuttingDown) latestPending = undefined;
      running = undefined;
    }
  };

  return {
    async drain() {
      while (running) await running;
    },
    getCursor() {
      return cursor;
    },
    hasPendingWork() {
      return running !== undefined || latestPending !== undefined;
    },
    schedule(snapshot) {
      if (shuttingDown) return;
      const acquisition = Promise.resolve(snapshot).catch(() => undefined);
      if (running) {
        latestPending = acquisition;
        return;
      }
      running = run(acquisition);
    },
    shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      shutdownController.abort();
      latestPending = undefined;
    },
  };
}

// ============================================================
// Dream：时间门槛与进程锁
// ============================================================

function evaluateAutoDreamTiming(input) {
  if (input.nowMs - input.lastConsolidatedAtMs < LIMITS.AUTO_DREAM_MINIMUM_INTERVAL_MS) {
    return { decision: 'skip', reason: 'minimum-interval' };
  }
  if (input.nowMs - input.lastScanAtMs < LIMITS.AUTO_DREAM_SCAN_THROTTLE_MS) {
    return { decision: 'skip', reason: 'scan-throttled' };
  }
  return { decision: 'scan' };
}

async function readDreamLastConsolidatedAt(memoryRoot) {
  try {
    return (await fsp.stat(path.join(memoryRoot, DREAM_LOCK_FILE))).mtimeMs;
  } catch {
    return 0;
  }
}

function isLiveProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireDreamLock(input) {
  const lockPath = path.join(input.memoryRoot, DREAM_LOCK_FILE);
  const nowMs = input.nowMs ?? Date.now();
  const pid = input.pid ?? process.pid;
  let priorMtimeMs;
  let priorPid;
  try {
    const [stat, content] = await Promise.all([fsp.stat(lockPath), fsp.readFile(lockPath, 'utf8')]);
    priorMtimeMs = stat.mtimeMs;
    const parsed = Number.parseInt(content.trim(), 10);
    if (Number.isFinite(parsed)) priorPid = parsed;
  } catch {
    // 不存在或不可读都按无 owner 处理
  }
  // reentrant 只给手动 Dream 用：本进程自己留下的锁不算被占用（上游没有手动入口）
  const ownLock = input.reentrant === true && priorPid === pid;
  if (
    !ownLock &&
    priorMtimeMs !== undefined &&
    nowMs - priorMtimeMs < LIMITS.DREAM_LOCK_FRESH_MS &&
    priorPid !== undefined &&
    isLiveProcess(priorPid)
  ) {
    return null;
  }
  await fsp.mkdir(input.memoryRoot, { recursive: true });
  await fsp.writeFile(lockPath, String(pid), 'utf8');
  let writtenPid;
  try {
    writtenPid = Number.parseInt((await fsp.readFile(lockPath, 'utf8')).trim(), 10);
  } catch {
    return null;
  }
  if (writtenPid !== pid) return null;
  return priorMtimeMs ?? 0;
}

async function restoreDreamLockAfterFailure(input) {
  const lockPath = path.join(input.memoryRoot, DREAM_LOCK_FILE);
  if (input.priorMtimeMs === 0) {
    await fsp.rm(lockPath, { force: true });
    return;
  }
  await fsp.writeFile(lockPath, '', 'utf8');
  const seconds = input.priorMtimeMs / 1000;
  await fsp.utimes(lockPath, seconds, seconds);
}

module.exports = {
  normalizeText,
  parseFrontmatter,
  stampMemoryOriginSessionId,
  MEMORY_FRONTMATTER_PATTERN,
  stripTopLevelMarkdownHtmlComments,
  formatMemoryIndexContent,
  formatProjectMemoryIndexContent,
  formatBytes,
  scanMemoryManifest,
  readManifestEntry,
  rankManifestCandidates,
  tokenize,
  bm25Scores,
  createRecallState,
  canStartMemoryRecall,
  recordRecalledMemories,
  readRecalledMemories,
  filterMemorySelections,
  parseSelectorResponse,
  parseSelectorText,
  memoryHeader,
  countWords,
  countWordsCjkAware,
  countWordsForGate,
  isMemoryRecallQueryEligible,
  messagesAfterFoundCursor,
  countMessagesAfterCursor,
  containsEligibleUserProse,
  containsDirectMemoryWrite,
  evaluateMemoryExtraction,
  createMemoryExtractionScheduler,
  evaluateAutoDreamTiming,
  readDreamLastConsolidatedAt,
  acquireDreamLock,
  restoreDreamLockAfterFailure,
};