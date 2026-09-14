/**
 * dsh-agent-skill-forge · 策略层（纯函数：阈值判定 / 节流冷却 / 状态迁移 / 输入校验）
 *
 * 提取原则（2026-09-14 可维护性补课，AGENTS.md §5.22）：
 * - **零 IO、零 cordis、零时钟**——所有输入显式传入（时间以 ISO 字符串注入），决策以数值返回；
 * - **行为与提取前逐字等价**：阈值、边界符号（`<` / `>=`）、默认值、早退顺序一律不变；
 * - 调用方（src/index.ts）只负责「读状态 → 调本模块 → 落盘/投递」的接线。
 *
 * 判据真源：本文件是阈值语义的唯一真源，回归测试见 tests/policy.test.mjs。
 */

/** 通知节流状态（双轨独立推进：步数轨 + 工具调用轨） */
export interface NotifyState {
  nextStepThreshold: number
  nextToolThreshold: number
  notifiedCount: number
}

/** 决策所需的单轮信号（TurnIndex 的结构子集，便于纯函数与磁盘数据共用） */
export interface TurnSignals {
  /** step/end 计数（旧磁盘索引无此字段 = undefined，按 0 处理） */
  steps?: number
  toolCalls: number
  errors: number
  /** 该轮用户输入累计字符数 */
  contextChars: number
}

/** 阈值配置（index.ts 的 Config 子集） */
export interface PolicyConfig {
  notifyAfterSteps: number
  notifyAfterTools: number
  /** 上下文候选阈值：某轮用户输入超此字符数即「上下文密集型」 */
  ctxSignalChars: number
}

export type NotifyDecision =
  /** 未达阈值 / 通知关闭：调用方什么都不做（状态不落盘） */
  | { action: 'skip' }
  /** 达阈值但本批无高价值轮：推进双轨阈值防空转（notifiedCount 不变） */
  | { action: 'silent'; silentState: NotifyState }
  /** 有高价值轮：应投递通知（投递成功后调用方用 advanceNotifyState 推进状态） */
  | {
    action: 'notify'
    totalSteps: number
    totalTools: number
    errorTurns: number
    turnCount: number
  }

export type HintDecision =
  | { action: 'skip' }
  | { action: 'hint'; hintValue: number }

/** 默认通知状态（首见会话：阈值 = 配置值） */
export function defaultNotifyState(cfg: Pick<PolicyConfig, 'notifyAfterSteps' | 'notifyAfterTools'>): NotifyState {
  return {
    nextStepThreshold: cfg.notifyAfterSteps,
    nextToolThreshold: cfg.notifyAfterTools,
    notifiedCount: 0,
  }
}

/** 高价值轮（炼化通知的价值门）：报错轮 / 复杂工具链（≥5 次） / 大上下文 */
export function isHighValueTurn(t: TurnSignals, ctxSignalChars: number): boolean {
  return t.errors > 0 || t.toolCalls >= 5 || t.contextChars >= ctxSignalChars
}

/** 炼化候选轮（压缩标记 / 候选计数门）：复杂工具链阈值更低（≥3 次），且排除废渣 */
export function isCandidateTurn(t: TurnSignals & { wasted?: boolean }, ctxSignalChars: number): boolean {
  return (t.toolCalls >= 3 || t.errors > 0 || t.contextChars >= ctxSignalChars) && !t.wasted
}

/** 推进阈值（成功计数/静默推进共用）：新阈值 = 当前累计 + 配置间隔 */
export function advanceNotifyState(
  state: NotifyState,
  totalSteps: number,
  totalTools: number,
  cfg: Pick<PolicyConfig, 'notifyAfterSteps' | 'notifyAfterTools'>,
  counted: boolean,
): NotifyState {
  return {
    nextStepThreshold: totalSteps + cfg.notifyAfterSteps,
    nextToolThreshold: totalTools + cfg.notifyAfterTools,
    notifiedCount: state.notifiedCount + (counted ? 1 : 0),
  }
}

/**
 * 炼化通知决策（复合触发：步数轨或工具轨任一达阈值即检查）。
 * 早退顺序（与提取前一致）：① 通知关闭 ② 双轨均未达 ③ 无高价值轮 → silent。
 */
