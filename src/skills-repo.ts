/**
 * 技能仓的自动提交与脏检测（lh-3482d40b 的 ① 与 ③，2026-11-12）。
 *
 * ## 要解决的两个洞
 *
 * **① 「改完技能自动提交」没有必经挂点。** `skill_commit` 是技能目录的**唯一写入口**，
 * 但它只写文件、不提交 ⇒ 回滚点停在最后一次手动提交上。挂在 `skill_commit` 内部是唯一
 * 不靠记性的位置。
 *
 * **③ 外部工具改写技能目录时，仓会脏而没人提交。** 有的工具（第三方脚本、手工编辑）
 * 不走 `skill_commit`。若不看，脏会一直累积到某次有人想起来为止 —— 与「44 仓静默积压
 * 143 提交 / 20 天」同形（见 lh-6446b715）。
 *
 * ## 为什么「自动提交」只提交自己写的那一个路径
 *
 * 若 `git add -A`，外部工具写的**未审阅**改动会被顺手卷进提交里 —— 那就把 ③ 变成了
 * 「自动吞掉别人的改动」，比不提交更糟。所以：
 * - `commitSkillPath` 只 `git add -- <那一个文件>`，提交信息写明来源与时刻；
 * - `skillsRepoStatus` 负责把**剩余脏**报出来，让外部改动可见而不是被吞。
 *
 * ⚠ 两道闸门是**叠加**的，不要只留一道：`git commit -m … -- <path>` 的 pathspec 本身也能
 * 挡住别的文件。实测（2026-11-12 尸体测试）：只把 `add` 换成 `-A` 而**保留** commit 的
 * pathspec 时，测试**全绿** —— 因为 pathspec 把 `-A` 的后果吃掉了。所以那条测试真正钉住的是
 * 「commit 带 pathspec」；要验证区分力，尸体必须把**两处**都改成天真实现（`add -A` +
 * 无 pathspec 的 `commit`），此时才红。留着这条，免得下次有人用错的尸体宣布「测过了」。
 *
 * ## 失败不阻断
 *
 * 技能写入已经成功了，git 失败不该让它失败 —— 但也不能静默。两类失败都进返回值，
 * 由调用方拼进 `skill_commit` 的 note 里。
 */
import { spawnSync } from 'node:child_process'
import { relative, isAbsolute } from 'node:path'

/** 同步阻塞会卡住整个宿主 ⇒ 带 timeout（与 `mirror-drift.ts` 同纪律，AGENTS.md §5.24）。 */
const GIT_TIMEOUT_MS = 60000

interface GitRun {
  status: number | null
  stdout: string
  stderr: string
  /** 启动失败/超时等 —— 与「命令跑了但退出码非 0」不是一回事 */
  bootError: string | null
}

