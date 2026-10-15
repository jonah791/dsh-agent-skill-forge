/**
 * dsh-agent-skill-forge · 技能库审计层（纯函数 · 零 IO）
 *
 * ── 论文依据（不是我的偏好，每条都有实验支撑）───────────────────────────────
 * SkillFusion: Towards Reliable Multi-Skill Composition for LLM Agents
 * （arXiv:2610.15481v1，29 页）。核心问题：**独立编写的技能被联合加载时产生三类交互** ——
 * ⊕ 硬冲突（同一决策点上动作不兼容）/ ⊖ 软冲突（偏好竞争）/ ≡ 冗余（重复要求）。
 * 核心洞见：**合适的合并操作取决于交互的 type 与 scope**。
 *
 * ★ 四条移植判据（消融/审计数据都在论文里，我照录读数）：
 *   ① **scope 是影响最大的一维** —— 消融「去 scope normalization」Success .799→.768，
 *      是全部变体里跌幅最大的（typed IR 同方向；conflict types 的贡献在 resolution：
 *      Preservation .900→.850）。⇒ 审计必须把 **scope 质量单列**，不与其他异常混一个数。
 *   ② **严格剪枝会漏** —— 300 对人工审计：SF-strict 漏掉 24/60 不兼容对（Recall .600），
 *      选择性回捞捞回 14 对 ⇒ F1 .713→.840。⇒ 必须有**选择性回捞**，不能只靠结构剪枝。
 *   ③ **全量两两比对更差** —— No gate：Recall 最高（.917）但 Precision .696、**24 个假阳**
 *      （SF-final 只有 9）、Preservation .717 vs .900、API 成本 7.610× vs 1.820×。
 *      ⇒ 必须**结构化剪枝**：全比会把「本来有用的指令」当冲突去改。
 *   ④ **压缩有性能代价** —— 消融「去压缩」的 Success 反而更高（.811 vs .799），
 *      压缩只提高 Compliance。⇒ 本层**不提议压缩**，只报「值得看」的对象。
 *
 * ★ 漏检归因（论文 Table 9，24 个漏检）：Type assignment 8 · **Scope normalization 6** ·
 *   Cross-type 5 · Scope overlap 3 · Classifier 1 · Annotation ambiguity 1。
 *   ⇒ 前两位都在 **type / scope 的表示质量**上，不在分类器 —— 所以审计的重点是**表示**。
 *
 * ── 本层的边界（诚实标注）──────────────────────────────────────────────────
 *   · **只产出候选与证据，不下裁决**（SOUL §2.1：机制把信号送达，不代替决策）。
 *   · **不做语义冲突判定**：硬/软冲突需要读两条指令的**行为语义**，机器判据（词/字符重叠）
 *     到不了那一层 ⇒ 本层只报「冗余候选 + scope 缺口 + 结构异常」，冲突留给 LLM/人读。
 *     ⚠ 这是**能力边界**，不是遗漏 —— 假装能判冲突会造出 24 个假阳那种噪音。
 *   · **无时钟、无随机**：同一目录跑两次结果一致（可复算）。
 */

/** 一条技能的审计输入（由薄 I/O 层从盘上读出来喂进来）。 */
export interface SkillRecord {
  /** 目录名（索引键） */
  dir: string
  /** frontmatter `name`（空串 = 缺 frontmatter 或没写 name） */
  name: string
  /** frontmatter `description`（空串 = 没写） */
  description: string
  /** SKILL.md 正文字符数 */
  chars: number
  /** 正文头部（用于正文级相似度；调用方截断，缺省取前 4000 字符） */
  bodyHead?: string
  /** 是否含显式触发条件段（由 `hasTriggerSection` 判定后传入，避免二次解析） */
  hasTrigger?: boolean
}

