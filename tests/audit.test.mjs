/**
 * audit.ts 单测 —— 技能库审计层（纯函数）。
 *
 * 纪律（SOUL §5.9 规则 2）：**新防线必带尸体测试**，且必须有**金标准**
 * （无关技能 ⇒ 零候选）——否则「恒亮的判据不是证据」。
 *
 * ★ 本组里最要紧的是 **C 组（有意指针 vs 真冗余）** 与 **D2（回捞真的捞到了）**：
 *   前者对应论文 Table 2 的教训（No gate 的 24 个假阳 = 把本来有用的东西当冲突），
 *   后者对应判据②（严剪漏 24/60，回捞捞回 14）。
 *
 * 运行：`npm run build && node --test tests/audit.test.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditSkills,
  bodySimilarity,
  contentFingerprint,
  hasScopeSignal,
  hasTriggerSection,
  isIntentionalPointer,
  jaccard,
  pairFingerprints,
  pairKey,
  parseFrontmatter,
  renderAudit,
  shingleSet,
  splitPairKey,
  tokenSet,
  NEAR_DUP_BODY_THRESHOLD,
} from '../lib/audit.js'

/** 造一条技能记录（只给审计层需要的字段）。 */
const rec = (dir, description, over = {}) => ({
  dir,
  name: dir,
  description,
  chars: 1000,
  hasTrigger: true,
  ...over,
})

/* ── A 金标准：判据不得恒亮 ─────────────────────────────────────────────── */

test('A1 两个完全无关的技能（不同前缀、词不重叠、正文不同）⇒ 零候选', () => {
  const rep = auditSkills([
    rec('alpha-thing', '数据库迁移与回滚的实操纪律', { bodyHead: '第一节 迁移脚本必须先备份再执行' }),
    rec('zeta-other', '语音合成与音色选择', { bodyHead: '第二节 采样率与比特率的取舍' }),
  ])
  assert.equal(rep.pairs.length, 0, '无关技能不得产生任何候选（否则判据恒亮）')
  assert.equal(rep.stats.candidates, 0)
})

test('A2 同前缀 ⇒ 进候选池，但内容不同 ⇒ **不报冗余**（剪枝 ≠ 判定）', () => {
  const rep = auditSkills([
    rec('dsh-alpha', '插件 A 的部署流程', { bodyHead: '甲甲甲甲甲 内容一' }),
    rec('dsh-beta', '完全另一件事的网络排障', { bodyHead: '乙乙乙乙乙 内容二' }),
  ])
  assert.equal(rep.stats.candidates, 1, '同前缀必须进候选池（剪枝的作用）')
  assert.equal(rep.pairs.length, 0, '但内容不同就不该报冗余 —— 剪枝只决定「看什么」，不决定「是什么」')
})

/* ── B 尸体：每一类都必须报 ─────────────────────────────────────────────── */

test('B1 尸体·description 逐字相同（非指针）⇒ duplicate-desc，且 intentional=false', () => {
  const d = '把外部论文的结论移植到本机的取证流程'
  const rep = auditSkills([rec('aaa-one', d), rec('bbb-two', d)])
  const hit = rep.pairs.find((p) => p.kind === 'duplicate-desc')
  assert.ok(hit !== undefined, '逐字相同的 description 必须被报出')
  assert.equal(hit.intentional, false, '非指针 ⇒ 不算「有意」，应进「值得看」清单')
})

test('B2 尸体·description 词集高度重叠 ⇒ near-duplicate-desc', () => {
  const rep = auditSkills([
    rec('p-one', '浏览器自动化验证：用无头浏览器做界面验收与截图复核'),
    rec('p-two', '浏览器自动化验证：用无头浏览器做界面验收与截图核对'),
  ])
  assert.ok(rep.pairs.some((p) => p.kind === 'near-duplicate-desc'), '近重复 description 必须被报出')
})

test('B3 尸体·无 description ⇒ no-description（严重档）', () => {
  const rep = auditSkills([rec('x-nod', '', { hasTrigger: false })])
  assert.equal(rep.scopeGaps.filter((g) => g.kind === 'no-description').length, 1)
})

test('B4 尸体·name ≠ 目录名 ⇒ name-mismatch（索引漂移）', () => {
  const rep = auditSkills([rec('dir-name', '有描述', { name: 'frontmatter-name' })])
  const a = rep.anomalies.find((x) => x.kind === 'name-mismatch')
  assert.ok(a !== undefined, '目录名与 frontmatter name 不一致必须报出')
  assert.match(a.detail, /frontmatter-name/)
})

