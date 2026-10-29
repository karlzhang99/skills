# ~/MyCode/skills — 金融数据技能源目录

这个目录是技能的**源目录**，不是任何工具的安装点。`install-skills.mjs` 扫描这里每个子目录，把技能同步到 DSH / Codex / Claude Code / WorkBuddy 四家。

技能目录有两种写法，脚本自动识别，**不写死技能名**：

| 写法 | 例子 | 安装时做什么 |
|---|---|---|
| 目录里放 `git-addr`（一行 git 地址） | `a-stock-data/git-addr` | 拉到 `~/.cache/skills-src`，再从缓存同步 |
| 目录里放 `SKILL.md` | `my-skill/` | 直接复制（`--mode link` 可软链到 dsh） |

先看能导入什么，再装到四家：

```bash
node ~/MyCode/skills/install-skills.mjs list   # 列出可导入的技能（只读本地，不联网）
node ~/MyCode/skills/install-skills.mjs        # 拉取并安装到四家
```

首次安装、升级、改了 `git-addr`（比如 HTTPS 换 SSH）都跑第二条；缓存里的 origin 与 `git-addr` 不一致时会自动重新 clone。

当前四个技能：

| 技能 | 本目录里的东西 | 装出去是什么 |
|---|---|---|
| `a-stock-data` | `git-addr` + `split-a-stock-data.mjs` | **实体目录**，拉取后拆成「导航 + references」 |
| `global-stock-data` | `git-addr` + `split-global-stock-data.mjs` | **实体目录**，同上 |
| `chanlun` | `git-addr` | **复制整包**（仓库根就是技能包） |
| `westockdata` | `git-addr` | **复制整包**（仓库根就是技能包，没有拆分脚本） |

四家的技能目录：

| 工具 | 技能目录 | 生效方式 |
|---|---|---|
| DSH | `~/.dsh/skills` | 内置扫描根，目录监听自动刷新 catalog |
| Codex | `~/.codex/skills` | 重开会话 |
| Claude Code | `~/.claude/skills` | 重开会话 |
| WorkBuddy | `~/.workbuddy/skills` | 重开 / 重启；复制时保留 `_skillhub_meta.json` 等 `_*` 元数据 |

- 带 `git-addr` 的技能：上游仓库不放在本目录，每次安装都重新拉一次到 `~/.cache/skills-src`（拉完保留，下次 `fetch` 复用），`~/MyCode/skills` 里只留一行地址。四个地址都是 SSH（`git@github.com:...`），需要本机 SSH key 已加到 GitHub。
- 带 `SKILL.md` 的技能：直接复制整包。默认 `copy`（各家一份，互不影响）；想要「改本目录即时生效」就 `--mode link`，只支持 dsh。
- `chanlun` / `westockdata` 的脚本在拉取缓存 `~/.cache/skills-src/<name>/` 里（已装到各工具的副本也有同样文件）；下文的 `python3 ~/.cache/skills-src/chanlun/scripts/...` 就是这么来的。

---

## 一、四个技能的作用与用法

### 1. `a-stock-data` — A 股全栈取数（自包含 Python 代码）

**作用**：15 层 87 个端点（行情/K线/逐笔、研报、资金面与筹码、新闻、财务三表、公告、打板、ETF 期权、互动舆情、宏观利率、指数与交易日历、期货大宗、事件驱动、可转债），34 个数据源，除 iwencai 外零 key。每个端点内嵌可直接运行的 Python 代码。

**什么时候用**：需要 A 股的原始数据、官方源字段、或要自己改抓取逻辑时。取数优先试 `westock`（见分工），拿不到再来这里。

**怎么用**：模型加载后按 `SKILL.md` 的「端点路由表」找到 §编号，只读对应的一个 `references/layer-*.md`。目录结构：

