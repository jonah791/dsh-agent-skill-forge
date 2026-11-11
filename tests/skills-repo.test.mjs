/**
 * skills-repo.test.mjs — 技能仓的「只提交自己写的」与「脏要报出来」（lh-3482d40b ① / ③）
 *
 * 要防的两个反面，都是真实会发生的形状：
 * ① **`git add -A` 把外部工具写的未审阅改动顺手卷进提交** —— 那比不提交更糟：它让
 *    「没人看过的改动」获得了「已提交、有历史」的外观。
 * ③ **脏了没人知道** —— 脏会一直累积到某次有人想起来（与 44 仓静默积压 143 提交同形）。
 *
 * 所以第一条测试的核心断言不是「提交发生了」，而是「**只有指定的那个文件进了提交**」。
 * 带尸体：把实现换成 `add -A` 必须变红，否则这条断言没有区分力。
 *
 * 运行：npm test（夹具全部在 os.tmpdir 下的临时 git 仓，不碰真实技能目录）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { commitSkillPath, skillsRepoStatus, dirtyNotice } from '../lib/skills-repo.js'

const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })

/** 建一个带初始提交的临时仓，返回目录与清理器。 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'skills-repo-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@local'])
  git(dir, ['config', 'user.name', 'test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf8')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-qm', 'seed'])
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const headCount = (dir) => Number(git(dir, ['rev-list', '--count', 'HEAD']).stdout.trim())

test('① 只提交指定文件：另一个外部改动必须留在工作区，不进提交', () => {
  const { dir, cleanup } = repo()
  try {
    mkdirSync(join(dir, 'alpha'), { recursive: true })
    const mine = join(dir, 'alpha', 'SKILL.md')
    writeFileSync(mine, '# alpha\n', 'utf8')
    // 外部工具写的东西——**不许被顺手卷进提交**
    writeFileSync(join(dir, 'external.txt'), '外部工具写的\n', 'utf8')

    const before = headCount(dir)
    const out = commitSkillPath(dir, mine, 'alpha')
    assert.equal(out.ok, true, `提交失败：${out.detail}`)
    assert.match(out.detail, /已提交/)
    assert.equal(headCount(dir), before + 1, '应当正好多一个提交')

    const committed = git(dir, ['show', '--name-only', '--pretty=format:', 'HEAD']).stdout
      .split(/\r?\n/).filter((l) => l.trim() !== '')
    assert.deepEqual(committed, ['alpha/SKILL.md'], `提交里混进了别的文件：${JSON.stringify(committed)}`)

    const status = skillsRepoStatus(dir)
    assert.equal(status.kind, 'dirty', 'external.txt 应仍留在工作区（未提交）')
    assert.equal(status.count, 1)
    assert.ok(status.sample[0].includes('external.txt'))
  } finally {
    cleanup()
  }
})

test('① 内容无变化 ⇒ 不产生空提交', () => {
  const { dir, cleanup } = repo()
  try {
    const p = join(dir, 'SKILL.md')
    writeFileSync(p, '# x\n', 'utf8')
    assert.equal(commitSkillPath(dir, p, 'x').ok, true)
    const before = headCount(dir)
    const again = commitSkillPath(dir, p, 'x')
    assert.equal(again.ok, true)
    assert.match(again.detail, /内容无变化/)
    assert.equal(headCount(dir), before, '无变化却多出提交 = 空提交噪音')
  } finally {
    cleanup()
  }
})

test('① 非 git 目录 ⇒ 良性跳过（技能写入本身成功，不该因 git 缺席变红）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-nongit-'))
  try {
    const p = join(dir, 'SKILL.md')
    writeFileSync(p, '# y\n', 'utf8')
    const out = commitSkillPath(dir, p, 'y')
    assert.equal(out.ok, true)
    assert.match(out.detail, /不在 git 仓内/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③ 脏读数：干净报 clean、脏报数量与样例', () => {
  const { dir, cleanup } = repo()
  try {
    assert.equal(skillsRepoStatus(dir).kind, 'clean')
    assert.equal(dirtyNotice({ kind: 'clean', count: 0, sample: [], reason: '' }), '', '干净时必须一言不发')

    writeFileSync(join(dir, 'a.txt'), 'a\n', 'utf8')
    writeFileSync(join(dir, 'b.txt'), 'b\n', 'utf8')
    const st = skillsRepoStatus(dir)
    assert.equal(st.kind, 'dirty')
    assert.equal(st.count, 2)
    const notice = dirtyNotice(st)
    assert.match(notice, /2 个未提交改动/)
    assert.match(notice, /a\.txt/)
  } finally {
    cleanup()
  }
})

test('③ 非 git 目录报 unavailable 且带原因（不是静默 clean）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-nongit2-'))
  try {
    const st = skillsRepoStatus(dir)
    assert.equal(st.kind, 'unavailable')
    assert.ok(st.reason.length > 0, '不可用必须给原因——静默 clean 就是又一次假绿')
    assert.equal(dirtyNotice(st), '', 'unavailable 不该冒充脏')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
