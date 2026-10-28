#!/usr/bin/env node
/**
 * 由上游 ZCode 源码生成逐字比对基线 test/fixtures/upstream-prompts.json。
 * 仅开发期使用（需要 devDependencies 里的 esbuild / marked / yaml），不进插件包。
 *
 * 用法：
 *   node scripts/gen-upstream-fixtures.mjs <ZCode 仓库里的 apps/zcode-cli/packages/core/src>
 *
 * 做法：用 esbuild 把上游的 .ts 入口打成临时 ESM，除 marked / yaml 外的外部依赖
 * 全部换成空代理（提示词构造函数不依赖它们），再用固定输入执行上游函数，
 * 输出写进基线文件，同时记录每个上游源文件的 SHA-256。
 */
import { build, transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const core = resolve(process.argv[2] || process.env.ZCODE_CORE_SRC || '');
if (!existsSync(join(core, 'memory', 'extraction.ts'))) {
  console.error('请传入上游 apps/zcode-cli/packages/core/src 目录');
  process.exit(2);
}
const out = mkdtempSync(join(tmpdir(), 'zcode-upstream-'));
const KEEP_REAL = new Set(['marked', 'yaml']);
const REAL_ENTRY = {
  marked: join(repoRoot, 'node_modules', 'marked', 'lib', 'marked.esm.js'),
  yaml: join(repoRoot, 'node_modules', 'yaml', 'dist', 'index.js'),
};

// 上游没有导出、且所在文件顶层依赖运行时（zod 等）的函数：只截取函数本体单独编译，内容不改
async function loadFunction(rel, name) {
  const source = readFileSync(join(core, rel), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${rel}`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const snippet = `export ${source.slice(start, end + 1)}\n`;
  const { code } = await transform(snippet, { loader: 'ts', format: 'esm' });
  const outfile = join(out, `${name}.mjs`);
  writeFileSync(outfile, code, 'utf8');
  return (await import(pathToFileURL(outfile).href))[name];
}

async function load(rel) {
  const outfile = join(out, `${rel.replace(/[\\/]/g, '_')}.mjs`);
  const stub = {
    name: 'stub-external',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point' || /^node:/.test(args.path)) return undefined;
        if (KEEP_REAL.has(args.path)) return { path: REAL_ENTRY[args.path] };
        if (/^\.\.?\//.test(args.path)) {
          const target = resolve(args.resolveDir, args.path).replace(/\.js$/, '.ts');
          return existsSync(target) ? { path: target } : { path: target, namespace: 'stub' };
        }
        return { path: args.path, namespace: 'stub' };
      });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        // 递归空代理：任意属性/调用/构造都返回代理，满足上游模块顶层对外部依赖的取值
        contents: 'const make = () => new Proxy(function stub() {}, { get: (_, k) => (k === "__esModule" ? false : k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : make()), apply: () => make(), construct: () => make() }); module.exports = make();',
        loader: 'js',
      }));
    },
  };
  await build({ entryPoints: [join(core, rel)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent', plugins: [stub] });
  return import(pathToFileURL(outfile).href);
}

const manifest = [
  { filename: 'user-role.md', filePath: '/m/user-role.md', mtimeMs: 1700000000000, description: 'Role', type: 'user' },
  { filename: 'release.md', filePath: '/m/release.md', mtimeMs: 1700000500000, description: undefined, type: undefined },
];
const memories = [{ filePath: '/m/user-role.md', content: 'body text', mtimeMs: 1700000000000, header: 'Memory: /m/user-role.md:' }];
const INDEX = '- [Deploy](deploy.md) — smoke test before release';

const sources = [
  'context/sections/memory.ts',
  'context/sections/request-user-context.ts',
  'context/builder.ts',
  'memory/extraction.ts',
  'memory/dream.ts',
  'memory/index-content.ts',
  'memory/recall/manifest.ts',
  'memory/recall/selector.ts',
  'memory/recall/content.ts',
  'subagent/persistent-memory-prompt.ts',
  'runtime/helpers/project-memory-dream.ts',
  'system-reminder/source.ts',
];

const fixture = { _provenance: {} };
try {
  for (const rel of sources) {
    fixture._provenance[rel] = createHash('sha256').update(readFileSync(join(core, rel))).digest('hex');
  }
  const sec = await load('context/sections/memory.ts');
  fixture.memorySectionDefault = sec.buildMemorySection('/root/mem', 'default-index').content;
  fixture.memorySectionSemantic = sec.buildMemorySection('/root/mem', 'semantic-recall').content;
  const ext = await load('memory/extraction.ts');
  fixture.extractionManifest = ext.buildMemoryExtractionPrompt({ manifest, messageCount: 7 });
  fixture.extractionEmpty = ext.buildMemoryExtractionPrompt({ manifest: [], messageCount: 3 });
  const dream = await load('memory/dream.ts');
  fixture.dream = dream.buildMemoryDreamPrompt({ memoryRoot: '/root/mem', sessionIds: ['s1', 's2'], transcriptRoot: '/t' });
  const pm = await load('subagent/persistent-memory-prompt.ts');
  for (const scope of ['user', 'project', 'local']) {
    for (const indexContent of ['', '- [A](a.md) — hook']) {
      fixture[`persistent_${scope}_${indexContent ? 'index' : 'empty'}`] = pm.buildPersistentAgentMemoryPrompt({ indexContent, rootDir: '/root/agent', scope });
    }
  }
  const man = await load('memory/recall/manifest.ts');
  fixture.manifest = man.formatMemoryManifest(manifest);
  const sel = await load('memory/recall/selector.ts');
  fixture.selectorRequest = sel.buildMemorySelectorRequest({ query: 'how do we release', state: { manifest } });
  const content = await load('memory/recall/content.ts');
  fixture.attachment = content.formatRelevantMemoryAttachment(memories);

  // 以下不在 14 段之内，但同样逐字比对：索引外层、元用户包装、提醒标签、Dream 更新提示
  const ruc = await load('context/sections/request-user-context.ts');
  fixture.requestUserContext = ruc.buildRequestUserContextSection({ memoryRoot: '/root/mem', memoryIndexContent: INDEX }).content;
  const builder = await load('context/builder.ts');
  fixture.contextMetaUserBody = builder.buildContextMetaUserBody([{ content: fixture.requestUserContext }]);
  const reminder = await load('system-reminder/source.ts');
  fixture.contextPrefixReminder = reminder.wrapSystemReminderForSource('context_prefix', fixture.contextMetaUserBody);
  fixture.relevantMemoryReminder = reminder.wrapSystemReminderForSource('relevant_memory', `${fixture.attachment}\n<system-reminder>nested</system-reminder>`);
  const formatProjectMemoryUpdate = await loadFunction('runtime/helpers/project-memory-dream.ts', 'formatProjectMemoryUpdate');
  fixture.memoryUpdate = formatProjectMemoryUpdate({ summary: 'consolidated 2 memory files', paths: ['/m/a.md', '/m/MEMORY.md'], inContextPaths: ['/m/MEMORY.md'] });
  fixture.memoryUpdateNoContext = formatProjectMemoryUpdate({ summary: 'consolidated 1 memory file', paths: ['/m/a.md'], inContextPaths: [] });
} finally {
  rmSync(out, { recursive: true, force: true });
}

const target = join(repoRoot, 'test', 'fixtures', 'upstream-prompts.json');
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`wrote ${target}`);
for (const [key, value] of Object.entries(fixture)) {
  if (key === '_provenance') continue;
  console.log(`${key}: ${JSON.stringify(value).length}`);
}