```
SKILL.md                    导航 + 87 端点路由表
references/00-changelog.md        版本变更与口径更正（含科创板成交量单位这类坑）
references/01-source-priority.md  数据源优先级 + 东财防封铁律
references/02-activation.md       完整触发条件
references/03-prerequisites.md    依赖、iwencai key、mootdx 0.11.x BESTIP bug
references/04-tdx-client.md       tdx_client / 市场前缀
references/05-ticker-normalization.md  代码格式归一化
references/06-http-helpers.md     em_get / EM_SESSION / V39_RETRY_SESSION
references/layer-01..15-*.md      每层一个文件（3–40KB）
```

**前置**：`pip install mootdx requests pandas stockstats numpy baostock xlrd openpyxl`；iwencai 语义搜索需要 `IWENCAI_API_KEY`。

**注意**：科创板（688/689）K 线成交量单位是**股**，其余是手；东财所有请求必须走 `em_get()` 限流；mootdx 行情命令 2026-09 起已失效，只留作财务/F10。

---

### 2. `global-stock-data` — 美股/港股/全球市场（带合规分级）

**作用**：15 层 50+ 端点，17 个数据源，每个源标注 **S/B/C/D 合规级别与条款原文**。覆盖行情与 K 线（含日/台/韩/印/欧市场后缀）、技术指标、基本面、资金流、CBOE 期权链与 0DTE/VIX 期限结构、SEC EDGAR 申报与全市场横截面筛选、FINRA 做空、央行利率与汇率、台股、EIA 能源。

**什么时候用**：美股/港股/全球市场；或者需要合规级别判断、需要官方源原始字段时。

**怎么用**：先读 `references/01-compliance.md` 确认所选源的合规级别（C 需授权、D 禁止自动抓取），再按路由表打开对应的 `references/layer-*.md`。目录结构与 A 股那份平行：

```
SKILL.md                         导航 + 路由表（Layer → 文件）
references/00-changelog.md
references/01-compliance.md      ⭐ 合规分级，取用前必读
references/02-activation.md
references/03-prerequisites.md
references/04-market-codes.md    东财 secid / Yahoo 后缀 / SECUCODE
references/05-helpers.md         Yahoo crumb、em_get、official_get 限流出口
references/layer-01..15-*.md     每层一个文件
```

**前置**：只要 `requests`（Windows 另装 `tzdata`）。SEC 要求 UA 带真实联系方式：`SEC_CONTACT` 不改会抛 `RuntimeError`。

---

### 3. `chanlun` — 缠论结构分析

**作用**：把缠中说禅流程固化成可复现的机械化流程，按原文口径输出结构化结论：K 线包含处理 → 分型 → 笔 → **线段（特征序列分型）** → **线段级中枢（延伸不扩区间）** → 背驰（趋势/盘整分开）→ 三类买卖点（状态机 + 互斥），并给出支撑/阻力/触发/失效价位。

**什么时候用**：分析走势、判断趋势、找买卖点、复盘 K 线、判断"现在处于上涨/下跌/盘整的哪一段"。

**怎么用**：加载后按 `references/workflow.md` 执行；理论细节查 `references/chanlun-theory.md`。

主级别数据（二选一）：

```python
# a-stock-data
df = tencent_kline("sh600519", period="day", adjust="qfq", count=250)
df.to_json("/tmp/chanlun/day.json", orient="records")
```

```bash
# 或 westock kline + 转换器
westock kline sh600519 --period day --limit 250 > /tmp/chanlun/day.md
python3 ~/.cache/skills-src/chanlun/scripts/westock_kline_to_json.py /tmp/chanlun/day.md > /tmp/chanlun/day.json
```

次级别数据（区间套，三买/三卖/二买确认用）：

```bash
westock kline sh600519 --period m30 --start 2026-09-27 --end 2026-10-27 > /tmp/chanlun/m30.md
python3 ~/.cache/skills-src/chanlun/scripts/westock_kline_to_json.py /tmp/chanlun/m30.md > /tmp/chanlun/m30.json
```

