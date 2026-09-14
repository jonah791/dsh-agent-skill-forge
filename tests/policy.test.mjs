/**
 * policy.ts 单测（决策纯函数：阈值 / 冷却节流 / 状态迁移 / 输入校验）
 *
 * 纪律：常数取自源码真源（Config 默认值 notifyAfterSteps=200 / notifyAfterTools=200 /
 * ctxSignalChars=800 / compactHintTokens=300000），不臆造。
 * 覆盖：主路径（边界=阈值即触发）、退化路径（空输入/关闭开关/脏数据一律不抛且保守）、
 * 真实事故样本（阈值 342 vs 实际 153 的膨胀修复）。
 *
 * 运行：`node --test tests/policy.test.mjs`（先 `npm run build` 产出 lib/）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceNotifyState,
  decideCompactHint,
  decideNotify,
  defaultNotifyState,
  isCandidateTurn,
  isHighValueTurn,
  migrateNotifyState,
  validateSkillCommit,
  SKILL_BODY_NOTE,
  SKILL_NAME_NOTE,
} from '../lib/policy.js'

/** 源码真源常数（index.ts Config schema 默认值） */
const CFG = { notifyAfterSteps: 200, notifyAfterTools: 200, ctxSignalChars: 800 }
const HINT_TOKENS = 300000

// ---------- 炼化通知：主路径与阈值边界 ----------

test('主路径：步数轨恰好达 200 即触发通知（边界=阈值即触发，非「超过」）', () => {
  const turns = [{ steps: 200, toolCalls: 5, errors: 0, contextChars: 0 }]
  const d = decideNotify({ enabled: true, turns, state: defaultNotifyState(CFG), cfg: CFG })
  assert.equal(d.action, 'notify')
  assert.equal(d.totalSteps, 200)
  assert.equal(d.totalTools, 5)
  assert.equal(d.errorTurns, 0)
  assert.equal(d.turnCount, 1)
})

test('主路径：工具轨恰好达 200 即触发（复合触发——任一轨达标即检查）', () => {
  const turns = [{ steps: 0, toolCalls: 200, errors: 0, contextChars: 0 }]
  const d = decideNotify({ enabled: true, turns, state: defaultNotifyState(CFG), cfg: CFG })
  assert.equal(d.action, 'notify')
  assert.equal(d.totalSteps, 0)
  assert.equal(d.totalTools, 200)
})

test('主路径：多轮累计（steps 按 0 兜底缺字段，toolCalls 累加）', () => {
  const turns = [
    { steps: 100, toolCalls: 150, errors: 1, contextChars: 0 },
    { toolCalls: 60, errors: 0, contextChars: 0 },
  ]
  const d = decideNotify({ enabled: true, turns, state: defaultNotifyState(CFG), cfg: CFG })
  assert.equal(d.action, 'notify')
  assert.equal(d.totalSteps, 100)
  assert.equal(d.totalTools, 210)
  assert.equal(d.errorTurns, 1)
  assert.equal(d.turnCount, 2)
})

test('边界保守：199 步 + 199 工具调用不触发（差一步即不检查，不抛）', () => {
  const turns = [{ steps: 199, toolCalls: 199, errors: 0, contextChars: 799 }]
  const d = decideNotify({ enabled: true, turns, state: defaultNotifyState(CFG), cfg: CFG })
  assert.equal(d.action, 'skip')
})

test('退化：空轨迹不抛且不触发（保守早退）', () => {
  assert.equal(decideNotify({ enabled: true, turns: [], state: defaultNotifyState(CFG), cfg: CFG }).action, 'skip')
})

test('退化：通知关闭时阈值远超也不触发（开关早退优先于任何计算）', () => {
  const turns = [{ steps: 999999, toolCalls: 999999, errors: 3, contextChars: 99999 }]
  const d = decideNotify({ enabled: false, turns, state: defaultNotifyState(CFG), cfg: CFG })
  assert.equal(d.action, 'skip')
})

test('静默推进：达阈值但无高价值轮 → silent（双轨按累计重算，notifiedCount 不变）', () => {
  // 真实常数差异：工具链 3 次是「候选」级，5 次才是「高价值」级 → 本批不打扰
  const turns = Array.from({ length: 100 }, () => ({ steps: 2, toolCalls: 3, errors: 0, contextChars: 100 }))
  const d = decideNotify({ enabled: true, turns, state: defaultNotifyState(CFG), cfg: CFG })
  assert.equal(d.action, 'silent')
  assert.deepEqual(d.silentState, { nextStepThreshold: 400, nextToolThreshold: 500, notifiedCount: 0 })
})

