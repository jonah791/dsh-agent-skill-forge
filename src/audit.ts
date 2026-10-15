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

import { createHash } from 'node:crypto'

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

/* ── 裁决台账（人读结论的留痕）────────────────────────────────────────────────
 *
 * 存在理由（2026-10-15）：审计器每轮报 4 对「术语重叠（需人读）」，我读完判定 4/4 **互补**
 *   （诊断 ≠ 验证 · 生命周期相邻 · 路由层明写不复制规则 · 工时口径 vs 收付款链路）。
 *   ⚠ 但那个结论**只活在当次会话里** —— 下一轮它照样报「需人读」，未来的我再读一遍。
 *   §5.39 形态：规则层反复失效时换机制承载 ⇒ 把裁决落到台账，**靠流程不靠记性**。
 *
 * ★ 核心性质：裁决**不是豁免权，是「这一版内容我读过」**。
 *   每条裁决带**内容指纹**（description + 正文头部 —— 与审计判定**同域**）；
 *   任一方内容变了 ⇒ 指纹不匹配 ⇒ 该对**自动回到「需人读」**（进 `staleVerdicts`）。
 *   ⇒ 防的是「拿一份过期的判断继续豁免」—— 那比没裁决更坏（假绿）。
 */

/** 技能对的稳定键：**与顺序无关**（`a↔b` 与 `b↔a` 是同一条裁决）。
 *  ⚠ 分隔符用 `|`：技能名是 kebab-case，不含它 ⇒ 无歧义，且人读友好。 */
export function pairKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a
}

/** 一条裁决（台账的值；台账本体是 `Record<pairKey, PairVerdict>`）。 */
export interface PairVerdict {
  /** `complementary` = 职责互补（不该合并）· `redundant` = 真冗余（该合并）·
   *  `intentional` = 有意指针（防呆占位符，正文没写标记词时由人补判） */
  verdict: 'complementary' | 'redundant' | 'intentional'
  /** 判定依据（**一句话说清「凭什么」**——未来的我要靠它复算，不能只写「已看过」） */
  reason: string
  /**
   * ★ 各侧内容指纹，**按 `pairKey` 的字典序**（`[小, 大]`）。
   *
   * 为什么分侧存而不是拼成一个串：**「哪一侧变了」必须直接可算** ——
   * 拼串再拆回来要复现写入时的排序逻辑，一旦排序口径漂移就静默算错。
   * 分侧存 ⇒ `old[0] !== now.get(small)` 一眼定侧，无需解析。
   */
  fingerprints: [string, string]
  /** 裁决时刻（ISO；人读线索，不参与判据） */
  at: string
}

/** 单条技能的内容指纹 —— **与审计判定同域**（审计用 description 判档、用 bodyHead 判回捞）。 */
export function contentFingerprint(rec: { description: string; bodyHead?: string }): string {
  return createHash('sha256')
    .update(rec.description + '\u0000' + (rec.bodyHead ?? ''))
    .digest('hex')
    .slice(0, 12)
}

/**
 * 一对的指纹（按 `pairKey` 字典序排列）—— 与 `PairVerdict.fingerprints` **同一口径**。
 * @returns `[小的一侧, 大的一侧]`；键不完整时返回空数组（调用方按「无效」处理）
 */
export function pairFingerprints(
  a: string, b: string,
  byDir: ReadonlyMap<string, { description: string; bodyHead?: string }>,
): string[] {
  const ra = byDir.get(a)
  const rb = byDir.get(b)
  if (ra === undefined || rb === undefined) return []
  const [small, big] = a < b ? [ra, rb] : [rb, ra]
  return [contentFingerprint(small), contentFingerprint(big)]
}

/** 把 `pairKey` 拆回两侧（`|` 不在技能名里 ⇒ 无歧义）。坏键 ⇒ `[undefined, undefined]`。 */
export function splitPairKey(key: string): [string | undefined, string | undefined] {
  const i = key.indexOf('|')
  if (i <= 0 || i >= key.length - 1) return [undefined, undefined]
  return [key.slice(0, i), key.slice(i + 1)]
}

/** 已裁决的对（指纹仍匹配 ⇒ 从「需人读」移出）。 */
export interface ResolvedPair {
  a: string
  b: string
  verdict: PairVerdict['verdict']
  reason: string
  at: string
  /** 原档位（裁决前它落在哪一档——便于事后回看「我裁掉的是什么」） */
  severity: 'strong' | 'weak'
}