test('B5 尸体·超大技能 ⇒ oversized，且文案里**明确不建议压缩**（论文判据④）', () => {
  const rep = auditSkills([rec('big-one', '很大', { chars: 40000 })])
  const a = rep.anomalies.find((x) => x.kind === 'oversized')
  assert.ok(a !== undefined)
  assert.match(a.detail, /只报告不建议压缩/, '必须带上论文依据，否则读者会顺手去压缩')
})

test('B6 尸体·无 frontmatter ⇒ no-frontmatter', () => {
  const rep = auditSkills([rec('no-fm', '', { name: '' })])
  assert.ok(rep.anomalies.some((x) => x.kind === 'no-frontmatter'))
})

/* ── C ★ 有意指针 vs 真冗余（论文 Table 2 的教训）───────────────────────── */

test('C1 有意指针（「已熔炼进…防呆指针」）⇒ intentional=true，不进「值得看」', () => {
  const d = '已熔炼进 dsh-upgrade-adaptation 的防呆指针；本目录保留为上游资源树。'
  const rep = auditSkills([rec('aaa-p', d), rec('bbb-q', d)])
  const hit = rep.pairs.find((p) => p.kind === 'duplicate-desc')
  assert.ok(hit !== undefined)
  assert.equal(hit.intentional, true, '有意的占位符必须被单独标记')
  assert.equal(rep.stats.intentional, 1)
})

test('C2 同一条描述里，指针与非指针**分开统计**（不混成一个数）', () => {
  const ptr = '已熔炼进某插件的防呆指针；本目录保留为上游资源树。'
  const real = '完全另一件事的重复描述，两边都不是指针。'
  const rep = auditSkills([
    rec('a1', ptr), rec('a2', ptr),      // 一对指针
    rec('b1', real), rec('b2', real),    // 一对真冗余
  ])
  assert.equal(rep.stats.intentional, 1, '指针那一对应被计入 intentional')
  assert.equal(rep.pairs.filter((p) => !p.intentional).length, 1, '真冗余那一对应留在可行动清单里')
})

test('C3 isIntentionalPointer 判据：命中标记词才为真（不得恒真）', () => {
  assert.equal(isIntentionalPointer('已熔炼进 X 的防呆指针；本目录保留为上游资源树'), true)
  assert.equal(isIntentionalPointer('这是一份正常的技能描述，讲的是取证流程'), false)
})

/* ── D ★ 剪枝与回捞（判据②③的直接验证）────────────────────────────────── */

test('D1 剪枝真的省：跨域技能互不相干 ⇒ 候选数远小于全量对数', () => {
  // ⚠ 样本设计教训（第一版被我写错）：第一版造 30 条**全部同前缀**（mod0-item / mod1-item…）
  //   ⇒ 前缀剪枝必然全命中 ⇒ 候选数 == 全量对数，测的根本不是「剪枝省不省」。
  //   真实技能库的形态是**域各异**（anima / weather / robotics…）—— 照那个形态造样本才有意义。
  const recs = [
    rec('anima-nsfw', '涩图生成配方与提交链', { bodyHead: '基模选择与开关匹配' }),
    rec('weather-data', '气象数据的单位与时区口径', { bodyHead: '露点与风寒公式' }),
    rec('robotics-motion', '机器人运动学与轨迹', { bodyHead: '正逆解往返与限位' }),
    rec('voice-speech', '语音合成与音色选择', { bodyHead: '采样率与比特率取舍' }),
    rec('latex-table', '表格挤成竖条的治本', { bodyHead: '估宽判据与跨页' }),
    rec('k8s-runbook', 'K8s 排障分诊表', { bodyHead: '三拍取证与判据' }),
  ]
  const rep = auditSkills(recs)
  assert.equal(rep.stats.allPairs, 15, '6 个技能的全量对数是 15')
  assert.ok(rep.stats.candidates < rep.stats.allPairs, '剪枝必须真的省（否则退化成 No gate）')
})

