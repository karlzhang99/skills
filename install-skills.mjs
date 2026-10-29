#!/usr/bin/env node
/**
 * 通用技能安装器：把本仓库下的技能同步到 DSH / Codex / Claude Code / WorkBuddy。
 *
 * 本仓库下每个子目录就是一个技能，两种形式，脚本自动识别，不写死任何技能名：
 * - 目录里有 `git-addr`（一行 git 地址）：安装时拉到缓存目录（默认 ~/.cache/skills-src），
 *   拉完保留，下次 fetch 复用；再从缓存同步（有 split-*.mjs 就先拆层）；
 * - 目录里有 `SKILL.md`：本地技能包，直接复制（或 --mode link 软链到 dsh）。
 *
 * 用法:
 *   node install-skills.mjs list     # 列出可导入的技能
 *   node install-skills.mjs          # 拉取 + 同步到四家
 */

import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, readdir, readFile, rename, rm, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expandHome, fail, parseFlags, parseList, pathExists, printUsage, reportError, usageFail } from './lib/cli.mjs'

const run = promisify(execFile)

/** 工具名 → 技能安装根目录。 */
const TOOLS = {
  dsh: join(homedir(), '.dsh', 'skills'),
  codex: join(homedir(), '.codex', 'skills'),
  claude: join(homedir(), '.claude', 'skills'),
  workbuddy: join(homedir(), '.workbuddy', 'skills'),
}
const DEFAULT_TARGETS = Object.keys(TOOLS)

/** 技能目录里放这个文件表示「从 git 拉取」，内容是一行地址。 */
const ADDRESS_FILE = 'git-addr'
const DEFAULT_CACHE = join(homedir(), '.cache', 'skills-src')

/** 复制整包时跳过的目录/文件（.git 体积大且与运行无关）。 */
const IGNORED = new Set([
  '.git', '.github', '.gitignore', '.DS_Store', '.idea', '.vscode',
  'node_modules', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache',
])

const USAGE = `
用法: node install-skills.mjs <list | install> [选项]

命令:
  list               列出当前技能目录下可导入的技能（不联网）
  install            拉取远程技能并同步到各工具（默认命令）

选项:
  --targets <list>   目标工具，逗号分隔：${DEFAULT_TARGETS.join(' / ')}，或 all（默认 all）
  --only <list>      只处理这些技能（逗号分隔），默认全部；不存在的技能会直接报错
  --root <dir>       技能源根目录（默认脚本所在目录）
  --cache <dir>      远程技能拉取目录（默认 ~/.cache/skills-src，拉完保留）
  --no-pull          不联网，直接用缓存里上次拉取的副本
  --mode <copy|link> copy=复制目录（默认）；link=软链到源目录，只有本地技能 + dsh 支持
  --no-split         不拆层，直接安装原包
  --dry-run          只打印计划，不联网、不落盘
  --json             输出机器可读的 JSON
  -h, --help         显示本帮助

技能目录的两种形式:
  <name>/git-addr    一行 git 地址，安装时拉取到缓存再同步
  <name>/SKILL.md    本地技能包，直接复制

目标目录:
${DEFAULT_TARGETS.map(name => `  ${name.padEnd(9)} ${TOOLS[name]}`).join('\n')}

示例:
  node install-skills.mjs list
  node install-skills.mjs list --json
  node install-skills.mjs
  node install-skills.mjs --only chanlun --targets dsh
`

const isRealDirectory = async path => lstat(path).then(info => info.isDirectory(), () => false)

/** 目录里是否有 SKILL.md（判断是不是一个技能包）。 */
const isSkillDir = async path => lstat(join(path, 'SKILL.md')).then(info => info.isFile(), () => false)

/** 读 git-addr：没有文件返回 null；有文件但为空返回 ''。 */
const readAddress = async dir => {
  const file = join(dir, ADDRESS_FILE)
  if (!(await pathExists(file))) return null
  const lines = (await readFile(file, 'utf8'))
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  return lines[0] ?? ''
}

