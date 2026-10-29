#!/usr/bin/env node
/**
 * 把技能装到各编程助手的技能目录：DSH / Codex / Claude Code / WorkBuddy。
 *
 * 两种来源：
 * - 远程技能（a-stock-data、global-stock-data）：~/skills 下只放空占位目录，每次安装都从 GitHub
 *   拉到缓存目录（默认 ~/.cache/skills-src），拉完保留，下次 fetch 复用，再拆层安装；
 * - 本地技能（chanlun、westockdata 等）：直接复制 ~/skills 下的整包。
 *
 * 复制是原子的（先写暂存目录再换名，失败回滚）；目标里已有的 `_*` 元数据会被保留。
 */

import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, readdir, readFile, rename, rm, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expandHome, fail, parseFlags, parseList, pathExists, printUsage, reportError, usageFail } from './lib/cli.mjs'

const run = promisify(execFile)

/** 工具名 → 技能扫描根目录。 */
const TOOLS = {
  dsh: join(homedir(), '.dsh', 'skills'),
  codex: join(homedir(), '.codex', 'skills'),
  claude: join(homedir(), '.claude', 'skills'),
  workbuddy: join(homedir(), '.workbuddy', 'skills'),
}
const DEFAULT_TARGETS = Object.keys(TOOLS)

/**
 * 需要从 GitHub 现场拉取的技能。本地 ~/skills/<name> 只是空占位目录，
 * 上游仓库拉到缓存目录后再拆层安装。加新技能就在这里加一条。
 */
const REMOTE_SKILLS = {
  'a-stock-data': { url: 'https://github.com/simonlin1212/a-stock-data.git', branch: 'main' },
  'global-stock-data': { url: 'https://github.com/simonlin1212/global-stock-data.git', branch: 'main' },
}
const DEFAULT_CACHE = join(homedir(), '.cache', 'skills-src')

/** 复制整包时跳过的目录/文件（.git 体积大且与运行无关）。 */
const IGNORED = new Set([
  '.git', '.github', '.gitignore', '.DS_Store', '.idea', '.vscode',
  'node_modules', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache',
])

const USAGE = `
用法: node ~/skills/install-skills.mjs [选项]

把技能装到各工具的技能目录。远程技能每次安装都从 GitHub 重新拉取一次。

选项:
  --targets <list>   目标工具，逗号分隔：${DEFAULT_TARGETS.join(' / ')}，或 all（默认 all）
  --only <list>      只装这些技能（逗号分隔），默认全部
  --root <dir>       本地技能源根目录（默认 ~/skills）
  --cache <dir>      远程技能的拉取目录（默认 ~/.cache/skills-src，拉完保留）
  --no-pull          不联网，直接用缓存里上次拉取的副本
  --mode <copy|link> copy=复制目录（默认）；link=软链到源目录，只有 dsh 支持（改源即时生效）
  --no-split         不拆层，直接安装原包（远程技能会复制缓存里的仓库）
  --dry-run          只打印计划，不联网、不落盘
  --json             输出机器可读的 JSON 摘要
  -h, --help         显示本帮助

远程技能（每次安装重新拉取）:
${Object.entries(REMOTE_SKILLS).map(([name, { url, branch }]) => `  ${name.padEnd(18)} ${url} (${branch})`).join('\n')}

目标目录:
${DEFAULT_TARGETS.map(name => `  ${name.padEnd(9)} ${TOOLS[name]}`).join('\n')}

示例:
  node ~/skills/install-skills.mjs
  node ~/skills/install-skills.mjs --targets dsh
  node ~/skills/install-skills.mjs --only chanlun,westockdata
  node ~/skills/install-skills.mjs --no-pull --targets dsh,codex
`

const exists = pathExists
const isRealDirectory = async path => lstat(path).then(info => info.isDirectory(), () => false)

/** 目录里是否有 SKILL.md（判断是不是一个技能包）。 */
const isSkillDir = async path => lstat(join(path, 'SKILL.md')).then(info => info.isFile(), () => false)