/** 一对技能的冗余候选。 */
export interface PairFinding {
  a: string
  b: string
  /** `duplicate-desc` = description 逐字相同；`near-duplicate-desc` = 词集高度重叠；
   *  `near-duplicate-body` = 正文 shingle 高度重叠（**回捞**捞回的，词可能不重叠） */
  kind: 'duplicate-desc' | 'near-duplicate-desc' | 'near-duplicate-body'
  score: number
  /** ★ **有意的指针**（「已熔炼进 X」「防呆指针」「保留为上游资源树」…）——
   *  论文 Table 2 的教训：No gate 的 24 个假阳就是「把本来有用的东西当冲突」。
   *  有意的占位符**不是**冗余缺陷 ⇒ 单独标记，不进「值得看」的清单。 */
  intentional: boolean
  /** ★ **证据强度**：`strong` = 正文也同源（**多证据合取**）；
   *  `weak` = 只有 description 层证据 —— ⚠ **同域技能的术语重叠是正常的**
   *  （`plugin-test` 与 `plugin-workflow` 都讲插件，词必然重叠），
   *  所以 weak 档**不是结论**，是「需要人读一眼正文才能判」的提示。
   *  ★ 这一档的由来（2026-10-15 标定）：descSim 0.15~0.19 命中 4 对，看名字职责各不相同
   *  （调试 vs 测试分层 / 客服 vs 支付）⇒ 单靠词重叠会造出论文 Table 2 里 No gate 那种假阳。 */
  severity: 'strong' | 'weak'
  /** 判据的原文证据（可复算：照这句自己去读一遍） */
  evidence: string
}

/** scope 质量缺口（论文消融第一重要的维度）。 */
export interface ScopeGap {
  dir: string
  /** `no-description`（严重：技能目录里看不见它）| `no-trigger-section`（提示：description 已承担粗粒度 scope） */
  kind: 'no-description' | 'no-trigger-section'
}

/** 结构异常。 */
export interface Anomaly {
  dir: string
  kind: 'no-frontmatter' | 'name-mismatch' | 'oversized'
  detail: string
}

export interface AuditReport {
  total: number
  pairs: PairFinding[]
  scopeGaps: ScopeGap[]
  anomalies: Anomaly[]
  stats: {
    /** 候选对总数（剪枝 + 回捞）；论文 Table 2 用同一口径对比 SF-strict / SF-final / No gate */
    candidates: number
    /** 全量两两对数 —— 报告它，才能看出剪枝省了多少 */
    allPairs: number
    /** 冗余候选里被标为「有意指针」的数量 */
    intentional: number
    /** description 总字符数（每步注入的固定开销） */
    descChars: number
  }
}

/** 判定「有意指针」的标记词 —— 命中任一即算。 */
export const INTENTIONAL_MARKERS: readonly string[] = [
  '已熔炼进',
  '防呆指针',
  '保留为上游资源树',
  '已合并进',
  '本目录保留',
  '指针；',
]

/** 触发条件段的标记词（放宽匹配：我的技能用多种措辞写「何时用」）。 */
export const TRIGGER_MARKERS: readonly string[] = [
  '**触发**',
  '**触发条件**',
  '触发条件：',
  '何时进入本技能',
  '**何时',
  '适用场景',
  '**适用范围',
  '用于：',
  '何时用',
]

/** 缺省：正文级相似度只在候选对内算，且只取正文头部这么多字符（控制开销）。 */
export const DEFAULT_BODY_HEAD = 4000
/**
 * 剪枝下限：description 词集 Jaccard 到这个值才进候选池。
 *
 * ★ **标定读数（2026-10-15 · 真实 186 技能库 · 17205 对）**：
 *   p50=0.008 · p90=0.025 · p99=0.056；`≥0.05` 235 对 · `≥0.10` 25 对 · `≥0.15` 7 对。
 *   ⚠ **旧值 `> 0` 收了 9731 对（占 56.6%）** —— 中文二元组下「沾一个共同词」（如「的」「方法」）
 *   就 > 0 ⇒ 剪枝退化，实测只省 43%，而论文 SF-final 只准入 **7.8–19%**。
 *   ⇒ 取 0.05（235 对）把「有意义的词重叠」与「沾边」分开。
 */
