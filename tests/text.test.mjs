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
  extractToolRefs,
  summarizeBlocks,
  truncate,
} from '../lib/text.js'

// ---------- summarizeBlocks ----------

test('主路径：text 块拼接，tool-result 记块数，其余类型记号化', () => {
  assert.equal(summarizeBlocks({ content: [{ type: 'text', text: 'hello' }] }), 'hello')
  assert.equal(
    summarizeBlocks({ content: [{ type: 'text', text: 'a' }, { type: 'tool-result', content: [1, 2, 3] }, { type: 'image' }] }),
    'a\n[tool-result 3 blocks]\n[image]',
  )
})

test('主路径：多 text 块按换行拼接', () => {
  assert.equal(summarizeBlocks({ content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }), '第一段\n第二段')
})

test('退化：空 content 不抛返回空串', () => {
  assert.equal(summarizeBlocks({ content: [] }), '')
})

test('脏数据不抛：text 块缺 text → 空段；tool-result 缺 content → 0 blocks', () => {
  assert.equal(summarizeBlocks({ content: [{ type: 'text' }] }), '')
  assert.equal(summarizeBlocks({ content: [{ type: 'tool-result' }] }), '[tool-result 0 blocks]')
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

test('主路径：反引号标识符与「工具：xxx」双模式提取', () => {
  assert.deepEqual(extractToolRefs('用 `wq_simulate` 回测'), ['wq_simulate'])
  assert.deepEqual(extractToolRefs('工具：skill_commit 写入'), ['skill_commit'])
  assert.deepEqual(extractToolRefs('工具: wq_simulate'), ['wq_simulate'])
  assert.deepEqual(extractToolRefs('先 `read` 再 工具：write 落盘'), ['read', 'write'])
})

test('主路径：重复引用去重', () => {
  assert.deepEqual(extractToolRefs('`wq_simulate` 与 `wq_simulate` 一样'), ['wq_simulate'])
})

test('边界保守：标识符短于 3 字符不匹配（正则下限 2,40）', () => {
  assert.deepEqual(extractToolRefs('`ab`'), [])
  assert.deepEqual(extractToolRefs('工具：ab'), [])
})

test('边界保守：大写开头不匹配（工具名规则为小写）', () => {
  assert.deepEqual(extractToolRefs('`Read`'), [])
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