分析：

```bash
# 基础：线段级中枢 + 区间套确认
python3 ~/.cache/skills-src/chanlun/scripts/chanlun_analyze.py /tmp/chanlun/day.json \
  --sub-level /tmp/chanlun/m30.json --name 贵州茅台 --out /tmp/chanlun/r.json

# 短数据降级：250 根日线常凑不够 3 条线段，用笔级中枢（噪声更大）
python3 ~/.cache/skills-src/chanlun/scripts/chanlun_analyze.py /tmp/chanlun/day.json --center-level stroke

# 历史信号回溯：按首次识别记账，统计其后 20 根的表现
python3 ~/.cache/skills-src/chanlun/scripts/chanlun_analyze.py /tmp/chanlun/day.json \
  --center-level stroke --history --history-horizon 20 \
  --history-fee 0.0005 --history-slippage 0.0005 --history-out /tmp/chanlun/trades.csv

# 多标的批量扫描（同一套参数）
python3 ~/.cache/skills-src/chanlun/scripts/batch_scan.py --symbols sh600519,hk00700 --fetch \
  --center-level stroke --history --out /tmp/chanlun/summary.csv

# 参数敏感性网格
python3 ~/.cache/skills-src/chanlun/scripts/param_sweep.py --dir /tmp/chanlun '*.json' \
  --center-levels segment,stroke --horizons 10,20,30 \
  --out /tmp/chanlun/matrix.csv --detail-out /tmp/chanlun/detail.csv

# 出图（自包含 SVG，含中枢树 L2）
python3 ~/.cache/skills-src/chanlun/scripts/render_chart.py /tmp/chanlun/day.json \
  --center-level stroke --last 300 --out /tmp/chanlun/chart.svg \
  --html /tmp/chanlun/chart.html

# 一键报告（HTML 自带图 + 表，另出 Markdown）
python3 ~/.cache/skills-src/chanlun/scripts/make_report.py /tmp/chanlun/day.json \
  --center-level stroke --sub-level /tmp/chanlun/m30.json --history \
  --title "贵州茅台 日线" --out /tmp/chanlun/report.html --md /tmp/chanlun/report.md

python3 -m unittest discover -s ~/.cache/skills-src/chanlun/tests -v   # 改脚本后先跑（51 条）
```

**注意**：

- 信号带 `state`：`confirmed`（次级别已确认，可直接执行）/ `candidate`（形态成立、缺次级别确认）/ `approx`（无次级别数据，本级别近似）。
- 带 `--sub-level` 时会输出 `multi_level.confluence`：`共振` / `矛盾` / `待确认`，矛盾时以大级别为准。
- 线段级中枢需要较长历史（一段线段通常 5–7 笔，250 根日线常只有 1–3 条线段）；短数据用 `--center-level stroke` 降级，报告里注明口径。
- 单边行情里中枢会长期延伸，一买/一卖因此很少出现；脚本会提示"最后中枢仍在延伸"，这不是 bug。
- `--history` 按"下一根开盘入场 + 双边手续费/滑点"模拟，先触发失效价即止损出场；收益按信号方向折算（买点做多、卖点做空），并可用 `--history-out trades.csv` 导出明细。
- 中枢会生成 `center_tree`：相邻重叠的中枢合并、段数 > 9 的单中枢提升为高一级别。
- **没有信号是正常结果**：一买只认趋势背驰，三买要求"离开中枢 + 回抽不进中枢"，严格口径下一段行情常常没有买点。
- 末段线段未出现特征序列分型时标 `未确认`，仍参与中枢计算，但报告要说明可能被延伸。
- 候选笔会被**收盘价**证伪：收盘越过候选笔起点极值时输出"已失效"。
- 中枢段数 > 9 会标 `⚠级别升级`（本版只提示，不建中枢树）。
- 同级别同一天出现买点与卖点时两条都丢弃并记入 `conflicts`，说明处在临界状态。

