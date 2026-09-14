<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 被动技能熔炉（Trace2Skill / Ctx2Skill 落地）——后台采集会话轨迹索引（零 LLM 成本）+ 阈值信号送达 + 压缩时刻打炼化候选标记；蒸馏/合并/剪枝决策归爱丽丝；产出 DSH 技能目录原生可加载的 SKILL.md
  inject: 'tools','agents','memoryApi'
  tools: skill_signals, skill_marks, skill_extract, skill_commit
  runtime: host-only
  envDeps: 无强依赖（纯逻辑 + 标准 Node）；可选：dsh-agent-memory（memoryApi 缺省时技能索引回流被静默跳过，SKILL.md 仍是权威存储）
  boundary: 只采集与建议，**不蒸馏、不合并、不自动写技能**（唯一写动作是 skill_commit，需显式调用）；工具引用校验只覆盖「系统工具面 + 本进程见过的工具」
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6 / dsh-llm ^0.1.0-rc.6 / dsh-session ^0.1.0-rc.6
-->
# dsh-agent-skill-forge

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-skill-forge"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-86%20passed-brightgreen" alt="tests">
</p>

**一句话**：把「这次会话里踩过的坑、验证过的流程」变成下次能直接加载的 `SKILL.md`——插件只做**采集与提示**，蒸馏与写入由 agent 本人决定。

**为什么值得用**：经验不落盘就等于没学到——压缩一过，路径、报错、绕法全蒸发。本插件在后台**零 LLM 成本**地给每一轮轨迹建索引（事件数/工具调用/报错/上下文规模），在轨迹够厚时把信号送到你面前，并**在压缩发生的那一刻**（此刻上下文最全）把高价值候选轮打上标记落盘——压缩后按标记蒸馏，单次压缩的收益最大化。它只提醒，不替你决定蒸馏什么、何时蒸馏、怎么写。

## 能力

| 工具 | 用途（描述取自源码，逐字） |
|------|--------------------------|
| `skill_signals` | 技能熔炉信号（只读）：本会话轨迹轮次索引——每轮的事件数/工具调用数/报错数/估算 token。选候选轮次后用 `skill_extract` 提取轨迹分析。决策（蒸馏什么/何时蒸馏）归爱丽丝。`limit` 取最近 N 轮（缺省 20） |
| `skill_marks` | 压缩轨迹标记（只读）：最近一次压缩触发时标记的炼化候选 turn（含工具调用/报错/上下文规模特征）——压缩前上下文最全时刻的高价值轨迹，压缩后按此炼化收益最大化。只读信号，炼化决策归爱丽丝 |
| `skill_extract` | 提取轨迹（只读）：按 turn 范围从会话事件流提取事件序列文本（用户消息/模型动作/工具调用/结果与错误），供爱丽丝蒸馏分析。零 LLM 调用（纯数据提取）。`linkContext=true`（缺省）时输出联动视图——显式标注「上下文特征」段与应对轨迹交错呈现，供蒸馏「上下文特征 → 应对策略」的条件化技能。`startTurn` 必需；`endTurn` 缺省 = `startTurn`；`maxChars` 缺省 20000（超长分段返回） |
| `skill_commit` | 写入技能（**可写**）：把蒸馏出的技能保存为 SKILL.md（YAML frontmatter + 正文）——默认写用户级技能目录（跨项目可加载），`scope=project` 写 `<cwd>/.agents/skills/`。纪律：技能只提供指导（决策/流程/规避），不提供工具——工具引用限于系统工具面（提交时自动校验，幻觉工具会警告）。`turns` 声明本次炼化覆盖的轮次 → 提交后标为**废渣**，信号/候选不再重复提示 |

背景行为（无工具面，自动发生）：

- **轨迹索引**：订阅会话事件，按轮累计 `eventCount` / `toolCalls` / `errors` / `estTokens` / `contextChars`；`persistIndex=true` 时落盘（按 `sessionId` 隔离）。
- **炼化通知**：累计步数 **或** 工具调用数达阈值即投递一条信号（双轨独立推进的复合触发），送到主会话。
- **压缩前提醒**：压缩段内上下文压力越过 `compactHintTokens` 时提醒「先炼化再压缩」（按阈值段节流）。
- **压缩标记**：`compaction/start` 时刻计算候选轮并落盘（供压缩后炼化）。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-skill-forge": "link:<工作区>/self-plugins/dsh-agent-skill-forge"
```

**2) 构建**：

```bash
cd self-plugins/dsh-agent-skill-forge && npm install && npm run build && npm test
```

**3) 挂组合**（web profile）：

```yaml
- id: agent-skill-forge
  name: dsh-agent-skill-forge
  config:
    notifyEnabled: true
    notifyAfterSteps: 200
    notifyAfterTools: 200
