/**
 * aggregate.ts 单测（聚合纯函数：轮次索引 / 候选排序 / 视图构建 / 分段 / 提取视图）
 *
 * 纪律：常数取自源码真源（ctxSignalChars 默认 800、候选 TOP 10、候选工具链门 3 次），不臆造。
 * 覆盖：主路径（含真实排序与 slice 上限）、退化路径（空输入 / 脏数据字段缺失 / 反向 turn 范围
 * 一律不抛且行为保守）、分段边界（恰好等于预算 = 合并，超出 = 切分）。
 *
 * 运行：`node --test tests/aggregate.test.mjs`（先 `npm run build` 产出 lib/）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExtractView,
  buildSignalsView,
  countCandidateTurns,
  createTurnIndex,
  maxTurn,
  segmentLines,
  selectCompactionCandidates,
} from '../lib/aggregate.js'

const CTX = 800 // 源码真源：ctxSignalChars 默认值

/** 构造轮次索引（缺省字段与 createTurnIndex 一致） */
function turn(over) {
  return {
    turn: 1,
    startAt: 'T',
    endAt: null,
    eventCount: 0,
    toolCalls: 0,
    errors: 0,
    estTokens: 0,
    contextChars: 0,
    ...over,
  }
}

// ---------- 轮次索引 ----------

test('主路径：createTurnIndex 字段与提取前逐字一致（steps/wasted 不落空键）', () => {
  const idx = createTurnIndex(7, '2026-09-14T00:00:00.000Z')
  // deepEqual（strict）比对自有键集合：steps / wasted 必须「不存在」而非 undefined
  assert.deepEqual(idx, {
    turn: 7,
    startAt: '2026-09-14T00:00:00.000Z',
    endAt: null,
    eventCount: 0,
    toolCalls: 0,
    errors: 0,
    estTokens: 0,
    contextChars: 0,
  })
  assert.equal(idx.steps, undefined)
  assert.equal(idx.wasted, undefined)
})

test('主路径：maxTurn 取最大 turn', () => {
  assert.equal(maxTurn([3, 1, 7, 2]), 7)
})

test('退化：maxTurn 空输入不抛且返回 0（压缩段起点语义）', () => {
  assert.equal(maxTurn([]), 0)
  assert.equal(maxTurn(new Map().keys()), 0)
})

test('边界保守：maxTurn 全为非正 turn 返回 0（不是 Math.max 的负数）', () => {
  assert.equal(maxTurn([-5, -1, 0]), 0)
})

// ---------- 候选计数 / 候选排序 ----------

test('主路径：countCandidateTurns 命中三类门（工具链 3 / 报错 / 大上下文）并排除废渣', () => {
  const turns = [
    { toolCalls: 3, errors: 0, contextChars: 0 },
    { toolCalls: 2, errors: 0, contextChars: 0 },
    { toolCalls: 0, errors: 1, contextChars: 0 },
    { toolCalls: 0, errors: 0, contextChars: CTX },
    { toolCalls: 9, errors: 9, contextChars: 9999, wasted: true },
  ]
  assert.equal(countCandidateTurns(turns, CTX), 3)
})

test('退化：countCandidateTurns 空输入不抛返回 0；脏数据轮不抛且不计入', () => {
  assert.equal(countCandidateTurns([], CTX), 0)
  assert.equal(countCandidateTurns([{}], CTX), 0)
})

test('主路径：候选按「工具调用 + 报错×2」降序，废渣与未达门者被排除', () => {
  const entries = new Map([
    [1, turn({ turn: 1, toolCalls: 3 })],
    [2, turn({ turn: 2, errors: 1 })],
    [3, turn({ turn: 3, toolCalls: 2, contextChars: CTX })],
    [4, turn({ turn: 4, toolCalls: 2, contextChars: CTX - 1 })],
    [5, turn({ turn: 5, toolCalls: 5, wasted: true })],
    [6, turn({ turn: 6, toolCalls: 5 })],
  ])
  const got = selectCompactionCandidates(entries.entries(), CTX)
  assert.deepEqual(got.map((c) => c.turn), [6, 1, 2, 3])
  assert.deepEqual(got[1], { turn: 1, toolCalls: 3, errors: 0, contextChars: 0, estTokens: 0, wasted: false })
})