export function decideNotify(input: {
  enabled: boolean
  turns: readonly TurnSignals[]
  state: NotifyState
  cfg: PolicyConfig
}): NotifyDecision {
  const { enabled, turns, state, cfg } = input
  if (!enabled) return { action: 'skip' }
  // 累计步数/工具调用 = 全会话所有轮之和（跨压缩累积，不重置）
  let totalSteps = 0
  let totalTools = 0
  for (const t of turns) { totalSteps += t.steps ?? 0; totalTools += t.toolCalls }
  // 复合触发：步数或工具调用任一达阈值即检查
  if (totalSteps < state.nextStepThreshold && totalTools < state.nextToolThreshold) return { action: 'skip' }
  let hasValue = false
  for (const t of turns) {
    if (isHighValueTurn(t, cfg.ctxSignalChars)) {
      hasValue = true
      break
    }
  }
  if (!hasValue) {
    return { action: 'silent', silentState: advanceNotifyState(state, totalSteps, totalTools, cfg, false) }
  }
  let errorTurns = 0
  for (const t of turns) if (t.errors > 0) errorTurns += 1
  return { action: 'notify', totalSteps, totalTools, errorTurns, turnCount: turns.length }
}

/**
 * 重启恢复：从磁盘载荷迁移通知节流状态。
 *
 * 2026-09-01 步数轨迁移：nextStepThreshold 只在「旧文件无 notify 记录」时按 diskSteps + config 重算；
 * 已有阈值记录一律沿用——否则每次重启都把阈值推到 diskSteps+200，阈值膨胀 → 提醒永不触发
 * （实证：notifiedCount=0，阈值 342 vs 实际 153）。工具轨语义未变，旧文件有则沿用。
 *
 * 脏数据（notify 非对象 / 字段缺失）一律走「首次迁移」分支，不抛。
 */
export function migrateNotifyState(
  turns: readonly TurnSignals[] | undefined,
  notify: unknown,
  cfg: Pick<PolicyConfig, 'notifyAfterSteps' | 'notifyAfterTools'>,
): NotifyState {
  const list = turns ?? []
  const diskSteps = list.reduce((s, t) => s + (t.steps ?? 0), 0)
  const diskTools = list.reduce((s, t) => s + (t.toolCalls ?? 0), 0)
  const n = notify as {
    nextStepThreshold?: unknown
    nextToolThreshold?: unknown
    notifiedCount?: unknown
  } | null | undefined
  if (n !== undefined && n !== null && typeof n.nextStepThreshold === 'number' && n.nextStepThreshold > 0) {
    // 已有阈值记录：沿用（重启不重置节流——避免阈值膨胀/重复提醒）
    return {
      nextStepThreshold: n.nextStepThreshold,
      nextToolThreshold: (typeof n.nextToolThreshold === 'number' && n.nextToolThreshold > 0) ? n.nextToolThreshold : diskTools + cfg.notifyAfterTools,
      notifiedCount: typeof n.notifiedCount === 'number' ? n.notifiedCount : 0,
    }
  }
  // 首次/旧文件：按迁移规则初始化
  return {
    nextStepThreshold: diskSteps + cfg.notifyAfterSteps,
    nextToolThreshold: diskTools + cfg.notifyAfterTools,
    notifiedCount: 0,
  }
}

/**
 * 压缩前炼化提醒决策。
 * 判据：上下文压力 = 当前上下文占用（最新请求完整输入 token），非跨轮累加。
 * 节流：同段不重复——已提醒过且增量不足阈值的 30% 则跳过。
 * 边界（逐字保留）：`total === threshold` 即触发；`增量 === 0.3×threshold` 即触发。
 */
export function decideCompactHint(input: { total: number; lastHinted: number; threshold: number }): HintDecision {
  const { total, lastHinted, threshold } = input
  if (total < threshold) return { action: 'skip' }
  if (lastHinted >= threshold && total - lastHinted < threshold * 0.3) return { action: 'skip' } // 节流：同段不重复
  return { action: 'hint', hintValue: total }
}

/** skill_commit 输入校验的固定文案（判据真源，测试断言用真实常数） */
export const SKILL_NAME_NOTE = '技能名必须为小写 kebab-case（如 alpha-refine）'
export const SKILL_BODY_NOTE = 'description 与 body 不能为空'

/** 技能名形态：小写 kebab-case（首字符字母或数字，后续字母/数字/连字符） */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * skill_commit 输入校验（早退顺序：先名字后正文，与提取前一致）。
 * 通过 → { ok: true }；不通过 → { ok: false, note }（note 直接回填工具返回值）。
 */
export function validateSkillCommit(input: { name: string; description: string; body: string }): { ok: true } | { ok: false; note: string } {
  const { name, description, body } = input
  if (name.length === 0 || !SKILL_NAME_PATTERN.test(name)) return { ok: false, note: SKILL_NAME_NOTE }
  if (description.length === 0 || body.length === 0) return { ok: false, note: SKILL_BODY_NOTE }
  return { ok: true }
}