```

**4) 30 秒验证**（走一遍「看信号 → 提轨迹」的最小闭环）：

```text
① skill_signals { limit: 5 }      → 期望：列出最近 5 轮的事件数/工具调用/报错/估算 token
② skill_extract { startTurn: <上面某一轮> }  → 期望：该轮的事件序列文本（含用户消息与工具调用）
③ 落盘确认（见下节）：cat <工作区>/.dsh/skill-forge-index-<sessionId>.json | head
```

## 配置

（键名与 `src/index.ts` 的 `Config` schema 一致；默认值取自源码）

| 项 | 默认 | 说明 |
|----|------|------|
| `persistIndex` | `true` | 轨迹索引落盘（按 `sessionId` 隔离）；关掉则只在内存中 |
| `ctxSignalChars` | `800`（最小 100） | 「上下文密集型候选」判定阈值（该轮用户输入字符数） |
| `compactHintTokens` | `300000`（最小 10000） | 压缩前炼化提醒的上下文压力阈值（按**当前上下文占用**计，不跨轮累加） |
| `compactHintEnabled` | `true`（**注意**：源码 schema 默认 `true`，而 `package.json` 描述与本文件 2026-09-14 注释称「默认关闭」——本 README 以源码为准；两处不一致已如实记录） | 是否发送「压缩前炼化提醒」 |
| `notifyEnabled` | `true` | 炼化通知开关（信号送达，炼化决策归 agent） |
| `notifyAfterSteps` | `200` | 炼化通知·步数轨阈值（累计 step；步是真实工作单元，一轮可含多步） |
| `notifyAfterTools` | `200` | 炼化通知·工具调用轨阈值（长跑会话「工具密集但步数慢」时更敏感） |

## 落盘与自证（出问题时先看这里）

本插件**不写 `*-trace.jsonl` 阶段轨迹**，它的自证产物是**索引 / 标记 / 技能**三类文件：

| 文件 | 谁写 | 内容 |
|------|------|------|
| `<工作区>/.dsh/skill-forge-index-<sessionId>.json` | 本插件 | 轨迹索引：逐 turn 的 `eventCount` / `toolCalls` / `errors` / `estTokens` / `contextChars` / `wasted`（废渣标记）+ 通知阈值推进状态。**按 `sessionId` 隔离**——同一 cwd 多会话共用一个文件会互相覆盖（A 写 → B 覆盖 → A 重启后索引永久丢失） |
| `<工作区>/.dsh/skill-forge-marks-<sessionId>.json` | 本插件 | 最近一次压缩打下的炼化候选标记：`{ at, compactionId, candidates[] }` |
| `${DSH_AGENTS_HOME:-~/.agents}/skills/<name>/SKILL.md` | `skill_commit`（scope=user） | 技能产物（YAML frontmatter + 正文），DSH 技能目录**原生可加载** |
| `<cwd>/.agents/skills/<name>/SKILL.md` | `skill_commit`（scope=project） | 项目级技能产物 |
| `<工作区>/.dsh/` 下其他文件 | 宿主/其他插件 | 只读参考 |

**一条命令答五问**：

```bash
node -e "const fs=require('fs');const d='.dsh';const f=fs.readdirSync(d).filter(x=>x.startsWith('skill-forge-index-'));const j=JSON.parse(fs.readFileSync(d+'/'+f[0],'utf8'));const t=j.turns||{};const ks=Object.keys(t);console.log('turns='+ks.length,'notify=',JSON.stringify(j.notify));console.log(ks.slice(-5).map(k=>k+': ev='+t[k].eventCount+' tools='+t[k].toolCalls+' err='+t[k].errors+' ctx='+t[k].contextChars+' wasted='+t[k].wasted).join('\n'))"
# ① 跑的是哪个构建 → 取不到（索引无 build 自报）；用「生效判据」节的 plugin_boot_status / lib mtime 判
# ② 谁发起        → 取不到调用者；索引文件名的 sessionId 即"哪场会话"（多会话互不覆盖）
# ③ 断在哪一段   → 索引文件不存在 = 采集环断（persistIndex=false 或从未收到事件）；有索引但 notify 字段不动 = 通知阈值未推进（检查 send 是否失败）；有 marks 文件 = 压缩标记环工作
# ④ 结果质量     → 逐 turn 的 toolCalls/errors/contextChars 即素材质量；wasted=true 表示该轮已炼化（不再提示）
# ⑤ 耗时与预算   → 无 durationMs；「预算」是两条阈值轨（notifyAfterSteps / notifyAfterTools）与 compactHintTokens
```

**观测不反噬**：索引/标记的读写全部走 IO 薄壳，失败**吞错返回 `false` / `undefined`，绝不抛**（轨迹采集是旁路，不能因磁盘问题打断会话），并有尸体测试覆盖。

> **两个容易误读的点**：① 索引里 `wasted=true` 不代表「这轮没价值」，只代表「已经炼化过」，避免重复提示；② 通知发送**成功才推进阈值状态**——「状态显示已提醒但消息从未投递」是被明确修掉的自我欺骗形状（旧版在 `if` 外无条件推进）。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. 行为级（最直接）：`skill_signals` 返回本轮索引（工具在工具面上且能读到轨迹）⇒ 采集与查询都在工作；或跑几轮后 `<工作区>/.dsh/skill-forge-index-<sessionId>.json` 的 mtime 前进；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回的 `liveNow` 含本插件 ⇒ 进程在跑它；
3. 构建级：`lib/index.js` 的 mtime **早于** web 进程启动时间 ⇒ 当前进程加载的是这个产物。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。本插件也没有 `hasUnverifiedBuilds()` 类兜底，构建完必须重启 web 才生效。

**回退**（三档）：

- 源码级：`git -C self-plugins/dsh-agent-skill-forge revert <commit>` → `npm run build` → `npm test` → 预检 → 重启；
- 组合级：给 profile 里 `agent-skill-forge` 行加 `disabled: true`（或把 `notifyEnabled` / `persistIndex` 置 `false` 做轻量静音）→ 重启；
- 运行期：
  - 清采集产物：删 `<工作区>/.dsh/skill-forge-index-*.json` 与 `skill-forge-marks-*.json`（副作用：废渣标记一并丢失，已炼化的轨迹会重新出现在候选里）；
  - **技能本身是独立产物**：`SKILL.md` 一旦写入技能目录就与本插件无关，回退插件**不会**删除已有技能——要撤销技能请直接删对应目录（这是技能维护的常规动作）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（跑 lib/ 产物，需先 npm run build）
```