/** 扫描所有技能目录：有 git-addr 或 SKILL.md 的才算。 */
const discoverSkills = async root => {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    fail(`读不了技能源目录 ${root}：${error.message}`)
  }
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    const address = await readAddress(dir)
    if (address === null && !(await isSkillDir(dir))) continue
    skills.push({ name: entry.name, dir, address })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** 有对应的 split-*.mjs 就走拆层安装。 */
const splitScript = (root, name) => join(root, `split-${name}.mjs`)

/** 复制整包时的过滤：只要运行需要的文件。 */
const keep = source => {
  const name = basename(source)
  if (IGNORED.has(name)) return false
  if (name.endsWith('.pyc') || name.endsWith('.pyo')) return false
  return true
}

/** 替换目录时保留目标里已有的 `_*` 元数据（WorkBuddy 技能市场等）。 */
const carryOverMeta = async (target, stage) => {
  if (!(await isRealDirectory(target))) return
  for (const name of await readdir(target)) {
    if (!name.startsWith('_')) continue
    if (await pathExists(join(stage, name))) continue
    await cp(join(target, name), join(stage, name), { recursive: true })
  }
}

/** 原子复制：先写暂存目录，再换名，失败回滚；目标是软链时只移链接，不会写穿到源目录。 */
const copySkill = async (source, target) => {
  const parent = dirname(target)
  const name = basename(target)
  const stage = join(parent, `.${name}.stage-${process.pid}`)
  const backup = join(parent, `.${name}.old-${process.pid}`)

  await mkdir(parent, { recursive: true })
  await rm(stage, { recursive: true, force: true })
  await cp(source, stage, { recursive: true, filter: keep })
  await carryOverMeta(target, stage)

  const existed = await pathExists(target)
  if (existed) await rename(target, backup)
  try {
    await rename(stage, target)
  } catch (error) {
    if (existed) await rename(backup, target)
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  if (existed) await rm(backup, { recursive: true, force: true })
}

/** 软链安装：只替换文件/软链，实体目录要用户自己确认，避免误删。 */
const linkSkill = async (source, target) => {
  await mkdir(dirname(target), { recursive: true })
  const info = await lstat(target).catch(() => null)
  if (info !== null) {
    if (info.isDirectory()) {
      fail(`${target} 是实体目录，link 模式不替你删除；先移除它，或改用 --mode copy`)
    }
    await unlink(target)
  }
  await symlink(source, target)
}

/** 装完再验一遍：SKILL.md 存在且 frontmatter 至少有 name / description。 */
const validate = async target => {
  const text = await readFile(join(target, 'SKILL.md'), 'utf8').catch(() => {
    fail(`安装结果缺少 SKILL.md：${target}`)
  })
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (frontmatter === null) fail(`SKILL.md 缺少 YAML frontmatter：${target}`)
  if (!/^name:\s*\S/m.test(frontmatter[1])) fail(`SKILL.md frontmatter 缺少 name：${target}`)
  if (!/^description:\s*\S/m.test(frontmatter[1])) fail(`SKILL.md frontmatter 缺少 description：${target}`)
}

/** 跑 git 命令：不弹交互式认证，超时 2 分钟。 */
const git = async args => {
  const { stdout } = await run('git', args, {
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout.trim()
}

const normalizeUrl = url => url.replace(/\/+$/, '').replace(/\.git$/, '')

/** 仓库根不一定是技能根：根上没有 SKILL.md 时，找唯一的一级子目录。 */
const resolveSkillRoot = async repoDir => {
  if (await isSkillDir(repoDir)) return repoDir
  const candidates = []
  for (const entry of await readdir(repoDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const sub = join(repoDir, entry.name)
    if (await isSkillDir(sub)) candidates.push(sub)
  }
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) fail(`拉下来的仓库里找不到 SKILL.md：${repoDir}`)
  fail(`仓库里有多个 SKILL.md，无法确定用哪个：${candidates.join(', ')}`)
}

/**
 * 把技能拉到缓存目录。已有克隆就 fetch（每次都重新拉），拉完保留；
 * 缓存里的 origin 地址和 git-addr 不一致时重新 clone。
 */
const pullRemote = async (skill, cacheDir) => {
  const url = skill.address
  if (url === '') fail(`git-addr 是空的：${join(skill.dir, ADDRESS_FILE)}`)
  const dir = join(cacheDir, skill.name)
  const hasClone = await pathExists(join(dir, '.git'))
  let via = hasClone ? 'update' : 'clone'

  if (hasClone) {
    const current = await git(['-C', dir, 'remote', 'get-url', 'origin']).catch(() => '')
    if (normalizeUrl(current) !== normalizeUrl(url)) {
      await rm(dir, { recursive: true, force: true })
      await mkdir(cacheDir, { recursive: true })
      await git(['clone', '--depth', '1', '--single-branch', url, dir])
      via = 'clone'
    } else {
      try {
        await git(['-C', dir, 'fetch', '--depth', '1', 'origin', 'HEAD'])
      } catch {
        await git(['-C', dir, 'fetch', '--depth', '1', 'origin'])
      }
      await git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD'])
    }
  } else {
    await mkdir(cacheDir, { recursive: true })
    await rm(dir, { recursive: true, force: true })
    await git(['clone', '--depth', '1', '--single-branch', url, dir])
  }

  const commit = await git(['-C', dir, 'rev-parse', '--short', 'HEAD'])
  const source = await resolveSkillRoot(dir)
  return { dir, source, commit, via }
}

const describeType = skill => {
  if (skill.address === null) return 'local'
  return skill.address === '' ? 'remote(空)' : 'remote'
}

const printList = async ({ skills, root, json }) => {
  const rows = []
  for (const skill of skills) {
    const split = await pathExists(splitScript(root, skill.name))
    const installed = []
    for (const [tool, toolRoot] of Object.entries(TOOLS)) {
      if (await pathExists(join(toolRoot, skill.name, 'SKILL.md'))) installed.push(tool)
    }
    const sourceText = skill.address === null ? skill.dir : (skill.address || '（git-addr 为空）')
    rows.push({ name: skill.name, type: describeType(skill), split, installed, source: sourceText })
  }

  if (json) {
    console.log(JSON.stringify({ root, tools: TOOLS, skills: rows }, null, 2))
    return
  }

  const installedText = row => (row.installed.length === 0 ? '-' : row.installed.length === Object.keys(TOOLS).length ? '全部' : row.installed.join(','))
  // 中文字符按 2 列算，保证表格对齐
  const displayWidth = text => [...text].reduce((sum, ch) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
  const pad = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)))
  const widths = {
    name: Math.max(...rows.map(row => displayWidth(row.name)), displayWidth('技能')),
    type: Math.max(...rows.map(row => displayWidth(row.type)), displayWidth('类型')),
    kind: displayWidth('处理'),
    installed: Math.max(...rows.map(row => displayWidth(installedText(row))), displayWidth('已装')),
  }

  console.log(`源目录: ${root}\n`)
  console.log(`${pad('技能', widths.name)}  ${pad('类型', widths.type)}  ${pad('处理', widths.kind)}  ${pad('已装', widths.installed)}  来源`)
  for (const row of rows) {
    console.log(`${pad(row.name, widths.name)}  ${pad(row.type, widths.type)}  ${pad(row.split ? 'split' : 'copy', widths.kind)}  ${pad(installedText(row), widths.installed)}  ${row.source}`)
  }
  const remote = rows.filter(row => row.type.startsWith('remote')).length
  console.log(`\n共 ${rows.length} 个技能：${remote} 个从 git 拉取，${rows.length - remote} 个本地。`)
}

const main = async () => {
  const { flags, rest } = parseFlags(process.argv.slice(2), {
    '-h': 'boolean',
    '--help': 'boolean',
    '--dry-run': 'boolean',
    '--json': 'boolean',
    '--no-split': 'boolean',
    '--no-pull': 'boolean',
    '--root': 'string',
    '--cache': 'string',
    '--targets': 'string',
    '--only': 'string',
    '--mode': 'string',
  })
  if (flags['--help'] || flags['-h']) {
    printUsage(USAGE)
    return
  }

  const command = rest[0] ?? 'install'
  if (rest.length > 1) usageFail(`多余的参数：${rest.slice(1).join(' ')}（选项要带 -- 前缀）`)
  if (command !== 'install' && command !== 'list') {
    usageFail(`未知命令 ${command}；可用：install（默认）、list`)
  }

  const json = Boolean(flags['--json'])
  const dryRun = Boolean(flags['--dry-run'])
  const noPull = Boolean(flags['--no-pull'])
  const splitEnabled = !flags['--no-split']
  const mode = flags['--mode'] ?? 'copy'
  if (mode !== 'copy' && mode !== 'link') usageFail(`--mode 只支持 copy 或 link，收到 ${mode}`)

  // 默认以脚本所在目录为技能源，仓库搬到哪都能用
  const skillsRoot = expandHome(flags['--root'] ?? import.meta.dirname)
  const cacheDir = expandHome(flags['--cache'] ?? DEFAULT_CACHE)

  const discovered = await discoverSkills(skillsRoot)
  if (discovered.length === 0) {
    fail(`${skillsRoot} 下没有可导入的技能（子目录里要有 git-addr 或 SKILL.md）`)
  }

  const only = parseList(flags['--only'] ?? '')
  const known = discovered.map(skill => skill.name)
  for (const name of only) {
    if (!known.includes(name)) usageFail(`技能不存在：${name}；可选：${known.join(', ')}`)
  }
  const selected = only.length > 0 ? discovered.filter(skill => only.includes(skill.name)) : discovered

  if (command === 'list') {
    await printList({ skills: selected, root: skillsRoot, json })
    return
  }

  const requested = parseList(flags['--targets'] ?? 'all')
  const targets = requested.some(item => item === 'all') ? [...DEFAULT_TARGETS] : requested
  for (const target of targets) {
    if (TOOLS[target] === undefined) {
      usageFail(`未知目标 ${target}；可选：${DEFAULT_TARGETS.join(', ')} 或 all`)
    }
  }
  if (mode === 'link') {
    const blocked = targets.filter(target => target !== 'dsh')
    if (blocked.length > 0) usageFail(`link 模式只支持 dsh（其他工具不保证跟随软链）：${blocked.join(', ')}`)
  }

  const skills = selected

  if (mode === 'link') {
    const blocked = []
    for (const skill of skills) {
      if (skill.address !== null || await pathExists(splitScript(skillsRoot, skill.name))) blocked.push(skill.name)
    }
    if (blocked.length > 0) usageFail(`这些技能没有可软链的本地源目录（远程拉取 / 拆层生成）：${blocked.join(', ')}`)
  }

  if (!json) {
    console.log(`本地源: ${skillsRoot}`)
    console.log(`缓存  : ${cacheDir}（远程技能每次安装重新拉取${noPull ? '；本次 --no-pull' : ''}）`)
    console.log(`技能  : ${skills.map(skill => skill.name).join(', ')}`)
    console.log(`目标  : ${targets.map(name => `${name} (${TOOLS[name]})`).join('\n         ')}`)
    console.log(`模式  : ${mode}${dryRun ? ' · dry-run（不联网、不落盘）' : ''}\n`)
  }

  // 先拉取所有远程技能（每个只拉一次，与装几家无关），拉取失败的技能后面按失败记。
  const sources = new Map()
  for (const skill of skills) {
    if (skill.address === null) {
      sources.set(skill.name, { source: skill.dir, commit: null, via: 'local' })
      continue
    }

    if (dryRun) {
      sources.set(skill.name, { pending: true })
      if (!json) console.log(`· 拉取 ${skill.name} ← ${skill.address || '（git-addr 为空）'}（dry-run 跳过）`)
      continue
    }

    try {
      if (noPull) {
        const dir = join(cacheDir, skill.name)
        if (!(await pathExists(join(dir, '.git')))) {
          fail(`--no-pull：缓存里没有 ${skill.name}，先不加 --no-pull 跑一次`)
        }
        const commit = await git(['-C', dir, 'rev-parse', '--short', 'HEAD']).catch(() => 'unknown')
        const source = await resolveSkillRoot(dir)
        sources.set(skill.name, { dir, source, commit, via: 'cache' })
        if (!json) console.log(`· 使用缓存 ${skill.name} ${commit} → ${dir}`)
      } else {
        const info = await pullRemote(skill, cacheDir)
        sources.set(skill.name, info)
        if (!json) console.log(`↓ 拉取 ${skill.name} ← ${skill.address} ${info.commit}（${info.via}）→ ${info.dir}`)
      }
    } catch (error) {
      const message = error.stderr?.trim() || error.message
      sources.set(skill.name, { error: message })
      if (!json) console.error(`✗ 拉取失败 ${skill.name}：${message}`)
    }
  }
  if (!json) console.log('')

  const results = []
  let installed = 0
  let failed = 0

  for (const target of targets) {
    const targetRoot = TOOLS[target]
    for (const skill of skills) {
      const info = sources.get(skill.name)
      const destination = join(targetRoot, skill.name)
      const split = splitEnabled && await pathExists(splitScript(skillsRoot, skill.name))
      const kind = mode === 'link' ? 'link' : (split ? 'split' : 'copy')

      try {
        if (info?.error) fail(`拉取失败：${info.error}`)

        if (dryRun) {
          results.push({ tool: target, skill: skill.name, kind, target: destination, ok: true, detail: 'dry-run' })
          if (!json) {
            const suffix = skill.address === null ? '' : '（先拉取再装）'
            console.log(`· ${target.padEnd(10)} ${skill.name.padEnd(18)} ${kind.padEnd(5)} → ${destination}${suffix}`)
          }
          continue
        }

        if (kind === 'split') {
          const args = [splitScript(skillsRoot, skill.name), '--root', skillsRoot, '--target-root', targetRoot, '--target', destination, '--source', join(info.source, 'SKILL.md')]
          const { stdout } = await run(process.execPath, args, { cwd: skillsRoot })
          await validate(destination)
          results.push({ tool: target, skill: skill.name, kind, target: destination, ok: true, detail: stdout.trim(), commit: info.commit })
          if (!json) console.log(`✓ ${target.padEnd(10)} ${skill.name.padEnd(18)} split → ${destination}${info.commit ? ` (${info.commit})` : ''}`)
        } else if (kind === 'link') {
          await linkSkill(info.source, destination)
          await validate(destination)
          results.push({ tool: target, skill: skill.name, kind, target: destination, ok: true, detail: `→ ${info.source}` })
          if (!json) console.log(`✓ ${target.padEnd(10)} ${skill.name.padEnd(18)} link  → ${info.source}`)
        } else {
          await copySkill(info.source, destination)
          await validate(destination)
          results.push({ tool: target, skill: skill.name, kind, target: destination, ok: true, detail: 'copied', commit: info.commit })
          if (!json) console.log(`✓ ${target.padEnd(10)} ${skill.name.padEnd(18)} copy  → ${destination}${info.commit ? ` (${info.commit})` : ''}`)
        }
        installed += 1
      } catch (error) {
        failed += 1
        const message = error.stderr?.trim() || error.message
        results.push({ tool: target, skill: skill.name, kind, target: destination, ok: false, detail: message })
        if (!json) console.error(`✗ ${target.padEnd(10)} ${skill.name.padEnd(18)} ${kind.padEnd(5)} ${message}`)
      }
    }
    if (!json && !dryRun) console.log('')
  }

  const summary = {
    root: skillsRoot,
    cache: cacheDir,
    mode,
    dryRun,
    noPull,
    splitEnabled,
    targets,
    skills: skills.map(skill => skill.name),
    pulled: [...sources.entries()].map(([name, info]) => ({ name, ...info })),
    installed,
    failed,
    results,
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2))
  } else if (!dryRun) {
    console.log(`汇总：${targets.length} 个目标 × ${skills.length} 个技能 = ${targets.length * skills.length} 项，成功 ${installed}，失败 ${failed}`)
    if (failed === 0) console.log('DSH 的目录监听会自动刷新 catalog；Codex / Claude Code / WorkBuddy 重开一次会话或重启后生效。')
  }

  if (failed > 0) process.exitCode = 1
}

main().catch(reportError)
