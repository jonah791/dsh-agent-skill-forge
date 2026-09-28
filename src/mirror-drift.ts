/**
 * 镜像仓漂移只读闸门（纯解析 + 薄 I/O + 纯文案，同模块内聚）。
 *
 * **为什么存在**：技能真源（`~/.agents/skills` / `<cwd>/.agents/skills` / `$DSH_HOME/skills`）
 * 与资产仓镜像（`alice-self-assets/skills`）是两份物理副本，纪律「改完就同步」写在资产仓
 * README 里、`sync-skills.ps1` 也早就存在——却仍复发两次（2026-09-22 把改进写进镜像而加载
 * 真源；2026-09-28 积压 6 天 47 项）。⇒ **工具够了，缺的是触发点**。本模块把触发点长在
 * 「改技能时必然经过」的地方：`skill_commit` 的返回体。
 *
 * **语义边界**：
 * - **只报数，不同步**——同步是写镜像仓，属爱丽丝的决策（AGENTS.md §2.1「机制把信号送达，
 *   不代替决策」）。
 * - **判据单一真源**：漂移判定完全交给 `sync-skills.ps1 -Check`，不在此重算哈希——第二实现
 *   就是第二真源（AGENTS.md §5.22 规则 4）。
 * - **观测绝不反噬主流程**：任何失败都返回显式状态而非抛错（AGENTS.md §5.22 规则 3）。
 *
 * **四态显式**（`DriftProbe`）：`off`（未配置）/ `clean` / `drift` / `unavailable`（仪器故障）。
 * 关键在于 `unavailable` **不得**与 `clean` 合并——「读不到」伪装成「无漂移」正是 2026-09-28
 * 修掉的假绿形状（旧闸门只对账一源，同一状态报「真源独有技能 0」而事实是 4）。
 */
import { spawn, spawnSync } from 'node:child_process'

/** 漂移读数 */
export interface DriftReading {
  /** 漂移项数（权威来源是闸门退出码，`summary` 只用于显示） */
  count: number
  /** 闸门可人读的一行摘要（解析不到时为空串——不猜数字） */
  summary: string
}

/** 探测结果（四态显式） */
export type DriftProbe =
  | { kind: 'off' }
  | { kind: 'clean' }
  | { kind: 'drift'; reading: DriftReading }
  | { kind: 'unavailable'; reason: string }

/** 闸门退出码语义（以脚本头注为准）：0=无漂移 · 1=有漂移 · 2=路径缺失 · 3=真源冲突 */
export const GATE_EXIT_CLEAN = 0
export const GATE_EXIT_DRIFT = 1

/**
 * 纯解析：闸门退出码 + stdout → 漂移读数。
 *
 * 返回 `null` 表示**仪器故障**（退出码 2/3 或非预期）——调用方必须把它与「无漂移」区分开。
 * 项数优先取退出码（退出码是判据），摘要行仅用于显示；摘要解析不到时 `summary` 为空串，
 * 由文案层降级为「项数未知」，**不猜数字**。
 */
export function parseDriftCheck(exitCode: number, stdout: string): DriftReading | null {
  if (exitCode === GATE_EXIT_CLEAN) return { count: 0, summary: '' }
  if (exitCode !== GATE_EXIT_DRIFT) return null
  const m = /有漂移（(\d+)\s*项）/.exec(stdout)
  if (m === null) return { count: -1, summary: '' }
  return { count: Number(m[1]), summary: '有漂移（' + m[1] + ' 项）' }
}

/** 纯文案：探测结果 → 追加到 `skill_commit` note 的片段（无内容时为空串，"无消息即好消息"） */
export function buildDriftNote(probe: DriftProbe): string {
  if (probe.kind === 'off' || probe.kind === 'clean') return ''
  if (probe.kind === 'unavailable') {
    return '\n\n⚠ 镜像漂移闸门不可用（' + probe.reason + '）——本次提交后**未核实**镜像仓是否落后'
  }
  const n = probe.reading.count
  const countText = n < 0 ? '项数未知' : n + ' 项'
  return (
    '\n\n⚠ 镜像仓漂移 ' + countText + '——跑 `scripts/sync-skills.ps1` 同步' +
    '（纪律与命令序见技能 `skill-maintenance` §7；本闸门只报数，同步与否由爱丽丝决定）'
  )
}

