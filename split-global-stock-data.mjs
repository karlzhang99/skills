#!/usr/bin/env node
/**
 * 把上游单文件技能 global-stock-data（约 15 万字符）重新生成为按层拆分包。
 *
 * 用法:
 *   node ~/skills/split-global-stock-data.mjs                    # 生成并覆盖 ~/.dsh/skills/global-stock-data
 *   node ~/skills/split-global-stock-data.mjs --dry-run          # 只校验，不落盘
 *   node ~/skills/split-global-stock-data.mjs --target-root ~/.claude/skills
 *   node ~/skills/split-global-stock-data.mjs --help
 *
 * 行为与 split-a-stock-data.mjs 相同：只读上游 SKILL.md、全部校验通过后才原子替换目标目录、
 * 失败自动回滚、拼接结果与上游正文逐行比对；目标父目录不存在会自动创建。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { expandHome, fail, parseFlags, pathExists, printUsage, reportError, usageFail } from './lib/cli.mjs'

const NAME = 'global-stock-data'

const USAGE = `
用法: node ~/skills/split-${NAME}.mjs [选项]

把上游单文件 SKILL.md 拆成「导航 SKILL.md + references/**」，并原子安装到目标目录。

选项:
  --source <file>        上游 SKILL.md 路径（默认 <root>/${NAME}/SKILL.md）
  --root <dir>           技能源根目录（默认 ~/skills）
  --target-root <dir>    安装根目录（默认 ~/.dsh/skills）
  --target <dir>         精确安装目录（优先于 --target-root，默认 <target-root>/${NAME}）
  --name <name>          安装后的目录名与 frontmatter name（默认 ${NAME}）
  --dry-run              只生成并校验，不写盘
  -h, --help             显示本帮助

示例:
  node ~/skills/split-${NAME}.mjs --dry-run
  node ~/skills/split-${NAME}.mjs --target-root ~/.claude/skills
`

const DESCRIPTION = '需要取美股/港股及全球市场真实数据时使用：行情与K线（含日/台/韩/印/欧市场）、技术指标、基本面、资金流、CBOE期权链与0DTE·VIX期限结构、SEC EDGAR申报与全市场筛选、FINRA做空、央行利率与汇率、台股、EIA能源（15层50+端点，内嵌Python，每个源标注S/B/C/D合规级别）。分工只针对取数：westock CLI 已授权且覆盖该市场时优先用它；它未授权或没有该维度，或需要合规分级、官方源原始字段、自写抓取代码时用本 skill。非取数能力（合规分级、代码格式规则、备用源、数据口径）不受分工限制。'
const WHEN_TO_USE = '取数优先 westock（已授权且覆盖该市场时）；未授权、无该维度、或需要合规分级、官方源原始字段、自写抓取代码时用本 skill。非取数能力不受此分工限制。'

const LAYER_NAMES = [
  'quote', 'kline', 'indicators', 'fundamentals', 'fund-flow', 'options', 'sec-filings', 'tools',
  'short-interest', 'filings-events', 'edgar-frames', 'macro-calendar', 'rates-fx', 'taiwan', 'energy',
]

const main = async () => {
  const { flags, rest } = parseFlags(process.argv.slice(2), {
    '-h': 'boolean',
    '--help': 'boolean',
    '--dry-run': 'boolean',
    '--source': 'string',
    '--root': 'string',
    '--target-root': 'string',
    '--target': 'string',
    '--name': 'string',
  })
  if (flags['--help'] || flags['-h']) {
    printUsage(USAGE)
    return
  }
  if (rest.length > 0) usageFail(`多余的参数：${rest.join(' ')}（用 --help 查看用法）`)

  const root = expandHome(flags['--root'] ?? join(homedir(), 'skills'))
  // 源目录可能只是空占位（上游克隆放在缓存里），两个位置都找：--source > <root>/<name> > 缓存
  const localSource = join(root, NAME, 'SKILL.md')
  const cachedSource = join(homedir(), '.cache', 'skills-src', NAME, 'SKILL.md')
  const source = expandHome(flags['--source'] ?? ((await pathExists(localSource)) ? localSource : cachedSource))
  if (!(await pathExists(source))) {
    fail(`找不到上游 SKILL.md：${source}\n跑一次 node ~/skills/install-skills.mjs（会从 GitHub 拉到缓存），或用 --source 指定文件`)
  }
  const installName = flags['--name'] ?? NAME
  const targetRoot = expandHome(flags['--target-root'] ?? join(homedir(), '.dsh', 'skills'))
  const target = expandHome(flags['--target'] ?? join(targetRoot, installName))
  const dryRun = Boolean(flags['--dry-run'])

  const sourceDir = dirname(source)
  const targetPath = resolve(target)
  if (targetPath === resolve(sourceDir) || targetPath.startsWith(resolve(sourceDir) + sep)) {
    fail(`目标目录 ${target} 落在源目录 ${sourceDir} 里，拒绝覆盖（会破坏上游克隆）`)
  }

  const stage = join(dirname(target), `.${installName}.stage`)
  const backup = join(dirname(target), `.${installName}.old`)

  const raw = await readFile(source, 'utf8')
  const lines = raw.split('\n')

  /** 找到唯一匹配的标题行；缺失即上游结构变了，必须失败而不是产出错包。 */
  const findHeadings = (pattern, label) => {
    const found = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => pattern.test(line))
    if (found.length === 0) fail(`上游 SKILL.md 缺少「${label}」标题（${pattern}），结构已变，未改动目标目录`)
    return found
  }
  const heading = (pattern, label) => findHeadings(pattern, label)[0].index

  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (frontmatter === null) fail('上游 SKILL.md 缺少 YAML frontmatter')

  const version = (frontmatter[1].match(/^version:\s*(.+)$/m) ?? [])[1]?.trim() ?? 'unknown'

  const titleAt = heading(/^# 美股港股全栈数据工具包/, '文档标题')
  const routingAt = heading(/^## 端点路由速查/, '端点路由速查')
  const complianceAt = heading(/^## 数据源合规分级/, '数据源合规分级')
  const activateAt = heading(/^## When to Activate/, 'When to Activate')
  const prerequisitesAt = heading(/^## Prerequisites/, 'Prerequisites')
  const marketCodesAt = heading(/^## 市场代码规则/, '市场代码规则')
  const helpersAt = heading(/^## 共用 Helper 函数/, '共用 Helper 函数')
  const layerHeads = findHeadings(/^## Layer \d+:/, 'Layer')

  if (!(titleAt < routingAt && routingAt < complianceAt && complianceAt < activateAt && activateAt < prerequisitesAt
    && prerequisitesAt < marketCodesAt && marketCodesAt < helpersAt && helpersAt < layerHeads[0].index)) {
    fail('上游 SKILL.md 的章节顺序与预期不符，未改动目标目录')
  }

  const slice = (start, end) => lines.slice(start, end).join('\n').replace(/\n+$/, '') + '\n'
  const between = (start, end) => lines.slice(start + 1, end).join('\n').replace(/\n+$/, '') + '\n'

  const routingTitle = lines[routingAt]
  const routing = between(routingAt, complianceAt)

  const files = []
  files.push(['references/00-changelog.md', slice(titleAt + 1, routingAt)])
  files.push(['references/01-compliance.md', slice(complianceAt, activateAt)])
  files.push(['references/02-activation.md', slice(activateAt, prerequisitesAt)])
  files.push(['references/03-prerequisites.md', slice(prerequisitesAt, marketCodesAt)])
  files.push(['references/04-market-codes.md', slice(marketCodesAt, helpersAt)])
  files.push(['references/05-helpers.md', slice(helpersAt, layerHeads[0].index)])

  const layers = layerHeads.map((head, index) => {
    const number = Number(head.line.match(/^## Layer (\d+):/)[1])
    const end = layerHeads[index + 1]?.index ?? lines.length
    const text = slice(head.index, end)
    const spans = [...text.matchAll(/^### (\d+(?:\.\d+)+)(?:[–-](\d+(?:\.\d+)+))?/gm)].map(m => [m[1], m[2] ?? m[1]])
    const range = spans.length === 0 ? '—' : `${spans[0][0]}–${spans.at(-1)[1]}`
    const count = spans.reduce((sum, [from, to]) => sum + Number(to.split('.')[1]) - Number(from.split('.')[1]) + 1, 0)
    const slug = LAYER_NAMES[number - 1] ?? `layer-${number}`
    return { number, slug, text, range, count }
  })

  for (const layer of layers) {
    files.push([`references/layer-${String(layer.number).padStart(2, '0')}-${layer.slug}.md`, layer.text])
  }

  // 无损校验：按原文顺序拼回，逐行与上游正文比对（忽略空行与行尾空白）。
  const normalize = text => text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const reconstructed = normalize([
    files[0][1],
    `${routingTitle}\n${routing}`,
    ...files.slice(1).map(([, text]) => text),
  ].join('\n'))
  const expected = normalize(lines.slice(titleAt + 1).join('\n'))
  if (reconstructed !== expected) fail('拼接结果与上游正文不一致，未改动目标目录')

  const layerTable = layers
    .map(layer => `| ${layer.number} | \`references/layer-${String(layer.number).padStart(2, '0')}-${layer.slug}.md\` | ${layer.count} | ${layer.range} |`)
    .join('\n')

  const skill = `---
name: ${installName}
description: ${DESCRIPTION}
whenToUse: ${WHEN_TO_USE}
metadata:
  upstream: https://github.com/simonlin1212/global-stock-data
  upstream-version: ${version}
  generated-by: split-global-stock-data.mjs
---

# 美股港股全栈数据工具包 V${version}（按层拆分版）

上游是一个自包含的单文件 skill（约 15 万字符）。全文一次性加载会占掉大半上下文，所以这里按原文标题机械拆开，**内容、代码、编号未改写**，只在 \`SKILL.md\` 里加了导航。本目录由 \`~/skills/split-global-stock-data.mjs\` 生成，请勿手改。

## 使用方式

1. 先看 \`references/01-compliance.md\`：每个数据源标了 S/B/C/D 合规级别与条款原文，**C/D 级不可商用、D 级禁止未经许可的自动抓取**。取数前确认所选源的级别可用。
2. 在下面的「端点路由表」里按 Layer / 子节定位函数。
3. 按「层 → 文件」表只打开对应的那一个 reference；共享 helper（Yahoo crumb 管理器、东财统一查询 \`em_get\`、官方源限流出口 \`official_get\`）在 \`references/05-helpers.md\`，层文件里的端点多依赖它们，照抄时要一起带上。

## 层 → 文件

| 层 | 文件 | § 数 | § 范围 |
|---|------|------|--------|
${layerTable}

其他参考：\`references/00-changelog.md\`（版本变更）、\`references/02-activation.md\`（完整触发条件）、\`references/03-prerequisites.md\`（依赖）、\`references/04-market-codes.md\`（东财/Yahoo/SECUCODE 代码格式）。

## 端点路由表

${routing}
## 环境

\`\`\`bash
pip install requests
pip install tzdata   # 仅 Windows 需要：Yahoo K 线按交易所时区算日期
\`\`\`

极简依赖：只有 \`requests\`，所有源都是直连 HTTP。SEC EDGAR 要求 UA 里带真实联系方式（\`SEC_CONTACT\`），未改会抛 \`RuntimeError\` —— 见 \`references/05-helpers.md\`。
`

  const totalChars = files.reduce((sum, [, text]) => sum + [...text].length, 0) + [...skill].length
  console.log(`上游版本 ${version} → ${files.length + 1} 个文件，${totalChars} 字符，校验通过`)

  if (dryRun) {
    console.log(`--dry-run：未写盘（目标会是 ${target}）`)
    return
  }

  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  for (const [path, text] of files) {
    const full = join(stage, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text, 'utf8')
  }
  await writeFile(join(stage, 'SKILL.md'), skill, 'utf8')

  await mkdir(dirname(target), { recursive: true })
  await rm(backup, { recursive: true, force: true })
  const existed = await rename(target, backup).then(() => true, () => false)
  try {
    await rename(stage, target)
  } catch (error) {
    if (existed) await rename(backup, target)
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  if (existed) await rm(backup, { recursive: true, force: true })

  console.log(`已更新 ${target}（版本 ${version}）`)
}

main().catch(reportError)