export const DESC_PRUNE_MIN = 0.05
/**
 * description 近重复阈值。
 *
 * ★ **标定读数**：`≥0.15` 命中 7 对（其中 3 对是逐字相同）；第 4~7 名落在 0.14–0.19
 *   （`plugin-runtime-debug↔plugin-test` 0.189 · `plugin-release↔plugin-write` 0.182 …）。
 *   ⚠ 旧值 0.35 只剩那 3 对逐字相同的 —— **浪费了 0.15~0.35 这段的分辨力**。
 *   ⇒ 取 0.15：宁可多看 4 对（假阳代价 = 我读一眼），也不错漏
 *     （论文判据②：严剪漏 24/60，Recall .600）。⚠ 同域技能的术语重叠**是正常的**，
 *     所以命中的对只标「值得看」，**不标缺陷**。
 */
export const NEAR_DUP_DESC_THRESHOLD = 0.15
/**
 * 正文 shingle 相似度阈值。
 *
 * ★ **标定读数**：`≥0.45` 命中 3 对（0.919 / 0.858 / 0.847）；**第 4 名 0.148 断崖**。
 *   ⇒ 0.45 正好落在断崖中间 —— 这个缺省值是**量出来的**，不是拍的。
 */
export const NEAR_DUP_BODY_THRESHOLD = 0.45
/** 超过这个字符数 ⇒ 标 oversized（⚠ **只报告，不建议压缩** —— 见头注判据④） */
export const OVERSIZED_CHARS = 30000

/**
 * 解析 SKILL.md 的 frontmatter。**不抛异常**（插件与宿主同进程，逃逸异常会杀死 web）。
 * 返回 `hasFrontmatter=false` 时 name/description 均为空串 —— 「没写」与「写了空」在读数上分开。
 */
export function parseFrontmatter(text: string): {
  name: string
  description: string
  hasFrontmatter: boolean
  body: string
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m === null) return { name: '', description: '', hasFrontmatter: false, body: text }
  const fm = m[1] ?? ''
  const pick = (key: string): string => {
    const r = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(fm)
    return r === null ? '' : (r[1] ?? '').trim()
  }
  return {
    name: pick('name'),
    description: pick('description'),
    hasFrontmatter: true,
    body: text.slice(m[0].length),
  }
}

/** 命中任一标记词即算「有意指针」。 */
export function isIntentionalPointer(...texts: readonly string[]): boolean {
  const all = texts.join('\n')
  return INTENTIONAL_MARKERS.some((k) => all.includes(k))
}

/** 是否含显式触发条件段。 */
export function hasTriggerSection(text: string): boolean {
  return TRIGGER_MARKERS.some((k) => text.includes(k))
}

/**
 * 域键：把技能名归到「同一族」——论文结构化 gate（`τi = τj ∧ σi ∩ σj ≠ ∅`）在我这一侧的代理量。
 *
 * 我这一侧没有显式 type/scope，最接近的是**命名域**：
 *   · 三段以上取前两段（`dsh-agent-memory` ⇒ `dsh-agent`）
 *   · 两段取第一段（`plugin-test` ⇒ `plugin`）
 *
 * ⚠ 实测校准（2026-10-15 · 真实 186 技能库）：旧判据「第一段相同」把 60+ 个 `dsh-*` 全算一族
 *   ⇒ 剪枝退化（候选 9731/17205，只省 43%；论文 SF-final 只准入 7.8–19%）。
 *   取前两段后 `dsh-agent-*` 与 `dsh-plugin-*` 分开 —— 符合直觉，也把候选压回论文量级。
 */
export function domainKey(dir: string): string {
  const s = dir.split('-')
  return s.length >= 3 ? (s[0] ?? dir) + '-' + (s[1] ?? '') : (s[0] ?? dir)
}

/** 词集：英文小写词（≥3）+ 中文二元组（连续汉字的 2-gram）——中英混合语料下比整段中文词更稳。 */
export function tokenSet(s: string): Set<string> {
  const out = new Set<string>()
  const lower = s.toLowerCase()
  for (const w of lower.match(/[a-z][a-z0-9-]{2,}/g) ?? []) out.add(w)
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 2) { out.add(run); continue }
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

