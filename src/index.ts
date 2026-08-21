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
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'

export const name = 'agent-skill-forge'
export const inject = ['tools', 'agents'] as const

export interface Config {
  persistIndex: boolean
  /** 炼化通知开关：轨迹采集达到阈值时通知爱丽丝（信号送达，炼化决策归爱丽丝） */
  notifyEnabled: boolean
  /** 炼化通知阈值：每采集多少轮轨迹检查一次（缺省 100——价值驱动：有高价值轮才通知，不频繁打扰） */
  notifyAfterTurns: number
  /** 上下文候选阈值：某轮用户输入超过此字符数即标记为「上下文密集型」候选（联动蒸馏素材，Ctx2Skill 被动化）。 */
  ctxSignalChars: number
  /** 压缩前炼化提醒阈值：累计估算 token 超过此值即通知「先炼化再压缩」（单次压缩收益最大化，主人 08-17 定调；阈值 480k——主人实测压缩实际发生在 ~500k）。 */
  compactHintTokens: number
}

export const Config = z.object({
  persistIndex: z.boolean().default(true),
  ctxSignalChars: z.number().step(1).min(100).default(800),
  compactHintTokens: z.number().step(1).min(10000).default(480000),
  notifyEnabled: z.boolean().default(true),
  notifyAfterTurns: z.number().step(1).min(1).default(100),
})

/** 轨迹轮次索引（轻量：只记统计与边界，完整事件在会话日志） */
interface TurnIndex {
  turn: number
  startAt: string
  endAt: string | null
  eventCount: number
  toolCalls: number
  errors: number
  estTokens: number
  /** 上下文规模：该轮用户输入（user/message text）累计字符数——上下文密集型候选阈值。 */
  contextChars: number
  /** 废渣标记：该轮轨迹已被炼化（技能蒸馏完成）——信号/候选/通知全部排除（主人 2026-08-17 定调）。 */
  wasted?: boolean
}

/**
 * 压缩轨迹标记（主人 2026-08-17 定调：单次压缩收益最大化）：
 * 压缩触发（compaction/start）时——此刻上下文最全——按索引计算「炼化候选」（高价值 turn），
 * 打标记落盘；压缩完成（compaction/end）后通知爱丽丝（决策归爱丽丝：炼化什么/何时炼化）。
 * 与记忆插件的 checkpoint 通知互补（它管记忆，这里管技能）。
 */
interface CompactionMark {
  at: string
  compactionId?: string
  candidates: { turn: number; toolCalls: number; errors: number; contextChars: number; estTokens: number }[]
}

