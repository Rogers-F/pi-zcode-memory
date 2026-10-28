# NOTICE

本插件是 ZCode 3.16.x 长期记忆功能到 PI-Desktop 的移植，包含上游提示词与部分实现思路的改写。

## 上游

- 名称：ZCode（`zcode-cli` / `@zcode/core`）
- 版本快照：3.16.2（`apps/zcode-cli/packages/core/src`）
- 版权：Copyright 2026 Z.AI Co., Ltd.
- 许可证：Apache License 2.0（全文见 `LICENSE`，与上游同一份文本）

## 本插件的改动

1. 提示词：`lib/prompts.js` 逐字移植上游 14 段提示词（记忆规则、提取、Dream、选择器、清单、召回附件、代理持久记忆），另有 4 段上游文本同样逐字移植：`# agentsMd` 索引外层（`context/sections/request-user-context.ts`）、`context_prefix` 元用户包装（`context/builder.ts`）、`<system-reminder>` 包装（`system-reminder/source.ts`）、Dream 一次性更新提示（`runtime/helpers/project-memory-dream.ts`）。只允许以下三类差异，且都登记在 `lib/constants.js` 的 `PROMPT_SUBSTITUTIONS` 与 `docs/对齐矩阵.md` 的「替换表」：
   - `CLAUDE.md` → `AGENTS.md`（产品名差异，PI-Desktop 的项目指令文件叫 `AGENTS.md`）
   - 记忆根目录路径 → `~/.pi-desktop/zcode-memory/...`
   - 转录目录路径 → `~/.pi-desktop/zcode-memory/transcripts/...`
2. 实现：`lib/memory.js`、`lib/agent.js`、`lib/core.js`、`main.js`、`extension.js`、`panel-data.js` 是按上游行为重写的 CJS 模块，去掉了 ZCode 的运行时依赖（FileSystemPort、PermissionService、模型抽象等），改用 Node 内置模块与宿主 PI-Desktop 的插件 API。
3. 新增内容（不属于上游，单独标注）：文本工具协议 `buildMemoryToolProtocol`、选择器 JSON 输出说明 `MEMORY_SELECTOR_JSON_INSTRUCTION`（宿主不能传 JSON Schema）、Task 注入块 `buildPersistentMemoryTaskBlock`、E1–E4 四项改进（出处见 `docs/改进依据.md`）、FreeDesktop 回收站归档、管理面板。
4. YAML 处理：上游用 `yaml` 包解析前置元数据；本插件只实现记忆文件实际用到的子集（顶层标量与 `metadata` 下一层），矩阵记为「等效替代」。
5. Markdown 注释剥离：上游用 `marked` 的 Lexer；本插件用行扫描实现同一判定，矩阵记为「等效替代」。

## 移植所依据的上游文件（SHA256）

以下哈希对应 `apps/zcode-cli/packages/core/src/` 下的文件，用于核对移植基线：

| 文件 | SHA256 |
| --- | --- |
| context/sections/memory.ts | 719683a853fb1956884c86dbedb56b8dee6f246e3ce7343109a5d50383929209 |
| context/sections/request-user-context.ts | 68f3f5944228c5966a8055e874dd59eb32ad3d7ddd409effcc7fa3189f586967 |
| context/builder.ts | b171c2d0640beda7ebe3c2101b991000a56c2b00389ac16dc97a26d4ba0cae7a |
| system-reminder/source.ts | f86ba4d0090c96b2545b631d77b35998dadc40abe8a701f5c2a5c7e8a59631f1 |
| runtime/methods/context.ts | bf5e58b0799a510fcfac79667920159088121ba9d2a788a8889211fec0327def |
| runtime/methods/turn-loop.ts | 551a52dee7c062fdb33fec086dac17b80284d9448d5383b07d74b5b3ff7303ef |
| memory/extraction.ts | 834b5639cbd1e90f2104bd9c61e9598835e9ecfc8953338529480837a09ff041 |
| memory/dream.ts | 15a90375d91b22bbb4ad1b9b7b3829d4744ef31c8f97e80613bbd60e6cce3d45 |
| memory/index-content.ts | 09397af14b35c25822e901c44dc702c927b94b75c072a6f5cd595b7d9e9f4e71 |
| memory/project-root.ts | 69ea16dc573f1e60e5579be494d02dc7735ab24821208071f304e5699c2d7f55 |
| memory/recall/manifest.ts | 7dd910cbd1222ded8fafdbcd76be136a38c2d0b11250a07b0fd6aaff73e0b7c2 |
| memory/recall/selector.ts | c3f15e2847af5b3a3379c55c1da87e4adbac0a41fc72ad70d1876849e58939eb |
| memory/recall/content.ts | 9063e710e8ad3fa9a30a22f69eae023c3a68d18ac1601db9e092dbd7b95a8b35 |
| memory/recall/index.ts | 785e98eddee3711f118b5c0b96deb389dfcd2b3ff49db5f2eb3607d146bb1c5e |
| memory/memory-agent-loop.ts | efa4e0d5f4e8972d979b802a8af3296f8151b84cac281d03f40e2734f4beae0a |
| memory/memory-file-path.ts | 60003938862cd377719e029dc20f3ee40c78be4ee1c4244d8dc528bcfd1ab0ff |
| memory/origin-session.ts | 5fd667e140c5b79c697c973cb6f05597c8c37d0ea2b404754f31eb94621e4fc0 |
| subagent/persistent-memory.ts | 4ec0164f2ca988abdd00b6c58aa61a21d6fddf2955f598817514f90375de3751 |
| subagent/persistent-memory-prompt.ts | ed2298b5582d4be07676fef739ad50239e9b68c63ca4595bd54252cb867fa7c3 |
| runtime/helpers/project-memory.ts | 40327e071c99f17c92f972c8c88572f5d1ef33e80f419dc1e745e09047bea5e3 |
| runtime/helpers/project-memory-agent.ts | 0b225bd64acd3ebf432a7b02e2061fd935de235c5d21342a57f8b4a7a0725e4b |
| runtime/helpers/project-memory-dream.ts | bafdc766bb5d1008a4cb7ef2a51bd51fe0f78a927d4315c3af265ae3876e109b |
| runtime/helpers/project-memory-extraction.ts | b575ae82752886c224cedf809d8e9a6050d481d56752337840723cc9b961030f |
| runtime/helpers/project-memory-recall.ts | 14e204c53fcd4ca791ae0372c7d8818ab88ae194efd8e3fa260786e712aa8832 |

另有一份 UI 文件来自 `packages/ui/src/settings/memoryUpdatedAt.ts`（同一仓库）：

| 文件 | SHA256 |
| --- | --- |
| packages/ui/src/settings/memoryUpdatedAt.ts | c9ddf7168f4785c301b7b4721d2a0f48d3cc2677c885d82230b3f8deaf40be39 |

## 参考实现

提示词文本与行为对照另参考了同作者的 DSH 移植（`G:\AAAAAI相关\DSH工作区记忆插件`）与其逐字比对脚本 `脚本/compare_prompts.mjs`；本插件不含该项目的代码，只把它的比对结论作为复核线索，最终以 `test/fixtures/upstream-prompts.json` 中由上游源码生成的输出为准。

## 第三方依赖

运行时没有第三方依赖。开发依赖（都不会进入插件包）：`jsdom`（面板前端测试）、`esbuild` / `marked` / `yaml`（只在 `scripts/gen-upstream-fixtures.mjs` 里用上游源码生成逐字比对基线）。