test('D2 尸体·**回捞**：词集无交集但正文高度重叠 ⇒ 必须被捞回（跨前缀）', () => {
  // ⚠ 样本设计教训（第一版被我写错）：第一版两条描述是「甲方案：证据链的核对方式」/「乙方案：…」
  //   —— 它们**共享「方案」二字** ⇒ descSim > 0 ⇒ 走的是「候选池内」路径，**根本没测到回捞**。
  //   要测回捞，描述必须**词集完全无交集**（英文词互不共享 3-gram 最省事）。
  const body = '验收判据必须逐字对照原文。判据设计三问：它会被哪一次测量判真假？证据是落盘的还是别人说的？异常状态为什么是这样？'
  const rep = auditSkills([
    rec('alpha-x', 'alpha unique marker', { bodyHead: body }),
    rec('omega-y', 'bravo distinct token', { bodyHead: body }),
  ])
  const hit = rep.pairs.find((p) => p.kind === 'near-duplicate-body')
  assert.ok(hit !== undefined, '词不重叠但正文同源的对必须被回捞（否则就是论文里严剪漏掉的那 24/60）')
  assert.match(hit.evidence, /回捞/)
  assert.ok(hit.score >= NEAR_DUP_BODY_THRESHOLD)
})

test('D3 回捞不得恒捞：正文不同的跨前缀对，仍然不报', () => {
  const rep = auditSkills([
    rec('alpha-z', '甲', { bodyHead: '完全不同的内容一：' + '甲'.repeat(200) }),
    rec('omega-w', '乙', { bodyHead: '完全不同的内容二：' + '乙'.repeat(200) }),
  ])
  assert.equal(rep.pairs.filter((p) => p.kind === 'near-duplicate-body').length, 0)
})

/* ── E 可复算（无时钟、无随机）─────────────────────────────────────────── */

test('E1 同一输入跑两次结果逐字一致', () => {
  const recs = [
    rec('aaa-one', '描述甲甲乙乙'), rec('aaa-two', '描述甲甲乙乙'),
    rec('bbb-three', '另一个描述'), rec('ccc-four', '', { hasTrigger: false }),
  ]
  const a = JSON.stringify(auditSkills(recs))
  const b = JSON.stringify(auditSkills(recs))
  assert.equal(a, b, '审计层必须可复算（同目录两次跑出同一份读数）')
})

/* ── F parseFrontmatter ──────────────────────────────────────────────── */

test('F1 正常 frontmatter：name / description / body 正确切分', () => {
  const t = '---\nname: my-skill\ndescription: 一句话说明\n---\n\n# 标题\n正文内容\n'
  const r = parseFrontmatter(t)
  assert.equal(r.hasFrontmatter, true)
  assert.equal(r.name, 'my-skill')
  assert.equal(r.description, '一句话说明')
  assert.match(r.body, /正文内容/)
  assert.ok(!r.body.includes('name: my-skill'), 'body 不得含 frontmatter')
})

test('F2 无 frontmatter ⇒ hasFrontmatter=false 且 name/description 为空串（不猜）', () => {
  const r = parseFrontmatter('# 只有标题\n正文\n')
  assert.equal(r.hasFrontmatter, false)
  assert.equal(r.name, '')
  assert.equal(r.description, '')
  assert.equal(r.body, '# 只有标题\n正文\n')
})

test('F3 有 frontmatter 但缺 description ⇒ 空串（「没写」与「写了空」在读数上一致，都是没声明）', () => {
  const r = parseFrontmatter('---\nname: only-name\n---\n正文\n')
  assert.equal(r.hasFrontmatter, true)
  assert.equal(r.name, 'only-name')
  assert.equal(r.description, '')
})

/* ── G 词法工具与边界 ─────────────────────────────────────────────────── */

test('G1 tokenSet：中英混合都取得到（中文二元组 + 英文词）', () => {
  const t = tokenSet('浏览器 automation 验收')
  assert.ok(t.has('浏览') || t.has('览器'), '中文应被切成二元组')
  assert.ok(t.has('automation'), '英文词应被保留')
})

test('G2 jaccard / shingleSet / bodySimilarity：退化输入不抛', () => {
  assert.equal(jaccard(new Set(), new Set(['a'])), 0)
  assert.equal(jaccard(new Set(), new Set()), 0)
  assert.equal(shingleSet('').size, 0)
  assert.equal(bodySimilarity('', ''), 0)
  assert.equal(bodySimilarity('同一段文字', '同一段文字'), 1)
})

