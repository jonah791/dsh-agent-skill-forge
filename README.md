# dsh-agent-skill-forge — 被动技能熔炉

DSH（DeepSeek Harness）插件：把轨迹与上下文蒸馏为可加载技能（SKILL.md）——Trace2Skill 与 Ctx2Skill 思想的被动落地。所有决策（蒸馏什么/何时蒸馏/怎么写）归 agent 本人。

## 功能特性

- **轨迹蒸馏**：会话事件流建索引（零冗余）→ 信号 → 提取 → 写入技能目录
- **上下文蒸馏联动（Ctx2Skill 被动化）**：`skill_context_signals` 找上下文密集型候选；`skill_extract` 输出联动视图（上下文特征 → 应对轨迹）——蒸馏条件化技能
- **压缩前炼化触发**：上下文压力高时提醒「先炼化再压缩」（单次压缩收益最大化）
- **废渣标记**：炼化完成的轨迹标记 wasted，信号/候选不再重复提示
- **压缩轨迹标记**：compaction 时自动记录高价值候选 turn

## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-agent-skill-forge.git
cd dsh-agent-skill-forge
pnpm install
pnpm build
```

## 使用

| 工具 | 说明 |
|------|------|
| `skill_signals` | 轨迹轮次索引（含废渣标注） |
| `skill_marks` | 压缩时标记的炼化候选 |
| `skill_context_signals` | 上下文密集型候选（联动蒸馏素材） |
| `skill_extract` | 提取轨迹/联动视图（linkContext） |
| `skill_commit` | 写入 SKILL.md（turns 参数声明炼化范围 → 废渣标记） |

## 技术要点

- 零子代理、零额外 LLM 成本：采集纯计数，提取纯数据
- 技能形态：SKILL.md（YAML frontmatter + 条件化正文），DSH 技能目录原生可加载
- 分工：被动提取（本插件）+ 主动进化（dsh-agent-evolve）+ 决策归爱丽丝

## License

MIT