test('脏数据：轮字段全缺失不抛（累计 NaN → 保守不通知，不误报）', () => {
  const d = decideNotify({ enabled: true, turns: [{}], state: defaultNotifyState(CFG), cfg: CFG })
  assert.equal(d.action, 'silent')
  assert.equal(d.silentState.nextStepThreshold, 200)
  assert.ok(Number.isNaN(d.silentState.nextToolThreshold))
})

// ---------- 价值门 / 候选门 ----------

test('边界：工具调用恰好 5 算高价值轮，4 不算（通知价值门）', () => {
  assert.equal(isHighValueTurn({ toolCalls: 5, errors: 0, contextChars: 0 }, CFG.ctxSignalChars), true)
  assert.equal(isHighValueTurn({ toolCalls: 4, errors: 0, contextChars: 0 }, CFG.ctxSignalChars), false)
})

test('边界：候选门为 3 次工具调用（低于高价值门 5），报错轮无条件入选', () => {
  assert.equal(isCandidateTurn({ toolCalls: 3, errors: 0, contextChars: 0 }, CFG.ctxSignalChars), true)
  assert.equal(isCandidateTurn({ toolCalls: 2, errors: 0, contextChars: 0 }, CFG.ctxSignalChars), false)
  assert.equal(isCandidateTurn({ toolCalls: 0, errors: 1, contextChars: 0 }, CFG.ctxSignalChars), true)
})

test('边界：contextChars 恰好 800 即入选，799 不入选；wasted 一律排除', () => {
  assert.equal(isCandidateTurn({ toolCalls: 0, errors: 0, contextChars: 800 }, CFG.ctxSignalChars), true)
  assert.equal(isCandidateTurn({ toolCalls: 0, errors: 0, contextChars: 799 }, CFG.ctxSignalChars), false)
  assert.equal(isHighValueTurn({ toolCalls: 0, errors: 0, contextChars: 800 }, CFG.ctxSignalChars), true)
  assert.equal(isCandidateTurn({ toolCalls: 9, errors: 9, contextChars: 9999, wasted: true }, CFG.ctxSignalChars), false)
})

// ---------- 状态推进 ----------

test('状态推进：counted=true 记一次通知，false 只推阈值（notifiedCount 不变）', () => {
  const state = { nextStepThreshold: 200, nextToolThreshold: 200, notifiedCount: 3 }
  assert.deepEqual(advanceNotifyState(state, 340, 512, CFG, true), { nextStepThreshold: 540, nextToolThreshold: 712, notifiedCount: 4 })
  assert.deepEqual(advanceNotifyState(state, 340, 512, CFG, false), { nextStepThreshold: 540, nextToolThreshold: 712, notifiedCount: 3 })
  // 原状态不被改写（纯函数）
  assert.deepEqual(state, { nextStepThreshold: 200, nextToolThreshold: 200, notifiedCount: 3 })
})

// ---------- 重启迁移（真实事故样本） ----------

test('迁移：已有阈值记录一律沿用——真实事故样本（阈值 342 不得被推到 153+200）', () => {
  // AGENTS.md §5.12 事故现场：notifiedCount=0、阈值 342、实际 steps 153（每次重启重算 → 永不触发）
  const turns = [{ steps: 153, toolCalls: 40, errors: 0, contextChars: 0 }]
  const notify = { nextStepThreshold: 342, nextToolThreshold: 500, notifiedCount: 7 }
  assert.deepEqual(migrateNotifyState(turns, notify, CFG), { nextStepThreshold: 342, nextToolThreshold: 500, notifiedCount: 7 })
})

test('迁移：旧文件无 notify 记录 → 按磁盘累计 + 配置初始化（首次迁移）', () => {
  const turns = [{ steps: 153, toolCalls: 40 }]
  assert.deepEqual(migrateNotifyState(turns, null, CFG), { nextStepThreshold: 353, nextToolThreshold: 240, notifiedCount: 0 })
})

test('迁移：半迁移文件（有步数阈值缺工具阈值）→ 工具轨按磁盘累计兜底', () => {
  assert.deepEqual(
    migrateNotifyState([{ steps: 50, toolCalls: 10 }], { nextStepThreshold: 250 }, CFG),
    { nextStepThreshold: 250, nextToolThreshold: 210, notifiedCount: 0 },
  )
})

test('迁移脏数据不抛：notify 非对象/阈值非法/计数非数字 一律走首次分支', () => {
  for (const bad of ['garbage', 5, {}, { nextStepThreshold: 0 }, { nextStepThreshold: 'x' }, [], true]) {
    assert.deepEqual(
      migrateNotifyState(undefined, bad, CFG),
      { nextStepThreshold: 200, nextToolThreshold: 200, notifiedCount: 0 },
    )
  }
})