function runGit(dir: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): GitRun {
  try {
    const res = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
    const bootError = res.error !== undefined && res.error !== null
      ? ((res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        ? `git 超时（>${timeoutMs}ms）`
        : `git 启动失败：${String(res.error.message ?? res.error)}`)
      : null
    return {
      status: typeof res.status === 'number' ? res.status : null,
      stdout: typeof res.stdout === 'string' ? res.stdout : '',
      stderr: typeof res.stderr === 'string' ? res.stderr : '',
      bootError,
    }
  } catch (e) {
    return { status: null, stdout: '', stderr: '', bootError: `git 启动异常：${String(e)}` }
  }
}

export interface CommitOutcome {
  /** 这个文件现在是「已提交」状态（含「本来就没变化」与「功能不可用」两种良性情形） */
  ok: boolean
  /** 给人读的一句话，直接拼进 skill_commit 的 note */
  detail: string
}

/**
 * 提交技能目录里的**单个**文件。只 `git add` 这一个路径，不扫全仓。
 *
 * 良性情形都返回 `ok: true`（技能写入本身成功了，不该因 git 缺席而变红）：
 * 目录不是 git 仓 / 该路径无变化 / 提交成功。
 * 只有「命令跑了但失败」才 `ok: false`，且原文带 stderr 尾部。
 */
export function commitSkillPath(repoDir: string, writtenPath: string, label: string): CommitOutcome {
  const probe = runGit(repoDir, ['rev-parse', '--is-inside-work-tree'], 15000)
  if (probe.bootError !== null) return { ok: true, detail: `提交跳过（${probe.bootError}）` }
  if (probe.status !== 0) return { ok: true, detail: '提交跳过（不在 git 仓内，回滚点不覆盖这里）' }

  const rel = isAbsolute(writtenPath) ? relative(repoDir, writtenPath) : writtenPath
  if (rel.startsWith('..')) return { ok: true, detail: '提交跳过（文件不在仓内）' }

  const stage = runGit(repoDir, ['add', '--', rel], 30000)
  if (stage.bootError !== null) return { ok: true, detail: `提交跳过（${stage.bootError}）` }
  if (stage.status !== 0) {
    return { ok: false, detail: `git add 失败：${tail(stage.stderr)}` }
  }

  // 无变化 ⇒ `git diff --cached --quiet` 退出码 0。这是正常情形（内容与上次相同）。
  const staged = runGit(repoDir, ['diff', '--cached', '--quiet', '--', rel], 30000)
  if (staged.status === 0) return { ok: true, detail: '提交跳过（内容无变化）' }

  const message = `skills: ${label} 由 skill_commit 写入（${new Date().toISOString()}）`
  const commit = runGit(repoDir, ['commit', '-m', message, '--', rel], GIT_TIMEOUT_MS)
  if (commit.bootError !== null) return { ok: false, detail: `git commit ${commit.bootError}` }
  if (commit.status !== 0) return { ok: false, detail: `git commit 失败：${tail(commit.stderr)}` }
  const hash = runGit(repoDir, ['rev-parse', '--short', 'HEAD'], 15000)
  const short = hash.status === 0 ? hash.stdout.trim() : '?'
  return { ok: true, detail: `已提交 ${short}` }
}

export interface RepoStatus {
  kind: 'clean' | 'dirty' | 'unavailable'
  /** 脏文件数（kind=dirty 时有意义） */
  count: number
  /** 前几条脏文件，供人一眼看出是谁改的 */
  sample: string[]
  /** kind=unavailable 时的原因；其余为空串 */
  reason: string
}

/**
 * 报**剩余脏** —— 即「不是通过 `skill_commit` 写进来的那些改动」。
 * 这是 ③ 的读数：脏本身不是错，**脏了没人知道**才是。
 */
export function skillsRepoStatus(repoDir: string): RepoStatus {
  const probe = runGit(repoDir, ['rev-parse', '--is-inside-work-tree'], 15000)
  if (probe.bootError !== null) return { kind: 'unavailable', count: 0, sample: [], reason: probe.bootError }
  if (probe.status !== 0) return { kind: 'unavailable', count: 0, sample: [], reason: '不在 git 仓内' }
  const res = runGit(repoDir, ['status', '--porcelain'], 30000)
  if (res.bootError !== null) return { kind: 'unavailable', count: 0, sample: [], reason: res.bootError }
  if (res.status !== 0) return { kind: 'unavailable', count: 0, sample: [], reason: `git status 退出码 ${res.status}` }
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return { kind: 'clean', count: 0, sample: [], reason: '' }
  return { kind: 'dirty', count: lines.length, sample: lines.slice(0, 5).map((l) => l.trim()), reason: '' }
}

/** 纯文案：把脏读数拼成一行提示（干净/不可用都返回空串 —— 无消息即好消息）。 */
export function dirtyNotice(status: RepoStatus): string {
  if (status.kind !== 'dirty') return ''
  return `⚠ 技能仓有 ${status.count} 个未提交改动（不是 skill_commit 写的，可能是外部工具或手工编辑）：`
    + status.sample.join(' / ')
}

function tail(s: string, n = 160): string {
  const t = s.trim()
  return t.length <= n ? t : `…${t.slice(-n)}`
}