/** Jaccard（空集 ⇒ 0，不抛） */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 字符 shingle 集合（k=5，跨空白折叠）——用于正文级相似度（**回捞**的主力）。 */
export function shingleSet(s: string, k = 5): Set<string> {
  const norm = s.replace(/\s+/g, ' ')
  const out = new Set<string>()
  if (norm.length < k) { if (norm.length > 0) out.add(norm); return out }
  for (let i = 0; i + k <= norm.length; i++) out.add(norm.slice(i, i + k))
  return out
}

/** 正文相似度（shingle Jaccard）。 */
export function bodySimilarity(a: string, b: string, k = 5): number {
  return jaccard(shingleSet(a, k), shingleSet(b, k))
}

/**
 * 审计整个技能库。
 *
 * 候选生成照论文的两段式（**剪枝 + 回捞**，不是全比）：
 *   · **结构剪枝（strict）**：同前缀（`a-b` / `a-c` 共享首段）或 description 词集有交集；
 *   · **选择性回捞（fallback）**：正文 shingle 相似度 ≥ 阈值 —— 捞回「词不重叠但讲同一件事」的对
 *     （论文 Table 9：漏检前两位是 type / scope 的**表示质量**，正是词法判据看不见的地方）。
 *
 * @param records 技能记录（调用方读盘）
 * @param opts    阈值覆盖（缺省取本模块常量；⚠ 论文 A.5：阈值 0.50→0.80 的 Success 变化 ≤.006
 *                ⇒ **不敏感**，不要为调参花时间）
 */
