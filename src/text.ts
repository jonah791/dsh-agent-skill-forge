/**
 * dsh-agent-skill-forge · 文本层（纯函数：消息摘要 / 工具引用解析 / 提示文案）
 *
 * 提取原则（2026-09-14 可维护性补课）：零 IO、零 cordis、零时钟。
 * 文案是用户可见行为的一部分——字面常数即判据，逐字保留（回归测试断言真实字符串）。
 * 注意：`Message` 为**类型引用**（编译期擦除），本模块运行期不依赖 dsh-llm。
 */
import type { Message } from '@deepseek-ai/dsh-llm'

/** 消息内容摘要（text 块拼接截断） */
export function summarizeBlocks(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-result') parts.push('[tool-result ' + String((block as { content?: unknown[] }).content?.length ?? 0) + ' blocks]')
    else parts.push('[' + block.type + ']')
  }
  return parts.join('\n')
}

/** 截断（超出加省略号；`length === n` 不改写） */
export function truncate(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n) + '…'
}

/**
 * 提取文本中的工具引用：反引号内标识符 + 「工具：xxx」模式。
 * 技能只提供指导、不提供工具（SkillForge 约束版定义）——引用的工具必须是系统工具面已有能力。
 */
export function extractToolRefs(text: string): string[] {
  const refs = new Set<string>()
  // 反引号内的小写标识符（代码/工具引用惯用）：`wq_simulate`
  const backtick = text.match(/`([a-z][a-z0-9_]{2,40})`/g)
  if (backtick) for (const m of backtick) refs.add(m.slice(1, -1))
  // 「工具：xxx」或「工具:xxx」模式
  const colon = text.match(/工具[:：]\s*([a-z][a-z0-9_]{2,40})/g)
  if (colon) for (const m of colon) {
    const name = m.split(/[:：]/)[1]?.trim()
    if (name !== undefined) refs.add(name)
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
 * skill_commit 返回文案。
 * `turnsRequested` = 请求标记的 turn 数（**不是**实际标记成功的轮数——与提取前一致）。
 */
export function buildCommitNote(turnsRequested: number, unknownTools: readonly string[]): string {
  let note = 'SKILL.md 已写入；新会话技能目录自动发现（dsh-skill-filesystem）。已炼化轨迹 ' + turnsRequested + ' 轮标记为废渣，不再重复提示'
  if (unknownTools.length > 0) {
    note += '。\n⚠ 工具引用校验：以下工具不在已知工具面，可能是幻觉工具（技能只提供指导，不提供工具）：' + unknownTools.join(', ')
  }
  return note
}
