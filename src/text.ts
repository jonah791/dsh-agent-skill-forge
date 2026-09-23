/**
 * dsh-agent-skill-forge · 文本层（纯函数：消息摘要 / 工具引用解析 / 提示文案）
 *
 * 提取原则（2026-09-14 可维护性补课）：零 IO、零 cordis、零时钟。
 * 文案是用户可见行为的一部分——字面常数即判据，逐字保留（回归测试断言真实字符串）。
 * 注意：`Message` 为**类型引用**（编译期擦除），本模块运行期不依赖 dsh-llm。
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SkillKind } from './policy.js'

/**
 * 消息内容摘要（text 块拼接截断）。
 *
 * 2026-09-22 v4 契约适配：tool/result 的块已**上提到 message.content 顶层**，
 * `tool-result` 从 ContentBlock 联合移除 ⇒ 旧分支既无类型重叠（TS2367）也永不命中。
 * 工具输出的内容块现在直接参与循环，信息不丢（粒度反而更细）。
 */
export function summarizeBlocks(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else parts.push('[' + block.type + ']')
  }
  return parts.join('\n')
}

/** 截断（超出加省略号；`length === n` 不改写） */
export function truncate(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n) + '…'
}

/**
 * 提取文本中的工具引用：**调用形态**的反引号标识符 + 「工具：xxx」模式。
 * 技能只提供指导、不提供工具（SkillForge 约束版定义）——引用的工具必须是系统工具面已有能力。
 *
 * 2026-09-16 修正（假阳性根因，实测）：旧实现把**任何**反引号内的小写标识符当工具引用。
 * 但一份写得好的技能正文，反引号里几乎全是 JSON 字段名 / 错误码 / 枚举 / 命令
 * （`summary` `observations` `pending` `bad_receipt_ref` `curl` …）⇒ **写得越对，警告越多**，
 * 校验器从"提示"退化成"噪音"（一次提交报了 19 个"幻觉工具"，其中 0 个是工具）。
 * 新判据 = **只有看起来要被调用的标识符才算工具引用**：
 *   · `` `name(` `` / `` `name(...)` ``  —— 调用形态；
 *   · `工具：name` / `tool: name`      —— 显式标注。
 * 残留（已知，故意留着而不是再放宽）：真实但**从未被调用过**的工具若写成调用形态仍会被报——
 * 正解是把种子改成从**运行时工具注册表**取（而非"运行期见过"），见 AGENTS.md 待办。
 */
export function extractToolRefs(text: string): string[] {
  const refs = new Set<string>()
  // 调用形态：反引号内、紧跟左括号（可含空白）：`wq_simulate(` / `bounty_deliver(claim_id, …)`
  const call = text.match(/`[a-z][a-z0-9_]{2,40}\s*\(/g)
  if (call) for (const m of call) refs.add(m.slice(1).replace(/\s*\($/, ''))
  // 显式标注：「工具：xxx」/「tool: xxx」（反引号可有可无）
  const colon = text.match(/(?:工具|tool)[:：]\s*`?[a-z][a-z0-9_]{2,40}`?/g)
  if (colon) {
    for (const m of colon) {
      const name = m.replace(/^.*?[:：]\s*/, '').replace(/`/g, '').trim()
      if (name.length > 0) refs.add(name)
    }
  }
  return [...refs]
}

/** 炼化通知文案（信号送达，决策归爱丽丝） */
export function buildNotifyText(input: { turnCount: number; totalSteps: number; totalTools: number; errorTurns: number }): string {
  return '[skill-forge] 已采集 ' + input.turnCount + ' 轮 / ' + input.totalSteps + ' 步轨迹 / 累计 ' + input.totalTools + ' 次工具调用（含 ' + input.errorTurns + ' 轮报错）——有高价值轮可炼化（蒸馏技能）。是否炼化、炼化哪些由爱丽丝决定：skill_signals 查看候选，skill_extract 提取，skill_commit 写入。'
}

/** 压缩前炼化提醒文案（估算 k tokens 四舍五入） */
export function buildCompactHintText(input: { total: number; candidates: number }): string {
  return '[skill-forge] 上下文压力高（估算 ~' + Math.round(input.total / 1000) + 'k tokens）——压缩前建议先炼化：压缩前上下文最全，单次压缩收益最大化。skill_marks 查候选（当前 ' + input.candidates + ' 个），skill_extract 提取联动视图，skill_commit 写入 SKILL.md；炼化完再压缩。'
}

/**
 * 编号步骤数：行首 `1.` / `2)` 编号，或 `## 步骤 3` 式小标题。
 * 用于 `kind=workflow` 的「具体性」判据（2026-09-16 主人定调「具体的高效工作流」）。
 */
export function countNumberedSteps(text: string): number {
  const m = text.match(/^\s*(?:\d+[.)]\s+|#{2,4}\s*步骤\s*\d+)/gm)
  return m === null ? 0 : m.length
}

/**
 * 具体片段数：闭合的围栏代码块 + 围栏外的行内代码（`` `cmd` ``）。
 *
 * 这是「具体」的**可证伪判据**：有可执行的命令/调用 vs 只有形容词。
 * 未闭合的围栏不计（宁可判「不够具体」也不放过半截代码块）。
 */
export function countConcreteSnippets(text: string): number {
  const fenced = text.match(/^```[\s\S]*?^```/gm)
  const blocks = fenced === null ? 0 : fenced.length
  const rest = text.replace(/^```[\s\S]*?^```/gm, '')
  const inline = rest.match(/`[^`\n]+`/g)
  return blocks + (inline === null ? 0 : inline.length)
}

/**
 * skill_commit 返回文案。
 * `turnsRequested` = 请求标记的 turn 数（**不是**实际标记成功的轮数——与提取前一致）。
 * `kind` 缺省 `guidance` ⇒ 输出与扩充前**逐字相同**（向后兼容，旧调用方零影响）。
 */
export function buildCommitNote(turnsRequested: number, unknownTools: readonly string[], kind: SkillKind = 'guidance'): string {
  const head = kind === 'workflow' ? 'SKILL.md（kind=workflow：具体高效工作流）已写入' : 'SKILL.md 已写入'
  let note = head + '；新会话技能目录自动发现（dsh-skill-filesystem）。已炼化轨迹 ' + turnsRequested + ' 轮标记为废渣，不再重复提示'
  if (unknownTools.length > 0) {
    note += '。\n⚠ 工具引用校验：以下工具不在已知工具面，可能是幻觉工具（技能只提供指导，不提供工具）：' + unknownTools.join(', ')
  }
  return note
}

/**
 * `kind=tool` 的返回文案（2026-09-16 主人定调「扩充语义包括插件工具」）。
 * 语义要点：工具的载体是**插件**（README / docs / 版本 / 测试），不是技能目录——
 * 所以这一类产物不写 SKILL.md，而是登记进**跨会话累积**的工具候选台账。
 */
export function buildToolCandidateNote(input: { tool: string; plugin: string; turnsRequested: number; existed: boolean }): string {
  return (input.existed ? '工具候选已更新' : '工具候选已登记') + '：' + input.tool + ' → ' + input.plugin
    + '（写进工具候选台账，**不写 SKILL.md**——工具的载体是插件：README/docs/版本/测试，不是技能目录）。'
    + '已炼化轨迹 ' + input.turnsRequested + ' 轮标记为废渣。'
    + '下一步：plugin_forge 生成插件骨架（或手工建 self-plugins/<plugin>），成形后 skill_tools 置 forged。'
}