### 4. `westockdata` — 腾讯自选股结构化查询（CLI）

**作用**：把 `westock` CLI 的能力封装成技能，覆盖 A股/港股/美股/日韩股、ETF、指数、板块、期货、外汇、可转债的行情与 K 线/分时，以及财报三表、业绩预告、资金流/两融/大宗/龙虎榜/北南向、股东分红回购、研报评级一致预期、新闻公告、投资日历与公司事件、宏观指标、产业链图谱、选股。

**什么时候用**：要现成的结构化数据、不想自己写抓取代码时（取数首选）。

**怎么用**：直接调 CLI，常用：

```bash
westock quote sh600519                    # 实时行情（也支持 hk00700 / usAAPL / 指数 / ETF）
westock kline sh600519 --period day --limit 60
westock minute sh600519
westock technical sh600519                # MA/MACD/KDJ/RSI/BOLL
westock chip sh600519                     # 筹码成本分布（仅 A 股）
westock finance sh600519 --limit 4        # 三大表
westock fund flow sh600519                # 资金流（另有 margin / block / lhb / short / north-holding）
westock report list sh600519              # 研报（另有 rating / consensus / esg）
westock news list sh600519                # 新闻（另有 notice 公告）
westock macro indicator                   # 宏观（另有 calendar / event / risk / suspension）
westock sector ranking                    # 板块（另有 constituent / valuation / forecast / oper）
westock search 宁德时代                    # 统一搜索
westock screen condition                  # 选股
```

**前置**：`westock` CLI（已装：`~/.local/bin/westock` → `~/.westock/channels/wbgeneral/bin/westock`，v0.0.7），并完成一次授权。

**注意**：未授权时任何数据命令都会打印 `AUTH_REQUIRED:<url>`，用系统浏览器打开该链接，然后 `westock auth fetch --wait 300` 领取凭证。凭证在 `~/.westock/`，`westock auth clear` 可撤销。

---

## 二、分工：只约束"取数"

四个技能的 `description` 已经写明分工（模型只看得到 `description`，看不到 `whenToUse`）：

| 场景 | 用哪个 |
|---|---|
| 取现成结构化数据（A股/港股/美股/ETF/板块/研报/新闻/公告/宏观/资金面） | `westockdata`（需已授权） |
| westock 拿不到：A股逐笔、通达信盘后包、复权因子、申万行业变迁史、ETF 份额、备用源降级 | `a-stock-data` |
| westock 拿不到：CBOE 期权链/希腊字母/0DTE/VIX 期限结构、SEC EDGAR、FINRA 美股做空、台股、EIA、BIS/央行利率 | `global-stock-data` |
| 缠论结构分析、买卖点判断 | `chanlun` |

**不受分工限制的部分**（这些是"非取数能力"，照原样用各自技能）：

- `a-stock-data`：估值公式（前向 PE / PE 消化 / PEG / `full_valuation`）、筹码分布计算、成交量与复权口径说明、备用源速查。
- `global-stock-data`：S/B/C/D 合规分级与条款、代码格式规则、数据口径、备用源。
- `chanlun`：分型/笔/中枢/背驰的判定流程本身。

`chanlun` / `westockdata` 都从上游仓库拉取，`install-skills.mjs` 只是原样复制上游技能包，不会补这段分工句。如果上游更新后 `description` 里的分工句丢了，要改**上游仓库并重新安装**（直接改 `~/.cache/skills-src/<name>/` 会被下次拉取覆盖，除非加 `--no-pull`）；原句如下：

