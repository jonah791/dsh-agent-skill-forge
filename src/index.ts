/**
 * dsh-agent-skill-forge：被动技能熔炉（Trace2Skill 思想落地）
 *
 * 思想来源：Trace2Skill（Distill Trajectory-Local Lessons into Transferable Agent Skills）
 * —— 将大量成功/失败轨迹蒸馏为结构化、可直接加载的技能目录
 *
 * 设计定调（2026-08-16 主人；08-17 上下文蒸馏联动）：
 * - **被动插件**：后台只做 采集 + 信号 + 兜底——所有决策（蒸馏什么/何时蒸馏/怎么合并/技能写哪/剪不剪）归爱丽丝
 * - **上下文蒸馏联动（Ctx2Skill 被动化，主人 08-17 定调）**：技能 = 「上下文特征 → 应对策略」条件化规则——
 *   上下文与轨迹天然联动（上下文特征由 agent 自己持有，无需候选信号检测——主人 08-17 修正）；
 *   skill_extract 输出联动视图（上下文输入在前 ↔ 应对轨迹在后），蒸馏成条件化 SKILL.md；
 *   主动进化（对抗压力/版本选优）由 evolve 插件承担，不重复建主动引擎
 * - **零子代理**：不派子智能体加速（钱包有限）——分析/提炼/合并在主会话内由爱丽丝完成（零额外 LLM 成本）
 * - **轨迹天然可得**：DSH 会话事件溯源（session.events 完整事件流）——插件只建索引不复制事件（零冗余，replay-safe）
 * - **技能形态**：SKILL.md（~/.agents/skills/<name>/SKILL.md，YAML frontmatter + 正文）——DSH 技能目录原生可加载
 * - **成败判断归爱丽丝**：插件不判成败，只报轨迹结构与信号
 *
 * 结构（2026-09-14 可维护性补课，AGENTS.md §5.22）——本文件只做 cordis 接线：
 * - `src/policy.ts`   纯决策：通知阈值/冷却节流/状态迁移/输入校验（零 IO、零时钟）
 * - `src/aggregate.ts` 纯聚合：轮次索引/候选排序/视图构建/分段（零 IO、零时钟）
 * - `src/text.ts`     纯文本：消息摘要/工具引用解析/提示文案
 * - `src/trace-store.ts` 落盘薄壳：读吞错返回 undefined，写吞错返回 bool（绝不反噬主流程）
 * 回归测试：`node --test tests/*.test.mjs`（先 `npm run build` 产出 lib/）
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  advanceNotifyState,
  decideCompactHint,
  decideNotify,
  defaultNotifyState,
  migrateNotifyState,
  resolveSkillKind,
  validateSkillCommit,
} from './policy.js'
import type { SkillKind } from './policy.js'
import {
  buildExtractView,
  buildSignalsView,
  countCandidateTurns,
  createTurnIndex,
  maxTurn,
  selectCompactionCandidates,
} from './aggregate.js'
import type { CompactionMark, ExtractEvent, TurnIndex } from './aggregate.js'
import {
  buildCommitNote,
  buildCompactHintText,
  buildNotifyText,
  buildToolCandidateNote,
  countConcreteSnippets,
  countNumberedSteps,
  extractToolRefs,
  summarizeBlocks,
} from './text.js'
import { readJsonFile, skillIndexPath, skillMarksPath, skillToolsPath, writeJsonFile } from './trace-store.js'

export const name = 'agent-skill-forge'
export const inject = ['tools', 'agents', 'memoryApi'] as const

export interface Config {
  persistIndex: boolean
  /** 炼化通知开关：轨迹采集达到阈值时通知爱丽丝（信号送达，炼化决策归爱丽丝） */
  notifyEnabled: boolean
  /** 炼化通知步数阈值：累计 step（step/end 关闭步，harness 官方计数点）≥ 此值即检查（复合触发之一）。2026-09-01 主人定调：从轮次改为 200 步——step 是真实工作单元，一轮可含多步。 */
  notifyAfterSteps: number
  /** 炼化通知工具调用阈值：累计工具调用 ≥ 此值即检查（复合触发之二）。缺省 200——长跑会话「工具调用密集但步数慢」，纯步数阈值不敏感（2026-08-27 方案 B） */
  notifyAfterTools: number
  /** 上下文候选阈值：某轮用户输入超过此字符数即标记为「上下文密集型」候选（联动蒸馏素材，Ctx2Skill 被动化）。 */
  ctxSignalChars: number
  /** 压缩前炼化提醒阈值：累计估算 token 超过此值即通知「先炼化再压缩」（单次压缩收益最大化，主人 08-17 定调；2026-09-01 定调调至 300k）。 */
  compactHintTokens: number
  /**
   * 是否发送「压缩前炼化提醒」（压缩提醒）。
   *
   * 主人 2026-09-14 定调**关闭**：压缩已能**轮内自办**（`dsh-compact-provider` 直触：授权命中即
   * 在轮内起压缩事务），不再需要一条提醒来催我「先炼化再压缩」——提醒与压缩撞在同一拍，只添噪音。
   * 注意区分：**压缩提醒（本项）≠ 上下文提醒**（`dsh-agent-context` 的越阈值提示），后者保留。
   */
  compactHintEnabled: boolean
}