/**
 * 陈旧裁决 —— 台账里有、仍是候选，但**内容指纹对不上**（任一方描述/正文变了）。
 *
 * ⚠ **它是「必须可见」的一档**：此时该对**已自动回到「需人读」**（仍出现在 `pairs` 里），
 *   而这里记下「为什么豁免失效」——否则读的人只会看到它突然又冒出来，看不出是自己改过内容。
 *   ⇒ 防的是「拿一份过期的判断继续豁免」，那比没裁决更坏（假绿）。
 */
export interface StaleVerdict {
  a: string
  b: string
  verdict: PairVerdict['verdict']
  /** 当初的判定依据（人读线索） */
  reason: string
  at: string
  /** 哪一侧内容变了（诊断：`a` / `b` / `both`）—— 没有这个就只知道「失效了」 */
  changed: 'a' | 'b' | 'both'
}

/**
 * 孤裁决 —— 台账里有、本次候选对里没有。
 *
 * ⚠ **两型必须分开**（「空必须分型」的一贯纪律）：
 *   · `no-longer-similar`：两侧技能都在库，但已不再进候选 ⇒ 正常（将来又相似时裁决仍有效）
 *   · `skill-missing`：至少一侧已不在库里 ⇒ 悬空引用（该清）
 *   合成一个数就等于替读的人决定「这些要不要清」。
 */
export interface OrphanVerdict {
  key: string
  verdict: PairVerdict['verdict']
  reason: 'no-longer-similar' | 'skill-missing'
}

/** scope 质量缺口（论文消融第一重要的维度）。 */
export interface ScopeGap {
  dir: string
  /** `no-description`（严重：技能目录里看不见它）| `no-trigger-section`（提示：description 已承担粗粒度 scope） */
  kind: 'no-description' | 'no-trigger-section'
}

/**
 * scope 风险 —— **可行动**的清单，替代「无触发段 N/186」这个没有行动性的读数。
 *
 * 判据：`description 无 scope 信号` ∧ `存在词法近邻`（合取，两个条件都要）。
 * 依据：论文消融第一维是 scope（去 scope normalization ⇒ Success .799→.768，跌幅最大），
 *   而 **scope 的作用是「区分」** —— 只有存在混淆可能时，缺 scope 才有害。
 *   孤立域技能（词法上无近邻）缺触发词不影响选择 ⇒ **不进清单**（否则 133 条全是待办 = 没有待办）。
 *
 * ⚠ 近邻只算**非 intentional** 的对：`dsh-benchmark-case ↔ dsh-upgrade-audit ↔ plugin-upgrade`
 *   三条 description 逐字相同（Jaccard=1.0），那是**有意**的防呆占位符，不是 scope 缺陷。
 */
