/**
 * dsh-agent-skill-forge · 落盘层（IO 薄壳：吞错，绝不反噬主流程）
 *
 * 提取原则（2026-09-14 可维护性补课，AGENTS.md §5.22 §3）：
 * - 观测/持久化失败一律**吞错并返回 bool**（`writeJsonFile` → false；`readJsonFile` → undefined），
 *   **不抛**——轨迹采集是旁路，不能因磁盘问题打断会话；调用方可忽略返回值（行为与提取前一致）。
 * - 本模块只做「路径拼装 + 读写」，不含任何业务判据（判据在 policy/aggregate）。
 *
 * 尸体测试：tests/trace-store.test.mjs（喂父路径为普通文件的不可写路径 → 断言 false 且不抛）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 索引文件路径：按 sessionId 独立（主人 2026-08-24 跨会话问题）——同一 cwd 下多个会话
 * 共享一个 skill-forge-index.json 会互相覆盖（A 写 → B 覆盖 → A 重启后索引永久丢失）。
 * 文件名带 sessionId 隔离；load 校验 sessionId 兜底。旧共享文件（无 sessionId 后缀）不再读写。
 */
export function skillIndexPath(cwd: string, sessionId: string): string {
  return join(cwd, '.dsh', 'skill-forge-index-' + sessionId + '.json')
}

/** 压缩标记文件路径（同样按 sessionId 隔离） */
export function skillMarksPath(cwd: string, sessionId: string): string {
  return join(cwd, '.dsh', 'skill-forge-marks-' + sessionId + '.json')
}

/**
 * 工具候选台账路径（**故意不按 sessionId 隔离**）。
 *
 * 2026-09-16 主人定调「扩充语义包括插件工具」：一个「这个脚本该固化成工具」的意图是
 * **跨会话累积的资产**——按会话隔离会让它随会话结束蒸发，与台账的意义相悖。
 * 索引/标记是会话的旁路产物（须隔离），台账是熔炉的产出（须累积）——两者的隔离维度不同。
 */
export function skillToolsPath(cwd: string): string {
  return join(cwd, '.dsh', 'skill-forge-tools.json')
}

/**
 * 技能审计**裁决台账**路径（**不按 sessionId 隔离**，理由同工具候选台账）。
 *
 * 2026-10-15：审计器每轮报「术语重叠（需人读）」的对，我读完判定后又只活在当次会话里
 * ⇒ 下一轮照样报，未来的我再读一遍（§5.39：规则层反复失效 ⇒ 换机制承载）。
 * 台账跨会话累积——**裁决是关于技能库的结论，不是会话的旁路产物**。
 */
export function skillLedgerPath(cwd: string): string {
  return join(cwd, '.dsh', 'skill-forge-ledger.json')
}

/** 裁决台账文件形状。`ledgers` 的键 = 技能目录（经 `ledgerDirKey` 归一）。 */
export interface SkillLedgerFile {
  updatedAt: string
  ledgers: Record<string, Record<string, unknown>>
}

/**
 * 技能目录 → 台账键。
 *
 * ⚠ **归一的意义**：同一目录可能以 `C:\\Users\\tr\\.agents\\skills` / `C:/Users/tr/.agents/skills`
 *   两种写法抵达（工具参数是人/我手写的）⇒ 不归一会把同一个库分裂成两份台账，
 *   而「裁决失效」正是那种**看不出来的**失效（各查各的，都显示正常）。
 */
export function ledgerDirKey(dir: string): string {
  const norm = dir.replace(/\\/g, '/')
  return /^[a-z]:/i.test(norm) ? norm.charAt(0).toLowerCase() + norm.slice(1) : norm
}

/**
 * 写 JSON（自动建父目录；2 空格缩进）。
 * @returns true = 已写入；false = 失败（不可写路径 / 序列化失败——吞错，不抛）
 */
export function writeJsonFile(file: string, payload: unknown): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 读 JSON。
 * @returns 解析后的值；文件不存在 / 读失败 / JSON 坏 / 是目录 → undefined（吞错，不抛）
 */
export function readJsonFile(file: string): unknown {
  try {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
