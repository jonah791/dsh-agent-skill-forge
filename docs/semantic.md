# 语义文档：被动技能熔炉（Passive Skill Forge）

> 版本 v0.2.0 · 2026-09-16 · 作者：爱丽丝 · 状态：**已实现**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-skill-forge/src/`（index / policy / text / aggregate / trace-store）

---

## 1 · 定位与反定位

**定位**：**被动**技能熔炉（Trace2Skill / Ctx2Skill 思想落地）——后台**零 LLM 成本**地采集会话轨迹索引（每轮的工具调用数 / 报错数 / 上下文字符数 / 步数），在阈值处**送达信号**（炼化通知、压缩提醒），并提供 `skill_signals` / `skill_marks` / `skill_extract` / `skill_commit` / `skill_tools` 五个工具，把「把经验炼成资产」变成可操作流程。

**产物三态（2026-09-16 主人定调：扩充语义包括插件工具、具体的高效工作流）**：

扩充前熔炉只有一种产物（指导性 `SKILL.md`）。现在按**载体**分三类——载体不同，判据不同，落盘位置不同：

| kind | 是什么 | 载体 / 落点 | 结构判据（可证伪） |
|------|--------|------------|-------------------|
| `guidance` | 条件化行为规则：什么状态下做什么 / 规避什么 | `SKILL.md`（技能目录，被自动加载） | description 与 body 非空（**原语义，逐字不变**） |
| `workflow` | **具体**的高效工作流：编号步骤 + 可执行片段 | `SKILL.md`（frontmatter 带 `kind:`） | ≥2 条编号步骤 **且** ≥1 处可执行片段（围栏代码块或行内代码） |
| `tool` | 该固化的**插件工具**：「这个反复手写的脚本该变成哪个插件工具」 | **工具候选台账** `<cwd>/.dsh/skill-forge-tools.json`（**不写 SKILL.md**） | `toolName` + `toolPlugin` 形态合法（工具载体是插件，不是技能目录） |

**载体判据（为什么 `tool` 不写 SKILL.md）**：技能的载体是技能目录（一份被模型加载的**指导**）；工具的载体是**插件**（README / docs / 版本 / 测试 / 组合行）。把「工具」写成指导性技能，正是本次要扩掉的旧语义——工具是要被**执行**的，不是被**读到**的。

**反定位（本文不管什么）**：
- 不做蒸馏决策、不写产物正文——`skill_commit` 只在爱丽丝主动调用时落盘
- 不管压缩事务/入口（→ `dsh-agent-compact` / `dsh-compact-provider`）
- 不管**上下文提醒**与压缩告警（→ `dsh-agent-context`）——本插件的**压缩提醒**讲的是「压缩前先炼化」的时机，**两者不是一个东西**
- **不是**自动技能生成器：无 LLM 调用、无自动写入；`kind=tool` 也只**登记候选**，插件骨架仍由 `plugin_forge`/手工生成（见 U4）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 轨迹索引 | 每轮一条 `TurnIndex{toolCalls, errors, contextChars, endAt, wasted?}`，内存 + 可选落盘 |
| 候选轮 | 满足 `toolCalls ≥ 3 或 errors > 0 或 contextChars ≥ ctxSignalChars` 且未标废渣的轮 |
| 炼化通知 | 轨迹达 `notifyAfterSteps/notifyAfterTools` 且本批含高价值轮时投递的提醒消息 |
| 压缩提醒 | 上下文压力 ≥ `compactHintTokens` 时投递的「压缩前建议先炼化」提醒（**可关**） |
| 段（segment） | 一次压缩之后重新累计的区间（压缩重置上下文，累计从 0 起） |
| 节流 | 同段内不重复提醒（阈值 + 30% 增量）+ `wasted` 标记去重 |
| 存活推进 | 只有 `agent.send` 成功后才推进阈值状态（防「状态说提醒过、其实没送达」） |
| **产物类型 kind** | `guidance` / `workflow` / `tool` 三态；决定**落盘载体**与**结构判据**（§1） |
| **具体性** | `workflow` 的可证伪判据：编号步骤数 ≥2 且具体片段数 ≥1——只有形容词即拒 |
| **具体片段** | 闭合的围栏代码块，或围栏外的行内代码（`` `cmd` ``）——即「有可执行的命令/调用」 |
| **工具候选台账** | `kind=tool` 的产物：`<cwd>/.dsh/skill-forge-tools.json`，**跨会话累积** |
| **台账维度** | 会话旁路产物（索引/标记）按 `sessionId` 隔离；熔炉产出（工具台账）**不隔离**——维度按语义决定 |

## 3 · 概念模型

```
session/event  ──┬─ user/message   → 记 contextChars（本轮输入长度）
                 ├─ assistant/message → 记文本长度 + 上下文压力快照（usage.inputTokens）
                 ├─ tool/call     → toolCalls += 1（并记工具名）
                 ├─ step/end      → steps += 1（真实工作单元）
                 ├─ tool/result   → errors（isError）
                 └─ turn/end      → TurnIndex 收口
                        ├─ persistIndex（可选落盘）
                        ├─ maybeNotify      → 炼化通知（setImmediate → agent.send('next-step', true)）
                        └─ maybeCompactHint → 压缩提醒（受 compactHintEnabled 控制）