export const Config = z.object({
  persistIndex: z.boolean().default(true),
  ctxSignalChars: z.number().step(1).min(100).default(800),
  compactHintTokens: z.number().step(1).min(10000).default(300000),
  compactHintEnabled: z.boolean().default(true),
  notifyEnabled: z.boolean().default(true),
  notifyAfterSteps: z.number().step(1).min(1).default(200),
  notifyAfterTools: z.number().step(1).min(1).default(200),
})

/**
 * 工具候选（`kind=tool` 的产物）。
 * 跨会话累积在 `<cwd>/.dsh/skill-forge-tools.json`——「这个反复手写的脚本该固化成工具」是
 * 一个**跨会话的意图**，不能随会话结束蒸发（索引/标记是会话旁路产物，故按 sessionId 隔离；
 * 台账是熔炉的产出，故不隔离——两者的隔离维度按语义决定）。
 */
interface ToolCandidate {
  /** 拟固化的工具名（台账主键） */
  tool: string
  /** 拟归属的插件包名 */
  plugin: string
  /** 登记它的技能名（人读线索） */
  skill: string
  /** 为什么值得固化（来自 skill_commit 的 body） */
  why: string
  status: 'candidate' | 'forged' | 'abandoned'
  /** 支撑它的轨迹轮次 */
  turns: number[]
  createdAt: string
  updatedAt: string
}