```yaml
# westockdata
description: 金融市场结构化数据查询的权威入口（腾讯自选股）。支持 A股/港股/美股/日韩股、ETF、指数、板块、期货、外汇、可转债的行情/K线/分时、财报、研报、新闻、公告、事件、股东、分红、ETF持仓、热搜、新股与投资日历、龙虎榜，以及产业链图谱、行业经营数据、申万估值与盈利预测、全球宏观。分工只针对取数：CLI 已授权时优先用本 skill；未授权或没有该维度时回退到 a-stock-data（A股）或 global-stock-data（美股/全球）。筛股用 westock-screener，维度差异见 references/routing-guide.md。

# chanlun
description: 缠中说禅(缠论)技术分析框架。当用户要求分析股票走势、判断趋势、识别买卖点、复盘K线、技术面分析、看盘、解盘、波段操作时必须加载本 skill，并按缠论流程(包含处理、分型、笔、中枢、背驰、三类买卖点)执行结构化拆解。覆盖任意 A股/港股/美股/指数/期货 K线序列，配合 scripts/chanlun_analyze.py 机械化识别分型、笔、中枢、背驰与买卖点信号。本 skill 只做结构分析：脚本输入用 a-stock-data 的 tencent_kline(adjust="qfq") 导出 JSON，快速看盘可用 westock kline；都没有时不要编造行情。关键词：缠论、走势、买卖点、背驰、中枢、分型、笔、线段、技术分析。
```

---

## 三、安装与升级

### 一条命令装四家

```bash
node ~/MyCode/skills/install-skills.mjs                  # 遍历所有技能：拉取远程 + 同步到四家
node ~/MyCode/skills/install-skills.mjs --dry-run        # 只看计划，不联网不落盘
node ~/MyCode/skills/install-skills.mjs --targets dsh    # 只装一家（逗号分隔）
node ~/MyCode/skills/install-skills.mjs --only chanlun   # 只处理指定技能；不存在直接报错
```

`install-skills.mjs` 做的事：

- 遍历 `--root`（默认脚本所在目录，也就是本仓库）下所有子目录，有 `git-addr` 或 `SKILL.md` 的才算技能，**没有任何技能名写死在脚本里**；
- 远程技能**每次安装都重新拉一次**：缓存里没有就 `git clone --depth 1`，有就 `git fetch --depth 1 origin HEAD` + `reset --hard`；`git-addr` 改了指到别的仓库会检测到 origin 不一致并重新 clone。拉完保留在 `--cache`（默认 `~/.cache/skills-src`），下次接着复用；
- 仓库根没有 `SKILL.md` 时自动找唯一的一级子目录当技能根；找不到或有多个直接报错；
- 有 `split-<名字>.mjs` 的技能先从拉下来的 `SKILL.md` 拆层再装（`--no-split` 可关掉，但单文件很大）；
- 本地技能整包复制，跳过 `.git`、`__pycache__`、`.DS_Store`、`node_modules` 等；
- 目标已存在时先写 `.<name>.stage-<pid>`，再原子换名，失败回滚；目标若是软链只移链接，不会写穿到源目录；
- 复制时保留目标里已有的 `_*` 文件（WorkBuddy 技能市场的 `_skillhub_meta.json`、`_icon.png`）；
- 装完逐个校验 `SKILL.md` 的 `name` / `description`，有失败项时退出码为 1。

某次拉取失败（网络问题）只影响该技能，其他技能照装，退出码为 1；离线时可用 `--no-pull` 直接吃上一次的缓存。

### list：列出可导入的技能

```bash
node ~/MyCode/skills/install-skills.mjs list          # 技能 / 类型 / 处理方式 / 已装 / 来源
node ~/MyCode/skills/install-skills.mjs list --json   # 机器可读
```

只读本地目录、不联网。`git-addr` 为空会标成 `remote(空)`；「已装」显示四家里装了几家，全装显示「全部」。

### 新增一个技能

```bash
mkdir ~/MyCode/skills/my-skill
echo git@github.com:me/my-skill.git > ~/MyCode/skills/my-skill/git-addr
node ~/MyCode/skills/install-skills.mjs list            # 立刻出现在列表里
node ~/MyCode/skills/install-skills.mjs --only my-skill
```