工具面: skill_signals（轨迹轮次索引）/ skill_marks（压缩时标记的候选）/ skill_extract（提取轨迹+联动视图）
        / skill_commit（按 kind 落盘 guidance|workflow → SKILL.md；tool → 工具候选台账）
        / skill_tools（工具候选台账：列 / 详情 / 状态流转）
```

不变量（invariants）：

1. **I1 零 LLM 成本**：只读事件、只算数——任何路径都不得发起模型请求
2. **I2 只送达不决策**：通知/提醒都不替我决定炼化什么（§2.1）
3. **I3 状态仅在送达成功后推进**：`agent` 未找到 / `send` 抛错 ⇒ **不推进**阈值且留日志（防自我欺骗）
4. **I4 reenter 纪律**：`turn/end` 回调内不直接 `agent.send`，一律 `setImmediate`（§5.12 §4）
5. **I5 提醒可关**：压缩提醒由 `compactHintEnabled` 控制（默认 `true`；本部署 `false`，主人 2026-09-14 定调）
6. **I6 段内累计**：段累计只统计本压缩段（压缩后重置），不被压缩前历史顶满
7. **I7 失败不阻塞**：索引/通知路径异常不得影响会话（吞掉并 return）
8. **I8 产物类型 fail-closed**：未知 `kind` 一律拒（`SKILL_KIND_NOTE`）——**不得**当成 `guidance` 放行（放行的代价是产物类型静默写错）
9. **I9 向后兼容（硬约束）**：不传 `kind` / `kind='guidance'` 时，**判定结果与产出文件逐字节不变**（frontmatter 仅在非 `guidance` 时加 `kind:` 行）
10. **I10 台账维度按语义决定**：会话旁路产物按 `sessionId` 隔离；熔炉产出（工具台账）**跨会话累积**——「这个脚本该固化成工具」是一个跨会话的意图，按会话隔离会让它随会话结束蒸发
11. **I11 显式写入 fail-loud**：`skill_commit(kind=tool)` / `skill_tools` 的状态流转是**显式请求**，落盘失败必须回报失败（`writeJsonFile` 返回 `false` ⇒ 返回失败 note），**不得**吞错后谎报成功

## 4 · 契约

### 4.1 配置
- `persistIndex`(true)：轨迹索引是否落盘
- `ctxSignalChars`(800)：判「上下文密集型候选」的字符阈值
- `compactHintTokens`(300000)：压缩提醒的压力阈值
- `compactHintEnabled`(true)：**压缩提醒开关**（本部署 profile 置 `false`）
- `notifyEnabled`(true) / `notifyAfterSteps`(200) / `notifyAfterTools`(200)：炼化通知阈值

### 4.2 投递文本（可被日志/事件流断言）
- 炼化通知：`[skill-forge] …`（含候选数、工具链/报错特征，指向 `skill_signals` / `skill_extract`）
- 压缩提醒：`[skill-forge] 上下文压力高（估算 ~Nk tokens）——压缩前建议先炼化：… skill_marks 查候选（当前 K 个）… 炼化完再压缩。`
- `kind=guidance` 提交回执：`SKILL.md 已写入；新会话技能目录自动发现（dsh-skill-filesystem）。已炼化轨迹 N 轮标记为废渣，不再重复提示`（**逐字不变**）
- `kind=workflow` 提交回执：同上，仅头部换成 `SKILL.md（kind=workflow：具体高效工作流）已写入`
- `kind=tool` 提交回执：`工具候选已登记/已更新：<tool> → <plugin>（写进工具候选台账，**不写 SKILL.md**…）。已炼化轨迹 N 轮标记为废渣。下一步：plugin_forge …`

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 宿主事件 | `src/index.ts` `ctx.on('session/event')` | 逐事件累计；`turn/end` 处收口 + 通知 + （可选）压缩提醒 |
| 工具面 | `src/index.ts` `signalsTool/marksTool/extractTool/commitTool/toolsTool` | 爱丽丝主动调用 |
| 落盘（会话旁路） | `src/trace-store.ts` `skillIndexPath` / `skillMarksPath` | 按 `sessionId` 隔离 |
| 落盘（熔炉产出） | `src/trace-store.ts` `skillToolsPath` | **不**按 `sessionId` 隔离（I10） |
| 记忆 | `ctx.memoryApi.remember(...)`（可选） | `skill_commit`（guidance/workflow）成功后回流主记忆库（不可用则静默） |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件不做鉴权，不校验产物**内容质量**（质量由 `skill-maintenance` 技能与爱丽丝把关）——但它负责**结构判据**（§1 表格第三列）
- 不越界清单：不自动写产物、不自动删产物、不读消息正文以外的敏感字段、不落盘凭据
- 失败面：① `agent` 未找到 → 记日志 + **不推进**状态（下次 turn/end 重试）② `send` 抛错 → 同上 ③ 索引落盘失败 → 只 warn ④ `memoryApi` 不可用 → 静默（非致命）⑤ **工具台账落盘失败 → 返回失败 note**（显式写入不吞错，I11）⑥ `skill_tools` 无 cwd → 明确提示读不到台账

## 6 · 与既有机制的关系

- AGENTS.md **§5.7**（自我进化闭环：炼化靠流程不靠临场自觉）、**§5.8**（记忆检索纪律：技能目录优先）
- AGENTS.md **§5.12**（提醒机制防静默失效：本插件的两个提醒通道都在这条规则下）
- 主人 2026-09-16 「**有效的临时工具脚本应该抽象成通用的插件工具**」⇒ 本插件 `kind=tool` 是该指令的**登记端**；生成端是 `plugin_forge` / `self-plugins/<name>`
- 技能维护：产出 SKILL.md 的淘汰/合并纪律在技能 `skill-maintenance`
- 与压缩的关系：**只提供时机信号**；压缩由 `dsh-compact-provider` 的入口执行

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据 | 状态 |
|---|-----------|------|------|
| A1 | 轨迹索引零 LLM 调用 | 代码路径无 `llm`/`summarize` 调用 | 已实测（代码审查） |
| A2 | 状态只在 `send` 成功后推进 | 代码：`send` 抛错 → `return` 不推进；日志 `压缩前提醒发送失败` | 已实测（代码 + 历史日志） |
| A3 | `compactHintEnabled=false` ⇒ **不再投递压缩提醒** | 事件流：无新的 `[skill-forge] 上下文压力高` 消息 | **待线上验收**（本部署已置 false） |
| A4 | 炼化通知按阈值 + 高价值轮触发 | 历史通知消息 + `notifyAfterSteps/Tools` 配置 | 已实测 |
| A5 | reenter 不冲突（`setImmediate` 投递） | 历史修复记录 + 无 `session append cannot reenter` 报错 | 已实测 |
| A6 | 段内累计不被压缩前历史顶满 | 代码：`segmentStart` + 段重置 | 已实测（代码） |
| A7 | 有单测覆盖 | `node --test tests/*.test.mjs` → `# pass 99 / # fail 0`（aggregate 25 + policy 38 + text 25 + trace-store 11） | 已实测（**2026-09-22 复核复跑：99/99 绿**；旧记的 98 是 09-16 15:20 的快照，此后 `tests/text.test.mjs` 于同日 16:59 增补 1 例而未回写本文） |
| A8 | 未知 `kind` 被拒，**不得**当 guidance 放行 | 单测「kind 非法 → 拒绝（fail-closed）」 | 已实测 |
| A9 | 向后兼容：`guidance`（或缺省）的判定与产物**逐字/逐字节**不变 | 单测「不传 kind 与 kind=guidance 判定完全一致」+ 代码 `kindLine` 仅非 guidance 时非空 | 已实测 |
| A10 | `workflow` 具体性门槛可证伪（步骤/片段不达即拒） | 单测「kind=workflow：具体性门槛」+ `countNumberedSteps`/`countConcreteSnippets` 单测 | 已实测 |
| A11 | `kind=tool` **不写** SKILL.md，只写台账 | 代码：`kind==='tool'` 分支在写 SKILL.md 之前 return；单测断言文案含「不写 SKILL.md」 | 已实测（代码 + 单测） |
| A12 | 台账写入失败**不谎报成功** | 代码：`writeJsonFile` 返回 `false` ⇒ 返回失败 note，且不调用 `markWasted` | 已实测（代码审查） |
| A13 | 台账**跨会话累积**（不按 sessionId 隔离） | 单测 `skillToolsPath` 与 sessionId 无关 + 与 `skillIndexPath` 形态不同 | 已实测 |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（cordis 接线：索引、两提醒通道、五工具、配置）
- 纯函数层：`src/policy.ts`（阈值/节流/状态迁移/**产物类型与结构判据**）、`src/text.ts`（文本摘要/工具引用/**具体性计数**/文案）、`src/aggregate.ts`（轮次聚合/视图构建）、`src/trace-store.ts`（落盘薄壳）
- 同语义副本：无
- **生态契约面（不属本条目的可运行语义）**：`src/fabric.ts` + `dsh-plugin.json`（2026-09-20 补 DSH Community Fabric 契约面）——Fabric 目前**只有文档**（无 SDK / 无正式 schema / 无 runtime），骨架自带声明「**现在不可运行**」；本插件的实际功能仍在 DSH/Cordis 面（`src/index.ts` + `cordis.patch.yml`）。⇒ 语义文档不为其背书、**不得**据此声称通过 Fabric conformance。
- 未实现/未验证部分**显式标注**：① 压缩提醒的关闭只在本部署 profile 生效（插件默认仍是 `true`）② 轨迹索引的 `wasted` 标记只由 `skill_commit(turns=…)` 驱动，通知路径已按 `isCandidateTurn` 过滤但**通知投递本身**仍可能提及该轮所属批次 ③ `kind=tool` 只登记候选，**不生成**插件骨架（U4）