test('边界：候选上限 TOP 10（超出部分截断）', () => {
  const many = new Map(Array.from({ length: 15 }, (_, i) => [i, turn({ turn: i, toolCalls: 20 })]))
  const got = selectCompactionCandidates(many.entries(), CTX)
  assert.equal(got.length, 10)
})

test('退化：候选空输入不抛返回空表；脏数据轮（字段缺失）不抛且被保守排除', () => {
  assert.deepEqual(selectCompactionCandidates(new Map().entries(), CTX), [])
  assert.deepEqual(selectCompactionCandidates(new Map([[1, {}]]).entries(), CTX), [])
})

// ---------- skill_signals 视图 ----------

test('主路径：信号视图按 turn 降序，进行中轮 endAt 落空串，统计覆盖全量', () => {
  const entries = new Map([
    [1, turn({ turn: 1, startAt: 'A', endAt: 'B', eventCount: 10, toolCalls: 2, errors: 0, estTokens: 100 })],
    [2, turn({ turn: 2, startAt: 'C', endAt: 'D', eventCount: 20, toolCalls: 5, errors: 1, estTokens: 300 })],
    [3, turn({ turn: 3, startAt: 'E', eventCount: 30, toolCalls: 1, errors: 0, estTokens: 50, wasted: true })],
  ])
  const view = buildSignalsView(entries.entries(), 20)
  assert.deepEqual(view.turns.map((t) => t.turn), [3, 2, 1])
  assert.equal(view.turns[0].endAt, '')
  assert.equal(view.turns[0].wasted, true)
  assert.equal(view.turns[1].wasted, false)
  assert.deepEqual(view.stats, { totalTurns: 3, totalTokens: 450, turnsWithErrors: 1 })
})

test('边界：limit 只截断展示，统计仍覆盖全量；limit=0 返回空列表但统计完整', () => {
  const entries = new Map([
    [1, turn({ turn: 1, estTokens: 100 })],
    [2, turn({ turn: 2, estTokens: 300 })],
  ])
  const one = buildSignalsView(entries.entries(), 1)
  assert.equal(one.turns.length, 1)
  assert.deepEqual(one.stats, { totalTurns: 2, totalTokens: 400, turnsWithErrors: 0 })
  const none = buildSignalsView(entries.entries(), 0)
  assert.deepEqual(none.turns, [])
  assert.deepEqual(none.stats, { totalTurns: 2, totalTokens: 400, turnsWithErrors: 0 })
})

test('退化：信号视图空输入不抛（零统计）', () => {
  assert.deepEqual(buildSignalsView(new Map().entries(), 20), {
    turns: [],
    stats: { totalTurns: 0, totalTokens: 0, turnsWithErrors: 0 },
  })
})

test('脏数据：estTokens 缺失不抛（token 统计为 NaN，轮数与报错数仍正确）', () => {
  const view = buildSignalsView(new Map([[1, { turn: 1, startAt: 'A', errors: 2 }]]).entries(), 20)
  assert.equal(view.stats.totalTurns, 1)
  assert.equal(view.stats.turnsWithErrors, 1)
  assert.ok(Number.isNaN(view.stats.totalTokens))
  assert.equal(view.turns[0].endAt, '')
})

// ---------- 分段 ----------

test('主路径：分段在预算内合并为一段', () => {
  assert.deepEqual(segmentLines(['aa', 'bb', 'cc'], 10), ['aa\nbb\ncc'])
})

test('边界：恰好等于预算仍合并（> 才切分）', () => {
  assert.deepEqual(segmentLines(['aa', 'bb'], 5), ['aa\nbb'])
  assert.deepEqual(segmentLines(['aaaa', 'bb'], 5), ['aaaa', 'bb'])
})

test('退化：分段空输入不抛返回空表', () => {
  assert.deepEqual(segmentLines([], 10), [])
  assert.deepEqual(segmentLines([], 0), [])
})

test('退化：单行超预算 → 推入空段后独立成段（与提取前一致）', () => {
  assert.deepEqual(segmentLines(['xxxxxxxxxx'], 5), ['', 'xxxxxxxxxx'])
})

test('退化：maxChars=0 不抛（每行自成一格，末尾非空段保留）', () => {
  assert.deepEqual(segmentLines(['a', 'b'], 0), ['', 'a', 'b'])
})

// ---------- skill_extract 联动视图 ----------

