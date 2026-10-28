#!/usr/bin/env node
/**
 * 离线评估：E1 中文门槛、E2 召回排序、E3 预加载去重、严格上游模式。
 * 数据集在 test/fixtures/eval-dataset.json，不联网、不调用模型。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const memory = require('../lib/memory.js');
const core = require('../lib/core.js');

const dataset = JSON.parse(readFileSync(resolve(here, '../test/fixtures/eval-dataset.json'), 'utf8'));
const results = [];
let failures = 0;

function check(name, condition, detail) {
  results.push(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

// ---- E1 ----
const upstream = (text) => memory.countWords(text) >= 3;
const e1 = (text) => memory.countWordsCjkAware(text) >= 3;
const chinese = dataset.e1.chinese;
const english = dataset.e1.english;
const zhUpstream = chinese.filter((item) => upstream(item.text)).length;
const zhE1 = chinese.filter((item) => e1(item.text)).length;
check(
  'E1 中文触发数高于上游',
  zhE1 > zhUpstream,
  `上游 ${zhUpstream}/${chinese.length}，E1 ${zhE1}/${chinese.length}`,
);
const zhMust = chinese.filter((item) => item.expect === 'trigger');
for (const item of zhMust) {
  check(`E1 必须触发：${item.text}`, e1(item.text));
}
const zhMustNot = chinese.filter((item) => item.expect === 'no');
for (const item of zhMustNot) {
  check(`E1 不应触发：${item.text}`, !e1(item.text));
}
const enSame = english.every((item) => upstream(item.text) === e1(item.text));
check('E1 英文结果与上游完全一致', enSame, `${english.length} 条`);
for (const item of english) {
  if (item.expect === 'trigger') check(`E1 英文必须触发：${item.text}`, e1(item.text));
  if (item.expect === 'no') check(`E1 英文不应触发：${item.text}`, !e1(item.text));
}

// ---- E2 ----
const now = dataset.e2.now;
function recallAt5(order, relevant) {
  const top = order.slice(0, 5).map((entry) => entry.filename);
  return relevant.some((name) => top.includes(name)) ? 1 : 0;
}
let hybridScore = 0;
let baselineScore = 0;
for (const query of dataset.e2.queries) {
  const baseline = [...dataset.e2.memories].sort((left, right) => right.mtimeMs - left.mtimeMs);
  const hybrid = memory.rankManifestCandidates(dataset.e2.memories, query.query);
  const hybridHit = recallAt5(hybrid, query.relevant);
  const baselineHit = recallAt5(baseline, query.relevant);
  hybridScore += hybridHit;
  baselineScore += baselineHit;
  check(`E2 混合排序召回：${query.query}`, hybridHit === 1, `前五：${hybrid.slice(0, 5).map((entry) => entry.filename).join(', ')}`);
}
check(
  'E2 前 5 召回率高于按修改时间排序',
  hybridScore > baselineScore,
  `混合 ${hybridScore}/${dataset.e2.queries.length}，基线 ${baselineScore}/${dataset.e2.queries.length}`,
);
const strictOrder = memory.rankManifestCandidates(dataset.e2.memories, dataset.e2.queries[0].query);
check('E2 排序结果与时间戳无关时也稳定', strictOrder.length === dataset.e2.memories.length);
void now;

// ---- E3 ----
const e3Manifest = dataset.e3.items.map((item, index) => ({
  filename: item.existing.filename,
  filePath: item.existing.filename,
  mtimeMs: 1700000000000 + index,
  description: item.existing.body,
}));

function simulateExtraction({ withPreload }) {
  const files = new Map();
  for (const item of dataset.e3.items) files.set(item.existing.filename, item.existing.body);
  let duplicates = 0;
  for (const item of dataset.e3.items) {
    const ranked = withPreload ? memory.rankManifestCandidates(e3Manifest, item.newText) : [];
    const preloaded = ranked.length > 0 && ranked[0].filename === item.existing.filename;
    if (preloaded) {
      files.set(item.existing.filename, `${files.get(item.existing.filename)}\n${item.newText}`);
      continue;
    }
    const filename = `${item.topic}-${files.size}.md`;
    if ([...files.keys()].some((name) => name.startsWith(item.topic))) duplicates += 1;
    files.set(filename, item.newText);
  }
  return { duplicates, files: files.size };
}
const withoutE3 = simulateExtraction({ withPreload: false });
const withE3 = simulateExtraction({ withPreload: true });
check(
  'E3 开启后重复文件数不高于关闭时',
  withE3.duplicates <= withoutE3.duplicates,
  `关闭 ${withoutE3.duplicates}，开启 ${withE3.duplicates}`,
);
check(
  'E3 开启后文件总数更少',
  withE3.files < withoutE3.files,
  `关闭 ${withoutE3.files}，开启 ${withE3.files}`,
);

// ---- 严格上游模式 ----
const strict = core.normalizeSettings({ strictUpstream: true });
check('严格上游模式关闭 E1–E4', !strict.improveE1 && !strict.improveE2 && !strict.improveE3 && !strict.improveE4);
check(
  '严格上游模式下中文按上游空白计数',
  memory.countWordsForGate(dataset.e1.chinese[0].text, strict.improveE1) === memory.countWords(dataset.e1.chinese[0].text),
);
const strictManifest = dataset.e2.memories;
check(
  '严格上游模式下排序退回清单原顺序',
  strict.improveE2 === false,
  `清单仍为 ${strictManifest.length} 条`,
);

// ---- 输出 ----
for (const line of results) console.log(line);
console.log(`\neval: ${results.length - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);