## 9 · 实践修订记录

- **2026-08-23 首次实践（压缩提醒的三处修复）**
  - 语义**被补充**：① 段内累计（压缩后重置）② 状态仅在 `send` 成功后推进 ③ `turn/end` 回调内同步 `agent.send` 会 reenter → `setImmediate`
  - 教训：提醒类机制必须能回答「这条提醒真的送达了吗」
- **2026-09-14 二次实践（压缩提醒关闭 · v0.1.1）**
  - 语义**被补充**：压缩已能**轮内自办**（`dsh-compact-provider` 直触），提醒与压缩撞同一拍只剩噪音 ⇒ 新增 `compactHintEnabled` 开关，本部署置 `false`
  - 语义**被澄清（主人 2026-09-14 纠正）**：**压缩提醒 ≠ 上下文提醒**——前者（本插件）讲「压缩前先炼化」的时机，后者（`dsh-agent-context`）讲上下文占用；关前者不等于关后者
  - 教训：两个不同插件里的不同提醒，命名必须在工程上可区分（文档、配置键、消息前缀三处都要）
- **2026-09-16 三次实践（产物三态：语义扩充 · v0.2.0）**
  - 语义**被扩充（主人定调）**：「是时候改进技能熔炉了，可以扩充语义包括插件工具、具体的高效工作流等」
  - 落点：① `kind` 三态（`guidance`/`workflow`/`tool`）② `workflow` 的**具体性**成为可证伪的结构判据（步骤数 + 片段数）③ `tool` 走**工具候选台账**（跨会话累积，载体是插件不是技能目录）④ 新增 `skill_tools` 工具
  - 硬约束：**向后兼容**——不传 `kind` / `guidance` 的判定与产出文件逐字节不变（I9）
  - 教训（沿用主人同日的另一条指令）：**产物该落到哪个载体，由产物是什么决定**——指导落技能目录（要被读到），工具落插件（要被执行到）。把工具塞进技能目录，等于让它只能被读到、不能被调用
