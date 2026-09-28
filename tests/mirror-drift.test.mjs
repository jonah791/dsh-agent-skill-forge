/**
 * mirror-drift.ts 单测（纯解析 + 纯文案；I/O 只测「不触发」路径）
 *
 * 纪律（AGENTS.md §5.22 §3）：观测绝不反噬主流程——本模块任何失败都返回显式状态而非抛错。
 * 尸体测试（§5.9 规则 2）：
 *  - **仪器故障**样本（退出码 2/3）必须解析成 `null` ⇒ 报 `unavailable`，**不得**报 `clean`。
 *    这正是 2026-09-28 修掉的假绿形状：旧闸门没在看 DSH_HOME 域，同一状态报「无漂移」。
 *  - **项数解析不到**样本必须降级为「项数未知」，**不得**显示 `0 项`（不猜数字）。
 *
 * 夹具取自 2026-09-28 实测输出（真跑 `sync-skills.ps1 -Check` 抓的两种状态）。
 * 运行：`node --test tests/mirror-drift.test.mjs`（先 `npm run build` 产出 lib/）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDriftNote, parseDriftCheck, probeMirrorDrift, warmUpMirrorDrift } from '../lib/mirror-drift.js'

/** 夹具：无漂移（2026-09-28 实测，退出码 0） */
const CLEAN_STDOUT = `模式 检查 · 镜像 E:\\alice\\alice-self-assets\\skills
  真源[user] C:\\Users\\tr\\.agents\\skills
  真源[dsh-home] E:\\alice\\.dsh\\skills

真源 150 技能 / 533 文件 · 镜像 150 技能 / 533 文件
真源独有技能（0）：（无）
镜像独有技能（0）：（无）
内容有差异/缺失的文件（0）：（无）
镜像多出的文件（0）：（无）

✔ 无漂移
`

/** 夹具：有漂移（2026-09-28 实测，退出码 1） */
const DRIFT_STDOUT = `模式 检查 · 镜像 E:\\alice\\alice-self-assets\\skills
  真源[user] C:\\Users\\tr\\.agents\\skills
  真源[dsh-home] E:\\alice\\.dsh\\skills

真源 150 技能 / 534 文件 · 镜像 146 技能 / 528 文件
真源独有技能（4）：alpha-mining, dsh-plugin-development, plugin-ecosystem-convention, skill-maintenance
镜像独有技能（0）：（无）
内容有差异/缺失的文件（8）：dsh-plugin-development\\SKILL.md, tavern-preset-iteration\\SKILL.md
镜像多出的文件（0）：（无）

✖ 有漂移（12 项）—— 真源是权威；跑不带 -Check 的同步即可
`

// ---------- parseDriftCheck：退出码是判据 ----------

test('主路径：退出码 0 → 无漂移读数（count=0）', () => {
  const r = parseDriftCheck(0, CLEAN_STDOUT)
  assert.deepEqual(r, { count: 0, summary: '' })
})

test('主路径：退出码 1 → 从 stdout 取项数', () => {
  const r = parseDriftCheck(1, DRIFT_STDOUT)
  assert.equal(r.count, 12)
  assert.equal(r.summary, '有漂移（12 项）')
})

test('退出码优先于文本：退出码 0 但 stdout 含「有漂移」字样 ⇒ 仍判无漂移', () => {
  // 防「输出里恰好出现关键词」误导判据——权威是退出码，不是文案
  const r = parseDriftCheck(0, DRIFT_STDOUT)
  assert.deepEqual(r, { count: 0, summary: '' })
})

test('尸体：项数解析不到 ⇒ count=-1（不猜数字），不是 0', () => {
  const r = parseDriftCheck(1, '闸门输出格式变了的某一版\n✖ 有漂移—— 真源是权威\n')
  assert.equal(r.count, -1)
  assert.equal(r.summary, '')
})

test('尸体：退出码 2（路径缺失）⇒ null（仪器故障，不是「无漂移」）', () => {
  assert.equal(parseDriftCheck(2, '真源不存在：C:\\nope'), null)
})

test('尸体：退出码 3（真源之间同名冲突）⇒ null（仪器故障，不是「无漂移」）', () => {
  assert.equal(parseDriftCheck(3, '✖ 真源之间同名冲突（1）：a [user vs dsh-home]\n'), null)
})

test('边界：非预期退出码（如被信号中断的 1 之外的码）⇒ null', () => {
  assert.equal(parseDriftCheck(127, ''), null)
  assert.equal(parseDriftCheck(NaN, ''), null)
})

// ---------- buildDriftNote：无消息即好消息，故障必须响 ----------

test('off（未配置）⇒ 空串，不打扰', () => {
  assert.equal(buildDriftNote({ kind: 'off' }), '')
})

test('clean ⇒ 空串，不打扰', () => {
  assert.equal(buildDriftNote({ kind: 'clean' }), '')
})

test('drift ⇒ 含项数 + 同步命令 + 技能指路 + 「只报数」边界', () => {
  const note = buildDriftNote({ kind: 'drift', reading: { count: 12, summary: '有漂移（12 项）' } })
  assert.match(note, /12 项/)
  assert.match(note, /sync-skills\.ps1/)
  assert.match(note, /skill-maintenance/)
  assert.match(note, /只报数/)
})

test('尸体：项数未知时不得显示「0 项」（不猜数字）', () => {
  const note = buildDriftNote({ kind: 'drift', reading: { count: -1, summary: '' } })
  assert.match(note, /项数未知/)
  assert.doesNotMatch(note, /0 项/)
})

test('unavailable ⇒ 明确报故障（静默它就是又一次假绿）', () => {
  const note = buildDriftNote({ kind: 'unavailable', reason: '闸门超时（>15000ms）' })
  assert.match(note, /不可用/)
  assert.match(note, /闸门超时/)
  assert.match(note, /未核实/)
})

// ---------- probeMirrorDrift：未配置路径不得触发子进程 ----------
// 注：真实 spawn 属集成测试（依赖本机 PowerShell），此处只钉「不触发」的语义边界，
// 保证测试离线可跑、不依赖运行平台（技能 dsh-plugin-testability 纪律）。

test('未配置（空串）⇒ off，且不启动任何子进程', () => {
  assert.deepEqual(probeMirrorDrift(''), { kind: 'off' })
})

test('未配置（纯空白）⇒ off（空白等同未配置，不当成路径）', () => {
  assert.deepEqual(probeMirrorDrift('   '), { kind: 'off' })
  assert.deepEqual(probeMirrorDrift('\t\n'), { kind: 'off' })
})

// ---------- warmUpMirrorDrift：预热是异步的，绝不能抛 ----------
// 背景（2026-09-28 实测）：闸门冷启动 ≈ 16.7s（PowerShell 首启 + 缓存冷），热态 1.25s。
// 预热把它从 skill_commit 路径上移走；但它跑在 `apply()` 里，**抛错就是宿主死因**（§5.24）。

test('预热：未配置 ⇒ 直接返回，不抛、不启动子进程', () => {
  assert.doesNotThrow(() => warmUpMirrorDrift(''))
  assert.doesNotThrow(() => warmUpMirrorDrift('   '))
})

test('预热：路径不存在也**不得抛**（真 spawn 路径的 error 监听验收）', () => {
  // 在非 Windows 平台会在平台检查处直接返回；在 Windows 会真 spawn 一个不存在的脚本——
  // 若未注册 child.on('error')，未监听的 error 事件会抛出并杀死宿主。这条测的就是那个监听。
  assert.doesNotThrow(() => warmUpMirrorDrift('E:\\definitely\\not\\a\\gate.ps1'))
})