test('G3 hasTriggerSection：多种措辞都认（放宽匹配是刻意的）', () => {
  assert.equal(hasTriggerSection('## 一、何时进入本技能（触发条件）'), true)
  assert.equal(hasTriggerSection('**触发**：改代码后'), true)
  assert.equal(hasTriggerSection('**适用场景**：批量替换'), true)
  assert.equal(hasTriggerSection('这是一段没有任何触发说明的文字'), false)
})

test('G4 空库 / 单技能 ⇒ 不崩、零候选', () => {
  const empty = auditSkills([])
  assert.equal(empty.total, 0)
  assert.equal(empty.stats.allPairs, 0)
  assert.equal(empty.pairs.length, 0)
  const one = auditSkills([rec('solo', '唯一的技能')])
  assert.equal(one.total, 1)
  assert.equal(one.pairs.length, 0)
})

/* ── H 渲染（可读性 + 边界声明不得丢）────────────────────────────────── */

test('H1 renderAudit：报告含边界声明（不判硬/软冲突）——不得静默省略', () => {
  const rep = auditSkills([rec('aaa-one', '描述'), rec('bbb-two', '另一个')])
  const txt = renderAudit(rep)
  assert.match(txt, /不判硬\/软冲突/, '边界必须出现在输出里，否则读者会以为审计覆盖了冲突')
  assert.match(txt, /scope 质量/, 'scope 必须单列（论文消融第一重要的维度）')
})

test('H2 renderAudit：零候选时也说明「有意指针是被主动排除的」（空必须分型）', () => {
  const d = '已熔炼进 X 的防呆指针；本目录保留为上游资源树。'
  const rep = auditSkills([rec('aaa-p', d), rec('bbb-q', d)])
  const txt = renderAudit(rep)
  assert.match(txt, /有意指针/, '指针被排除这件事必须可见，否则「零可行动」会被读成「没检出」')
})

test('H3 severity=strong：正文也同源的对进「强证据」段（多证据合取）', () => {
  const body = '验收判据必须逐字对照原文。判据设计三问：它会被哪一次测量判真假？'
  const rep = auditSkills([
    rec('alpha-s', 'alpha unique marker', { bodyHead: body }),
    rec('omega-s', 'bravo distinct token', { bodyHead: body }),
  ])
  const hit = rep.pairs.find((p) => p.kind === 'near-duplicate-body')
  assert.ok(hit !== undefined)
  assert.equal(hit.severity, 'strong', '正文同源 ⇒ 多证据合取 ⇒ strong')
  assert.match(renderAudit(rep), /强证据/)
})

test('H4 severity=weak：只有 description 证据的对**不得冒充结论**（渲染必须降档）', () => {
  // 同域（plugin-*）+ 词高度重叠，但正文完全不同 ⇒ 典型「同域术语重叠」
  const rep = auditSkills([
    rec('plugin-aaa', '浏览器自动化验证：用无头浏览器做界面验收与截图复核', { bodyHead: '甲'.repeat(300) }),
    rec('plugin-bbb', '浏览器自动化验证：用无头浏览器做界面验收与截图核对', { bodyHead: '乙'.repeat(300) }),
  ])
  const hit = rep.pairs.find((p) => p.kind === 'near-duplicate-desc')
  assert.ok(hit !== undefined, '近重复 description 仍要报（信号不能丢）')
  assert.equal(hit.severity, 'weak', '正文不同源 ⇒ 只有单层证据 ⇒ weak')
  const txt = renderAudit(rep)
  assert.match(txt, /术语重叠/, 'weak 档必须降档呈现')
  assert.match(txt, /不是结论/, '必须写清它不构成结论 —— 否则读者会把同域术语重叠当冗余去改')
})

/* ── I scope 风险：无信号 ∧ 有近邻（**合取**）────────────────────────────────
 * 为什么是合取：scope 的作用是**区分** —— 孤立域技能缺触发词不影响选择。
 * 如果只按「无信号」报，133/186 条全是待办 = 没有待办（读数没有行动性）。
 */

test('I1 hasScopeSignal 金标准：英文/中文的「何时用」都认', () => {
  assert.equal(hasScopeSignal('Debug X. Use when host API semantics matter.'), true)
  assert.equal(hasScopeSignal('Coordinate the lifecycle. Use for guided workflows.'), true)
  assert.equal(hasScopeSignal('移动端 Expo + 何时用 Expo'), true)
  assert.equal(hasScopeSignal('适用于任何「超限静默截断」的文件'), true)
})

