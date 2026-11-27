---
name: deployment
stack: harness
version: 1.0.0
stage0: true
applies_to:
  - ".skills/deployment/**"
  - "harness.config.json"
  - "harness.rules.json"
references:
  - references/issue-tracker-interface.md
  - references/pitfall-checklist.md
---

# harness 部署到新项目

把 harness-starter 装进一个新项目（或旁挂到一个存量项目）时加载。
管的是**整个部署过程**：能力选配 → init → 接入 → 试运行 → 转常态。
**不管**日常开发（走各栈 skill）与 harness 自身开发（走 harness skill）。

## Stage 0（部署前强制）

| # | 读什么 | 为什么非读不可 |
|---|---|---|
| 0.1 | 本文件全文 | 部署路径的全部决策点与已知坑 |
| 0.2 | `references/pitfall-checklist.md` | 57 条已知坑（首批 47 条蒸馏自 24 个 retro + 17 个 CR，#48–57 为后续实战追记）——不读就是重踩 |
| 0.3 | 目标项目的构建体系（pom/package.json/Makefile） | stacks 配置的 lint/test 命令必须真实可跑 |

前置自检（全 ✅ 才允许 init）：

- [ ] 知道目标项目用什么 issue tracker（飞书/Jira/GitHub）——没有就跳过剖面 B
- [ ] 知道目标项目用什么 CI（GitLab/GitHub Actions/Jenkins）——没有就只有本地门禁
- [ ] 确认部署形态：进仓（harness 文件入 git）还是旁挂（独立目录 `--root` 指过去）
- [ ] 知道 target 的 skipTests 陷阱（Java 项目默认跳测试的属性名各不同）

## 能力选配矩阵

harness 不是全装的——按需选配，每个能力有独立的启用条件与配置键。

| 能力 | 配置键 | 不配的后果 | 部署难度 |
|---|---|---|---|
| **证据链**（verify-run + state 机） | 无（核心，始终启用） | 无证据的完成态 | 零配置 |
| **本地 CR→修复循环** | agents/coder.agent.md（已内置） | 未审代码直达 MR | 零配置 |
| **架构 fitness functions** | `architecture.*`（阈值） | 复杂度不可见 | 零配置（默认阈值） |
| **architect agent** | agents/architect.agent.md（已内置） | 无架构判断 | 零配置 |
| **定时器轮询** | `runtime.taskLoop.pollSeconds` | 无自动接单 | `install-task-loop.sh` |
| **飞书集成** | `runtime.feishu.*` | 不接不算故障 | OAuth 登录一步 |
| **GitLab MR 监控** | `runtime.gitlab.url` + PAT | 无打回检测 | PAT + env 文件 |
| **broker 通知** | `GITLAB_WEBHOOK_SECRET` 等 | 无飞书卡片 | webhook 配置 |
| **ai-review 语义审** | `AI_REVIEW_API_KEY/MODEL` | 缺凭据 exit 2（fail-closed） | 内网模型端点 |

## 部署五步

### 一、init（半小时）

```bash
# 进仓模式
node harness-starter/scripts/harness-cli.mjs init <target>

# 旁挂模式（harness 文件不进目标仓）
node harness-starter/scripts/harness-cli.mjs init .   # harness 装自己
# projects.dir 用相对路径指向代码仓（如 ../myproject）
```

init 自动完成：文件拷贝、配置适配、接入净化（不携带源仓的真实实例）、模板栈补齐。
conflict 文件（AGENTS.md / SKILL.md）留人工合并。

**坑**：Java 项目检查根 pom 和子模块 pom 的 skipTests 属性名——可能不同（TDasset 是 `skipTests` + `skip.tests` 两个独立属性），测试命令必须显式双开。

### 二、配置（半小时）

```json
// harness.config.json
{
  "projects": [{
    "id": "backend", "dir": "src",           // 真实目录
    "srcGlob": "src/**/*.java",
    "lint": "mvn -q compile",
    "test": "mvn test -DskipTests=false",      // 显式开测试
    "testOne": "mvn test -Dtest=<name>"
  }],
  "architecture": { "fileLineRed": 3000 }     // 可选：调 fitness 阈值
}

// harness.rules.json（如接飞书）
{
  "runtime": {
    "feishu": {
      "projectKey": "<你的空间 key>",
      "severity": { "field": "priority" },     // 优先级字段（非严重级别——见坑 #12）
      "iteration": { "field": "<迭代字段>", "prefix": "<产品线前缀>" }
    },
    "taskLoop": { "pollSeconds": 7200 }        // 轮询节拍
  }
}
```

### 三、凭据（10 分钟，如接飞书/GitLab）

```bash
# 飞书 OAuth（推荐，零管理员）
node scripts/feishu-auth.mjs login

# GitLab PAT（写入 0600 文件）
cat > ~/.harness/task-loop/task-loop.env <<EOF
GITLAB_URL=https://<你的实例>
GITLAB_TOKEN=<PAT>
HARNESS_GITLAB_PROJECT=<组/项目>
EOF
chmod 600 ~/.harness/task-loop/task-loop.env
```

### 四、影子周（1 周）

```bash
node scripts/task-loop.mjs --once --dry-run   # 每天跑，只看不干
node scripts/task-loop.mjs --report           # N≥30 且 0 误触发才转真跑
```

影子周验证：迭代过滤命中、优先级分级、误触发率。
**不跳过影子周**——直接真跑等于把未经校准的自动化扔进生产。

### 五、转常态

```bash
bash scripts/install-task-loop.sh .           # 装定时器（心跳 180s + 配置节拍）
# 手动做前 2-3 张单（验证"只含代码+测试"的 MR 动线）
# 然后放开自动认领
```

## 硬规则

| # | 规则 | 怎么查 |
|---|---|---|
| D1 | init 后必须跑 `npm run gate` 确认开箱绿 | `cd <target> && npm run gate` |
| D2 | 影子周 N≥30 且 0 误触发才转真跑，不跳 | `node scripts/task-loop.mjs --report` |
| D3 | 凭据只进 0600 文件（~/.harness/），绝不进 git | `git log --all -p -- '*.env' \| rg TOKEN` |
| D4 | 旁挂模式下目标仓零 harness 文件——约束一旦确认不可放松 | `git -C <target> status --short \| rg -v '^\?\?'` |
| D5 | skipTests 陷阱必须显式绕过（Java 项目） | 配置里 test 命令含 `-DskipTests=false` |
| D6 | 前 2-3 张单手动走全流程（含本地 CR），再放开自动 | state.json 里人工填 audit |

## 交付

1. 开箱 `npm run gate` 绿的截图/日志
2. 影子周报告（--report 输出）
3. 第一张真实单的完整证据链（state + verify 日志 + CR verdict）
4. 已知未接入项清单（"我们不接 X 因为 Y"——显式不接 ≠ 忘了接）

## 按需加载

- 接飞书 → `references/issue-tracker-interface.md`（能力接口与字段映射）
- 已知坑全清单 → `references/pitfall-checklist.md`（57 条，按部署阶段分组）
- 旁挂模式详情 → README「旁挂模式」节