也可以直接把技能包放进 `~/MyCode/skills/my-skill/`（含 `SKILL.md`），脚本按本地技能处理。仓库根不是技能根也没关系，会自动找唯一的一级子目录。

选项：

| 参数 | 作用 |
|---|---|
| `--targets <list>` | `dsh` / `codex` / `claude` / `workbuddy`，逗号分隔；默认 `all` |
| `--only <list>` | 只处理指定技能，默认全部（`list` 也可用它筛选）；名字不存在直接报错（退出码 2） |
| `--root <dir>` | 技能源根目录，默认脚本所在目录 |
| `--cache <dir>` | 远程技能拉取目录，默认 `~/.cache/skills-src`（拉完保留） |
| `--no-pull` | 不联网，直接用缓存里上次拉取的副本 |
| `--mode <copy 或 link>` | 默认 `copy`；`link` 建软链（只有本地技能 + dsh 支持，改源即时生效） |
| `--no-split` | 不拆层，直接安装原包 |
| `--dry-run` / `--json` | 只打印计划、不联网不落盘 / 输出机器可读摘要 |

不需要改 `cordis.yml`、不需要重启 `dsh web`：`~/.dsh/skills` 是内置扫描根，目录监听会自动刷新 catalog。Codex / Claude Code / WorkBuddy 重开会话后生效。

### 拆分脚本（也可以单独跑）

两个 `split-*.mjs` 都接受参数，`--help` 看完整说明：

| 参数 | 作用 |
|---|---|
| `--source <file>` | 上游 `SKILL.md` 路径 |
| `--root <dir>` | 技能源根目录，默认脚本所在目录 |
| `--target-root <dir>` | 安装根目录，默认 `~/.dsh/skills` |
| `--target <dir>` | 精确安装目录，优先于 `--target-root` |
| `--name <name>` | 安装后的目录名与 frontmatter `name` |
| `--dry-run` | 只生成并校验，不写盘 |
| `-h, --help` | 用法 |

```bash
node ~/MyCode/skills/split-a-stock-data.mjs --dry-run
node ~/MyCode/skills/split-a-stock-data.mjs --target-root ~/.codex/skills
node ~/MyCode/skills/split-global-stock-data.mjs --target /tmp/skills/global-stock-data
```

源文件按 `--source` → `~/MyCode/skills/<name>/SKILL.md` → `~/.cache/skills-src/<name>/SKILL.md` 的顺序找；`~/MyCode/skills` 里只有 `git-addr`，所以直接跑拆分脚本会用上一次安装拉下来的缓存（想更新先跑一次 `install-skills.mjs`）。

生成脚本的保障：上游改了章节结构会直接报 `结构已变，未改动目标目录` 并保留上一版；写盘用暂存目录 + 原子换名，失败回滚；生成后会拼回原文逐行比对。目标目录若落在源目录里会直接拒绝。三个脚本共用的参数解析与路径工具在 `lib/cli.mjs`。

### 升级

```bash
# 所有带 git-addr 的技能：重跑安装脚本，会逐个 fetch 最新（每次都重新拉）
node ~/MyCode/skills/install-skills.mjs

# westockdata 也是 git-addr 技能，和 chanlun 一样重跑安装脚本即可
node ~/MyCode/skills/install-skills.mjs --only westockdata

# 本地技能（目录里有 SKILL.md）：源目录改完直接重跑，copy 模式会覆盖安装副本
node ~/MyCode/skills/install-skills.mjs --only <name>

# westock CLI 自身升级（必须用 openssl 3，见下）
PATH=/usr/local/opt/openssl@3/bin:$PATH bash ~/.cache/skills-src/westockdata/scripts/setup.sh
```

### 卸载 / 回滚

```bash
# 默认 copy 安装的是实体目录；rm -rf 只删安装副本，源目录不动
rm -rf ~/.dsh/skills/chanlun ~/.codex/skills/chanlun ~/.claude/skills/chanlun ~/.workbuddy/skills/chanlun

# --mode link 装的是软链，rm 只删链接
rm ~/.dsh/skills/chanlun

# 想连拉取缓存一起清掉（下次安装会重新 clone）
rm -rf ~/.cache/skills-src
```

