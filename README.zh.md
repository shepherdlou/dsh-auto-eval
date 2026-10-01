# dsh-auto-eval

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的 auto-eval 和爬坡（hillclimb）插件。

它可以为 **dsh agent 自身**（提示词、AGENTS.md、skills、模型和 effort）或**你自己的 LLM 应用**建立评估，再针对评估改进它们。流程参照 Anthropic 的 [*Automating eval design and hillclimbing*](https://claude.dev/blog/automating-eval-design-and-hillclimbing/)，并按 Hamel Husain 在[评测文章](https://hamel.dev/blog/posts/claude-auto-evals/)里提的意见做了调整：

- **先看数据。** 先对真实 trace 做错误分析，再写 grader。
- **用网页标注**，不在聊天里贴 Markdown。trace、case 和 grader 输出都在网页上标。
- **一个 grader 只查一个失败模式**，结论只有 pass/fail。
- **grader 本身给你看。** judge 的 rubric 和检查代码都是普通文件，agent 会把原文给你看，而不是给你一段转述。
- **judge 先对齐你的标注**（在留出的标注上算 TPR/TNR），达标了才用。

```
/auto-eval ─► /error-analysis ─► /build-eval ─────────────────► /hillclimb
              采样 trace          收集 case（你来审）               分支 worktree
              你判断并写笔记       每个失败模式一个 grader            基线跑 k 次 → 噪声底
              归纳失败模式并排序    judge ⇄ 你的标注（TPR/TNR）        每轮只改一处
                                 train/test 划分，跑基线            train 超过噪声且 test 上升才保留
```

## 安装

```sh
# 装进你平时用的 profile（web、headless 等）
dsh plugin --profile web add github:shepherdlou/dsh-auto-eval
# 或者从本地目录安装
dsh plugin --profile web add ./dsh-auto-eval

dsh --profile web --dump-config | grep -A2 dsh-auto-eval   # 能看到 "# == dsh-auto-eval" 这一层就说明装好了
```

需要 dsh ≥ 0.2.0-rc.2、Node ≥ 22，以及 git。

## 使用

在项目里的 dsh 会话中输入 **`/auto-eval`**，agent 会先看项目里已经有哪些东西，然后带你进入合适的步骤。**`/eval`** 不调用模型，只打印当前状态。

agent 会给你一个标注页面的地址（`http://127.0.0.1:<端口>/?token=…`）。阅读和标注由你在页面上完成；采样 trace、提出分类、写 grader、跑评估由 agent 负责。

| 页面 | 你做什么 |
|---|---|
| Traces | 逐条判 Pass/Fail（`1`/`2`，用 `j`/`k` 翻页），写下第一个出错的地方（开放编码） |
| Failure modes | agent 根据你的笔记提出失败模式，你来改名、合并、重新归类（轴向编码，可以把笔记拖到某个模式上） |
| Cases | 逐条批准或拒绝评估输入，修正标签 |
| Grader labels | 针对某个 judge 先盲标，标完才显示 judge 的结论 |
| Results | 阅读打过分的 transcript，对不认同的结论点“I disagree” |

## 插件提供了什么

**Skills**（用户和模型都能调用）：`/auto-eval`（入口，负责分流）、`/error-analysis`、`/build-eval`、`/hillclimb`。

**Tools**

| Tool | 作用 |
|---|---|
| `eval_init` | 在 `.evals/<name>/` 下创建、校验、列出 eval |
| `eval_traces` | 列出或采样当前工作目录的历史 dsh 会话（先取被点踩的，再取异常的，其余随机），或导入你应用的 JSONL trace |
| `eval_review` | 打开标注页面，查看标注进度 |
| `eval_split` | 把 inbox 划分成 train（留在工作区）和 test（移到工作区外）；划分前的运行结果会一并移走 |
| `eval_run` | 对某个划分跑若干次并打分，返回分数和 95% 区间、各失败模式的通过率、诊断信息；test 只返回汇总数字 |
| `eval_judge_check` | 用你的标注校准 judge：标注分成 few-shot、dev、test 三份，dev 返回具体分歧，test 只返回 TPR/TNR |
| `eval_hillclimb` | start / round / finish / status |

**命令**：`/eval`。**守卫**：模型发起的工具调用，只要参数里引用了留出数据的存储位置，就会被拒绝。

## 评估对象

### 你自己的应用：`kind: command`

任何程序都可以。它从 stdin 读一条 case，把结果打印到 stdout：

```
stdin : {"id": "t01", "input": <case 输入>, "tags": [...], "meta": {...}}     （不会包含参考答案）
stdout: {"output": <任意值>, "messages"?: [{role, content}], "usage"?: {...}, "model"?: "..."}
```

stdout 输出纯文本也可以，整段会被当作 output。非零退出码或超时算基础设施错误，不计入失败。示例见 [`examples/support-triage`](examples/support-triage)。

### dsh agent 自身：`kind: dsh-agent`

每次运行执行 `dsh --profile headless [--patch <候选配置>] --json -`，任务从 stdin 传入。每次都在一个全新的 git worktree 里跑（`isolation: worktree`），各次运行之间不会互相留下状态。case 的 fixture（`fixture: {dir, into}`）会被拷进这个 worktree；code grader 能拿到它的 `workdir`，可以在里面跑测试。插件运行在 dsh 里时，完整 trace 会从会话存储中读回来。

候选配置就是仓库里的文件：AGENTS.md、`.dsh/skills/`，以及 `target.patch` 指向的 patch，例如：

```yaml
# .dsh/auto-eval-target.yml —— patch 会整体替换一行的 config，所以要保留的键都要写全
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
- id: system-prompt
  config:
    personaSuffix: Your working directory is {{cwd}}.
    personaPrefix: You are a coding agent powered by the {{model}} model.
```

turn 以 `error`、`max-tokens`、`aborted` 或 `blocked` 结束时，记为基础设施错误。`blocked` 一般是 headless 模式下有工具需要审批，这时要设置 `target.permissionMode`。示例见 [`examples/dsh-agent`](examples/dsh-agent)。

## `eval.yaml`

```yaml
name: support-triage
target: { kind: command, command: "node app.mjs", timeoutMs: 120000, isolation: shared }
repeats: 3            # 每条 case 的分数 = 多次运行中的通过比例
concurrency: 4
split: { seed: 42, testFraction: 0.3, stratifyBy: tag }
judge: { provider: deepseek-official, model: deepseek-v4-pro, maxTokens: 2048 }   # 不填则用 agent 的默认模型
goal: score           # score | cost | latency
prices: { deepseek-flash: { input: 0.27, output: 1.1, cacheRead: 0.07 } }       # 每百万 token 的美元价格（dsh 只报告 token 数）
graders:
  - { mode: wrong-category, kind: code,  file: graders/wrong-category.check.mjs }
  - { mode: promises-refund, kind: judge, file: graders/promises-refund.judge.md }
thresholds: { judgeTpr: 0.9, judgeTnr: 0.9, headroom: 0.95, minEffect: 0.03, minCostGain: 0.05 }
```

**Code grader**：`export default ({ input, output, expected, case, trace, workdir }) => ({ pass, reason })`。`pass: true` 表示这个失败模式没有出现。

**Judge rubric**：一个 Markdown 文件，只针对一个失败模式，写成可以逐条核对的 FAIL/PASS 条件。它原样接在固定协议后面，作为 judge 的 system prompt；judge 只能回复一个 JSON 对象 `{"critique": "...", "pass": true|false}`。dsh 没有 JSON mode，所以这个协议靠严格的解析器保证。`eval_judge_check` 会把校准用的例子写进 `graders/<mode>.fewshot.jsonl`，之后每次运行都会用上。

## 目录结构

```
.evals/<name>/
  eval.yaml  README.md  taxonomy.json
  traces/                 采样出的 trace（已归一化）
  labels/*.jsonl          你的标注；只追加，同一 id 以最后一行为准
  cases/inbox.jsonl       已收集、还没划分的 case
  cases/train.jsonl       train 划分
  graders/                <mode>.check.mjs 或 <mode>.judge.md（另有 .fewshot.jsonl）
  judge-checks/<mode>.json
  runs/<runId>/           results.jsonl、transcripts/、summary.json、results.html
  hillclimb/log.jsonl     每一轮的补丁、变化量、决定和理由
$DSH_HOME/auto-eval/<项目哈希>/<name>/heldout/
  test.jsonl、runs/、archived-runs/   ← 始终不在工作区里
.dsh-auto-eval/           hillclimb 用的 worktree（已被 git 忽略）
```

## 统计方法与判定规则

- **分数。** 每条 case 的分数是它在多次运行中的通过比例，eval 分数是所有 case 的平均。同一条 case 的多次运行彼此相关，所以 95% 区间按整条 case 重采样（聚类 bootstrap）。
- **基础设施错误和 grader 错误**不计入分数，单独报告。
- **诊断**会在以下情况给出提示：
  - 基础设施错误率超过 5%；
  - 出现 grader 错误；
  - 分数超过余量阈值；
  - 有 case 每次运行都失败；
  - 结果不稳定的 case 很多；
  - judge 对同一输入给出不同结论（由 `consistencySample` 检查）。
- **噪声底。** 取 `1.96·√2·σ`。σ 取两者中较大的一个：k 次基线运行之间的实际波动，以及根据每条 case 内部各次运行的方差推算出的波动。这样即使几次基线碰巧完全一样，也掩盖不了真实的噪声。
- **每轮判定。** 每一轮都和目前最好的版本在相同的 case 上配对比较：
  - 当且仅当 `Δtrain > 噪声` **且** `Δtest > 0` 时保留；
  - 只有 train 上升（过拟合信号），或任一划分下降时，回滚；
  - 补丁改动了 eval，或者 eval 本身变了，这一轮作废。eval 的指纹覆盖 `eval.yaml`、graders、cases、fixtures 和留出的 test 集。
- **cost 和 latency 目标**要求两个划分上的质量下降都不超过噪声，同时相对节省至少达到 `minCostGain`。
- **停滞。** 连续三轮都没有保留时，agent 停止打补丁，先把剩下的 train 失败按根因归类。
- **结束。** 分支停在 test 分数最好的版本上。报告给出基线和最终版本的分数及区间；如果配对的 test 区间包含 0，会注明这个提升尚未得到证实。

## 留出数据的隔离：能防什么，不能防什么

**能防住的：**
- test 的 case、参考答案和 transcript 都放在工作区之外。
- 工具只返回 test 的汇总数字，test 的诊断信息会去掉 case id。
- 划分之前跑过的运行结果会被移出工作区。
- 标注页面不提供任何留出数据。
- `tools/pre-execute` 守卫会拒绝参数里提到留出存储位置的模型工具调用。

**防不住的：**
- 执意要读的 agent 仍有办法拿到这些文件，比如用 shell 命令间接拼出路径。这个守卫只是一道警戒线，不是沙箱。
- 错误分析时采样的生产 trace 一直留在 `traces/` 里，即使有 case 是从这些 trace 派生的。

`/hillclimb` skill 还明确禁止把失败样本的内容贴进提示词。请始终有人读 hillclimb 的日志。

## 配置

在 profile 的 `cordis.patch.yml` 里设置：

```yaml
- id: auto-eval
  name: dsh-auto-eval
  config:
    reviewPort: 0               # 0 表示随便找一个空闲端口
    guardHeldout: true
    allowOtherWorkspaces: false # eval_traces 只读当前工作目录下的会话
    sessionScanLimit: 300
```

## 开发

```sh
npm install
npm test                                   # 34 个测试：核心模块、runner、标注服务、judge 校准、hillclimb、在真实 dsh ToolRuntime 上挂载插件、两个示例
dsh plugin --profile headless add .        # 然后对真实的 dsh 跑冒烟测试（不需要 API key，由脚本化的 mock 模型驱动）：
DSH_BIN=$(which dsh) node test/e2e/dsh-smoke.mjs
```

`lib/core/` 不依赖 dsh，可以单独引用：`import … from 'dsh-auto-eval/core'`。

## 局限

- 错误分析、case 审核和 grader 标注都需要人来做。这正是这个插件的出发点。
- dsh 的会话查询没有针对这种用法的索引，只能重放日志，所以 `eval_traces` 每次最多读 `sessionScanLimit` 个会话。
- 标注页面只绑定在 127.0.0.1 上；在远程机器上用，需要做端口转发。
- 金额由你在 `prices` 里填的价格算出，dsh 本身只报告 token 数。
- 守卫和隔离都是尽力而为，具体范围见上文。

## 致谢

本插件借鉴了 Anthropic 的 [*Automating eval design and hillclimbing*](https://claude.dev/blog/automating-eval-design-and-hillclimbing/)、Hamel Husain 的[评测文章](https://hamel.dev/blog/posts/claude-auto-evals/)和 [evals-skills](https://github.com/ai-evals-course/evals-skills) 合集，以及 [deepseek-harness#961](https://github.com/deepseek-ai/deepseek-harness/discussions/961) 中的 dsh 插件教程。

MIT 许可证。