test('I2 尸体·**内容特征词不得冒充「何时用」**（标定抓到的 4 个实测假阳）', () => {
  // 这四条在宽松表（含裸 `用于`/`触发`）下会被误报 —— 人读逐条核对才抓出来（精确率 8/15）
  assert.equal(hasScopeSignal('跨配置对照实验的设计纪律：…、规则有适用域'), false, '「适用域」≠「适用于」')
  assert.equal(hasScopeSignal('选场景三条判据（重复性/回报可判定/**触发可达**）'), false, '「触发可达」是内容特征')
  assert.equal(hasScopeSignal('评估外部数据集/语料能否用于自己的框架或研究'), false, '「能否用于」是内容')
  assert.equal(hasScopeSignal('待办有归宿/提醒有触发条件/承诺有回执'), false, '「触发条件」是内容特征')
})

test('I3 无信号 ∧ 有近邻 ⇒ 进 scope 风险清单（合取的两个条件都满足）', () => {
  const rep = auditSkills([
    rec('aaa-ops', '客户支持运营：SLA 口径 / 分诊矩阵 fail-closed / 升级阈值 + 可跑判据（实测五项 PASS）'),
    rec('bbb-pay', '电商与支付：状态机 fail-closed / 幂等键 / 验签 + 可跑判据（实测五项 PASS）'),
  ])
  assert.ok(rep.pairs.length > 0, '装置自检：这两条必须先是词法近邻（否则测的是别的东西）')
  assert.equal(rep.scopeRisks.length, 2, '两条都无信号且互为近邻 ⇒ 都该进清单')
  assert.ok(rep.scopeRisks[0].maxNeighbor >= 0.15, '近邻值必须过门槛')
  assert.notEqual(rep.scopeRisks[0].neighbor, rep.scopeRisks[0].dir, '近邻必须指向**对方**')
})

test('I4 对照组·有信号的两条（即使互为近邻）⇒ **不进** scope 风险清单', () => {
  const rep = auditSkills([
    rec('aaa-one', 'Test levels for plugins. Use when testing plugins.'),
    rec('bbb-two', 'Test levels for plugins. Use when testing plugins or package changes.'),
  ])
  assert.ok(rep.pairs.length > 0, '装置自检：对照组必须先成立（不成立 = 实验无结论）')
  assert.equal(rep.scopeRisks.length, 0, '已声明「何时用」⇒ 不算 scope 风险')
})

test('I5 对照组·无信号但域内孤立（无近邻）⇒ **不进**清单', () => {
  const rep = auditSkills([
    rec('alpha-thing', '数据库迁移与回滚的实操纪律'),
    rec('zeta-other', '语音合成与音色选择'),
  ])
  assert.equal(rep.pairs.length, 0, '装置自检：这两条必须真的不相干')
  assert.equal(rep.scopeRisks.length, 0, '无近邻 ⇒ 缺触发词不影响选择（否则 133 条全是待办 = 没有待办）')
})

test('I6 有意指针（逐字相同 + 「已熔炼进」标记）⇒ **不进** scope 风险清单', () => {
  const d = '已熔炼进 dsh-upgrade-adaptation 的防呆指针；本目录保留为上游资源树'
  const rep = auditSkills([rec('dsh-benchmark-case', d), rec('dsh-upgrade-audit', d)])
  assert.equal(rep.pairs.length, 1, '装置自检：逐字相同必须进候选池')
  assert.equal(rep.scopeRisks.length, 0, '有意为之的占位符不是 scope 缺陷（论文 Table 2 的教训）')
})

test('I7 renderAudit：有风险时报出清单，注明与冗余档**同一把尺子**，并给可执行动作', () => {
  const rep = auditSkills([
    rec('aaa-ops', '客户支持运营：SLA 口径 / 分诊矩阵 fail-closed / 升级阈值 + 可跑判据（实测五项 PASS）'),
    rec('bbb-pay', '电商与支付：状态机 fail-closed / 幂等键 / 验签 + 可跑判据（实测五项 PASS）'),
  ])
  const out = renderAudit(rep)
  assert.match(out, /高优先/, '有风险时必须报出清单')
  assert.match(out, /同一把尺子/, '必须说明它与冗余档共用门槛（判据单一真源）')
  assert.match(out, /提升到 description/, '必须给**可执行**的动作，不只报数')
})