const userEvent = (turnNo, text) => ({ type: 'user/message', data: { turn: turnNo, message: { content: [{ type: 'text', text }] } } })

const SAMPLE_EVENTS = [
  userEvent(5, '分析这个插件'),
  { type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'text', text: '好的' }] } } },
  { type: 'tool/call', data: { turn: 5, name: 'read', arguments: '{"file_path":"a"}' } },
  { type: 'tool/result', data: { turn: 5, message: { content: [{ type: 'text', text: 'OK' }] } } },
  { type: 'tool/result', data: { turn: 5, error: 'boom', message: { content: [{ type: 'text', text: 'ERR' }] } } },
  userEvent(4, '范围外'),
  undefined,
]

test('主路径：联动视图——上下文特征在前、应对轨迹在后，仅统计范围内的 turn', () => {
  const view = buildExtractView({ events: SAMPLE_EVENTS, start: 5, end: 5, maxChars: 20000, linkContext: true })
  assert.equal(view.turnCount, 1)
  assert.equal(view.eventCount, 5)
  assert.equal(view.contextChars, 6) // 「分析这个插件」
  assert.equal(view.segments.length, 1)
  const seg = view.segments[0]
  assert.ok(seg.startsWith('[上下文特征] 分析这个插件\n--- 应对轨迹 ---\n[assistant] 好的'))
  assert.ok(seg.includes('[tool-call] read({"file_path":"a"})'))
  assert.ok(seg.includes('[tool-result] OK'))
  assert.ok(seg.includes('[tool-result ERROR] ERR'))
})

test('主路径：linkContext=false 只出应对轨迹，但 contextChars 仍统计', () => {
  const view = buildExtractView({ events: SAMPLE_EVENTS, start: 5, end: 5, maxChars: 20000, linkContext: false })
  assert.equal(view.contextChars, 6)
  assert.ok(!view.segments[0].includes('[上下文特征]'))
  assert.ok(!view.segments[0].includes('--- 应对轨迹 ---'))
  assert.ok(view.segments[0].startsWith('[assistant] 好的'))
})

test('主路径：多段切分后非空段以换行拼接可无损还原', () => {
  const full = buildExtractView({ events: SAMPLE_EVENTS, start: 5, end: 5, maxChars: 20000, linkContext: true })
  const split = buildExtractView({ events: SAMPLE_EVENTS, start: 5, end: 5, maxChars: 10, linkContext: true })
  assert.ok(split.segments.length > 1)
  assert.equal(split.segments.filter((s) => s.length > 0).join('\n'), full.segments[0])
})

test('退化：空事件流不抛（空段 + 计数归零）', () => {
  assert.deepEqual(
    buildExtractView({ events: [], start: 1, end: 1, maxChars: 100, linkContext: true }),
    { segments: [], turnCount: 1, eventCount: 0, contextChars: 0 },
  )
})

test('退化保守：反向 turn 范围（end < start）不抛——turnCount 保持原算式', () => {
  assert.deepEqual(
    buildExtractView({ events: SAMPLE_EVENTS, start: 9, end: 5, maxChars: 100, linkContext: true }),
    { segments: [], turnCount: -3, eventCount: 0, contextChars: 0 },
  )
})

test('脏数据：事件缺 data / tool-call 缺 name 均不抛，占位符与提取前一致', () => {
  const noData = buildExtractView({ events: [{ type: 'user/message' }], start: 1, end: 9, maxChars: 100, linkContext: true })
  assert.equal(noData.eventCount, 0)
  assert.deepEqual(noData.segments, [])
  const noName = buildExtractView({ events: [{ type: 'tool/call', data: { turn: 2 } }], start: 2, end: 2, maxChars: 100, linkContext: false })
  assert.deepEqual(noName.segments, ['[tool-call] ?()'])
  assert.equal(noName.eventCount, 1)
})

test('脏数据：user/message 缺 message 不抛（上下文长度计 0，特征段仍以空前缀落段）', () => {
  const view = buildExtractView({ events: [{ type: 'user/message', data: { turn: 3 } }], start: 3, end: 3, maxChars: 100, linkContext: true })
  assert.equal(view.contextChars, 0)
  assert.deepEqual(view.segments, ['[上下文特征] \n--- 应对轨迹 ---'])
  assert.equal(view.eventCount, 1)
})
