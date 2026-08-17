# dsh-agent-skill-forge

被动技能熔炉（Trace2Skill 思想落地）——把会话轨迹蒸馏为可迁移技能。

## 设计定调（2026-08-16 主人）

- **被动插件**：后台只做 采集 + 信号 + 兜底；所有决策（蒸馏什么/何时蒸馏/怎么合并/技能写哪/剪不剪）归爱丽丝
- **零子代理**：不派子智能体（钱包有限）——分析/提炼/合并在主会话内由爱丽丝完成（零额外 LLM 成本）
- **轨迹天然可得**：DSH 会话事件溯源——插件只建索引不复制事件（零冗余，replay-safe）
- **技能形态**：SKILL.md（~/.agents/skills/<name>/SKILL.md）——DSH 技能目录原生可加载（dsh-skill-filesystem 自动发现）
- **成败判断归爱丽丝**：插件不判成败，只报轨迹结构与信号

## 工具

| 工具 | 说明 |
|------|------|
| skill_signals | 信号（只读）：轨迹轮次索引（事件数/工具调用/报错/token）——选候选后提取分析 |
| skill_extract | 提取轨迹（只读）：按 turn 范围提取事件序列文本，零 LLM 调用 |
| skill_commit | 写入技能（可写）：SKILL.md（user=~/.agents/skills 跨项目 / project=项目 .agents/skills） |

## 蒸馏流程（爱丽丝侧，Trace2Skill 三阶段）

1. **轨迹生成**：DSH 事件溯源自动记录（插件后台索引）
2. **补丁提案**（我分析）：成功轨迹 → 泛化行为规则（SuccessAnalyst 角色）；失败轨迹 → 根因 → 规避规则（ErrorAnalyst 角色）——同会话内完成，零子代理
3. **合并提交**：去重/冲突消解（判断归我）→ skill_commit 写 SKILL.md → 技能目录自动发现

## 验证记录（2026-08-16）

- 采集：turn 117 索引（132 事件/1527 token）✓
- 提取：turn 范围事件序列 ✓
- 蒸馏：今日踩坑轨迹 → dsh-plugin-pitfalls 技能（6 条条件化规避规则）✓
- 加载：写入后技能目录实时发现（catalog 自动更新）✓