test('I8 renderAudit：零风险时**不得**出现「高优先」段（空必须分型）', () => {
  const rep = auditSkills([rec('alpha-thing', '数据库迁移'), rec('zeta-other', '语音合成')])
  const out = renderAudit(rep)
  assert.ok(!out.includes('高优先'), '无风险时不得报清单（恒亮的判据不是证据）')
  assert.match(out, /不需要动/, '但要说清其余条目**为何**不用动 —— 空必须分型')
})

/* ── J 裁决台账：裁决是「这一版内容我读过」，**不是永久豁免** ──────────────────
 * 存在理由（2026-10-15）：审计器每轮报 4 对「需人读」，我判完 4/4 互补，而那个结论
 * 只活在当次会话里 ⇒ 下一轮照样报（§5.39：规则层反复失效 ⇒ 换机制承载）。
 * ★ 本组最要紧的是 **J3/J4/J5/J6（内容变 ⇒ 裁决自动失效）**：它防的是「拿过期判断继续豁免」，
 *   那比没裁决更坏（假绿）。
 */

/** 造一条「需人读」档的候选对（description 层重叠过门槛、正文不同 ⇒ severity=weak）。
 *  ⚠ 形状照 I3 那对真实数据（`可跑判据（实测…PASS）` 这类共有尾句是词重叠的主要来源）——
 *  最初我拍脑袋写的两条只重叠 ~0.04，**没进候选池**，是 J2 的「装置自检」把它抓出来的。 */
const WEAK_PAIR = [
  rec('aaa-debug', '调试插件运行时问题：宿主 API 语义 / 契约核对 + 可跑判据（实测三项 PASS）', { bodyHead: '甲甲甲甲甲 读宿主源码' }),
  rec('bbb-test', '选择插件测试层级：单元 / 覆盖 / 真组合 + 可跑判据（实测三项 PASS）', { bodyHead: '乙乙乙乙乙 选最小充分集' }),
]

/** 造一条裁决（指纹照当前内容算 —— 与工具写入同一口径）。 */
const verdictOf = (a, b, over = {}) => ({
  verdict: 'complementary',
  reason: '诊断 ≠ 验证：一个答「为什么坏了」，一个答「该跑哪几层证明好了」',
  fingerprints: pairFingerprints(a, b, new Map(WEAK_PAIR.map((r) => [r.dir, r]))),
  at: '2026-10-15T10:00:00.000Z',
  ...over,
})

test('J1 金标准：无台账 ⇒ 三档全空，且**报告不多一行**（向后兼容硬约束）', () => {
  const bare = auditSkills(WEAK_PAIR)
  const withEmpty = auditSkills(WEAK_PAIR, { ledger: {} })
  assert.equal(bare.resolved.length, 0, '无台账时不得凭空出现「已裁决」')
  assert.equal(bare.staleVerdicts.length, 0)
  assert.equal(bare.orphanVerdicts.length, 0)
  assert.equal(renderAudit(bare), renderAudit(withEmpty), '空台账与不传台账必须逐字相同')
})

test('J2 尸体·指纹匹配 ⇒ 该对**从「需人读」移出**，且裁决依据可见', () => {
  const key = pairKey('aaa-debug', 'bbb-test')
  const rep = auditSkills(WEAK_PAIR, { ledger: { [key]: verdictOf('aaa-debug', 'bbb-test') } })
  assert.equal(rep.pairs.length, 1, '装置自检：它必须先是「需人读」档的候选（否则测的是别的东西）')
  assert.equal(rep.resolved.length, 1, '指纹匹配 ⇒ 进已裁决档')
  assert.equal(rep.staleVerdicts.length, 0)
  const out = renderAudit(rep)
  assert.match(out, /已裁决 1 对/, '已裁决档必须报数')
  assert.match(out, /诊断 ≠ 验证/, '裁决**依据**必须可见 —— 否则等于「删掉了就不管了」')
  assert.match(out, /术语重叠 0 对/, '已裁决的对不得同时留在「需人读」档（两档互斥）')
})

