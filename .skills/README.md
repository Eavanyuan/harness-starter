# .skills — 领域知识层

> 这里放「怎么改这个栈的代码」。agent 定义里不写领域知识，全部下沉到这里。
> 一个 skill 一个目录，**目录名 = skill 名**；`stack` 字段说明它服务哪个栈。

**选择逻辑：按 `applies_to` 的文件 glob 选，不是按栈一对一。** 同一栈可以有多份
（`frontend` 和 `e2e` 都服务 `frontend`），一次改动命中几份就加载几份。

选择由命令完成，不靠模型判断：

```bash
node scripts/resolve-skills.mjs --diff                       # 取 git 改动，输出该读哪些
node scripts/resolve-skills.mjs backend/src/A.java           # 或显式给文件
```

输出里带 `← Stage 0 强制` 的，表示改代码前必须逐项完成它的 `## Stage 0`。

## 加载协议

| 时机 | 谁加载 | 加载什么 |
|---|---|---|
| TODO 进入 `act` 前 | coder / test-engineer | `.skills/<stack>/SKILL.md` + 它 `references:` 列的文件 |
| 交付前复查 | code-reviewer | 同上 |
| 会话恢复 | orchestrator | 遍历 TODO 的 `required_skills` 去重重载 |

三条硬约束，由 `npm run check:skills` 机械校验：

1. **Stage 0 未完成不得写代码。** SKILL.md 的 `## Stage 0` 是一张清单，逐项 Read 完才允许 Edit。
2. **不嵌套。** skill 只能引用自己的 `references/`，不得引用另一个 skill 的 `SKILL.md`。固定 2 层深度。
3. **单文件 ≤ 200 行**（可在 `harness.config.json` 调）。超了说明知识该拆进 `references/`，或某条规则该删。

## 结构

```text
.skills/
├── README.md               ← 本文件
├── SKILL.template.md       ← 新增栈时复制它
├── backend/
│   ├── SKILL.md            ← 入口：Stage 0 / 分流 / 硬规则 / 交付
│   └── references/
│       └── checklist.md    ← 长表：阻断级规则 + 检测命令
├── frontend/
└── e2e/
```

**入口文件只放"决定动作"的内容**：读完它就知道该不该动手、动完怎么验。**references 放"查得到"的内容**：具体写法、字段表、正则。两者的分界是——入口要背下来，references 允许现查。

## 现有 skill

| skill | 管什么 | 不管什么 |
|---|---|---|
| `backend` | `backend/` 下 Java 服务端改动 | 前端、构建流水线配置 |
| `frontend` | `frontend/` 下 Vue 组件与逻辑 | 纯样式主题、E2E |
| `e2e` | `frontend/tests/e2e/` 下的端到端用例 | 单元测试（归各栈 skill） |

> 命令里的 `backend/` `frontend/` 就是 `harness.config.json` → `stacks.<x>.dir`。
> 改目录名时两处一起改，`check:skills` 不校验这一致性，靠人。

## 30 分钟加一个栈

```bash
cp .skills/SKILL.template.md .skills/<stack>/SKILL.md
mkdir -p .skills/<stack>/references
touch .skills/<stack>/references/checklist.md
npm run check:skills        # 先看它骂什么，按提示填
```

1. **frontmatter**：`name` 必须等于目录名；`stack` 必须是 `harness.config.json` 里 `stacks` 的键；
   `applies_to` 必填——没有它，加载器不知道什么时候该用这份 skill。
2. **`## Stage 0`**：只列 3–5 个文件。判据是「读完就敢动手」——不是「了解一下背景」。
3. **`## 硬规则`**：每条编号 + 一条检测命令。**检测不了的不要写成硬规则**，写进 references 当建议。
4. 长内容进 `references/checklist.md`。
5. 跑 `npm run build:agents`，让新 stack 进入产物里的加载提示。

## 反模式（都是真踩过的）

**级联加载。** IDMP 的 backend skill 要求先连读 12 个文件，其中 6 个是子 skill 的子 skill。实际效果是模型读 3 个就开始写码，剩下 9 个在自检表里被打了勾——而且是编造的。改成 `1 + 1`（入口 + checklist）。

**同一个闸门写三遍。** 入口表一次、自检表一次、TODO 模板一次。三份必然漂移，而模型只信最后读到的那份。**闸门只写一次**，其余地方引用它。

**规则写成愿望。** "注意性能""保持可读""小心并发"无法检测，写进去只稀释注意力。能进硬规则的必须有检测形态。

**把工具链写进 skill。** 构建/测试命令属于 `harness.config.json` 的 `stacks`。skill 里写死命令，换构建工具时两处不一致。

**skill 当文档写。** 300 行的 skill 没有人会在动手前读完——包括模型。它是运行时加载物，不是知识库。

**`applies_to` 只写在文档里。** 如果"该读哪份 skill"靠模型自己判断，它会跳过，或者读完一份不相关的
还觉得自己做了。所以有了 `scripts/resolve-skills.mjs`：把选择变成一条命令、一份可复现的输出。

**把 grep 命中当成判决。** 检测命令产出的是**候选**，不是结论。静态检索无法判断语义，
所以命令要收紧到「命中即可疑」，剩下的交给人和 review——**但不要紧到漏掉真问题**。

实测的例子：查 TS 的 `any` 用 `\bany\b`，第一屏命中的是 license 头里的 "by any medium"。
这种规则活不过第一次全员使用——它会被当成噪声关掉，然后连真问题一起消失。
收紧成 `: any` / `as any` / `<any>` 之后，剩下的是真的类型逃逸。

**同一条规则的多层硬门禁会互相抵消。** 如果一条规则在 hook、CI、review 清单里各拦一次，
人就会挑最松的那条路走。只留一处硬拦，其余地方引用它。

## 版本

`version` 在 frontmatter，改了硬规则就 +1。`state.json` 的 `skill_versions` 记录每个阶段用了哪版，用于回溯"这条规则当时到底在不在"。