export function auditSkills(records: readonly SkillRecord[], opts: {
  nearDupDesc?: number
  nearDupBody?: number
  oversized?: number
  /** 剪枝下限（缺省 `DESC_PRUNE_MIN` = 0.05，标定依据见该常量） */
  descPrune?: number
} = {}): AuditReport {
  const descPrune = opts.descPrune ?? DESC_PRUNE_MIN
  const nearDesc = opts.nearDupDesc ?? NEAR_DUP_DESC_THRESHOLD
  const nearBody = opts.nearDupBody ?? NEAR_DUP_BODY_THRESHOLD
  const oversized = opts.oversized ?? OVERSIZED_CHARS

  const recs = [...records].sort((x, y) => (x.dir < y.dir ? -1 : x.dir > y.dir ? 1 : 0))
  const tok = new Map<string, Set<string>>()
  for (const r of recs) tok.set(r.dir, tokenSet(r.description))

  const pairs: PairFinding[] = []
  let candidates = 0

  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      const a = recs[i]!, b = recs[j]!
      const ta = tok.get(a.dir)!, tb = tok.get(b.dir)!
      const descSame = a.description !== '' && a.description === b.description
      const descSim = jaccard(ta, tb)

      // ── 结构剪枝：同域 ∪ **有意义的**词重叠 ──────────────────────────────
      // ⚠ 旧写法 `descSim > 0` 在中文二元组下退化成「沾一个共同词就进」（实测 9731/17205，
      //   只省 43%）⇒ 剪枝形同虚设，退到论文警告的 No gate 那一侧。取 0.05（标定 235 对）
      //   才算「有意义的词重叠」。
      const strict = domainKey(a.dir) === domainKey(b.dir) || descSim >= descPrune
      // ── 正文级相似度：**所有候选对都算**（不只回捞的）──────────────────────
      // ★ 修（2026-10-15 由测试 D2 抓到）：旧写法只在 `!strict` 时算 ⇒
      //   「进了候选池但 descSim 不够」的对**既不算 near-desc 也不算回捞** ⇒ **静默消失**。
      //   「进了池子却什么都不报」= 白看一遍，还让 `candidates` 这个读数虚高。
      //   论文的 `E = Estrict ∪ Efb` 说的是**候选集怎么来**；判定阶段不该再按来源分流。
      let bodySim = 0
      if (a.bodyHead !== undefined && b.bodyHead !== undefined) {
        bodySim = bodySimilarity(a.bodyHead, b.bodyHead)
      }
      const fb = !strict && bodySim >= nearBody
      if (!strict && !fb) continue
      candidates++

      const intentional = isIntentionalPointer(a.description, b.description, a.bodyHead ?? '', b.bodyHead ?? '')
      // ★ 证据强度：**多证据合取** —— 只有 description 层证据的对不叫结论（同域术语重叠是正常的）
      const severity: 'strong' | 'weak' = bodySim >= nearBody ? 'strong' : 'weak'
      if (descSame) {
        pairs.push({
          a: a.dir, b: b.dir, kind: 'duplicate-desc', score: 1, intentional, severity,
          evidence: '两条 description 逐字相同（' + a.description.slice(0, 60) + '…）',
        })
      } else if (strict && descSim >= nearDesc) {
        pairs.push({
          a: a.dir, b: b.dir, kind: 'near-duplicate-desc', score: descSim, intentional, severity,
          evidence: 'description 词集 Jaccard=' + descSim.toFixed(3) + '（阈值 ' + nearDesc + '）',
        })
      } else if (bodySim >= nearBody) {
        pairs.push({
          a: a.dir, b: b.dir, kind: 'near-duplicate-body', score: bodySim, intentional, severity,
          evidence: (fb ? '**回捞**：' : '候选池内：') + '正文 5-gram Jaccard=' + bodySim.toFixed(3)
            + '（阈值 ' + nearBody + (fb ? '，词集无交集' : '') + '）',
        })
      }
    }
  }

  const scopeGaps: ScopeGap[] = []
  for (const r of recs) {
    if (r.description === '') scopeGaps.push({ dir: r.dir, kind: 'no-description' })
    else if (r.hasTrigger === false) scopeGaps.push({ dir: r.dir, kind: 'no-trigger-section' })
  }

  const anomalies: Anomaly[] = []
  for (const r of recs) {
    if (r.name === '' && r.description === '') {
      anomalies.push({ dir: r.dir, kind: 'no-frontmatter', detail: '读不到 frontmatter（name 与 description 都空）' })
    } else if (r.name !== '' && r.name !== r.dir) {
      anomalies.push({ dir: r.dir, kind: 'name-mismatch', detail: 'frontmatter name=' + r.name + ' ≠ 目录名' })
    }
    if (r.chars > oversized) {
      anomalies.push({
        dir: r.dir, kind: 'oversized',
        detail: r.chars + ' 字符（> ' + oversized + '）——⚠ **只报告不建议压缩**：论文消融显示去压缩的 Success 反而更高（.811 vs .799）',
      })
    }
  }

  const n = recs.length
  return {
    total: n,
    pairs: pairs.sort((x, y) => y.score - x.score),
    scopeGaps,
    anomalies,
    stats: {
      candidates,
      // ⚠ `n < 2` 时 `(n*(n-1))/2` 会算出 `-0`（n=0 ⇒ 0×-1÷2）—— 严格相等下 `-0 !== 0`，
      //   而「空库的对数」在读数上必须是 0（测试 G4 抓到）。
      allPairs: n < 2 ? 0 : (n * (n - 1)) / 2,
      intentional: pairs.filter((p) => p.intentional).length,
      descChars: recs.reduce((s, r) => s + r.description.length, 0),
    },
  }
}