const discoverSkills = async root => {
  const entries = await readdir(root, { withFileTypes: true })
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (await isSkillDir(join(root, entry.name))) skills.push(entry.name)
  }
  return skills.sort()
}

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
    if (await exists(join(stage, name))) continue
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

  const existed = await exists(target)
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

/**
 * 把远程技能拉到缓存目录。已有克隆就 fetch + reset（每次都重新拉一次），
 * 拉完保留，不回删。
 */
const pullRemote = async (skill, cacheDir) => {
  const { url, branch } = REMOTE_SKILLS[skill]
  const dir = join(cacheDir, skill)
  const cloned = await exists(join(dir, '.git'))

  if (cloned) {
    await git(['-C', dir, 'fetch', '--depth', '1', 'origin', branch])
    await git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD'])
  } else {
    await mkdir(cacheDir, { recursive: true })
    await rm(dir, { recursive: true, force: true })
    await git(['clone', '--depth', '1', '--single-branch', '--branch', branch, url, dir])
  }

  const commit = await git(['-C', dir, 'rev-parse', '--short', 'HEAD'])
  return { dir, source: join(dir, 'SKILL.md'), commit, via: cloned ? 'fetch' : 'clone' }
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
  if (rest.length > 0) usageFail(`多余的参数：${rest.join(' ')}（用 --help 查看用法）`)

  const json = Boolean(flags['--json'])
  const dryRun = Boolean(flags['--dry-run'])
  const noPull = Boolean(flags['--no-pull'])
  const splitEnabled = !flags['--no-split']
  const mode = flags['--mode'] ?? 'copy'
  if (mode !== 'copy' && mode !== 'link') usageFail(`--mode 只支持 copy 或 link，收到 ${mode}`)

  const skillsRoot = expandHome(flags['--root'] ?? join(homedir(), 'skills'))
  const cacheDir = expandHome(flags['--cache'] ?? DEFAULT_CACHE)

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

  const discovered = await discoverSkills(skillsRoot)
  const known = [...new Set([...discovered, ...Object.keys(REMOTE_SKILLS)])].sort()

  const requestedSkills = parseList(flags['--only'] ?? '')
  const skills = requestedSkills.length > 0 ? requestedSkills : known
  for (const skill of skills) {
    if (!known.includes(skill)) usageFail(`技能 ${skill} 不存在；可选：${known.join(', ')}`)
  }

  const splitScript = skill => join(skillsRoot, `split-${skill}.mjs`)
  const hasSplit = async skill => splitEnabled && await exists(splitScript(skill))
  if (mode === 'link') {
    const blocked = []
    for (const skill of skills) {
      if (REMOTE_SKILLS[skill] !== undefined || await hasSplit(skill)) blocked.push(skill)
    }
    if (blocked.length > 0) usageFail(`这些技能没有可软链的本地源目录（远程拉取 / 拆层生成）：${blocked.join(', ')}`)
  }

  if (!json) {
    console.log(`本地源: ${skillsRoot}`)
    console.log(`缓存  : ${cacheDir}（远程技能每次安装重新拉取${noPull ? '；本次 --no-pull' : ''}）`)
    console.log(`技能  : ${skills.join(', ')}`)
    console.log(`目标  : ${targets.map(name => `${name} (${TOOLS[name]})`).join('\n         ')}`)
    console.log(`模式  : ${mode}${dryRun ? ' · dry-run（不联网、不落盘）' : ''}\n`)
  }

  // 先把远程技能各拉一次（与装几家无关），拉取失败的技能后面按失败记。
  const pulled = new Map()
  for (const skill of skills) {
    const remote = REMOTE_SKILLS[skill]
    if (remote === undefined) continue

    if (dryRun) {
      pulled.set(skill, { pending: true })
      if (!json) console.log(`· 拉取 ${skill} ← ${remote.url} (${remote.branch})（dry-run 跳过）`)
      continue
    }

    try {
      if (noPull) {
        const dir = join(cacheDir, skill)
        if (!(await exists(join(dir, 'SKILL.md')))) {
          fail(`--no-pull：缓存里没有 ${skill}，先不加 --no-pull 跑一次`)
        }
        const commit = await git(['-C', dir, 'rev-parse', '--short', 'HEAD']).catch(() => 'unknown')
        pulled.set(skill, { dir, source: join(dir, 'SKILL.md'), commit, via: 'cache' })
        if (!json) console.log(`· 使用缓存 ${skill} ${commit} → ${dir}`)
      } else {
        const info = await pullRemote(skill, cacheDir)
        pulled.set(skill, info)
        if (!json) console.log(`↓ 拉取 ${skill} ← ${remote.url} ${remote.branch} ${info.commit}（${info.via}）→ ${info.dir}`)
      }
    } catch (error) {
      const message = error.stderr?.trim() || error.message
      pulled.set(skill, { error: message })
      if (!json) console.error(`✗ 拉取失败 ${skill}：${message}`)
    }
  }
  if (!json) console.log('')

  const results = []
  let installed = 0
  let failed = 0

  for (const target of targets) {
    const targetRoot = TOOLS[target]
    for (const skill of skills) {
      const remote = REMOTE_SKILLS[skill] !== undefined
      const pulledInfo = remote ? pulled.get(skill) : null
      const destination = join(targetRoot, skill)
      const kind = mode === 'link' ? 'link' : (await hasSplit(skill) ? 'split' : 'copy')

      try {
        if (remote && pulledInfo?.error) fail(`拉取失败：${pulledInfo.error}`)

        if (dryRun) {
          results.push({ tool: target, skill, kind, target: destination, ok: true, detail: 'dry-run' })
          if (!json) {
            const suffix = remote ? '（先拉取再装）' : ''
            console.log(`· ${target.padEnd(10)} ${skill.padEnd(18)} ${kind.padEnd(5)} → ${destination}${suffix}`)
          }
          continue
        }

        if (kind === 'split') {
          const args = [splitScript(skill), '--root', skillsRoot, '--target-root', targetRoot, '--target', destination]
          if (remote) args.push('--source', pulledInfo.source)
          const { stdout } = await run(process.execPath, args, { cwd: skillsRoot })
          await validate(destination)
          results.push({ tool: target, skill, kind, target: destination, ok: true, detail: stdout.trim(), commit: pulledInfo?.commit })
          if (!json) console.log(`✓ ${target.padEnd(10)} ${skill.padEnd(18)} split → ${destination}${pulledInfo ? ` (${pulledInfo.commit})` : ''}`)
        } else if (kind === 'link') {
          const source = join(skillsRoot, skill)
          await linkSkill(source, destination)
          await validate(destination)
          results.push({ tool: target, skill, kind, target: destination, ok: true, detail: `→ ${source}` })
          if (!json) console.log(`✓ ${target.padEnd(10)} ${skill.padEnd(18)} link  → ${source}`)
        } else {
          const source = remote ? pulledInfo.dir : join(skillsRoot, skill)
          await copySkill(source, destination)
          await validate(destination)
          results.push({ tool: target, skill, kind, target: destination, ok: true, detail: 'copied', commit: pulledInfo?.commit })
          if (!json) console.log(`✓ ${target.padEnd(10)} ${skill.padEnd(18)} copy  → ${destination}`)
        }
        installed += 1
      } catch (error) {
        failed += 1
        const message = error.stderr?.trim() || error.message
        results.push({ tool: target, skill, kind, target: destination, ok: false, detail: message })
        if (!json) console.error(`✗ ${target.padEnd(10)} ${skill.padEnd(18)} ${kind.padEnd(5)} ${message}`)
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
    skills,
    pulled: [...pulled.entries()].map(([skill, info]) => ({ skill, ...info })),
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
