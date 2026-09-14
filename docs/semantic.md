# 语义文档：被动技能熔炉（Passive Skill Forge）

> 版本 v0.1.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**已实现**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-skill-forge/src/index.ts`（单文件）

---

## 1 · 定位与反定位

**定位**：**被动**技能熔炉（Trace2Skill 思想落地）——后台**零 LLM 成本**地采集会话轨迹索引（每轮的工具调用数 / 报错数 / 上下文字符数 / 时间），在阈值处**送达信号**（炼化通知、压缩提醒），并提供 `skill_signals` / `skill_marks` / `skill_extract` / `skill_commit` 四个工具把「蒸馏技能」这件事变成可操作流程。

**反定位（本文不管什么）**：
- 不做蒸馏决策、不写技能正文——`skill_commit` 只在爱丽丝主动调用时写 `SKILL.md`
- 不管压缩事务/入口（→ `dsh-agent-compact` / `dsh-compact-provider`）
- 不管**上下文提醒**与压缩告警（→ `dsh-agent-context`）——本插件的**压缩提醒**讲的是「压缩前先炼化」的时机，**两者不是一个东西**
- **不是**自动技能生成器：无 LLM 调用、无自动写入

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

## 3 · 概念模型

```
session/event  ──┬─ user/message   → 记 contextChars（本轮输入长度）
                 ├─ assistant/message → 记文本长度
                 ├─ tool/call     → toolCalls += 1（并记工具名）
                 ├─ tool/result   → errors（isError）→ 触发上下文压力估算
                 └─ turn/end      → TurnIndex 收口
                        ├─ persistIndex（可选落盘）
                        ├─ maybeNotify      → 炼化通知（setImmediate → agent.send('next-step', true)）
                        └─ maybeCompactHint → 压缩提醒（受 compactHintEnabled 控制，2026-09-14 默认关闭于 web）
工具面: skill_signals（轨迹轮次索引）/ skill_marks（压缩时标记的候选）/ skill_extract（提取轨迹+联动视图）
        / skill_commit（写 SKILL.md → 可选 memoryApi 回流）
```

不变量（invariants）：
1. **I1 零 LLM 成本**：只读事件、只算数——任何路径都不得发起模型请求
2. **I2 只送达不决策**：通知/提醒都不替我决定炼化什么（§2.1）
3. **I3 状态仅在送达成功后推进**：`agent` 未找到 / `send` 抛错 ⇒ **不推进**阈值且留日志（防自我欺骗）
4. **I4 reenter 纪律**：`turn/end` 回调内不直接 `agent.send`，一律 `setImmediate`（§5.12 §4）
5. **I5 提醒可关**：压缩提醒由 `compactHintEnabled` 控制（默认 `true`；本部署 `false`，主人 2026-09-14 定调）
6. **I6 段内累计**：段累计只统计本压缩段（压缩后重置），不被压缩前历史顶满
7. **I7 失败不阻塞**：索引/通知路径异常不得影响会话（吞掉并 return）

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

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 宿主事件 | `src/index.ts` `ctx.on('session/event')` | 逐事件累计；`turn/end` 处收口 + 通知 + （可选）压缩提醒 |
| 工具面 | `src/index.ts` `signalsTool/marksTool/extractTool/commitTool` | 爱丽丝主动调用 |
| 记忆 | `ctx.memoryApi.remember(...)`（可选） | `skill_commit` 成功后回流主记忆库（不可用则静默，`SKILL.md` 仍是权威） |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：本插件不做鉴权，不校验技能内容质量（质量由 `skill-maintenance` 技能与爱丽丝把关）
- 不越界清单：不自动写技能、不自动删技能、不读消息正文以外的敏感字段、不落盘凭据
- 失败面：① `agent` 未找到 → 记日志 + **不推进**状态（下次 turn/end 重试）② `send` 抛错 → 同上 ③ 索引落盘失败 → 只 warn ④ `memoryApi` 不可用 → 静默（非致命）

## 6 · 与既有机制的关系

- AGENTS.md **§5.7**（自我进化闭环：炼化靠流程不靠临场自觉）、**§5.8**（记忆检索纪律：技能目录优先）
- AGENTS.md **§5.12**（提醒机制防静默失效：本插件的两个提醒通道都在这条规则下）
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
| A7 | 有单测覆盖 | **本插件无 tests/** | **未验证（明确标注）** |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（单文件：索引、两提醒通道、四工具、配置）
- 同语义副本：无
- 未实现/未验证部分**显式标注**：① **无单测**（纯函数未抽出，A7）② 压缩提醒的关闭只在本部署 profile 生效（插件默认仍是 `true`）③ 轨迹索引的 `wasted`（废渣）标记只由 `skill_commit(turns=...)` 驱动，未被通知路径消费

## 9 · 实践修订记录

- **2026-08-23 首次实践（压缩提醒的三处修复）**
  - 语义**被补充**：① 段内累计（压缩后重置）② 状态仅在 `send` 成功后推进 ③ `turn/end` 回调内同步 `agent.send` 会 reenter → `setImmediate`
  - 教训：提醒类机制必须能回答「这条提醒真的送达了吗」
- **2026-09-14 二次实践（压缩提醒关闭 · v0.1.1）**
  - 语义**被补充**：压缩已能**轮内自办**（`dsh-compact-provider` 直触：授权命中即在轮内起压缩事务），提醒与压缩撞同一拍只剩噪音 ⇒ 新增 `compactHintEnabled` 开关，本部署置 `false`
  - 语义**被澄清（主人 2026-09-14 纠正）**：**压缩提醒 ≠ 上下文提醒**——前者（本插件）讲「压缩前先炼化」的时机，后者（`dsh-agent-context`）讲上下文占用；关前者不等于关后者
  - 教训：两个不同插件里的不同提醒，命名必须在工程上可区分（文档、配置键、消息前缀三处都要）

## 10 · 未决问题

- **U1** 压缩提醒关闭后，「压缩前炼化的收益最大化」这一动机由谁承接？（倾向：交给 §5.7 的日常炼化节奏，不再与压缩绑拍）
- **U2** 是否给本插件补纯函数单测（把索引/节流判定抽成纯函数）
- **U3** `wasted`（废渣）标记与通知路径的联动（当前 `skill_commit(turns)` 标记后，通知仍可能提示该轮）