/**
 * 薄 I/O：跑一次只读闸门。
 *
 * - `scriptPath` 为空 = 功能未开启 ⇒ `off`（**静默**，不算故障）。
 * - 已配置但跑不成（非 Windows / 启动失败 / 超时 / 路径不存在）⇒ `unavailable`（**要报**——
 *   配了不工作是故障，静默它就是又一次假绿）。
 * - `spawnSync` 带 timeout：同步阻塞会卡住整个宿主，闸门不值得让宿主陪葬（AGENTS.md §5.24）。
 */
export function probeMirrorDrift(
  scriptPath: string,
  opts: { timeoutMs?: number } = {},
): DriftProbe {
  if (scriptPath.trim() === '') return { kind: 'off' }
  if (process.platform !== 'win32') {
    return { kind: 'unavailable', reason: '闸门是 PowerShell 脚本，当前平台 ' + process.platform }
  }
  // 冷启动实测（2026-09-28 · Windows node · 同一脚本连跑三次）：**第一次 spawn ≈ 16.7s**
  // （PowerShell 首启 + 磁盘缓存冷），之后 1.25s（16714 / 1262 / 1248 ms）。
  // ⇒ 超时必须覆盖冷启动，否则**每次 web 重启后的首次提交必报「不可用」**——线上第一次
  // 真实调用正是这样超时的（旧默认 15s，差一点）。另配 warmUpMirrorDrift() 在插件启动后
  // 预热，把冷启动从提交路径上移走。
  const timeout = opts.timeoutMs ?? 60000
  let res: ReturnType<typeof spawnSync>
  try {
    res = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Check', '-Quiet'],
      { encoding: 'utf8', timeout, windowsHide: true },
    )
  } catch (e) {
    return { kind: 'unavailable', reason: '启动闸门失败：' + String(e) }
  }
  if (res.error !== undefined && res.error !== null) {
    const code = (res.error as NodeJS.ErrnoException).code
    if (code === 'ETIMEDOUT') return { kind: 'unavailable', reason: '闸门超时（>' + timeout + 'ms）' }
    return { kind: 'unavailable', reason: '闸门执行错误：' + String(res.error.message ?? res.error) }
  }
  if (typeof res.status !== 'number') {
    return { kind: 'unavailable', reason: '闸门无退出码（可能被信号中断）' }
  }
  const stdout = typeof res.stdout === 'string' ? res.stdout : ''
  const reading = parseDriftCheck(res.status, stdout)
  if (reading === null) {
    return { kind: 'unavailable', reason: '闸门退出码 ' + res.status + '（2=路径缺失 / 3=真源冲突），非 0/1' }
  }
  if (reading.count === 0) return { kind: 'clean' }
  return { kind: 'drift', reading }
}

/**
 * 预热：插件启动后**异步**跑一次闸门，把「PowerShell 首启 + 磁盘缓存冷」的 ~16.7s 从
 * `skill_commit` 路径上移走（2026-09-28 实测：冷 16714ms vs 热 1262ms）。
 *
 * 为什么不用 `probeMirrorDrift`：它是 `spawnSync`——**同步阻塞事件循环**，在 `apply()`
 * 里调用会把宿主卡住十几秒。这里用异步 `spawn` + `stdio: 'ignore'`，只求把缓存焐热，
 * 不要它的输出；**判据仍是同一个脚本**（单真源不变，只是换了调用姿势）。
 *
 * 失败**静默**：预热失败不是故障，真正的判据在提交时那次 `probeMirrorDrift`。
 * ⚠ 必须注册 `error` 监听：未监听的子进程 `error` 事件会抛出并杀死宿主（AGENTS.md §5.24）。
 */
export function warmUpMirrorDrift(scriptPath: string, opts: { timeoutMs?: number } = {}): void {
  if (scriptPath.trim() === '') return
  if (process.platform !== 'win32') return
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Check', '-Quiet'],
      { windowsHide: true, stdio: 'ignore' },
    )
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, opts.timeoutMs ?? 60000)
    const done = (): void => { clearTimeout(timer) }
    child.on('exit', done)
    child.on('error', done)
  } catch { /* 预热失败静默——真判据在提交时那次探测 */ }
}