/** 渲染成可读报告（工具返回体）。**排序稳定**（分数降序 + 名称升序）⇒ 可复算。 */
export function renderAudit(rep: AuditReport, opts: { maxRows?: number } = {}): string {
  const max = opts.maxRows ?? 15
  const L: string[] = []
  const saved = rep.stats.allPairs > 0
    ? '（全量两两 ' + rep.stats.allPairs + ' 对 ⇒ 剪枝+回捞后只看 ' + rep.stats.candidates + ' 对，省 '
      + Math.round((1 - rep.stats.candidates / rep.stats.allPairs) * 100) + '%）'
    : ''
  L.push('技能库审计｜共 ' + rep.total + ' 个技能 · description 合计 ' + rep.stats.descChars + ' 字符'
    + '（每步注入的固定开销）')
  L.push('候选对 ' + rep.stats.candidates + ' ' + saved)

  const strong = rep.pairs.filter((p) => !p.intentional && p.severity === 'strong')
  const weak = rep.pairs.filter((p) => !p.intentional && p.severity === 'weak')
  const intentionalPairs = rep.pairs.filter((p) => p.intentional)
  L.push('')
  L.push('≡ 冗余候选｜**强证据 ' + strong.length + ' 对**（正文也同源）· 术语重叠 ' + weak.length
    + ' 对（需人读）· 有意指针 ' + intentionalPairs.length + ' 对（不算缺陷）')
  if (strong.length > 0) {
    L.push('  ★ 强证据（**多证据合取**：description 与正文都同源）：')
    for (const p of strong.slice(0, max)) {
      L.push('  • [' + p.kind + ' ' + p.score.toFixed(3) + '] ' + p.a + ' ↔ ' + p.b + '\n      ' + p.evidence)
    }
    if (strong.length > max) L.push('  …（还有 ' + (strong.length - max) + ' 对）')
  }
  if (weak.length > 0) {
    L.push('  ⓘ 术语重叠 —— **只有 description 层证据，不是结论**：同域技能共享术语是正常的')
    L.push('    （`plugin-test` 与 `plugin-workflow` 都讲插件，词必然重叠）。判冗余要读正文的行为语义：')
    for (const p of weak.slice(0, max)) {
      L.push('      · ' + p.a + ' ↔ ' + p.b + '（Jaccard ' + p.score.toFixed(3) + '）')
    }
    if (weak.length > max) L.push('      …（还有 ' + (weak.length - max) + ' 对）')
  }
  if (strong.length === 0 && weak.length === 0) {
    L.push('  （无 —— 但先看下面「有意指针」那段：它们是被判据**主动排除**的，不是没检出）')
  }
  if (intentionalPairs.length > 0) {
    L.push('  ⓘ 有意指针 ' + intentionalPairs.length + ' 对（防呆占位符 —— 论文 Table 2 的教训：'
      + '把本来有用的东西当冲突去改，就是 No gate 那 24 个假阳）')
    for (const p of intentionalPairs.slice(0, 6)) L.push('      · ' + p.a + ' ↔ ' + p.b)
  }

  const noDesc = rep.scopeGaps.filter((g) => g.kind === 'no-description')
  const noTrig = rep.scopeGaps.filter((g) => g.kind === 'no-trigger-section')
  L.push('')
  L.push('scope 质量（论文消融第一重要的维度）｜无 description ' + noDesc.length
    + ' · 无显式触发段 ' + noTrig.length + '/' + rep.total)
  if (noDesc.length > 0) for (const g of noDesc.slice(0, max)) L.push('  ✖ ' + g.dir + '：**无 description** ⇒ 技能目录里看不见它')
  L.push('  ⓘ 「无显式触发段」是**提示不是缺陷**：description 本身已承担粗粒度 scope。'
    + '要补的是「何时**不**适用」与「与谁重叠」——那是 description 装不下的部分。')

  L.push('')
  L.push('结构异常｜' + rep.anomalies.length + ' 条')
  for (const a of rep.anomalies.slice(0, max)) L.push('  • [' + a.kind + '] ' + a.dir + '：' + a.detail)
  if (rep.anomalies.length > max) L.push('  …（还有 ' + (rep.anomalies.length - max) + ' 条）')

  L.push('')
  L.push('⚠ 边界：本审计**不判硬/软冲突** —— 那要读两条指令的行为语义，词法判据到不了那一层。'
    + '本层只报「冗余候选 + scope 缺口 + 结构异常」，冲突留给 LLM/人读（论文的 Classifier+Verifier 那一环）。')
  return L.join('\n')
}