export function apply(ctx: Context, config: Config): void {
  console.log('[dsh-agent-skill-forge] apply', new Date().toISOString(), '(HMR probe)')

  const indexBySession = new Map<string, Map<number, TurnIndex>>()
  // 当前上下文压力：sessionId → 最近一次请求的完整输入 token（usage.inputTokens）。
  // 主人 2026-08-24 指出「把两个会话的上下文加在一起算」：旧实现把每次请求的完整
  // inputTokens 累加进 estTokens（一轮内多次请求把同一份上下文重复计入 → 虚高）。
  // 本字段是「当前上下文占用」的诚实快照——上下文压力判断用这个，不跨轮累加。
  const contextPressureBySession = new Map<string, number>()
  // 炼化通知状态：sessionId → 下次通知阈值（步数/工具调用双轨独立推进——复合触发；2026-09-01 主人定调轮次轨改步数轨）
  const notifyState = new Map<string, { nextStepThreshold: number; nextToolThreshold: number; notifiedCount: number }>()
  // 压缩轨迹标记：sessionId → 最近一次压缩的炼化候选标记
  const marksBySession = new Map<string, CompactionMark>()
  // 已知工具面（技能只提供指导、不提供工具——工具引用校验用）：
  // 内置核心工具基线 + 会话事件 tool/call 动态采集（插件运行期间见过的工具）
  const knownTools = new Set<string>([
    'run_code', 'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'web_search',
    'remember', 'recall', 'life_sleep', 'life_status', 'taskboard_post', 'taskboard_list',
  ])
  // 压缩前炼化提醒状态：sessionId → 已提醒的 token 阈值段
  const hintState = new Map<string, number>()
  // 压缩段起点（2026-08-23 修复）：compaction/start 时记录该会话压缩前的最大 turn——
  // maybeCompactHint 只统计本段（压缩后）的轨迹累计；压缩后上下文重置，段累计从 0 重新积累，
  // 否则历史累计永久超阈值、提醒节流失效（压缩后永远不再提醒）
  const segmentBySession = new Map<string, number>()

  // 会话事件采集（零 LLM 成本：纯计数 + 估算）
  ctx.on('session/event', (session, event) => {
    const ev = event as unknown as {
      type: string
      data: {
        turn?: number
        usage?: { inputTokens?: number; outputTokens?: number }
        error?: unknown
      }
    }
    const turn = ev.data.turn
    if (turn === undefined) return
    let byTurn = indexBySession.get(session.id)
    if (byTurn === undefined) {
      // 重启恢复：采集起点也先读磁盘（否则新 map 只含新 turn，turnsOf 的懒加载
      // 因 get 非 undefined 而不触发——重启后历史索引丢失，2026-08-21 修复）
      byTurn = loadIndexFromDisk(session as { id: string; header?: { cwd?: string } }) ?? new Map()
      indexBySession.set(session.id, byTurn)
    }
    let idx = byTurn.get(turn)
    if (idx === undefined) {
      idx = createTurnIndex(turn, new Date().toISOString())
      byTurn.set(turn, idx)
    }
    idx.eventCount += 1
    if (ev.type === 'step/end') {
      // 步计数（2026-09-01 主人定调 200 步触发）：step/end 是 harness 官方关闭步事件（session-stats 同口径）
      idx.steps = (idx.steps ?? 0) + 1
    } else if (ev.type === 'user/message') {
      const msg = (ev.data as { message?: Message }).message
      const text = msg !== undefined ? summarizeBlocks(msg) : ''
      idx.contextChars += text.length
    } else if (ev.type === 'turn/end') {
      const nowIso = new Date().toISOString()
      idx.endAt = nowIso
      if (config.persistIndex) persistIndex(session, nowIso)
      maybeNotify(session, byTurn)
      // 压缩提醒（2026-09-14 主人定调默认关闭）：压缩已能轮内自办，不再需要催「先炼化再压缩」
      if (config.compactHintEnabled) maybeCompactHint(session, byTurn)
    } else if (ev.type === 'tool/call') {
      idx.toolCalls += 1
      const toolName = (ev.data as { name?: string }).name
      if (typeof toolName === 'string' && toolName.length > 0) knownTools.add(toolName)
    } else if (ev.type === 'tool/result') {
      if (ev.data.error !== undefined) idx.errors += 1
    } else if (ev.type === 'assistant/message') {
      const usage = ev.data.usage
      if (usage !== undefined) {
        const input = usage.inputTokens ?? 0
        const output = usage.outputTokens ?? 0
        // 主人 2026-08-24：不要「把上下文加在一起算」。旧实现 `idx.estTokens += input+output`
        // 把每次请求的完整上下文（usage.inputTokens 是整段上下文的 token 数，非增量）重复累加——
        // 一轮内多次请求会把同一份上下文重复计入，多轮下来严重虚高（实测 ~1163k）。
        // 修正：estTokens 记录该轮「最近一次请求的完整上下文大小」（上下文压力快照），赋值而非累加。
        idx.estTokens = input + output
        // 当前上下文占用 = 最新请求的完整输入 token（上下文压力判断用，不跨轮累加）
        contextPressureBySession.set(session.id, input)
      }
    } else if (ev.type === 'compaction/start') {
      // 压缩触发（此刻上下文最全）：计算炼化候选 → 打标记落盘（供压缩后炼化，单次压缩收益最大化）
      const byTurn2 = indexBySession.get(session.id)
      if (byTurn2 !== undefined && byTurn2.size > 0) {
        const candidates = selectCompactionCandidates(byTurn2.entries(), config.ctxSignalChars)
        const mark: CompactionMark = { at: new Date().toISOString(), compactionId: String((ev.data as { compactionId?: string }).compactionId ?? ''), candidates }
        marksBySession.set(session.id, mark)
        persistMarks(session, mark)
        console.log('[dsh-agent-skill-forge] 压缩标记', candidates.length + ' 候选 turn', session.id, new Date().toISOString())
      }
      // 压缩段重置（2026-08-23 修复）：压缩后上下文重置，本段起点 = 当前最大 turn，
      // hintState 清零让本段从 0 重新累计——不再被压缩前历史累计永久顶满（否则提醒永不再触发）
      const segmentStart = byTurn2 === undefined ? 0 : maxTurn(byTurn2.keys())
      segmentBySession.set(session.id, segmentStart)
      hintState.set(session.id, 0)
      // 压缩后上下文重置：当前上下文压力清零（否则旧压力继续顶满提醒——主人 2026-08-24 修正）
      contextPressureBySession.delete(session.id)
    }
  })

  /** 索引/标记落盘（IO 薄壳吞错——失败不影响采集主流程） */
  function persistIndex(session: { id: string; header?: { cwd?: string } }, nowIso: string): void {
    const cwd = session.header?.cwd
    if (cwd === undefined) return
    const byTurn = indexBySession.get(session.id)
    if (byTurn === undefined) return
    const payload = {
      sessionId: session.id,
      updatedAt: nowIso,
      turns: [...byTurn.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t),
      // 通知/提示状态一并落盘（重启不丢提醒节流——否则重启后可能重复提醒，主人 2026-08-21 强调）
      notify: notifyState.get(session.id) ?? null,
      hint: hintState.get(session.id) ?? null,
      // 压缩段起点落盘（重启不丢段边界——否则重启后段起点丢失、提醒统计错乱）
      segment: segmentBySession.get(session.id) ?? null,
    }
    writeJsonFile(skillIndexPath(cwd, session.id), payload)
  }

  function persistMarks(session: { id: string; header?: { cwd?: string } }, mark: CompactionMark): void {
    const cwd = session.header?.cwd
    if (cwd === undefined) return
    writeJsonFile(skillMarksPath(cwd, session.id), { sessionId: session.id, ...mark })
  }

  // 重启恢复：进程内索引/标记是内存态，web 重启即失——工具首次使用时从磁盘懒加载
  // （persistIndex 已落盘 <cwd>/.dsh/skill-forge-index-<sessionId>.json 与 skill-forge-marks-<sessionId>.json）
  function loadIndexFromDisk(session: { id: string; header?: { cwd?: string } }): Map<number, TurnIndex> | undefined {
    try {
      const cwd = session.header?.cwd
      if (cwd === undefined) return undefined
      const data = readJsonFile(skillIndexPath(cwd, session.id)) as {
        sessionId?: string
        turns?: TurnIndex[]
        notify?: unknown
        hint?: number
        segment?: number | null
      } | undefined
      if (data === undefined) return undefined
      if (data.sessionId !== session.id) return undefined
      // 恢复通知/提示节流状态（重启不丢提醒时机——否则阈值回退、可能重复提醒）
      // 2026-09-01 步数轨迁移 + 2026-09-05 膨胀修复：判据抽为 policy.migrateNotifyState（旧文件重算、已有记录沿用）
      notifyState.set(session.id, migrateNotifyState(data.turns, data.notify, config))
      if (data.hint !== undefined && data.hint !== null) hintState.set(session.id, data.hint)
      // 恢复压缩段起点（旧文件无 segment 时保持 0 = 全量统计，兼容历史语义）
      if (data.segment !== undefined && data.segment !== null) segmentBySession.set(session.id, data.segment)
      const map = new Map<number, TurnIndex>()
      for (const t of data.turns ?? []) map.set(t.turn, t)
      return map
    } catch { return undefined }
  }

  function loadMarksFromDisk(session: { id: string; header?: { cwd?: string } }): CompactionMark | undefined {
    try {
      const cwd = session.header?.cwd
      if (cwd === undefined) return undefined
      const data = readJsonFile(skillMarksPath(cwd, session.id)) as ({ sessionId?: string } & CompactionMark) | undefined
      if (data === undefined) return undefined
      if (data.sessionId !== session.id) return undefined
      return { at: data.at, compactionId: data.compactionId, candidates: data.candidates }
    } catch { return undefined }
  }

  // 压缩前炼化提醒（主人 2026-08-17：单次压缩收益最大化——压缩前上下文最全，先炼化再压缩）
  // 感知：本压缩段轨迹累计估算 token 接近压缩阈值 → 提醒「先炼化再压缩」；节流（每个阈值段一次）
  // 2026-08-23 修复：
  // 1) 只统计本压缩段（segmentStart 之后）的累计——压缩后上下文重置，段累计从 0 重新积累，
  //    不再被压缩前历史累计（>1.5M）永久顶满导致节流吞掉后续提醒
  // 2) hintState 仅在 send 成功后推进——agent 未找到 / send 抛错都留日志且不推进状态，
  //    避免「状态显示已提醒但消息从未投递」的自我欺骗（旧版状态在 if 外无条件推进）
  // 3) reenter 根因（2026-08-23 实测日志）：turn/end 事件由 session.append('turn/end', ...) 同步发布，
  //    其回调内直接 agent.send → inbox.splice → session.append('agent/inbox/spliced', ...) 触发
  //    「session append cannot reenter while another append is being published」——所以每次 send 都抛错。
  //    memory 插件在 compaction/end 投递成功是因为该事件发布路径无此冲突。
  //    修复：setImmediate 延迟到当前 append 事务完成后投递（send 成功才推进状态）。
  function maybeCompactHint(session: { id: string }, byTurn: Map<number, TurnIndex>): void {
    // 主人 2026-08-24：上下文压力 = 当前上下文占用（最新请求完整输入 token），
    // 不是「把所有轮次的上下文加在一起」。旧实现 `total += t.estTokens` 跨轮累加虚高。
    const total = contextPressureBySession.get(session.id) ?? 0
    // 阈值 + 节流判据抽为纯函数（policy.decideCompactHint，回归测试覆盖边界）
    const decision = decideCompactHint({ total, lastHinted: hintState.get(session.id) ?? 0, threshold: config.compactHintTokens })
    if (decision.action === 'skip') return
    const agent = ctx.agents?.get(session.id as never)
    if (agent === undefined) {
      // 诊断：agent 未找到（不推进状态，下次 turn/end 重试）
      console.log('[dsh-agent-skill-forge] 压缩前提醒跳过：agent 未找到', session.id, 'segmentTotal', total, new Date().toISOString())
      return
    }
    // 计算当前候选数（供提示）
    const candidates = countCandidateTurns(byTurn.values(), config.ctxSignalChars)
    const text = buildCompactHintText({ total, candidates })
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-agent-skill-forge' } })
    // reenter 修复：延迟到当前 session.append 事务完成后投递
    setImmediate(() => {
      try {
        // next-step（主人 2026-08-25）：插话插到下一帧之前，而非等到下一回合结束才注入
        agent.send(message, 'next-step', true)
      } catch (err) {
        // 发送失败：不推进状态（下次 turn/end 重试），留日志定位
        console.log('[dsh-agent-skill-forge] 压缩前提醒发送失败', session.id, String(err), new Date().toISOString())
        return
      }
      hintState.set(session.id, decision.hintValue)
    })
  }

  // 炼化通知：轨迹达到阈值 → 信号送达（wakeup=true 到达即送达；炼化决策归爱丽丝）
  // 价值驱动（主人 2026-08-21：通知太频繁/时机不对）：本批必须含高价值轮
  // （报错/复杂工具链/大上下文）才通知——纯闲聊轮不打扰；无价值也推进阈值防反复检查
  // 2026-08-23 修复：notifiedCount 仅在 send 成功后推进——agent 未找到 / send 抛错
  // 留日志且不推进状态（旧版状态在 if 外无条件推进，造成「已通知但从未投递」的假象）
  // 2026-08-27 方案 B（主人定调）：复合触发——任一先达即检查，双轨独立推进。
  // 2026-09-01 主人定调：轮次轨改为**步数轨**（notifyAfterSteps=200）——step（一次完整思考+工具调用链）
  // 才是真实工作单元，一轮可含多步；计数点用 step/end（harness session-stats 官方口径）。
  function maybeNotify(session: { id: string }, byTurn: Map<number, TurnIndex>): void {
    const state = notifyState.get(session.id) ?? defaultNotifyState(config)
    // 阈值/价值/推进判据抽为纯函数（policy.decideNotify + advanceNotifyState，回归测试覆盖边界）
    const decision = decideNotify({ enabled: config.notifyEnabled, turns: [...byTurn.values()], state, cfg: config })
    if (decision.action === 'skip') return
    if (decision.action === 'silent') {
      // 无价值轮：双轨都推进（防止低价值会话反复检查空转）
      notifyState.set(session.id, decision.silentState)
      return
    }
    const agent = ctx.agents?.get(session.id as never) // SessionId branded type 断言
    if (agent === undefined) {
      // 诊断：agent 未找到（不推进状态，下次 turn/end 重试）
      console.log('[dsh-agent-skill-forge] 炼化通知跳过：agent 未找到', session.id, 'steps', decision.totalSteps, 'tools', decision.totalTools, new Date().toISOString())
      return
    }
    const text = buildNotifyText({
      turnCount: decision.turnCount,
      totalSteps: decision.totalSteps,
      totalTools: decision.totalTools,
      errorTurns: decision.errorTurns,
    })
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-agent-skill-forge' } })
    // reenter 修复（同 maybeCompactHint）：turn/end 回调内同步 agent.send 会触发 session.append reenter，
    // 延迟到当前 append 事务完成后投递；send 成功才推进状态
    setImmediate(() => {
      try {
        // next-step（主人 2026-08-25）：插话插到下一帧之前，而非等到下一回合结束才注入
        agent.send(message, 'next-step', true) // wakeup=true：到达即送达（不打断当前思维；忙则排队）
      } catch (err) {
        // 发送失败：不推进状态（下次 turn/end 重试），留日志定位
        console.log('[dsh-agent-skill-forge] 炼化通知发送失败', session.id, String(err), new Date().toISOString())
        return
      }
      notifyState.set(session.id, advanceNotifyState(state, decision.totalSteps, decision.totalTools, config, true))
    })
  }

  function turnsOf(exec: ToolRunContext): {
    session: { id: string; surface: { nodes: readonly number[] }; events: Record<number, unknown>; header?: { cwd?: string } } | undefined
    byTurn: Map<number, TurnIndex>
  } {
    const session = exec.agent?.session
    let byTurn: Map<number, TurnIndex>
    if (session === undefined) {
      byTurn = new Map<number, TurnIndex>()
    } else {
      // 重启恢复：进程内索引丢失时从磁盘懒加载（web 重启不丢轨迹）
      byTurn = indexBySession.get(session.id) ?? loadIndexFromDisk(session) ?? new Map<number, TurnIndex>()
      indexBySession.set(session.id, byTurn)
    }
    return { session, byTurn }
  }

  // ---------- 工具 1：skill_signals ----------
  const signalsTool: ToolDefinition = defineTool({
    name: 'skill_signals',
    description: '技能熔炉信号（只读）：本会话轨迹轮次索引——每轮的事件数/工具调用数/报错数/估算 token。选候选轮次后用 skill_extract 提取轨迹分析。决策（蒸馏什么/何时蒸馏）归爱丽丝。',
    parameters: {
      limit: { type: 'number', description: '返回最近 N 轮（缺省 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          turns: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                turn: { type: 'number', required: true },
                startAt: { type: 'string', required: true },
                endAt: { type: 'string' },
                eventCount: { type: 'number', required: true },
                toolCalls: { type: 'number', required: true },
                errors: { type: 'number', required: true },
                estTokens: { type: 'number', required: true },
                wasted: { type: 'boolean', description: '已炼化废渣（不再提示）' },
              },
            },
            required: true,
          },
          stats: {
            type: 'object',
            additionalProperties: false,
            properties: {
              totalTurns: { type: 'number', required: true },
              totalTokens: { type: 'number', required: true },
              turnsWithErrors: { type: 'number', required: true },
            },
            required: true,
          },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        const list = value.turns.map((t: any) => `• turn ${t.turn} · ev ${t.eventCount} · tool ${t.toolCalls} · err ${t.errors} · ${Math.round((t.estTokens ?? 0) / 1000)}k${t.wasted ? ' [废]' : ''}`).join('\n')
        return [{ type: 'text', text: `轨迹信号 ${value.turns.length} 轮（共 ${value.stats.totalTurns}）——蒸馏决策归爱丽丝\n${list}` }]
      },
    },
    async execute(args, exec) {
      const { byTurn } = turnsOf(exec)
      const limit = (args.limit as number | undefined) ?? 20
      const view = buildSignalsView(byTurn.entries(), limit)
      return {
        turns: view.turns,
        stats: view.stats,
        note: '按 turn 索引（完整事件在会话日志，零冗余）；报错轮是规避规则素材，平稳轮是泛化行为素材——判断归爱丽丝',
      }
    },
  })



  // ---------- 工具 1.4：skill_marks（压缩轨迹标记查询）----------
  // 主人 2026-08-17：压缩触发时标记炼化候选（上下文最全时刻），压缩后按标记炼化——单次压缩收益最大化
  const marksTool: ToolDefinition = defineTool({
    name: 'skill_marks',
    description: '压缩轨迹标记（只读）：最近一次压缩触发时标记的炼化候选 turn（含工具调用/报错/上下文规模特征）——压缩前上下文最全时刻的高价值轨迹，压缩后按此炼化收益最大化。只读信号，炼化决策归爱丽丝。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          at: { type: 'string', required: true },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                turn: { type: 'number', required: true },
                toolCalls: { type: 'number', required: true },
                errors: { type: 'number', required: true },
                contextChars: { type: 'number', required: true },
                estTokens: { type: 'number', required: true },
                wasted: { type: 'boolean', description: '已炼化废渣（不再提示）' },
              },
            },
            required: true,
          },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        if (value.candidates.length === 0) return [{ type: 'text', text: value.note ?? '无候选' }]
        const list = value.candidates.map((c: any) => `• turn ${c.turn} · tool ${c.toolCalls} · err ${c.errors} · ${Math.round((c.estTokens ?? 0) / 1000)}k${c.wasted ? ' [已炼化]' : ''}`).join('\n')
        return [{ type: 'text', text: `压缩标记 @${value.at}：${value.candidates.length} 个炼化候选\n${list}` }]
      },
    },
    async execute(_args, exec) {
      const session = exec.agent?.session
      let mark = session === undefined ? undefined : marksBySession.get(session.id)
      if (mark === undefined && session !== undefined) {
        // 重启恢复：压缩标记进程内丢失时从磁盘懒加载
        mark = loadMarksFromDisk(session)
        if (mark !== undefined) marksBySession.set(session.id, mark)
      }
      if (mark === undefined) return { at: '', candidates: [], note: '无压缩标记（压缩后才有；压缩触发时会自动标记）' }
      return { at: mark.at, candidates: mark.candidates, note: '候选 = 压缩前高价值轨迹；skill_extract 提取联动视图后蒸馏成条件化技能' }
    },
  })

  // ---------- 工具 2：skill_extract ----------
  const extractTool: ToolDefinition = defineTool({
    name: 'skill_extract',
    description: '提取轨迹（只读）：按 turn 范围从会话事件流提取事件序列文本（用户消息/模型动作/工具调用/结果与错误），供爱丽丝蒸馏分析。零 LLM 调用（纯数据提取）。linkContext=true（缺省）时输出联动视图——显式标注「上下文特征」段（该范围用户输入内容摘要），与应对轨迹（工具/决策路径）交错呈现，供蒸馏「上下文特征 → 应对策略」条件化技能（Ctx2Skill 被动化，主人 08-17 定调）。',
    parameters: {
      startTurn: { type: 'number', required: true, description: '起始 turn' },
      endTurn: { type: 'number', description: '结束 turn（缺省=startTurn）' },
      maxChars: { type: 'number', description: '输出上限字符（缺省 20000，超长分段返回）' },
      linkContext: { type: 'boolean', description: '联动视图：开头输出上下文特征段（缺省 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          segments: { type: 'array', items: { type: 'string' }, required: true },
          turnCount: { type: 'number', required: true },
          eventCount: { type: 'number', required: true },
          contextChars: { type: 'number', description: '该范围用户输入总字符数（上下文规模）' },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        if (value.segments.length === 0) return [{ type: 'text', text: value.note ?? '无内容' }]
        return [{ type: 'text', text: value.segments.join('\n\n--- 分段 ---\n\n') }]
      },
    },
    async execute(args, exec) {
      // turnsOf 调用保持原样（副作用：懒加载磁盘索引进内存）
      const { session } = turnsOf(exec)
      if (session === undefined) return { segments: [], turnCount: 0, eventCount: 0, note: '无可用会话' }
      const start = args.startTurn as number
      const end = (args.endTurn as number | undefined) ?? start
      const maxChars = (args.maxChars as number | undefined) ?? 20000
      const linkContext = (args.linkContext as boolean | undefined) ?? true
      // 全量事件流提取（append-only 日志保留原始事件）：压缩只替换 surface 表层，
      // 原始事件仍在日志里——压缩标记的候选 turn 压缩后仍可提取
      // （原实现只遍历 surface.nodes，压缩后旧 turn 被替换出表层 → 提取失效，2026-08-21 修复）
      // alpha.4 适配（2026-09-06）：Session.events 已移除，改经 seq + eventAt 按需读日志。
      const sessionView = session as unknown as {
        seq: number
        eventAt(seq: number): ExtractEvent | undefined
      }
      const events: (ExtractEvent | undefined)[] = []
      for (let i = 0; i < sessionView.seq; i += 1) events.push(sessionView.eventAt(i))
      // 联动视图构建抽为纯函数（aggregate.buildExtractView，回归测试覆盖分段边界与脏事件）
      const view = buildExtractView({ events, start, end, maxChars, linkContext })
      return {
        segments: view.segments,
        turnCount: view.turnCount,
        eventCount: view.eventCount,
        contextChars: view.contextChars,
        note: '联动视图：上下文特征（触发条件）在前，应对轨迹在后——蒸馏「上下文特征 → 应对策略」条件化技能；成败判断归爱丽丝',
      }
    },
  })

  // ---------- 工具 3：skill_commit ----------
  const commitTool: ToolDefinition = defineTool({
    name: 'skill_commit',
    description: '把轨迹蒸馏产物落盘（可写）。产物类型由 kind 决定（2026-09-16 语义扩充）：guidance=条件化行为规则 → SKILL.md；workflow=**具体**高效工作流（需 ≥2 条编号步骤 + ≥1 处可执行片段）→ SKILL.md（frontmatter 带 kind）；tool=该固化的插件工具 → 工具候选台账（不写 SKILL.md——工具的载体是插件，不是技能目录）。guidance/workflow 默认写用户级 ~/.agents/skills/<name>/SKILL.md（跨项目可加载），scope=project 写 <cwd>/.agents/skills/。纪律：技能只提供指导（决策/流程/规避），不提供工具——正文引用的工具限于系统工具面（提交时自动校验，幻觉工具会警告）。turns 声明的轮次提交后标记为废渣。',
    parameters: {
      name: { type: 'string', required: true, description: '技能名（小写 kebab-case，如 alpha-refine）' },
      description: { type: 'string', required: true, description: '一句话描述（frontmatter description；技能目录显示用）' },
      body: { type: 'string', required: true, description: '正文（Markdown）。guidance=条件化行为规则（什么状态下做什么/规避什么）；workflow=具体步骤序列（编号步骤 + 命令/调用）；tool=为什么要固化这个工具' },
      scope: { type: 'string', enum: ['user', 'project'], description: '写入范围（缺省 user=~/.agents/skills）' },
      turns: { type: 'array', items: { type: 'number' }, description: '本次炼化覆盖的 turn 列表（可选）——提交后这些轨迹标记为废渣，信号/候选不再重复提示' },
      kind: { type: 'string', enum: ['guidance', 'workflow', 'tool'], description: '产物类型（缺省 guidance=原语义，不变）' },
      toolName: { type: 'string', description: 'kind=tool 必需：拟固化的工具名（小写字母开头，仅 [a-z0-9_]）' },
      toolPlugin: { type: 'string', description: 'kind=tool 必需：拟归属的插件包名（小写 kebab，如 dsh-earn-radar）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          name: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.path.length > 0 ? ('技能已写入 ' + value.path + '\n' + value.note) : value.note }],
    },
    async execute(args, exec) {
      const name = (args.name as string | undefined) ?? ''
      const description = (args.description as string | undefined) ?? ''
      const body = (args.body as string | undefined) ?? ''
      const scope = (args.scope as 'user' | 'project' | undefined) ?? 'user'
      const kindRaw = args.kind as string | undefined
      const kind: SkillKind = resolveSkillKind(kindRaw) ?? 'guidance'
      const toolName = (args.toolName as string | undefined) ?? ''
      const toolPlugin = (args.toolPlugin as string | undefined) ?? ''
      const turns = (args.turns as number[] | undefined) ?? []
      // 输入校验抽为纯函数（policy.validateSkillCommit）：早退顺序 = 名字 → kind → kind 专属 → 正文
      const validity = validateSkillCommit({
        name,
        description,
        body,
        kind: kindRaw,
        toolName,
        toolPlugin,
        numberedSteps: countNumberedSteps(body),
        concreteSnippets: countConcreteSnippets(body),
      })
      if (!validity.ok) return { path: '', name, note: validity.note }
      // 废渣标记（三类产物共用）：本次炼化覆盖的 turn → wasted（信号/候选不再重复提示）
      const markWasted = (): void => {
        const sess = exec.agent?.session
        if (sess === undefined || turns.length === 0) return
        const byTurn = indexBySession.get(sess.id)
        if (byTurn === undefined) return
        let marked = 0
        for (const t of turns) {
          const idx = byTurn.get(t)
          if (idx !== undefined && !idx.wasted) {
            idx.wasted = true
            marked += 1
          }
        }
        if (marked > 0) persistIndex(sess, new Date().toISOString())
      }
      const cwd = exec.agent?.session.header?.cwd

      // ── kind=tool：登记**工具候选台账**（不写 SKILL.md——工具的载体是插件）────────
      if (kind === 'tool') {
        if (cwd === undefined) return { path: '', name, note: '无会话 cwd，无法写工具候选台账' }
        const file = skillToolsPath(cwd)
        const reg = (readJsonFile(file) as { candidates?: Record<string, ToolCandidate> } | undefined) ?? {}
        const candidates = reg.candidates ?? {}
        const existed = candidates[toolName] !== undefined
        const prev = candidates[toolName]
        const nowIso = new Date().toISOString()
        candidates[toolName] = {
          tool: toolName,
          plugin: toolPlugin,
          skill: name,
          why: body.trim(),
          status: prev?.status ?? 'candidate',
          turns: [...new Set([...(prev?.turns ?? []), ...turns])].sort((a, b) => a - b),
          createdAt: prev?.createdAt ?? nowIso,
          updatedAt: nowIso,
        }
        const ok = writeJsonFile(file, { updatedAt: nowIso, candidates })
        // 显式写入必须 fail-loud：失败就**不能说已落盘**（§5.9「返回 ok 不是证据」）
        if (!ok) return { path: '', name, note: '工具候选台账写入失败（' + file + '）——产物未落盘，检查路径权限后重试' }
        markWasted()
        return { path: file, name, note: buildToolCandidateNote({ tool: toolName, plugin: toolPlugin, turnsRequested: turns.length, existed }) }
      }

      // ── kind=guidance | workflow：写 SKILL.md ────────────────────────────────
      let root: string
      if (scope === 'user') {
        root = join(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills')
      } else {
        if (cwd === undefined) return { path: '', name, note: '无会话 cwd，无法写项目级技能（改用 scope=user）' }
        root = join(cwd, '.agents', 'skills')
      }
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      // kind 只在非缺省时写入 frontmatter ⇒ guidance 产物与扩充前**逐字节相同**（向后兼容硬约束）
      const kindLine = kind === 'guidance' ? '' : 'kind: ' + kind + '\n'
      const frontmatter = '---\nname: ' + name + '\ndescription: ' + description.replace(/\n/g, ' ') + '\n' + kindLine + '---\n\n'
      const path = join(dir, 'SKILL.md')
      writeFileSync(path, frontmatter + body + '\n', 'utf8')
      markWasted()
      // 工具引用校验（技能只提供指导、不提供工具）：正文引用的工具必须属于系统工具面
      const toolRefs = extractToolRefs(body)
      const unknownTools = toolRefs.filter((t) => !knownTools.has(t))
      const note = buildCommitNote(turns.length, unknownTools, kind)
      // 技能要点回流主记忆库（2026-09-06 第二批）：SKILL.md 已落盘，同时把技能索引进记忆——recall 技能名可命中。
      // memoryApi 可选（dsh-agent-memory 未挂载/失败静默跳过，SKILL.md 仍是权威存储）。
      try {
        const api = (ctx as unknown as { memoryApi?: { remember(input: { text: string; kind?: string; tags?: string[]; key?: string }): Promise<unknown> } }).memoryApi
        if (api !== undefined) {
          const text = '## 技能：' + name + '\n\n' + description + '\n\n摘要：' + body.trim().slice(0, 400)
          void api.remember({ text, kind: 'knowledge', tags: ['技能', name], key: 'skill-' + name }).catch(() => { /* 回流失败静默 */ })
        }
      } catch { /* 回流失败不阻塞技能提交 */ }
      return { path, name, note }
    },
  })

  // ---------- 工具 4：skill_tools（工具候选台账 · 2026-09-16 语义扩充）----------
  const toolsTool: ToolDefinition = defineTool({
    name: 'skill_tools',
    description: '工具候选台账（读 + 流转）：skill_commit(kind=tool) 的产物——「这个反复手写的脚本该固化成哪个插件工具」。不传 tool 列出全部候选（含状态计数）；只传 tool 看详情；传 tool + status/plugin/note 则流转该候选（candidate → forged/abandoned）。台账**跨会话累积**（<cwd>/.dsh/skill-forge-tools.json），不随会话结束蒸发。',
    parameters: {
      tool: { type: 'string', description: '工具名（不传=列全部）' },
      status: { type: 'string', enum: ['candidate', 'forged', 'abandoned'], description: '流转到的状态（须与 tool 同传）' },
      plugin: { type: 'string', description: '修正归属插件包名（须与 tool 同传）' },
      note: { type: 'string', description: '补充说明（追加到 why；须与 tool 同传）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (args, value) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header?.cwd
      if (cwd === undefined) return { text: '(无会话 cwd，读不到工具候选台账)' }
      const file = skillToolsPath(cwd)
      const reg = (readJsonFile(file) as { candidates?: Record<string, ToolCandidate> } | undefined) ?? {}
      const candidates = reg.candidates ?? {}
      const names = Object.keys(candidates).sort()
      const tool = (args.tool as string | undefined) ?? ''
      if (tool === '') {
        if (names.length === 0) {
          return { text: '(工具候选台账为空：' + file + ')\n——把「这个脚本该固化成工具」的轨迹用 skill_commit(kind=\'tool\', toolName=…, toolPlugin=…) 登记进来' }
        }
        const counts: Record<string, number> = { candidate: 0, forged: 0, abandoned: 0 }
        for (const n of names) {
          const c = candidates[n]
          if (c !== undefined) counts[c.status] = (counts[c.status] ?? 0) + 1
        }
        const lines = names.map((n) => {
          const c = candidates[n] as ToolCandidate
          return '• ' + c.tool + ' → ' + c.plugin + ' [' + c.status + '] turns=' + c.turns.length + ' · ' + c.why.slice(0, 70).replace(/\n/g, ' ')
        })
        return { text: '工具候选台账（' + names.length + '：candidate ' + (counts.candidate ?? 0) + ' / forged ' + (counts.forged ?? 0) + ' / abandoned ' + (counts.abandoned ?? 0) + '）\n' + lines.join('\n') + '\n\n台账文件：' + file }
      }
      const cur = candidates[tool]
      if (cur === undefined) return { text: '(无候选工具 \'' + tool + '\'；现有：' + (names.join(', ') || '无') + ')' }
      const wantStatus = args.status as ToolCandidate['status'] | undefined
      const wantPlugin = args.plugin as string | undefined
      const wantNote = args.note as string | undefined
      if (wantStatus === undefined && wantPlugin === undefined && wantNote === undefined) {
        return { text: JSON.stringify(cur, null, 1) + '\n\n台账文件：' + file }
      }
      const nowIso = new Date().toISOString()
      const next: ToolCandidate = {
        ...cur,
        status: wantStatus ?? cur.status,
        plugin: wantPlugin ?? cur.plugin,
        why: wantNote !== undefined ? (cur.why + '\n\n' + wantNote) : cur.why,
        updatedAt: nowIso,
      }
      candidates[tool] = next
      const ok = writeJsonFile(file, { updatedAt: nowIso, candidates })
      if (!ok) return { text: '台账写入失败（' + file + '）——状态未流转' }
      return { text: '已更新 ' + tool + ': status=' + next.status + ' plugin=' + next.plugin + '\n' + JSON.stringify(next, null, 1) }
    },
  })

  ctx.tools.register(signalsTool)
  ctx.tools.register(marksTool)
  ctx.tools.register(extractTool)
  ctx.tools.register(commitTool)
  ctx.tools.register(toolsTool)
  ctx.logger('dsh-agent-skill-forge').info('ready（skill_signals / skill_marks / skill_extract / skill_commit / skill_tools 已注册——被动形态，决策归爱丽丝）')
}