**86 例离线测试全部通过**（`# pass 86 / # fail 0`）：

| 文件 | 覆盖 |
|------|------|
| `tests/aggregate.test.mjs` | 轨迹聚合：逐 turn 计数（事件/工具/报错/估算 token/上下文字符）、候选轮判定（`isCandidateTurn` 对 `ctxSignalChars` 的边界）、压缩候选选择、`wasted` 过滤 |
| `tests/policy.test.mjs` | 决策纯函数：`decideCompactHint`（阈值 + 段内节流、边界值、跳过分支）、通知阈值推进（步数/工具双轨复合触发）、通知状态迁移（`migrateNotifyState`，含旧形状兼容）、`validateSkillCommit`（早退顺序：先名字后正文）、工具引用提取与「幻觉工具」判定、`buildCommitNote` 文案 |
| `tests/text.test.mjs` | 文本处理：frontmatter 拼装（description 换行折叠）、联动视图渲染、超长分段、空输入退化 |
| `tests/trace-store.test.mjs` | 落盘层：索引/标记按 `sessionId` 隔离的路径拼装、写 JSON 自动建父目录、读 JSON 对「不存在/坏 JSON/是目录」一律 `undefined`；**尸体测试**——父路径是普通文件的不可写路径 → 断言 `false` 且不抛 |

**无网络依赖、无真实外部服务依赖**：全部离线（纯函数 + 临时目录）。`memoryApi`（`dsh-agent-memory`）在测试中不需要——未挂载时技能索引回流被静默跳过，SKILL.md 仍是权威存储。

## 设计要点

- **零 LLM、零子代理**：采集是纯计数，提取是纯数据搬运。**没有任何一次后台模型调用**——这既是成本约束，也是「决策归 agent」的工程表达：插件不替你想，只把素材摆好。
- **按 `sessionId` 隔离落盘**：多会话共享一个索引文件会互相覆盖（A 写 → B 覆盖 → A 重启后索引永久丢失）。文件名带 `sessionId`，读取时还校验 `sessionId` 兜底。
- **上下文压力 = 当前占用，不是历史累计**：早期实现把每轮 `estTokens` 累加 → 一轮内多次请求把同一份上下文重复计入 → 数值虚高、提醒永久顶满。现在只记「最新一次请求的完整输入 token」，且压缩后清零。
- **压缩时刻打标（收益最大化）**：`compaction/start` 是上下文**最全**的时刻——此刻算出的炼化候选，压缩后按标记蒸馏，代价最低。压缩同时重置段起点与提醒节流，避免历史累计把提醒永久顶满。
- **投递必须延迟且成功后推进状态**：`turn/end` 事件由 `session.append` 同步发布，回调内直接 `agent.send` 会撞上 `session append cannot reenter`（实测每次都抛）。修法是 `setImmediate` 延迟到当前 append 事务完成后投递，并且**只有 send 成功才推进阈值状态**——否则会出现「状态说提醒过了，消息从没到过」。
- **观测/持久化不反噬**：落盘层只做「路径拼装 + 读写」，任何失败吞错返回 bool；业务判据全在 `policy.ts` / `aggregate.ts`（纯函数，可离线回归）。
- **废渣标记是防重复，不是评价**：`wasted=true` 只表示「已炼化」，让信号不再重复提示同一批轮次。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `skill-maintenance` / `context-stewardship` / `plugin-maintainability` | 技能常态化维护（创建/更新/淘汰判据）、上下文管理与压缩时机、可维护性五问与自证证据层 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
