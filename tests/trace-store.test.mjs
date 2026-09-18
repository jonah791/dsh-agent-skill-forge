/**
 * trace-store.ts 单测（落盘薄壳：路径拼装 + 读写吞错）
 *
 * 纪律（AGENTS.md §5.22 §3）：观测绝不反噬主流程——落盘失败必须吞错且返回 false，不抛。
 * 尸体测试：喂**不可写路径**（父路径是普通文件）→ 断言 false 且不抛。
 *
 * 运行：`node --test tests/trace-store.test.mjs`（先 `npm run build` 产出 lib/）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile, skillIndexPath, skillMarksPath, skillToolsPath, writeJsonFile } from '../lib/trace-store.js'

/** 每例独立临时目录（测试结束清理） */
function tmpRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-forge-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------- 路径 ----------

test('主路径：索引/标记文件按 sessionId 隔离（跨会话不互相覆盖）', () => {
  assert.equal(skillIndexPath('E:\\alice', 'session-abc'), join('E:\\alice', '.dsh', 'skill-forge-index-session-abc.json'))
  assert.equal(skillMarksPath('E:\\alice', 'session-abc'), join('E:\\alice', '.dsh', 'skill-forge-marks-session-abc.json'))
  assert.notEqual(skillIndexPath('.', 's1'), skillIndexPath('.', 's2'))
})

test('语义扩充：工具候选台账**不**按 sessionId 隔离（跨会话累积的产出，维度按语义决定）', () => {
  assert.equal(skillToolsPath('E:\\alice'), join('E:\\alice', '.dsh', 'skill-forge-tools.json'))
  // 与 sessionId 无关：同一 cwd 永远同一文件（这正是「不蒸发」的落点）
  assert.equal(skillToolsPath('E:\\alice'), skillToolsPath('E:\\alice'))
  // 与同为 cwd 维度的索引路径形态不同（索引带 sessionId 后缀）
  assert.notEqual(skillToolsPath('.'), skillIndexPath('.', 's1'))
})

// ---------- 写：主路径 ----------

test('主路径：写 JSON 自动建父目录（.dsh）+ 2 空格缩进可回读', (t) => {
  const root = tmpRoot(t)
  const file = join(root, '.dsh', 'skill-forge-index-s1.json')
  assert.equal(existsSync(join(root, '.dsh')), false)
  assert.equal(writeJsonFile(file, { sessionId: 's1', turns: [] }), true)
  assert.ok(existsSync(file))
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { sessionId: 's1', turns: [] })
  assert.ok(readFileSync(file, 'utf8').includes('\n  "sessionId"'))
})

test('主路径：重复写覆盖（同会话索引演进）', (t) => {
  const root = tmpRoot(t)
  const file = join(root, '.dsh', 'skill-forge-index-s1.json')
  assert.equal(writeJsonFile(file, { v: 1 }), true)
  assert.equal(writeJsonFile(file, { v: 2 }), true)
  assert.deepEqual(readJsonFile(file), { v: 2 })
})

// ---------- 写：失败路径（尸体测试） ----------

test('写失败不抛（不可写路径：父路径是普通文件）→ 返回 false', (t) => {
  const root = tmpRoot(t)
  const plain = join(root, 'plain.txt')
  writeFileSync(plain, 'not a directory', 'utf8')
  let ok = null
  assert.doesNotThrow(() => {
    ok = writeJsonFile(join(plain, 'x', 'y.json'), { a: 1 })
  })
  assert.equal(ok, false)
})

test('写失败不抛（序列化失败：循环引用）→ 返回 false', (t) => {
  const root = tmpRoot(t)
  const cyclic = {}
  cyclic.self = cyclic
  let ok = null
  assert.doesNotThrow(() => {
    ok = writeJsonFile(join(root, 'cyclic.json'), cyclic)
  })
  assert.equal(ok, false)
})

test('写失败不抛（payload 含 BigInt → JSON.stringify 抛错）→ 返回 false', (t) => {
  const root = tmpRoot(t)
  let ok = null
  assert.doesNotThrow(() => {
    ok = writeJsonFile(join(root, 'bigint.json'), { n: 1n })
  })
  assert.equal(ok, false)
})

// ---------- 读：失败路径 ----------

test('读退化：文件不存在不抛 → undefined', (t) => {
  const root = tmpRoot(t)
  assert.equal(readJsonFile(join(root, 'nope.json')), undefined)
})

test('读退化：坏 JSON / 空文件不抛 → undefined', (t) => {
  const root = tmpRoot(t)
  const bad = join(root, 'bad.json')
  writeFileSync(bad, '{ not json', 'utf8')
  assert.equal(readJsonFile(bad), undefined)
  const empty = join(root, 'empty.json')
  writeFileSync(empty, '', 'utf8')
  assert.equal(readJsonFile(empty), undefined)
})

test('读退化：目标是目录不抛（EISDIR 吞掉）→ undefined', (t) => {
  const root = tmpRoot(t)
  assert.equal(readJsonFile(root), undefined)
})

test('读退化：父路径是普通文件不抛 → undefined', (t) => {
  const root = tmpRoot(t)
  const plain = join(root, 'plain.txt')
  writeFileSync(plain, 'x', 'utf8')
  assert.equal(readJsonFile(join(plain, 'y.json')), undefined)
})
