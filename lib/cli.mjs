/**
 * ~/skills 下几个安装脚本共用的小工具：零依赖，只用 Node 内置模块。
 *
 * - parseFlags：`--flag value` / `--flag=value` / 布尔开关 / `--` 终止符；
 * - usageFail：用法错误统一 exit 2，普通失败 exit 1；
 * - expandHome：把 `~/x` 展开成真实路径。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'

export class UsageError extends Error {
  constructor (message) {
    super(message)
    this.name = 'UsageError'
    this.exitCode = 2
  }
}

/** 普通失败：环境不满足、校验不通过等。 */
export const fail = message => {
  throw new Error(message)
}

/** 用法失败：参数写错。 */
export const usageFail = message => {
  throw new UsageError(message)
}

export const expandHome = path => {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** 路径是否存在（不跟随软链，软链本身也算存在）。 */
export const pathExists = path => lstat(path).then(() => true, () => false)

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {Record<string, 'boolean' | 'string'>} schema  形如 { '--dry-run': 'boolean', '--target': 'string' }
 * @returns {{ flags: Record<string, string | true>, rest: string[] }}
 */
export const parseFlags = (argv, schema) => {
  /** @type {Record<string, string | true>} */
  const flags = {}
  const rest = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      rest.push(...argv.slice(index + 1))
      break
    }
    if (arg === '-' || !arg.startsWith('-')) {
      rest.push(arg)
      continue
    }

    const equals = arg.indexOf('=')
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    const kind = schema[flag]
    if (kind === undefined) usageFail(`未知参数 ${flag}（用 --help 查看用法）`)

    if (kind === 'boolean') {
      if (equals !== -1) usageFail(`${flag} 是开关，不接受值`)
      flags[flag] = true
      continue
    }

    const value = equals === -1 ? argv[++index] : arg.slice(equals + 1)
    if (value === undefined || value === '') usageFail(`${flag} 需要一个值`)
    flags[flag] = value
  }

  return { flags, rest }
}

/** 逗号分隔的参数值 → 去空白、去空的数组。 */
export const parseList = value => value.split(',').map(item => item.trim()).filter(Boolean)

/** 打印帮助文本（去掉首尾多余换行）。 */
export const printUsage = text => {
  console.log(text.trim())
}

/** 统一的顶层错误输出。 */
export const reportError = error => {
  console.error(`\n✗ ${error.message}`)
  process.exit(error.exitCode ?? 1)
}