test('迁移脏数据不抛：阈值合法但工具阈值/通知计数非法 → 逐字段回退', () => {
  assert.deepEqual(
    migrateNotifyState([], { nextStepThreshold: 300, nextToolThreshold: -5, notifiedCount: 'x' }, CFG),
    { nextStepThreshold: 300, nextToolThreshold: 200, notifiedCount: 0 },
  )
})

test('迁移退化：turns 缺失（undefined）按空索引处理，不抛', () => {
  assert.deepEqual(migrateNotifyState(undefined, { nextStepThreshold: 900 }, CFG), { nextStepThreshold: 900, nextToolThreshold: 200, notifiedCount: 0 })
})

// ---------- 压缩前提醒：阈值 + 节流 ----------

test('主路径：上下文压力恰好 300k 即提醒（边界=阈值即触发）', () => {
  const d = decideCompactHint({ total: HINT_TOKENS, lastHinted: 0, threshold: HINT_TOKENS })
  assert.equal(d.action, 'hint')
  assert.equal(d.hintValue, HINT_TOKENS)
})

test('边界保守：299999 不提醒（差 1 token 不打扰）', () => {
  assert.equal(decideCompactHint({ total: 299999, lastHinted: 0, threshold: HINT_TOKENS }).action, 'skip')
})

test('节流：同段重复提醒被吞（增量 < 阈值 30% 即跳过）', () => {
  assert.equal(decideCompactHint({ total: 389999, lastHinted: 300000, threshold: HINT_TOKENS }).action, 'skip')
})

test('节流边界：增量恰好 30%（90000）即再次提醒', () => {
  const d = decideCompactHint({ total: 390000, lastHinted: 300000, threshold: HINT_TOKENS })
  assert.equal(d.action, 'hint')
  assert.equal(d.hintValue, 390000)
})

test('退化：上下文压力 0（压缩后清零）不提醒，不抛', () => {
  assert.equal(decideCompactHint({ total: 0, lastHinted: 0, threshold: HINT_TOKENS }).action, 'skip')
})

test('脏数据不抛：lastHinted 为 NaN → 不走节流（保守=仍提醒，与提取前一致）', () => {
  const d = decideCompactHint({ total: 400000, lastHinted: Number.NaN, threshold: HINT_TOKENS })
  assert.equal(d.action, 'hint')
  assert.equal(d.hintValue, 400000)
})

test('脏数据不抛：total 为 NaN → 判定确定（NaN < 阈值 恒 false → 走提醒分支）', () => {
  const d = decideCompactHint({ total: Number.NaN, lastHinted: 0, threshold: HINT_TOKENS })
  assert.equal(d.action, 'hint')
  assert.ok(Number.isNaN(d.hintValue))
})

// ---------- skill_commit 输入校验 ----------

test('校验主路径：kebab-case 名称 + 非空正文 → 通过', () => {
  assert.deepEqual(validateSkillCommit({ name: 'alpha-refine', description: '一句话', body: '正文' }), { ok: true })
})

test('校验边界：单字符名 / 数字开头 / 尾连字符 均合法（形态与小写 kebab-case 一致）', () => {
  for (const name of ['a', '1a', 'a-', 'a1-b2']) {
    assert.deepEqual(validateSkillCommit({ name, description: 'd', body: 'b' }), { ok: true }, `name=${name} 应合法`)
  }
})

test('校验失败：大写开头 / 前导连字符 / 下划线 / 空名 → 名称规范文案', () => {
  for (const name of ['Alpha', '-a', 'a_b', '', '中文名', 'a b']) {
    assert.deepEqual(validateSkillCommit({ name, description: 'd', body: 'b' }), { ok: false, note: SKILL_NAME_NOTE }, `name=${name} 应被拒`)
  }
})

test('校验失败：名称合法但 description / body 为空 → 正文文案', () => {
  assert.deepEqual(validateSkillCommit({ name: 'ok-name', description: '', body: 'b' }), { ok: false, note: SKILL_BODY_NOTE })
  assert.deepEqual(validateSkillCommit({ name: 'ok-name', description: 'd', body: '' }), { ok: false, note: SKILL_BODY_NOTE })
})

test('校验早退顺序：名称不合规优先于正文为空（与提取前一致）', () => {
  assert.deepEqual(validateSkillCommit({ name: 'BAD', description: '', body: '' }), { ok: false, note: SKILL_NAME_NOTE })
})

test('校验脏数据不抛：空白名（空格）被拒而非崩溃', () => {
  assert.deepEqual(validateSkillCommit({ name: '   ', description: 'd', body: 'b' }), { ok: false, note: SKILL_NAME_NOTE })
})