test('J3 尸体·**内容变 ⇒ 裁决自动失效**（回到「需人读」，且注明是哪一侧变的）', () => {
  const key = pairKey('aaa-debug', 'bbb-test')
  const ledger = { [key]: verdictOf('aaa-debug', 'bbb-test') }
  // 只改 b 侧正文 —— 指纹必然失配。⚠ 描述必须**保住共有尾句**，否则该对掉出候选池 ⇒
  // 测的就变成「孤裁决」（J7 的场景）而不是「失效」——这条陷阱 J3/J5 各踩过一次。
  const edited = [WEAK_PAIR[0], rec('bbb-test', '选择插件测试层级：单元 / 覆盖 / 真组合 + 可跑判据（实测三项 PASS）', { bodyHead: '乙乙乙乙乙 换了一段完全不同的正文' })]
  const rep = auditSkills(edited, { ledger })
  assert.equal(rep.pairs.filter((p) => !p.intentional).length, 1, '装置自检：改完仍须是候选对')
  assert.equal(rep.orphanVerdicts.length, 0, '装置自检：不得掉成孤裁决（那说明编辑过头了）')
  assert.equal(rep.resolved.length, 0, '内容变过 ⇒ **不得**继续算「已裁决」（裁决不是永久豁免）')
  assert.equal(rep.staleVerdicts.length, 1, '失效必须被报出来')
  assert.equal(rep.staleVerdicts[0].changed, 'b', '要能指出**哪一侧**变了（否则只知道「失效了」）')
  assert.match(renderAudit(rep), /裁决已失效 1 对/, '失效必须醒目（否则读的人看不出是自己改过内容）')
})

test('J4 尸体·**描述变也失效**（指纹同域＝description + 正文头部，两者任一都算）', () => {
  const key = pairKey('aaa-debug', 'bbb-test')
  const ledger = { [key]: verdictOf('aaa-debug', 'bbb-test') }
  // ⚠ 编辑必须**保住共有尾句**，否则该对掉出候选池 ⇒ 测的就变成「孤裁决」而非「失效」
  const edited = [rec('aaa-debug', '调试插件运行时问题：宿主 API 语义 / 契约核对（已改过的描述）+ 可跑判据（实测三项 PASS）', { bodyHead: '甲甲甲甲甲 读宿主源码' }), WEAK_PAIR[1]]
  const rep = auditSkills(edited, { ledger })
  assert.equal(rep.pairs.filter((p) => !p.intentional).length, 1, '装置自检：改完仍须是候选对')
  assert.equal(rep.orphanVerdicts.length, 0, '装置自检：不得掉成孤裁决（那说明编辑过头了）')
  assert.equal(rep.staleVerdicts.length, 1, 'description 变 ⇒ 同样失效')
  assert.equal(rep.staleVerdicts[0].changed, 'a')
})

test('J5 尸体·**两侧都变** ⇒ changed=both（不误报成单侧）', () => {
  const key = pairKey('aaa-debug', 'bbb-test')
  const ledger = { [key]: verdictOf('aaa-debug', 'bbb-test') }
  const edited = [
    rec('aaa-debug', '调试插件运行时问题：宿主 API 语义 / 契约核对 + 可跑判据（实测三项 PASS）', { bodyHead: '甲甲甲甲甲 改过' }),
    rec('bbb-test', '选择插件测试层级：单元 / 覆盖 / 真组合 + 可跑判据（实测三项 PASS）', { bodyHead: '乙乙乙乙乙 也改过' }),
  ]
  const rep = auditSkills(edited, { ledger })
  assert.equal(rep.orphanVerdicts.length, 0, '装置自检：描述保住 ⇒ 不得掉成孤裁决')
  assert.equal(rep.staleVerdicts.length, 1, '装置自检：两侧都改 ⇒ 必须判失效')
  assert.equal(rep.staleVerdicts[0].changed, 'both')
})

test('J6 尸体·**坏形状的台账值**（旧版/手改：指纹不是两元组）⇒ 一律算失效，不静默接受', () => {
  const key = pairKey('aaa-debug', 'bbb-test')
  // 模拟旧版字段名（单一拼接串）—— 形状不对必须算失效
  const legacy = { [key]: { verdict: 'complementary', reason: '旧版', fingerprint: 'deadbeef-cafe', at: '2026-10-01T00:00:00.000Z' } }
  const rep = auditSkills(WEAK_PAIR, { ledger: legacy })
  assert.equal(rep.resolved.length, 0, '形状不对**不得**当匹配（假绿比多做一次人读更坏）')
  assert.equal(rep.staleVerdicts.length, 1, '要报失效，让人看见它需要重判')
})

