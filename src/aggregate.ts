/**
 * dsh-agent-skill-forge · 聚合层（纯函数：轨迹索引 / 候选聚合 / 视图构建 / 分段）
 *
 * 提取原则（2026-09-14 可维护性补课）：零 IO、零 cordis、零时钟（时间以 ISO 字符串注入）。
 * 行为判据逐字等价——**排序稳定性、slice 上限、分段边界符号**均与提取前一致，
 * 回归测试见 tests/aggregate.test.mjs。
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import { summarizeBlocks, truncate } from './text.js'
import { isCandidateTurn } from './policy.js'
import type { TurnSignals } from './policy.js'

/** 轨迹轮次索引（轻量：只记统计与边界，完整事件在会话日志） */
export interface TurnIndex {
  turn: number
  startAt: string
  endAt: string | null
  eventCount: number
  toolCalls: number
  /** 该轮关闭的步数（step/end 计数，harness 官方步计数点）。旧磁盘索引无此字段 = undefined → 按 0 处理。 */
  steps?: number
  errors: number
  estTokens: number
  /** 上下文规模：该轮用户输入（user/message text）累计字符数——上下文密集型候选阈值。 */
  contextChars: number
  /** 废渣标记：该轮轨迹已被炼化（技能蒸馏完成）——信号/候选/通知全部排除（主人 2026-08-17 定调）。 */
  wasted?: boolean
}

/** 压缩标记里的炼化候选（压缩前上下文最全时刻的高价值轨迹） */
export interface CompactionCandidate {
  turn: number
  toolCalls: number
  errors: number
  contextChars: number
  estTokens: number
  wasted?: boolean
}

/**
 * 压缩轨迹标记（主人 2026-08-17 定调：单次压缩收益最大化）：
 * 压缩触发（compaction/start）时——此刻上下文最全——按索引计算「炼化候选」（高价值 turn），
 * 打标记落盘；压缩完成（compaction/end）后通知爱丽丝（决策归爱丽丝：炼化什么/何时炼化）。
 * 与记忆插件的 checkpoint 通知互补（它管记忆，这里管技能）。
 */
export interface CompactionMark {
  at: string
  compactionId?: string
  candidates: CompactionCandidate[]
}

/** 新建轮次索引（时间注入：调用方传 `new Date().toISOString()`） */
export function createTurnIndex(turn: number, nowIso: string): TurnIndex {
  return { turn, startAt: nowIso, endAt: null, eventCount: 0, toolCalls: 0, errors: 0, estTokens: 0, contextChars: 0 }
}

/** 压缩段起点 = 当前最大 turn（无轮次/全非正 turn 时保持 0，与提取前一致——不是 Math.max） */
export function maxTurn(turns: Iterable<number>): number {
  let max = 0
  for (const turn of turns) if (turn > max) max = turn
  return max
}

/** 候选轮计数（压缩前提醒文案用） */
export function countCandidateTurns(turns: Iterable<TurnSignals & { wasted?: boolean }>, ctxSignalChars: number): number {
  let n = 0
  for (const t of turns) if (isCandidateTurn(t, ctxSignalChars)) n += 1
  return n
}

/**
 * 压缩标记候选（TOP 10）：过滤门（≥3 工具调用 / 有报错 / 大上下文）+ 排除废渣，
 * 按「工具调用 + 报错×2」降序（稳定排序：同分保持索引插入顺序）。
 */
export function selectCompactionCandidates(
  entries: Iterable<readonly [number, TurnIndex]>,
  ctxSignalChars: number,
): CompactionCandidate[] {
  return [...entries]
    .map(([turn, t]) => ({ turn, toolCalls: t.toolCalls, errors: t.errors, contextChars: t.contextChars, estTokens: t.estTokens, wasted: t.wasted ?? false }))
    .filter((x) => isCandidateTurn(x, ctxSignalChars))
    .sort((a, b) => (b.toolCalls + b.errors * 2) - (a.toolCalls + a.errors * 2))
    .slice(0, 10)
}