export interface ScopeRisk {
  dir: string
  /** 最近的词法近邻（非 intentional 对里的最大 Jaccard） */
  maxNeighbor: number
  /** 那个近邻是谁 */
  neighbor: string
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
  /** scope 风险（无信号 ∧ 有近邻）—— **可行动清单**，按近邻相似度降序 */
  scopeRisks: ScopeRisk[]
  anomalies: Anomaly[]
  /** ★ 已裁决且**指纹仍匹配**的对（从「需人读」移出——裁决不是豁免权，是「这一版内容我读过」） */
  resolved: ResolvedPair[]
  /** ★ 裁决已失效的对（内容变了 ⇒ 自动回到「需人读」；**必须可见**，不许静默恢复） */
  staleVerdicts: StaleVerdict[]
  /** ★ 孤裁决（台账里有、本次候选对里没有）—— 两型分开，见 `OrphanVerdict` */
  orphanVerdicts: OrphanVerdict[]
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

/**
 * description 层的「何时用」信号词 —— **只有这些才算 scope 声明**。
 *
 * ★ **标定读数（2026-10-15 · 真实 186 技能库 · 人读逐条核对）**：
 *   宽松表（含裸 `用于` / `触发`）命中 15 条，**精确率仅 8/15** —— 假阳全是**内容特征**被误读：
 *   `规则有适用域`（comparative-config-experiment）· `**触发可达**`（mechanism-fit-validation）·
 *   `能否用于自己的框架`（external-corpus-fitness）· `提醒有触发条件`（personal-assistant-ops）。
 *   ⇒ 取严：这里下游是**写操作**（补 description），假阳 = 白改一条 + **永久**加长每步注入开销；
 *     假阴性 = 漏一个该补的（但它仍然可发现，只是不如最优）—— 代价不对称（AGENTS.md §5.9）。
 *   去掉裸 `用于` / `触发` 后 **8/8 全真**；漏掉 `用于迭代预设…`（context-effect-research）两例，
 *   但它们无词法近邻 ⇒ 不进高优先清单，漏判无后果。
 *
 * ⚠ 本表只查 **description**（技能目录里唯一被读到的一句）；正文级的触发段走 `TRIGGER_MARKERS`。
 */
export const SCOPE_SIGNAL_MARKERS: readonly string[] = [
  'use when',
  'use for',
  'use this',
  'when to use',
  '何时用',
  '何时别',
  '何时不',
  '适用于',
  '适用场景',
  '什么时候用',
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
 * ⚠ **IDF 加权的负结果（2026-10-15 · 不要重试）**。
 *
 * 动机：模板词制造虚假相似度 —— 实测 `判据` 出现在 **87/186** 个技能的 description 里（df=47%），
 *   `实测` 54 · `纪律` 43。直觉是「按信息量加权，模板词自动降权」。
 *
 * 量完的读数（186 技能 · 17205 对 · 脚本读全部 description 算 df → 加权交/加权并）：
 *   · 值域确实被压低：被报的 4 对降 22–27%（0.189→0.147 · 0.182→0.141 · 0.161→0.117 · 0.158→0.127）；
 *   · 但**排名几乎不变**（4→4 · 5→5 · 6→7 · 7→6）—— IDF 是**全局缩放**，不改变相对排序；
 *   · 阈值敏感度：`≥0.05` 235→64 对，`≥0.15` 7→3 对（那 3 对是逐字相同的有意指针）。
 *   ⇒ 对「减少假阳」**无实质帮助**，不值得动判据。
 *
 * 结论：模板词污染是**真的**，但它不是假阳的主因 —— 那几对的相似度主要来自**真实的领域词重叠**
 *   （`plugin-*` 都讲插件），而**同域共享术语是正常的**（所以本档只标「值得看」，不标缺陷）。
 */
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

/** 是否含显式触发条件段（**正文**级，查全文）。 */
export function hasTriggerSection(text: string): boolean {
  return TRIGGER_MARKERS.some((k) => text.includes(k))
}

/**
 * description 是否声明了「何时用」（**description** 级 —— 技能目录里唯一被读到的一句）。
 *
 * ⚠ 与 `hasTriggerSection` 的域**不同**，两者不可互相替代：后者查正文全文，本函数只查 description。
 *   实测 `customer-support-ops` 正文有触发段、description 没有 —— 而读者（包括未来的我）
 *   在技能目录里**只看得见 description**，正文常没人翻（技能维护规范 §3.1）。
 */
export function hasScopeSignal(description: string): boolean {
  const s = description.toLowerCase()
  return SCOPE_SIGNAL_MARKERS.some((k) => s.includes(k))
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
  /** ★ 裁决台账（`pairKey` → 裁决）。缺省 `{}` = 无裁决（行为与加台账前**逐字一致**——
   *  ⚠ 向后兼容硬约束：没台账时 `resolved`/`staleVerdicts`/`orphanVerdicts` 全空，报告不多一行。 */
  ledger?: Readonly<Record<string, PairVerdict>>
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

  // ── scope 风险：无信号 ∧ 有近邻（**合取**）────────────────────────────────
  // 为什么是合取：scope 的作用是「区分」——孤立域技能缺触发词不影响选择（133 条全列 = 没有待办）。
  // ⚠ 近邻只取 **description 层**且 **非 intentional** 的对：
  //   · body-kind 的 `score` 是正文相似度，不是词法近邻（拿它当门槛是串了尺子）；
  //   · 有意指针（`dsh-benchmark-case ↔ dsh-upgrade-audit ↔ plugin-upgrade` 逐字相同）是**有意**的。
  const best = new Map<string, { sim: number; who: string }>()
  for (const p of pairs) {
    if (p.intentional) continue
    if (p.kind !== 'duplicate-desc' && p.kind !== 'near-duplicate-desc') continue
    const sides: ReadonlyArray<readonly [string, string]> = [[p.a, p.b], [p.b, p.a]]
    for (const [me, other] of sides) {
      const cur = best.get(me)
      if (cur === undefined || p.score > cur.sim) best.set(me, { sim: p.score, who: other })
    }
  }
  const scopeRisks: ScopeRisk[] = []
  for (const r of recs) {
    if (r.description === '' || hasScopeSignal(r.description)) continue
    const b = best.get(r.dir)
    if (b === undefined) continue
    scopeRisks.push({ dir: r.dir, maxNeighbor: b.sim, neighbor: b.who })
  }
  scopeRisks.sort((x, y) => y.maxNeighbor - x.maxNeighbor || (x.dir < y.dir ? -1 : 1))

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

  // ── 裁决台账对账 ──────────────────────────────────────────────────────────
  // 三档互不掩盖（「空必须分型」）：resolved（指纹匹配 ⇒ 从「需人读」移出）·
  // stale（仍是候选但指纹不匹配 ⇒ **回落到需人读**，并记下是哪一侧变了）· orphan（本次候选里没有）。
  const byDir = new Map<string, SkillRecord>()
  for (const r of recs) byDir.set(r.dir, r)
  const candidateKeys = new Set<string>()
  for (const p of pairs) candidateKeys.add(pairKey(p.a, p.b))

  const resolved: ResolvedPair[] = []
  const staleVerdicts: StaleVerdict[] = []
  const ledger = opts.ledger ?? {}
  for (const [key, v] of Object.entries(ledger)) {
    const [a, b] = splitPairKey(key)
    if (a === undefined || b === undefined) continue // 坏键：不猜（下面的 orphan 也不认它）
    const ra = byDir.get(a)
    const rb = byDir.get(b)
    if (ra === undefined || rb === undefined) continue // 缺一侧 ⇒ orphan 的 `skill-missing`
    const pair = pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))
    if (pair === undefined) continue // 不是候选 ⇒ orphan 的 `no-longer-similar`
    const now = pairFingerprints(a, b, byDir) // 按 pairKey 字典序 —— 与写入同一口径
    const old = v.fingerprints
    // 台账里形状不对的（旧版/手改）⇒ 一律算失效（**不静默接受**——假绿比多做一次人读更坏）
    const okShape = Array.isArray(old) && old.length === 2
    // 逐侧比对（分侧存的意义就在这：哪一侧变了一目了然）
    const aChanged = !okShape || old[0] !== now[0]
    const bChanged = !okShape || old[1] !== now[1]
    if (!aChanged && !bChanged) {
      resolved.push({ a: ra.dir, b: rb.dir, verdict: v.verdict, reason: v.reason, at: v.at, severity: pair.severity })
    } else {
      staleVerdicts.push({
        a: ra.dir, b: rb.dir, verdict: v.verdict, reason: v.reason, at: v.at,
        changed: aChanged && bChanged ? 'both' : (aChanged ? 'a' : 'b'),
      })
    }
  }