装错了直接重跑 `install-skills.mjs` 覆盖即可（脚本幂等）；远程技能要回滚到旧版本，可以 `git -C ~/.cache/skills-src/<name> checkout <旧commit>` 后加 `--no-pull` 安装。

---

## 四、排错

| 现象 | 处理 |
|---|---|
| 技能不出现在 catalog | 检查 `SKILL.md` 的 frontmatter 有 `name`（kebab-case）+ `description`；目录必须是 `~/.dsh/skills/<name>/SKILL.md` 或 `~/.dsh/skills/<name>.md`（只扫一层） |
| Codex / Claude Code / WorkBuddy 里看不到新技能 | 先 `ls ~/.codex/skills` 等确认已装（`install-skills.mjs` 默认四家都装），再重开会话；这三家不保证跟随软链，别用 `--mode link` 装过去 |
| `westock` 报 `AUTH_REQUIRED:<url>` | 系统浏览器打开链接 → `westock auth fetch --wait 300`；链接 5 分钟有效，过期重跑 `westock auth status` 拿新链接 |
| 安装时报 `拉取失败 … unable to access` | 远程技能每次安装都要联网拉 GitHub。检查网络 / 代理后重跑；临时离线用 `--no-pull` 吃缓存 |
| 安装时报 `Permission denied (publickey)` | `git-addr` 用的是 SSH 地址，先 `ssh -T git@github.com` 确认 key 已加到 GitHub；没有 key 就把 `git-addr` 临时改回 HTTPS 地址 |
| `list` 里出现 `remote(空)` 或安装报 `git-addr 是空的` | `~/MyCode/skills/<name>/git-addr` 是空文件或只剩注释，写入一行 git 地址即可 |
| `--only` 写错技能名 | 直接报 `技能不存在：xxx` 并列出可选技能（退出码 2）；先 `list` 看准确名字 |
| setup.sh 报"签名缺失或无效，疑似发布物被篡改" | 环境里是 OpenSSL 1.1.1（没有 `pkeyutl -rawin`）导致误判，不是发布物问题。用 `PATH=/usr/local/opt/openssl@3/bin:$PATH` 重跑 |
| 加载大技能后回答被截断 | 工具结果超过 8192 字符时，压缩触发后会被裁成"前 4096 + 后 1024"。`a-stock-data` / `global-stock-data` 已拆层，按需只读一个 reference；不要让模型整目录通读 |
| 改了 `SKILL.md` 但模型还看到旧描述 | catalog 按 `name+description` 摘要判断是否重发；等一次目录刷新（约 2 秒写稳定窗口），或新开会话 |

---

## 五、验证清单

```bash
node ~/MyCode/skills/install-skills.mjs list              # 技能 / 类型 / 处理 / 已装 / 来源
node ~/MyCode/skills/install-skills.mjs --dry-run         # 四家 × 全部技能的计划
ls ~/.dsh/skills ~/.codex/skills ~/.claude/skills ~/.workbuddy/skills   # 都应各有四个实体目录
ls ~/MyCode/skills/a-stock-data ~/MyCode/skills/global-stock-data ~/MyCode/skills/chanlun ~/MyCode/skills/westockdata    # 应只有 git-addr
du -sh ~/.cache/skills-src/*                              # 拉取缓存（每个远程技能一个仓库）
node ~/MyCode/skills/split-a-stock-data.mjs --dry-run     # 结构 / 无损校验
westock auth status                                # READY
westock quote sh600519                             # 真实行情
```

模型侧验证：在会话里让技能目录出现（新会话自动带），或直接输入 `/a-stock-data`、`/global-stock-data`、`/chanlun`、`/westockdata` 手动触发。