- **2026-09-22 复核记录（语义 drift D3 复核：判定为「非本条语义」的 impl 变动）**
  - **D3 触发因**：本条目 impl 落点 `src/index.ts` 的 mtime（2026-09-19 21:52）晚于本文（2026-09-16 15:20）。逐项取证后**判定与本文语义无关**：
    ① **未提交的工作区改动**（`git diff`：`turnsOf` 的返回类型收窄——去掉 `surface`/`events` 两个字段）——这是 **DSH 0.1.6 适配**（旧 Session 形状字段在新版不再存在，且该文件 535 行起已改经 seq + eventAt 读日志，字段无人使用）；**纯类型层收窄，零行为/零契约变化**。
    ② `8f4e697`（2026-09-20 chore(fabric)）只新增 `src/fabric.ts` + `dsh-plugin.json`（Fabric 前瞻契约面，自述「现在不可运行」），未触及索引/提醒/五工具的任何语义。
    ⇒ 二者都**不属于本条语义**（同一源文件承载多种关注点，impl 清单是**文件粒度**才被一起算进来）——**故不为消警而改内容**。
  - 复核中**顺带发现并修正了一处真实过时**（与 D3 无关，属独立取证）：A7 与 U2 记的「98 例」是 2026-09-16 15:20 的快照，此后同日 16:59 `tests/text.test.mjs` 增补 1 例——2026-09-22 复跑 `node --test tests/*.test.mjs` 实为 **99/99 绿**（25+38+25+11），两处计数已回写。
  - 语义**被补充**：§8 新增「生态契约面」一条——把 `src/fabric.ts` / `dsh-plugin.json` 显式标注为**不属本条目可运行语义**（Fabric 只有文档、骨架不可运行、不得据此声称 conformance），避免后续复核再次把 fabric 提交误算进本条 drift。
  - 教训：**D3 是 mtime 判据，不是语义判据**——它只说明「impl 文件被碰过」，碰的是类型层、格式层还是另一条语义，必须逐提交读 diff 才能判。本条即典型假报：**同一 `src/index.ts` 里塞着 DSH 兼容性适配与业务语义两件事**。

## 10 · 未决问题

- **U1** 压缩提醒关闭后，「压缩前炼化的收益最大化」这一动机由谁承接？（倾向：交给 §5.7 的日常炼化节奏，不再与压缩绑拍）
- **U2** ~~是否给本插件补纯函数单测~~ → **已解决**（2026-09-14 可维护性补课抽出 policy/aggregate/text/trace-store，2026-09-16 扩至 **99 例**；2026-09-22 复核复跑 99/99 绿）
- **U3** `wasted`（废渣）标记与通知路径的联动（当前 `skill_commit(turns)` 标记后，通知仍可能提示该轮所属批次）
- **U4**（2026-09-16 新增）`kind=tool` 的候选能否直接驱动 `plugin_forge` 生成骨架（当前只登记，生成仍靠手工/显式调用 `plugin_forge`）——若要打通，须先定义「从候选到 spec」的映射（工具名/参数/实现要点从哪来）
- **U5**（2026-09-16 新增）`workflow` 的具体性判据是否需要更强的形式（当前是计数门槛：≥2 步骤 + ≥1 片段）——计数可被「凑数」满足；是否需要断言「步骤与片段的一一对应」
