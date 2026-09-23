/**
 * text.ts 单测（文本纯函数：消息摘要 / 工具引用解析 / 提示文案）
 *
 * 纪律：文案字面常数逐字断言（用户可见行为 = 判据），不使用模糊匹配替代整串比对。
 * 覆盖：主路径、边界（标识符最短 3 字符 / 截断恰好等于上限）、退化路径（空输入 / 脏数据不抛）。
 *
 * 运行：`node --test tests/text.test.mjs`（先 `npm run build` 产出 lib/）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCommitNote,
  buildCompactHintText,
  buildNotifyText,
  buildToolCandidateNote,
  countConcreteSnippets,
  countNumberedSteps,
  extractToolRefs,
  summarizeBlocks,
  truncate,
} from '../lib/text.js'

// ---------- summarizeBlocks ----------

test('主路径：text 块拼接，其余类型记号化（v4：块已上提，无 tool-result 块）', () => {
  assert.equal(summarizeBlocks({ content: [{ type: 'text', text: 'hello' }] }), 'hello')
  assert.equal(
    summarizeBlocks({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'tool-call' }] }),
    'a\n[image]\n[tool-call]',
  )
})

test('主路径：多 text 块按换行拼接', () => {
  assert.equal(summarizeBlocks({ content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }), '第一段\n第二段')
})

test('退化：空 content 不抛返回空串', () => {
  assert.equal(summarizeBlocks({ content: [] }), '')
})

test('脏数据不抛：text 块缺 text → 空段；其余类型一律记号化', () => {
  assert.equal(summarizeBlocks({ content: [{ type: 'text' }] }), '')
  assert.equal(summarizeBlocks({ content: [{ type: 'image' }] }), '[image]')
})

// ---------- truncate ----------

test('主路径：未超上限原样返回，超出补省略号', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcdef', 5), 'abcde…')
})

test('边界：长度恰好等于上限不改写（<= 而非 <）', () => {
  assert.equal(truncate('abcde', 5), 'abcde')
})

test('退化：空串/零上限不抛', () => {
  assert.equal(truncate('', 0), '')
  assert.equal(truncate('abc', 0), '…')
})

// ---------- extractToolRefs ----------

test('主路径：调用形态与「工具：xxx」双模式提取', () => {
  assert.deepEqual(extractToolRefs('用 `wq_simulate(` 回测'), ['wq_simulate'])
  assert.deepEqual(extractToolRefs('先 `bounty_deliver(claim_id, token)` 再写台账'), ['bounty_deliver'])
  assert.deepEqual(extractToolRefs('工具：skill_commit 写入'), ['skill_commit'])
  assert.deepEqual(extractToolRefs('工具: `wq_simulate`'), ['wq_simulate'])
  assert.deepEqual(extractToolRefs('先 工具：write 落盘'), ['write'])
})

test('回归·2026-09-16 假阳性根因：JSON 字段名/错误码/枚举/shell 命令都不再算工具引用', () => {
  const body = '顶层 `summary`（≥80 字符）+ `observations` 数组；`receipt_ref=runx:receipt:<id>`；'
    + '错误码 `bad_receipt_ref`、`payout_target_in_use`；状态 `pending` / `failed`；命令 `curl -sS`；'
    + '字段 `rail`、`report_depth`、`github_not_found`。'
  assert.deepEqual(extractToolRefs(body), [])
})

test('主路径：重复引用去重', () => {
  assert.deepEqual(extractToolRefs('`wq_simulate(` 与 `wq_simulate(` 一样'), ['wq_simulate'])
})

test('边界保守：标识符短于 3 字符不匹配（正则下限 2,40）', () => {
  assert.deepEqual(extractToolRefs('`ab(`'), [])
  assert.deepEqual(extractToolRefs('工具：ab'), [])
})

test('边界保守：大写开头不匹配（工具名规则为小写）', () => {
  assert.deepEqual(extractToolRefs('`Read(`'), [])
})

test('退化：空文本不抛返回空表', () => {
  assert.deepEqual(extractToolRefs(''), [])
})

test('脏数据不抛：冒号后非标识符/中文占位不匹配', () => {
  assert.deepEqual(extractToolRefs('工具：`中文名`'), [])
  assert.deepEqual(extractToolRefs('工具：'), [])
})

// ---------- 提示文案（字面常数 = 行为判据） ----------

test('主路径：炼化通知文案逐字一致（含真实阈值 200 步）', () => {
  const text = buildNotifyText({ turnCount: 12, totalSteps: 200, totalTools: 260, errorTurns: 2 })
  assert.equal(
    text,
    '[skill-forge] 已采集 12 轮 / 200 步轨迹 / 累计 260 次工具调用（含 2 轮报错）——有高价值轮可炼化（蒸馏技能）。是否炼化、炼化哪些由爱丽丝决定：skill_signals 查看候选，skill_extract 提取，skill_commit 写入。',
  )
})

test('退化：炼化通知文案零数据也成立（不抛）', () => {
  const text = buildNotifyText({ turnCount: 0, totalSteps: 0, totalTools: 0, errorTurns: 0 })
  assert.ok(text.startsWith('[skill-forge] 已采集 0 轮 / 0 步轨迹 / 累计 0 次工具调用（含 0 轮报错）'))
})

test('主路径：压缩前提醒文案逐字一致（含真实阈值 300k）', () => {
  const text = buildCompactHintText({ total: 300000, candidates: 4 })
  assert.equal(
    text,
    '[skill-forge] 上下文压力高（估算 ~300k tokens）——压缩前建议先炼化：压缩前上下文最全，单次压缩收益最大化。skill_marks 查候选（当前 4 个），skill_extract 提取联动视图，skill_commit 写入 SKILL.md；炼化完再压缩。',
  )
})

test('边界：估算 token 四舍五入（299999 仍显示 ~300k）', () => {
  assert.ok(buildCompactHintText({ total: 299999, candidates: 0 }).includes('估算 ~300k tokens'))
  assert.ok(buildCompactHintText({ total: 0, candidates: 0 }).includes('估算 ~0k tokens'))
})

test('主路径：skill_commit 文案（无幻觉工具时不带告警）', () => {
  const note = buildCommitNote(3, [])
  assert.equal(note, 'SKILL.md 已写入；新会话技能目录自动发现（dsh-skill-filesystem）。已炼化轨迹 3 轮标记为废渣，不再重复提示')
  assert.ok(!note.includes('⚠'))
})

test('主路径：skill_commit 文案（有未知工具时追加告警行）', () => {
  const note = buildCommitNote(0, ['fake_tool_a', 'fake_tool_b'])
  assert.ok(note.includes('⚠ 工具引用校验：以下工具不在已知工具面，可能是幻觉工具（技能只提供指导，不提供工具）：fake_tool_a, fake_tool_b'))
})

test('退化：skill_commit 文案轮数为 0 不抛', () => {
  assert.ok(buildCommitNote(0, []).includes('已炼化轨迹 0 轮标记为废渣'))
})

// ---------- 语义扩充：具体性计数（kind=workflow 的可证伪判据）----------
// 判据要点：「具体」必须能被机械判定——有可执行的命令/调用 vs 只有形容词。

test('countNumberedSteps：行首编号与小标题都算，散文算 0', () => {
  assert.equal(countNumberedSteps('1. 先做 A\n2. 再做 B'), 2)
  assert.equal(countNumberedSteps('1) 先做 A\n2) 再做 B'), 2)
  assert.equal(countNumberedSteps('## 步骤 1\n### 步骤 2'), 2)
  assert.equal(countNumberedSteps('先做 A，再做 B'), 0)
  assert.equal(countNumberedSteps('第 1 步做 A'), 0) // 「第 N 步」不算：判据是行首编号/小标题
  assert.equal(countNumberedSteps(''), 0)
})

test('countConcreteSnippets：围栏块 + 围栏外行内代码；未闭合围栏不计（宁可判不够具体）', () => {
  assert.equal(countConcreteSnippets('```\ncmd a\n```'), 1)
  assert.equal(countConcreteSnippets('跑 `npm run build` 即可'), 1)
  assert.equal(countConcreteSnippets('```\nx\n```\n\n跑 `npm test`'), 2)
  assert.equal(countConcreteSnippets('只有形容词，没有命令'), 0)
  assert.equal(countConcreteSnippets(''), 0)
  assert.equal(countConcreteSnippets('```\n未闭合的围栏'), 0)
})

test('kind=workflow 文案：头部标注类型，其余与 guidance 逐字相同（只换头）', () => {
  const g = buildCommitNote(2, [])
  const w = buildCommitNote(2, [], 'workflow')
  assert.ok(g.startsWith('SKILL.md 已写入；'))
  assert.ok(w.startsWith('SKILL.md（kind=workflow：具体高效工作流）已写入；'))
  assert.equal(w.slice(w.indexOf('；')), g.slice(g.indexOf('；')))
})

test('kind=tool 文案：明说写台账不写 SKILL.md，并指向 plugin_forge', () => {
  const note = buildToolCandidateNote({ tool: 'earn_scan', plugin: 'dsh-earn-radar', turnsRequested: 3, existed: false })
  assert.ok(note.includes('工具候选已登记：earn_scan → dsh-earn-radar'))
  assert.ok(note.includes('不写 SKILL.md'))
  assert.ok(note.includes('plugin_forge'))
  assert.ok(note.includes('已炼化轨迹 3 轮'))
  assert.ok(buildToolCandidateNote({ tool: 'x', plugin: 'p', turnsRequested: 0, existed: true }).includes('工具候选已更新'))
})