export function apply(ctx: Context, config: Config): void {
  console.log('[dsh-agent-skill-forge] apply', new Date().toISOString(), '(HMR probe)')

  const indexBySession = new Map<string, Map<number, TurnIndex>>()
  // 炼化通知状态：sessionId → 下次通知阈值
  const notifyState = new Map<string, { nextThreshold: number; notifiedCount: number }>()
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
      idx = { turn, startAt: new Date().toISOString(), endAt: null, eventCount: 0, toolCalls: 0, errors: 0, estTokens: 0, contextChars: 0 }
      byTurn.set(turn, idx)
    }
    idx.eventCount += 1
    if (ev.type === 'user/message') {
      const msg = (ev.data as { message?: Message }).message
      const text = msg !== undefined ? summarizeBlocks(msg) : ''
      idx.contextChars += text.length
    } else if (ev.type === 'turn/end') {
      idx.endAt = new Date().toISOString()
      if (config.persistIndex) persistIndex(session)
      maybeNotify(session, byTurn)
      maybeCompactHint(session, byTurn)
    } else if (ev.type === 'tool/call') {
      idx.toolCalls += 1
      const toolName = (ev.data as { name?: string }).name
      if (typeof toolName === 'string' && toolName.length > 0) knownTools.add(toolName)
    } else if (ev.type === 'tool/result') {
      if (ev.data.error !== undefined) idx.errors += 1
    } else if (ev.type === 'assistant/message') {
      const usage = ev.data.usage
      if (usage !== undefined) {
        idx.estTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      }
    } else if (ev.type === 'compaction/start') {
      // 压缩触发（此刻上下文最全）：计算炼化候选 → 打标记落盘（供压缩后炼化，单次压缩收益最大化）
      const byTurn2 = indexBySession.get(session.id)
      if (byTurn2 !== undefined && byTurn2.size > 0) {
        const candidates = [...byTurn2.entries()]
          .map(([turn, t]) => ({ turn, toolCalls: t.toolCalls, errors: t.errors, contextChars: t.contextChars, estTokens: t.estTokens, wasted: t.wasted ?? false }))
          .filter((x) => (x.toolCalls >= 3 || x.errors > 0 || x.contextChars >= config.ctxSignalChars) && !x.wasted)
          .sort((a, b) => (b.toolCalls + b.errors * 2) - (a.toolCalls + a.errors * 2))
          .slice(0, 10)
        const mark: CompactionMark = { at: new Date().toISOString(), compactionId: String((ev.data as { compactionId?: string }).compactionId ?? ''), candidates }
        marksBySession.set(session.id, mark)
        persistMarks(session, mark)
        console.log('[dsh-agent-skill-forge] 压缩标记', candidates.length + ' 候选 turn', session.id, new Date().toISOString())
      }
    }
  })

  function persistIndex(session: { id: string; header?: { cwd?: string } }): void {
    try {
      const cwd = session.header?.cwd
      if (cwd === undefined) return
      const byTurn = indexBySession.get(session.id)
      if (byTurn === undefined) return
      const dir = join(cwd, '.dsh')
      mkdirSync(dir, { recursive: true })
      const payload = {
        sessionId: session.id,
        updatedAt: new Date().toISOString(),
        turns: [...byTurn.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t),
        // 通知/提示状态一并落盘（重启不丢提醒节流——否则重启后可能重复提醒，主人 2026-08-21 强调）
        notify: notifyState.get(session.id) ?? null,
        hint: hintState.get(session.id) ?? null,
      }
      writeFileSync(join(dir, 'skill-forge-index.json'), JSON.stringify(payload, null, 2), 'utf8')
    } catch { /* 持久化失败静默 */ }
  }

  function persistMarks(session: { id: string; header?: { cwd?: string } }, mark: CompactionMark): void {
    try {
      const cwd = session.header?.cwd
      if (cwd === undefined) return
      const dir = join(cwd, '.dsh')
      mkdirSync(dir, { recursive: true })
      const payload = { sessionId: session.id, ...mark }
      writeFileSync(join(dir, 'skill-forge-marks.json'), JSON.stringify(payload, null, 2), 'utf8')
    } catch { /* 持久化失败静默 */ }
  }

  // 重启恢复：进程内索引/标记是内存态，web 重启即失——工具首次使用时从磁盘懒加载
  // （persistIndex 已落盘 <cwd>/.dsh/skill-forge-index.json 与 skill-forge-marks.json）
  function loadIndexFromDisk(session: { id: string; header?: { cwd?: string } }): Map<number, TurnIndex> | undefined {
    try {
      const cwd = session.header?.cwd
      if (cwd === undefined) return undefined
      const file = join(cwd, '.dsh', 'skill-forge-index.json')
      if (!existsSync(file)) return undefined
      const data = JSON.parse(readFileSync(file, 'utf8')) as {
        sessionId?: string
        turns?: TurnIndex[]
        notify?: { nextThreshold: number; notifiedCount: number }
        hint?: number
      }
      if (data.sessionId !== session.id) return undefined
      // 恢复通知/提示节流状态（重启不丢提醒时机——否则 nextThreshold 回退、可能重复提醒）
      if (data.notify !== undefined && data.notify !== null) {
        notifyState.set(session.id, data.notify)
      } else if ((data.turns?.length ?? 0) >= config.notifyAfterTurns) {
        // 旧文件兼容：无 notify 状态但已有大量轨迹——推进阈值防重启后立即重复提醒
        notifyState.set(session.id, { nextThreshold: (data.turns?.length ?? 0) + config.notifyAfterTurns, notifiedCount: 0 })
      }
      if (data.hint !== undefined && data.hint !== null) hintState.set(session.id, data.hint)
      const map = new Map<number, TurnIndex>()
      for (const t of data.turns ?? []) map.set(t.turn, t)
      return map
    } catch { return undefined }
  }

  function loadMarksFromDisk(session: { id: string; header?: { cwd?: string } }): CompactionMark | undefined {
    try {
      const cwd = session.header?.cwd
      if (cwd === undefined) return undefined
      const file = join(cwd, '.dsh', 'skill-forge-marks.json')
      if (!existsSync(file)) return undefined
      const data = JSON.parse(readFileSync(file, 'utf8')) as { sessionId?: string } & CompactionMark
      if (data.sessionId !== session.id) return undefined
      return { at: data.at, compactionId: data.compactionId, candidates: data.candidates }
    } catch { return undefined }
  }

  // 压缩前炼化提醒（主人 2026-08-17：单次压缩收益最大化——压缩前上下文最全，先炼化再压缩）
  // 感知：轨迹累计估算 token 接近压缩阈值 → 提醒「先炼化再压缩」；节流（每个阈值段一次）
  function maybeCompactHint(session: { id: string }, byTurn: Map<number, TurnIndex>): void {
    let total = 0
    for (const [, t] of byTurn) total += t.estTokens
    if (total < config.compactHintTokens) return
    const lastHinted = hintState.get(session.id) ?? 0
    if (lastHinted >= config.compactHintTokens && total - lastHinted < config.compactHintTokens * 0.3) return // 节流：同段不重复
    const agent = ctx.agents?.get(session.id as never)
    if (agent !== undefined) {
      // 计算当前候选数（供提示）
      const candidates = [...byTurn.entries()].filter(([, t]) => (t.toolCalls >= 3 || t.errors > 0 || t.contextChars >= config.ctxSignalChars) && !t.wasted).length
      const text = '[skill-forge] 上下文压力高（估算 ~' + Math.round(total / 1000) + 'k tokens）——压缩前建议先炼化：压缩前上下文最全，单次压缩收益最大化。skill_marks 查候选（当前 ' + candidates + ' 个），skill_extract 提取联动视图，skill_commit 写入 SKILL.md；炼化完再压缩。'
      try {
        agent.send(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-agent-skill-forge' } }),
          'next-turn',
          true,
        )
      } catch { /* 通知失败静默 */ }
    }
    hintState.set(session.id, total)
  }

  // 炼化通知：轨迹达到阈值 → 信号送达（wakeup=true 到达即送达；炼化决策归爱丽丝）
  // 价值驱动（主人 2026-08-21：通知太频繁/时机不对）：本批必须含高价值轮
  // （报错/复杂工具链/大上下文）才通知——纯闲聊轮不打扰；无价值也推进阈值防反复检查
  function maybeNotify(session: { id: string }, byTurn: Map<number, TurnIndex>): void {
    if (!config.notifyEnabled) return
    const state = notifyState.get(session.id) ?? { nextThreshold: config.notifyAfterTurns, notifiedCount: 0 }
    if (byTurn.size < state.nextThreshold) return
    let hasValue = false
    for (const [, t] of byTurn) {
      if (t.errors > 0 || t.toolCalls >= 5 || t.contextChars >= config.ctxSignalChars) {
        hasValue = true
        break
      }
    }
    if (!hasValue) {
      state.nextThreshold = byTurn.size + config.notifyAfterTurns
      notifyState.set(session.id, state)
      return
    }
    const agent = ctx.agents?.get(session.id as never) // SessionId branded type 断言
    if (agent !== undefined) {
      let errorTurns = 0
      for (const [, t] of byTurn) if (t.errors > 0) errorTurns += 1
      const text = '[skill-forge] 已采集 ' + byTurn.size + ' 轮轨迹（含 ' + errorTurns + ' 轮报错）——有高价值轮可炼化（蒸馏技能）。是否炼化、炼化哪些由爱丽丝决定：skill_signals 查看候选，skill_extract 提取，skill_commit 写入。'
      try {
        agent.send(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-agent-skill-forge' } }),
          'next-turn',
          true, // wakeup=true：到达即送达（不打断当前思维；忙则排队）
        )
      } catch { /* 通知失败静默（轨迹索引仍在，可随时查） */ }
    }
    state.nextThreshold = byTurn.size + config.notifyAfterTurns
    state.notifiedCount += 1
    notifyState.set(session.id, state)
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
      render: (args, value) => [{ type: 'text', text: '轨迹信号 ' + value.turns.length + ' 轮（共 ' + value.stats.totalTurns + '）——蒸馏决策归爱丽丝' }],
    },
    async execute(args, exec) {
      const { byTurn } = turnsOf(exec)
      const limit = (args.limit as number | undefined) ?? 20
      const turns = [...byTurn.entries()].sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, t]) => ({
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
      for (const [, t] of byTurn) {
        totalTokens += t.estTokens
        if (t.errors > 0) turnsWithErrors += 1
      }
      return {
        turns,
        stats: { totalTurns: byTurn.size, totalTokens, turnsWithErrors },
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
              },
            },
            required: true,
          },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: '压缩标记 @' + value.at + '：' + value.candidates.length + ' 个炼化候选' }],
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
      render: (args, value) => [{ type: 'text', text: '轨迹 ' + value.turnCount + ' 轮 / ' + value.eventCount + ' 事件 / ' + value.segments.length + ' 段' }],
    },
    async execute(args, exec) {
      const { session, byTurn } = turnsOf(exec)
      if (session === undefined) return { segments: [], turnCount: 0, eventCount: 0, note: '无可用会话' }
      const start = args.startTurn as number
      const end = (args.endTurn as number | undefined) ?? start
      const maxChars = (args.maxChars as number | undefined) ?? 20000
      const linkContext = (args.linkContext as boolean | undefined) ?? true
      // 联动视图：先聚合上下文特征段（该范围所有用户输入）
      let contextChars = 0
      const ctxLines: string[] = []
      const lines: string[] = []
      let eventCount = 0
      // 全量事件流提取（append-only 日志保留原始事件）：压缩只替换 surface 表层，
      // 原始事件仍在 session.events 里——压缩标记的候选 turn 压缩后仍可提取
      // （原实现只遍历 surface.nodes，压缩后旧 turn 被替换出表层 → 提取失效，2026-08-21 修复）
      const events = session.events as unknown as readonly {
        type?: string
        data?: {
          turn?: number
          message?: Message
          name?: string
          arguments?: string
          error?: unknown
        }
      }[]
      for (let i = 0; i < events.length; i++) {
        const event = events[i]
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
      const segments: string[] = []
      let current = ''
      for (const line of allLines) {
        if (current.length + line.length + 1 > maxChars) {
          segments.push(current)
          current = line
        } else {
          current = current.length === 0 ? line : current + '\n' + line
        }
      }
      if (current.length > 0) segments.push(current)
      return {
        segments,
        turnCount: end - start + 1,
        eventCount,
        contextChars,
        note: '联动视图：上下文特征（触发条件）在前，应对轨迹在后——蒸馏「上下文特征 → 应对策略」条件化技能；成败判断归爱丽丝',
      }
    },
  })

  // ---------- 工具 3：skill_commit ----------
  const commitTool: ToolDefinition = defineTool({
    name: 'skill_commit',
    description: '写入技能（可写）：把蒸馏出的技能保存为 SKILL.md（YAML frontmatter + 正文）——默认写用户级 ~/.agents/skills/<name>/SKILL.md（跨项目可加载），scope=project 写 <cwd>/.agents/skills/。纪律：技能只提供指导（决策/流程/规避），不提供工具——工具引用限于系统工具面（提交时自动校验，幻觉工具会警告）。',
    parameters: {
      name: { type: 'string', required: true, description: '技能名（小写 kebab-case，如 alpha-refine）' },
      description: { type: 'string', required: true, description: '一句话描述（frontmatter description；技能目录显示用）' },
      body: { type: 'string', required: true, description: '技能正文（Markdown；条件化行为规则——在什么状态下做什么/规避什么）' },
      scope: { type: 'string', enum: ['user', 'project'], description: '写入范围（缺省 user=~/.agents/skills）' },
      turns: { type: 'array', items: { type: 'number' }, description: '本次炼化覆盖的 turn 列表（可选）——提交后这些轨迹标记为废渣，信号/候选不再重复提示' },
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
      render: (args, value) => [{ type: 'text', text: '技能已写入 ' + value.path }],
    },
    async execute(args, exec) {
      const name = (args.name as string | undefined) ?? ''
      const description = (args.description as string | undefined) ?? ''
      const body = (args.body as string | undefined) ?? ''
      const scope = (args.scope as 'user' | 'project' | undefined) ?? 'user'
      if (name.length === 0 || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return { path: '', name, note: '技能名必须为小写 kebab-case（如 alpha-refine）' }
      if (description.length === 0 || body.length === 0) return { path: '', name, note: 'description 与 body 不能为空' }
      let root: string
      if (scope === 'user') {
        root = join(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills')
      } else {
        const cwd = exec.agent?.session.header?.cwd
        if (cwd === undefined) return { path: '', name, note: '无会话 cwd，无法写项目级技能（改用 scope=user）' }
        root = join(cwd, '.agents', 'skills')
      }
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      const frontmatter = '---\nname: ' + name + '\ndescription: ' + description.replace(/\n/g, ' ') + '\n---\n\n'
      const path = join(dir, 'SKILL.md')
      writeFileSync(path, frontmatter + body + '\n', 'utf8')
      // 废渣标记：本次炼化覆盖的 turn → wasted（信号/候选不再重复提示）
      const turns = (args.turns as number[] | undefined) ?? []
      const byTurn = exec.agent?.session === undefined ? undefined : indexBySession.get(exec.agent.session.id)
      if (byTurn !== undefined && turns.length > 0) {
        let marked = 0
        for (const t of turns) {
          const idx = byTurn.get(t)
          if (idx !== undefined && !idx.wasted) {
            idx.wasted = true
            marked += 1
          }
        }
        if (marked > 0 && exec.agent?.session !== undefined) persistIndex(exec.agent.session)
      }
      // 工具引用校验（技能只提供指导、不提供工具）：正文引用的工具必须属于系统工具面
      const toolRefs = extractToolRefs(body)
      const unknownTools = toolRefs.filter((t) => !knownTools.has(t))
      let note = 'SKILL.md 已写入；新会话技能目录自动发现（dsh-skill-filesystem）。已炼化轨迹 ' + turns.length + ' 轮标记为废渣，不再重复提示'
      if (unknownTools.length > 0) {
        note += '。\n⚠ 工具引用校验：以下工具不在已知工具面，可能是幻觉工具（技能只提供指导，不提供工具）：' + unknownTools.join(', ')
      }
      return { path, name, note }
    },
  })

  ctx.tools.register(signalsTool)
  ctx.tools.register(marksTool)
  ctx.tools.register(extractTool)
  ctx.tools.register(commitTool)
  ctx.logger('dsh-agent-skill-forge').info('ready（skill_signals / skill_marks / skill_extract / skill_commit 已注册——被动形态，决策归爱丽丝）')
}

/** 消息内容摘要（text 块拼接截断） */
function summarizeBlocks(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-result') parts.push('[tool-result ' + String((block as { content?: unknown[] }).content?.length ?? 0) + ' blocks]')
    else parts.push('[' + block.type + ']')
  }
  return parts.join('\n')
}

/**
 * 提取文本中的工具引用：反引号内标识符 + 「工具：xxx」模式。
 * 技能只提供指导、不提供工具（SkillForge 约束版定义）——引用的工具必须是系统工具面已有能力。
 */
function extractToolRefs(text: string): string[] {
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

function truncate(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n) + '…'
}
