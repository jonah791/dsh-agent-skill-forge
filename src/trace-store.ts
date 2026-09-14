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
