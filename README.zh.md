# dsh-auto-eval

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下面简称 dsh）的评估插件。用它给 LLM 应用建评估集，再拿评估集去改进应用本身。

能评估两类对象：

- **dsh agent 自己**：提示词、AGENTS.md、skills、用哪个模型、推理强度开多大。
- **你自己写的 LLM 应用**：只要能从命令行跑起来就行。

流程照着 Anthropic 那篇 [Automating eval design and hillclimbing](https://claude.dev/blog/automating-eval-design-and-hillclimbing/) 来。Hamel Husain 写过一篇[评测](https://hamel.dev/blog/posts/claude-auto-evals/)，挑了不少毛病，下面这些是照他的意见改的：

- 先看数据。没读过真实对话之前，不写评分器。
- 标注在网页里做。在聊天框里来回贴 Markdown 太难受了。
- 一个评分器只查一种问题，结果就是通过或不通过，不打 1 到 5 分。
- 评分器的代码和 judge 的提示词都是普通文件，原样拿给你看。
- 用 LLM 当裁判之前，先拿你的标注对一遍（看 TPR 和 TNR），对得上才用。
- 该你拍板的环节，工具会卡住，agent 跳不过去。真想跳，要写明理由，理由会记下来。

```
/auto-eval ─► /error-analysis ─► /build-eval ─────────────────► /hillclimb
              采样对话记录        收集用例，你来审                  单独开一个分支
              你逐条判、写笔记     每类问题一个评分器                 基线跑几遍，量出噪声
              归纳出问题类型       judge 对齐你的标注                 每轮只改一处
                                 切分训练集和测试集，跑基线          训练集涨过噪声、测试集也涨，才留下
```

## 安装

```sh
# 装到你平时用的 profile 里（web、headless 等）
dsh plugin --profile web add github:shepherdlou/dsh-auto-eval
# 或者装本地目录
dsh plugin --profile web add ./dsh-auto-eval

dsh --profile web --dump-config | grep -A2 dsh-auto-eval   # 能看到 "# == dsh-auto-eval" 就装好了
```

需要 dsh 0.2.0-rc.2 以上、Node 22 以上，项目要在 git 里。

## 怎么用

在项目里开一个 dsh 会话，输入 `/auto-eval`。它会先看看项目里已经有什么，再决定从哪一步开始。想看进度，输入 `/eval`，这个命令不调模型。

轮到你动手的时候，agent 会给你一个本地网址（`http://127.0.0.1:端口/?token=…`），然后停下来等你。你在网页里看、在网页里标；采样、归纳、写评分器、跑评估这些活归 agent。

如果 dsh 是一次性跑的（比如 headless 模式），进程一退出网页也跟着没了。这种情况下 agent 会直接给你一条命令，用插件自带的小工具把网页开起来：

```sh
node <插件目录>/bin/dsh-auto-eval.mjs review <eval 名字> --cwd <项目目录>
node <插件目录>/bin/dsh-auto-eval.mjs status --cwd <项目目录>      # 和 /eval 一样
```

网页里有这几块：

| 页面 | 你要做的事 |
|---|---|
| Traces | 一条条看对话，判通过或不通过（快捷键 `1`/`2`，`j`/`k` 翻页）。不通过的写一句笔记，记下最先出问题的地方 |
| Failure modes | agent 根据你的笔记归纳出几类问题，你来改名、合并、调整归类（可以把笔记直接拖到某一类上） |
| Cases | 审评估用例，留下或去掉，顺手改标签。都看过了可以一键通过剩下的 |
| Grader labels | 给某个 judge 盲标：你先判，判完才显示 judge 怎么判的 |
| Results | 看打分结果和完整对话，觉得哪条判错了就点“I disagree” |

## 插件里有什么

**Skills**（你和模型都能调）：`/auto-eval`（入口，负责判断下一步）、`/error-analysis`、`/build-eval`、`/hillclimb`。

**工具**

| 工具 | 干什么 |
|---|---|
| `eval_init` | 在 `.evals/<名字>/` 下新建、检查、列出评估 |
| `eval_traces` | 从当前目录的历史 dsh 会话里采样（先挑被点踩的，再挑出过错的，剩下随机），或者导入你应用导出的 JSONL 日志 |
| `eval_review` | 打开标注网页，查看标注进度 |
| `eval_split` | 把收集到的用例切成训练集（留在项目里）和测试集（挪到项目外面）。你没审过的用例它不收 |
| `eval_run` | 在某个集合上跑若干遍并打分，给出分数和 95% 区间、每类问题的通过率、诊断信息。测试集只返回汇总数字。还没写评分器时也能跑，只收集输出；加上 `saveAsTraces` 会把输出放进标注网页 |
| `eval_judge_check` | 拿你的标注校准 judge：标注分三份，few-shot 示例、开发集、测试集。开发集返回具体分歧，测试集只给 TPR 和 TNR |
| `eval_hillclimb` | start / round / finish / status。judge 没在当前提示词上校准过，它不开工 |

另外还有 `/eval` 命令。还有一道拦截：模型调用其他工具时，参数里只要提到测试集的存放位置，就直接拒绝。

## 两类评估对象

### 你自己的应用：`kind: command`

什么语言写的都行。每次从 stdin 读一条用例，把结果打到 stdout：

```
stdin : {"id": "t01", "input": <用例输入>, "tags": [...], "meta": {...}}     （参考答案不会传进来）
stdout: {"output": <任意值>, "messages"?: [{role, content}], "usage"?: {...}, "model"?: "..."}
```

stdout 直接打一段纯文本也可以，整段算作输出。退出码非零或者超时，记为基础设施错误，不算应用答错。例子见 [`examples/support-triage`](examples/support-triage)。

### dsh agent 自己：`kind: dsh-agent`

每次运行是 `dsh --profile headless [--patch <候选配置>] --json -`，任务从 stdin 传进去。默认每次都在一个新的 git worktree 里跑（`isolation: worktree`），上一次留下的文件不会影响下一次。用例可以带 fixture（`fixture: {dir, into}`），运行前拷进 worktree；代码评分器拿得到这个目录，可以在里面跑测试。插件跑在 dsh 里的时候，会从会话存储里把完整对话读回来。

候选配置就是仓库里的文件：AGENTS.md、`.dsh/skills/`，再加上 `target.patch` 指向的 patch 文件，比如：

```yaml
# .dsh/auto-eval-target.yml。patch 会整行替换 config，要保留的键都得写上
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
- id: system-prompt
  config:
    personaSuffix: Your working directory is {{cwd}}.
    personaPrefix: You are a coding agent powered by the {{model}} model.
```

一轮对话如果以 `error`、`max-tokens`、`aborted` 或 `blocked` 结束，算基础设施错误。`blocked` 多半是 headless 模式下有工具要审批，没人点，去调 `target.permissionMode`。例子见 [`examples/dsh-agent`](examples/dsh-agent)。

## `eval.yaml`

```yaml
name: support-triage
target: { kind: command, command: "node app.mjs", timeoutMs: 120000, isolation: shared }
repeats: 3            # 每条用例跑几遍；单条用例的分数 = 通过的比例
concurrency: 4
split: { seed: 42, testFraction: 0.3, stratifyBy: tag }
judge: { provider: deepseek-official, model: deepseek-v4-pro, maxTokens: 8192 }   # 不填就用 agent 的默认模型；推理 token 也算在 maxTokens 里
goal: score           # score | cost | latency
prices: { deepseek-flash: { input: 0.27, output: 1.1, cacheRead: 0.07 } }       # 每百万 token 多少美元。dsh 只报 token 数，钱要自己按价格算
graders:
  - { mode: wrong-category, kind: code,  file: graders/wrong-category.check.mjs }
  - { mode: promises-refund, kind: judge, file: graders/promises-refund.judge.md }
thresholds: { judgeTpr: 0.9, judgeTnr: 0.9, headroom: 0.95, minEffect: 0.03, minCostGain: 0.05 }
```

**代码评分器**写成这样：`export default ({ input, output, expected, case, trace, workdir }) => ({ pass, reason })`。`pass: true` 表示这类问题没出现。

什么时候用代码，什么时候用 judge？问自己一句：两个认真的人会不会对结果有分歧？不会，就写代码，比如判空、判长度、字段对不对、测试过没过。会，就交给 judge。拿正则去匹配自然语言回复（“是不是承诺了退款”“有没有编造订单信息”）不算代码能判的事，换个说法就漏了。

**judge 的提示词**是一个 Markdown 文件，只针对一类问题，写成能逐条核对的“什么情况算不通过、什么情况算通过”。插件会在前面加一段固定说明，要求 judge 只回一个 JSON：`{"critique": "...", "pass": true|false}`。dsh 没有 JSON 模式，所以回复是靠一个严格的解析器检查的。`eval_judge_check` 会把校准用的例子写进 `graders/<mode>.fewshot.jsonl`，之后每次运行都带上。

## 目录结构

```
.evals/<名字>/
  eval.yaml  README.md  taxonomy.json
  traces/                 采样来的对话记录
  labels/*.jsonl          你的标注。只往后追加，同一个 id 以最后一行为准
  cases/inbox.jsonl       收集了、还没切分的用例
  cases/train.jsonl       训练集
  graders/                <mode>.check.mjs 或 <mode>.judge.md（外加 .fewshot.jsonl）
  judge-checks/<mode>.json  校准结果，和提示词的哈希绑在一起，提示词一改就失效
  audit.jsonl             哪一步人工环节被跳过了，为什么
  runs/<runId>/           results.jsonl、transcripts/、summary.json、results.html
  hillclimb/log.jsonl     每一轮改了什么、分数怎么变、留下还是撤回、原因
$DSH_HOME/auto-eval/<项目哈希>/<名字>/heldout/
  test.jsonl、runs/、archived-runs/     测试集一直放在这里，不进项目目录
.dsh-auto-eval/           爬坡用的 worktree，已经加进 git 忽略
```

## 分数怎么算，改动怎么取舍

- 单条用例的分数是它跑若干遍里通过的比例，整体分数是所有用例的平均。同一条用例跑几遍，结果是相关的，所以 95% 区间按整条用例重采样（聚类 bootstrap）。
- 基础设施错误和评分器自己出错的情况不计分，单独列出来。
- 诊断信息会提醒这些情况：基础设施错误超过 5%；评分器报错；分数高过余量阈值（评估集太简单）；有用例每一遍都失败（可能是题目有歧义，或者评分器有 bug）；不稳定的用例太多；同一个输入 judge 前后判得不一样（用 `consistencySample` 检查）。
- **噪声**按 `1.96·√2·σ` 算。σ 取两个数里大的那个：基线跑几遍之间的实际波动，以及用每条用例内部的方差推出来的波动。这样就算基线几遍碰巧一模一样，也不会把噪声算成零。
- **每一轮**都在同一批用例上和目前最好的版本配对比较：
  - 训练集提升超过噪声，**并且**测试集也上涨，才留下；
  - 只有训练集涨（典型的过拟合），或者哪边掉了，就撤回；
  - 改动碰了评估集本身，或者评估集被改过（`eval.yaml`、评分器、用例、fixture、测试集都算在内），这一轮作废。
- 目标是成本或延迟时，两个集合上的质量下降都不能超过噪声，同时成本或延迟至少降 `minCostGain`。
- 连续三轮没有改动被留下，agent 会停下来，先把剩下的训练集失败按原因分一遍类，再决定下一步。
- 收尾时分支停在测试集分数最高的版本上，报告里给出基线和最终版本的分数和区间。配对比较的区间要是跨过了 0，会写明“提升还不能算数”。

## 测试集隔离的边界

做到的：

- 测试用例、参考答案和测试集上的运行记录都放在项目目录外面。
- 工具只返回测试集的汇总数字，诊断里也不带用例 id。
- 切分之前跑过的记录里有后来分进测试集的用例，切分时一并挪走。
- 标注网页不提供测试集里的任何东西。
- 模型调别的工具时，参数里提到测试集位置的，`tools/pre-execute` 那道拦截会直接拒掉。

没做到的：

- 铁了心要读的话，比如用 shell 命令把路径拼出来，还是拦不住。这道拦截只能防无意，防不了故意。
- 做错误分析时采样的生产对话会一直留在 `traces/` 里，就算后来有用例是从里面挑出来的。

`/hillclimb` 这个 skill 还规定不许把失败样本的内容贴进提示词。爬坡日志最好有人看着。

## 配置

写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: auto-eval
  name: dsh-auto-eval
  config:
    reviewPort: 0               # 0 表示随便挑一个空闲端口
    guardHeldout: true
    allowOtherWorkspaces: false # eval_traces 只读当前目录下的会话
    sessionScanLimit: 300
```

## 开发

```sh
npm install
npm test                                   # 38 个测试，覆盖核心模块、runner、标注服务、judge 校准、人工环节的拦截、爬坡、在真实 dsh ToolRuntime 上挂插件、两个示例
dsh plugin --profile headless add .        # 再对真实 dsh 跑一遍冒烟测试，用脚本模拟的模型驱动，不需要 API key：
DSH_BIN=$(which dsh) node test/e2e/dsh-smoke.mjs
```

`lib/core/` 不依赖 dsh，可以单独用：`import … from 'dsh-auto-eval/core'`。

## 已知限制

- 错误分析、审用例、给 judge 标注，这几步得有人来做，插件不会替你做。
- dsh 的会话查询没有为这种用法建索引，只能把日志从头重放一遍，所以 `eval_traces` 每次最多读 `sessionScanLimit` 个会话。
- 标注网页只监听 127.0.0.1。在远程机器上用，要自己做端口转发。
- 金额是按你在 `prices` 里填的单价算的，dsh 本身只给 token 数。
- 测试集隔离能做到哪一步，上面写清楚了。

## 致谢

思路来自 Anthropic 的 [Automating eval design and hillclimbing](https://claude.dev/blog/automating-eval-design-and-hillclimbing/)、Hamel Husain 的[评测文章](https://hamel.dev/blog/posts/claude-auto-evals/)和 [evals-skills](https://github.com/ai-evals-course/evals-skills)。插件写法参考了 [deepseek-harness#961](https://github.com/deepseek-ai/deepseek-harness/discussions/961) 里的教程。

MIT 许可证。