  const orphanVerdicts: OrphanVerdict[] = []
  for (const [key, v] of Object.entries(ledger)) {
    if (candidateKeys.has(key)) continue
    const [a, b] = splitPairKey(key)
    const missing = (a !== undefined && !byDir.has(a)) || (b !== undefined && !byDir.has(b))
    orphanVerdicts.push({
      key, verdict: v.verdict,
      reason: missing ? 'skill-missing' : 'no-longer-similar',
    })
  }
  orphanVerdicts.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  staleVerdicts.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0))
  resolved.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0))

  return {
    total: n,
    pairs: pairs.sort((x, y) => y.score - x.score),
    scopeGaps,
    scopeRisks,
    anomalies,
    resolved,
    staleVerdicts,
    orphanVerdicts,
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
  const weakAll = rep.pairs.filter((p) => !p.intentional && p.severity === 'weak')
  const intentionalPairs = rep.pairs.filter((p) => p.intentional)
  // ★ 已裁决且指纹仍匹配的对，**从「需人读」移出**（裁决 = 「这一版内容我读过」）
  const resolvedKeys = new Set(rep.resolved.map((r) => pairKey(r.a, r.b)))
  const weak = weakAll.filter((p) => !resolvedKeys.has(pairKey(p.a, p.b)))
  L.push('')
  L.push('≡ 冗余候选｜**强证据 ' + strong.length + ' 对**（正文也同源）· 术语重叠 ' + weak.length
    + ' 对（需人读）· 已裁决 ' + rep.resolved.length + ' 对 · 有意指针 ' + intentionalPairs.length + ' 对（不算缺陷）')
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
  // ── 已裁决（从上面那档移出；裁决依据必须可见——否则等于「删掉了就不管了」）──────────
  if (rep.resolved.length > 0) {
    L.push('  ✔ 已裁决 ' + rep.resolved.length + ' 对（**指纹仍匹配** ⇒ 从「需人读」移出）：')
    for (const r of rep.resolved.slice(0, max)) {
      L.push('      · [' + r.verdict + '] ' + r.a + ' ↔ ' + r.b + ' —— ' + r.reason)
    }
    if (rep.resolved.length > max) L.push('      …（还有 ' + (rep.resolved.length - max) + ' 对）')
  }
  // ── 陈旧裁决（内容变了 ⇒ 自动回到「需人读」）——**必须醒目** ──────────────────────
  if (rep.staleVerdicts.length > 0) {
    L.push('  ⚠ **裁决已失效 ' + rep.staleVerdicts.length + ' 对**（内容变过 ⇒ 已自动回到「需人读」，'
      + '它们**仍在上面那档里**——裁决不是永久豁免）：')
    for (const s of rep.staleVerdicts.slice(0, max)) {
      L.push('      · ' + s.a + ' ↔ ' + s.b + '（' + s.changed + ' 侧内容变过；原判 ' + s.verdict + ' @' + s.at + '）')
    }
  }
  if (strong.length === 0 && weak.length === 0) {
    L.push('  （需人读档为空 —— 但先看「有意指针」与「已裁决」两段：'
      + '它们是被判据**主动排除**或被裁决**处置过**的，不是没检出）')
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
  // ── 可行动清单：无信号 ∧ 有近邻（合取）────────────────────────────────────
  if (rep.scopeRisks.length > 0) {
    L.push('  ★ **高优先（最易选错）' + rep.scopeRisks.length + ' 条** —— description 里没有「何时用」，'
      + '而词法上又有近邻（门槛 ' + NEAR_DUP_DESC_THRESHOLD + '，与冗余档**同一把尺子**）：')
    for (const s of rep.scopeRisks.slice(0, max)) {
      L.push('      · ' + s.dir + '（近邻 ' + s.neighbor + ' ' + s.maxNeighbor.toFixed(3) + '）')
    }
    if (rep.scopeRisks.length > max) L.push('      …（还有 ' + (rep.scopeRisks.length - max) + ' 条）')
    L.push('    ⇒ 动作：把正文里**已有**的边界声明（反定位「不做 X → 归谁」）提升到 description')
  }
  L.push('  ⓘ 其余 ' + (rep.total - noDesc.length - rep.scopeRisks.length) + ' 条**不需要动**：'
    + '要么 description 已声明「何时用」，要么词法上无近邻（域内孤立）。'
    + 'scope 的作用是**区分** —— 没有混淆可能时补它没有收益（否则 133 条全是待办 = 没有待办）。')

  L.push('')
  L.push('结构异常｜' + rep.anomalies.length + ' 条')
  for (const a of rep.anomalies.slice(0, max)) L.push('  • [' + a.kind + '] ' + a.dir + '：' + a.detail)
  if (rep.anomalies.length > max) L.push('  …（还有 ' + (rep.anomalies.length - max) + ' 条）')

  // ── 孤裁决（台账里有、本次候选没有）—— **两型分开报** ────────────────────────────
  if (rep.orphanVerdicts.length > 0) {
    const missing = rep.orphanVerdicts.filter((o) => o.reason === 'skill-missing')
    const gone = rep.orphanVerdicts.filter((o) => o.reason === 'no-longer-similar')
    L.push('')
    L.push('裁决台账对账｜孤裁决 ' + rep.orphanVerdicts.length + ' 条'
      + '（台账里有、本次候选对里没有）——两型不同处置，**不合报**：')
    if (missing.length > 0) {
      L.push('  ✖ skill-missing ' + missing.length + ' 条（至少一侧已不在库 ⇒ **悬空引用，该清**）：')
      for (const o of missing.slice(0, max)) L.push('      · ' + o.key + '（' + o.verdict + '）')
    }
    if (gone.length > 0) {
      L.push('  ⓘ no-longer-similar ' + gone.length + ' 条（两侧都在库、只是不再相似 ⇒ 正常，'
        + '将来又相似时裁决仍有效）：')
      for (const o of gone.slice(0, max)) L.push('      · ' + o.key + '（' + o.verdict + '）')
    }
  }

  L.push('')
  L.push('⚠ 边界：本审计**不判硬/软冲突** —— 那要读两条指令的行为语义，词法判据到不了那一层。'
    + '本层只报「冗余候选 + scope 缺口 + 结构异常」，冲突留给 LLM/人读（论文的 Classifier+Verifier 那一环）。')
  return L.join('\n')
}