/** skill_signals 视图：最近 N 轮（turn 降序）+ 全会话统计（统计覆盖全量，不受 limit 影响） */
export function buildSignalsView(entries: Iterable<readonly [number, TurnIndex]>, limit: number): {
  turns: {
    turn: number
    startAt: string
    endAt: string
    eventCount: number
    toolCalls: number
    errors: number
    estTokens: number
    wasted: boolean
  }[]
  stats: { totalTurns: number; totalTokens: number; turnsWithErrors: number }
} {
  const list = [...entries]
  const turns = [...list].sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, t]) => ({
    turn: t.turn,
    startAt: t.startAt,
    endAt: t.endAt ?? '', // 空串 = 进行中（lossless JSON：不可用 undefined）
    eventCount: t.eventCount,
    toolCalls: t.toolCalls,
    errors: t.errors,
    estTokens: t.estTokens,
    wasted: t.wasted ?? false,
  }))
  let totalTokens = 0
  let turnsWithErrors = 0
  for (const [, t] of list) {
    totalTokens += t.estTokens
    if (t.errors > 0) turnsWithErrors += 1
  }
  return { turns, stats: { totalTurns: list.length, totalTokens, turnsWithErrors } }
}

/** 会话事件（skill_extract 读取所需的结构子集） */
export interface ExtractEventData {
  turn?: number
  message?: Message
  name?: string
  arguments?: string
  error?: unknown
}

export interface ExtractEvent {
  type?: string
  data?: ExtractEventData
}

/**
 * 按行分段（maxChars 预算）。
 * 边界（逐字保留）：`当前长 + 行长 + 1 === maxChars` 仍合并（> 才切）；空段会被推入（超预算首行场景）。
 */
export function segmentLines(lines: readonly string[], maxChars: number): string[] {
  const segments: string[] = []
  let current = ''
  for (const line of lines) {
    if (current.length + line.length + 1 > maxChars) {
      segments.push(current)
      current = line
    } else {
      current = current.length === 0 ? line : current + '\n' + line
    }
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * skill_extract 联动视图（Ctx2Skill 被动化）：上下文特征段（触发条件）在前，应对轨迹在后。
 * 全量事件流提取（append-only 日志保留原始事件）：压缩只替换 surface 表层，
 * 原始事件仍在日志里——压缩标记的候选 turn 压缩后仍可提取。
 */
export function buildExtractView(input: {
  events: readonly (ExtractEvent | undefined)[]
  start: number
  end: number
  maxChars: number
  linkContext: boolean
}): { segments: string[]; turnCount: number; eventCount: number; contextChars: number } {
  const { events, start, end, maxChars, linkContext } = input
  let contextChars = 0
  const ctxLines: string[] = []
  const lines: string[] = []
  let eventCount = 0
  for (const event of events) {
    if (event === undefined) continue
    const turn = event.data?.turn
    if (turn === undefined || turn < start || turn > end) continue
    eventCount += 1
    const t = event.type
    const d = event.data
    if (d === undefined) continue
    if (t === 'user/message') {
      const text = d.message !== undefined ? summarizeBlocks(d.message) : ''
      contextChars += text.length
      if (linkContext) ctxLines.push('[上下文特征] ' + truncate(text, 400))
    } else if (t === 'assistant/message') {
      const text = d.message !== undefined ? summarizeBlocks(d.message) : ''
      lines.push('[assistant] ' + truncate(text, 300))
    } else if (t === 'tool/call') {
      lines.push('[tool-call] ' + String(d.name ?? '?') + '(' + truncate(String(d.arguments ?? ''), 200) + ')')
    } else if (t === 'tool/result') {
      const err = d.error !== undefined
      const text = d.message !== undefined ? summarizeBlocks(d.message) : ''
      lines.push(err ? '[tool-result ERROR] ' + truncate(text, 300) : '[tool-result] ' + truncate(text, 300))
    }
  }
  // 联动：上下文特征段放在最前（「触发条件」先行），后接应对轨迹（交错）
  const allLines = linkContext && ctxLines.length > 0 ? [...ctxLines, '--- 应对轨迹 ---', ...lines] : lines
  return {
    segments: segmentLines(allLines, maxChars),
    turnCount: end - start + 1,
    eventCount,
    contextChars,
  }
}