test('J7 尸体·孤裁决两型**分开报**（skill-missing ≠ no-longer-similar）', () => {
  const ledger = {
    [pairKey('aaa-debug', 'bbb-test')]: verdictOf('aaa-debug', 'bbb-test'),   // 本次候选内
    [pairKey('aaa-debug', 'zzz-gone')]: verdictOf('aaa-debug', 'bbb-test'),   // zzz-gone 不在库
    [pairKey('ccc-a', 'ddd-b')]: verdictOf('aaa-debug', 'bbb-test'),          // 两侧都在库但不相干
  }
  const recs = [...WEAK_PAIR, rec('ccc-a', '数据库迁移脚本的备份纪律'), rec('ddd-b', '语音合成的采样率取舍')]
  const rep = auditSkills(recs, { ledger })
  assert.equal(rep.orphanVerdicts.length, 2, '两条孤裁决')
  const missing = rep.orphanVerdicts.filter((o) => o.reason === 'skill-missing')
  const gone = rep.orphanVerdicts.filter((o) => o.reason === 'no-longer-similar')
  assert.equal(missing.length, 1, '一侧不在库 ⇒ skill-missing（悬空引用，该清）')
  assert.equal(gone.length, 1, '两侧在库只是不相似 ⇒ no-longer-similar（正常，将来仍有效）')
  const out = renderAudit(rep)
  assert.match(out, /skill-missing 1 条/)
  assert.match(out, /no-longer-similar 1 条/)
})

test('J8 判据单调性：裁决**只减**「需人读」，绝不改变候选集本身', () => {
  const key = pairKey('aaa-debug', 'bbb-test')
  const bare = auditSkills(WEAK_PAIR)
  const rep = auditSkills(WEAK_PAIR, { ledger: { [key]: verdictOf('aaa-debug', 'bbb-test') } })
  assert.equal(rep.pairs.length, bare.pairs.length, 'pairs 是**检出层**，裁决不得动它（动了就是拿裁决伪造证据）')
  assert.equal(rep.stats.candidates, bare.stats.candidates, '候选数同理')
  assert.equal(rep.scopeRisks.length, bare.scopeRisks.length, 'scope 档不受裁决影响（两条独立判据）')
})

test('J9 pairKey / splitPairKey：与顺序无关，且坏键不猜', () => {
  assert.equal(pairKey('b', 'a'), pairKey('a', 'b'), 'a↔b 与 b↔a 是同一条裁决')
  assert.equal(pairKey('a', 'b'), 'a|b')
  assert.deepEqual(splitPairKey('a|b'), ['a', 'b'])
  assert.deepEqual(splitPairKey('|b'), [undefined, undefined], '缺左侧 ⇒ 不猜')
  assert.deepEqual(splitPairKey('a|'), [undefined, undefined], '缺右侧 ⇒ 不猜')
  assert.deepEqual(splitPairKey('nokey'), [undefined, undefined], '无分隔符 ⇒ 不猜')
})

test('J10 指纹分侧存 ⇒ 「哪一侧变了」直接可算（不靠解析拼接串）', () => {
  const byDir = new Map(WEAK_PAIR.map((r) => [r.dir, r]))
  const fps = pairFingerprints('aaa-debug', 'bbb-test', byDir)
  assert.equal(fps.length, 2)
  assert.equal(fps[0], contentFingerprint(byDir.get('aaa-debug')), '[0] 必须是字典序小的一侧')
  assert.equal(fps[1], contentFingerprint(byDir.get('bbb-test')))
  assert.deepEqual(pairFingerprints('bbb-test', 'aaa-debug', byDir), fps, '顺序无关（同一条裁决）')
  assert.deepEqual(pairFingerprints('aaa-debug', 'zzz-missing', byDir), [], '缺一侧 ⇒ 空数组（不猜）')
})

test('J11 renderAudit：零裁决时**不得**出现「已裁决」段（空必须分型）', () => {
  const out = renderAudit(auditSkills(WEAK_PAIR))
  assert.ok(!out.includes('✔ 已裁决'), '没有裁决就别报「已裁决 0 对」占位（那是噪音）')
  assert.ok(!out.includes('裁决已失效'), '同理，失效段也别占位')
})
