#!/usr/bin/env node
/**
 * 配置体检 —— 照抄脚手架之后的第一步，比 gate 更早发现问题。
 *
 * gate 校验的是"已经配好之后对不对"，doctor 校验的是"配了没有"。
 * 这两类失败长得完全不同：前者是红灯，后者是门禁静默不生效。
 *
 * 本文件自己也被这套 harness 的规则约束：任何"看起来存在、实际不生效"的东西都要报出来。
 * 所以除了占位值与未注册 hook，还检查两件更隐蔽的事：
 *   · 某个 CLI 的 hook 接线是否真的存在（不是"某个 CLI 存在"就够了）
 *   · 配置里每个功能键是否真有代码读它（空转的配置键 = 假门禁）
 *
 * 用法：node scripts/doctor.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 规则清单的规范化与 guard_command 共用同一份实现：doctor 若自己解析一遍，
// 两种写法（字符串 / {pattern,hint}）迟早有一边认错，体检就会对着空气报绿。
import { blockedRules } from '../hooks/lib/verify.mjs';
const errors = [];
const warns = [];
const ok = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

let config;
try {
  config = JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8'));
} catch (e) {
  console.error(`[doctor] harness.config.json 无法解析：${e.message}`);
  process.exit(1);
}

const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
const json = (p) => {
  const t = read(p);
  if (t === null) return { exists: false, value: null };
  try {
    return { exists: true, value: JSON.parse(t) };
  } catch (e) {
    return { exists: true, value: null, error: e.message };
  }
};

// 0. 模板态：脚手架刚 clone 下来、还没指向真实项目
const PLACEHOLDER_NAME = 'harness-starter';
const templateMode = (config.project && config.project.name) === PLACEHOLDER_NAME;

// 1. 技术栈目录（v2 projects 数组 + v1 stacks 对象统一消费——allStacks 是唯一入口）
import { allStacks } from './lib/analyzer.mjs';
const stacksArr = allStacks(config);
if (stacksArr.length === 0) err('stacks/projects 为空 —— coder 不知道该改哪个目录');
let stackMissing = 0;
for (const s of stacksArr) {
  const name = s.id || 'unknown';
  const dir = join(ROOT, s.dir || name);
  if (!existsSync(dir)) {
    stackMissing++;
    if (templateMode) {
      warn(`projects[${name}].dir="${s.dir}" 还不存在（模板态，预期如此）—— 改成项目真实目录后此提醒消失`);
    } else {
      err(`projects[${name}].dir="${s.dir}" 不存在 —— 占位值没改成项目真实目录，验证命令会跑空`);
    }
  } else ok.push(`projects[${name}] → ${s.dir}`);
  for (const k of ['lint', 'test', 'testOne']) {
    if (!s[k]) warn(`projects[${name}].${k} 未配置，验证命令会靠模型猜`);
  }
  // 配置提供的标准流程自身不得命中禁用规则，否则要么运行时必被 guard_command 拦，
  // 要么违反 .ai/rules/verification.md 的纪律——配置与规则打架比缺配置更糟。
  const blocked = blockedRules(config.gates || {});
  for (const k of ['lint', 'test', 'testOne']) {
    const cmd = s[k];
    if (!cmd) continue;
    const hitCmd = blocked.find((r) => {
      try {
        return new RegExp(r.pattern).test(cmd);
      } catch {
        return false;
      }
    });
    if (hitCmd) {
      err(`projects[${name}].${k}="${cmd}" 命中 gates.blockedCommands 的 /${hitCmd.pattern}/ —— 配置自带的标准流程违反验证纪律，改命令或改规则`);
    }
  }
  if (!s.srcGlob) warn(`projects[${name}].srcGlob 未配置 —— 证据新鲜度判断会退化成"所有改动文件"`);
}

// 2. hook 接线：按 CLI 逐个查，不是"某个 CLI 注册了就算"
const manifest = json((config.hooks && config.hooks.manifest) || 'hooks/hooks.manifest.json');
const declaredHooks = new Set();
if (!manifest.exists || !manifest.value) {
  err('hooks/hooks.manifest.json 缺失或无法解析 —— 接线没有事实源');
} else {
  for (const groups of Object.values(manifest.value.events || {})) {
    for (const g of groups || []) for (const h of g.hooks || []) if (h.script) declaredHooks.add(h.script);
  }
}

const targets = config.targets || {};
for (const [name, t] of Object.entries(targets)) {
  if (!t.enabled) continue;
  if (!t.hooksFile) {
    warn(`target "${name}" 没有 hook 机制 —— 只有 CI 兜底，文档里不要写"hook 硬拦"`);
    continue;
  }
  const f = json(t.hooksFile);
  if (!f.exists) {
    err(`${t.hooksFile} 不存在 —— ${name} 会话里没有任何 hook（跑 npm run build:hooks）`);
    continue;
  }
  if (f.error) {
    err(`${t.hooksFile} 无法解析：${f.error}`);
    continue;
  }
  const text = read(t.hooksFile) || '';
  const missing = [...declaredHooks].filter((s) => !text.includes(s));
  if (missing.length) {
    err(`${t.hooksFile} 少了 ${missing.length} 个 hook：${missing.join(', ')} —— ${name} 侧门禁不完整`);
  }
  if (name === 'zcode' && f.value.hooks && f.value.hooks.enabled !== true) {
    err(`${t.hooksFile} 的 hooks.enabled 不是 true —— ZCode 默认关闭 hook，写了也不执行`);
  }
  if (!missing.length) ok.push(`${name} hook 接线完整（${declaredHooks.size} 个）`);
}

// 3. hooks/ 下有脚本但没人接线 = 永不执行
const hookDir = join(ROOT, 'hooks');
if (existsSync(hookDir)) {
  for (const f of readdirSync(hookDir).filter((n) => n.endsWith('.mjs'))) {
    if (!declaredHooks.has(`hooks/${f}`)) err(`hooks/${f} 没有被 manifest 引用 —— 它永远不会执行`);
  }
}

// 4. 配置键必须有人消费。空转的键比没有键更糟：文档拿它当承诺。
const codeFiles = [];
for (const dir of ['hooks', 'scripts']) {
  const d = join(ROOT, dir);
  if (!existsSync(d)) continue;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(mjs|sh)$/.test(e.name)) codeFiles.push(full);
    }
  };
  walk(d);
}
const code = codeFiles.map((p) => readFileSync(p, 'utf8')).join('\n');
const CONSUMED = [
  'defaultFlowTier',
  'trustLevel',
  'requireVerifyLog',
  'verifyFreshnessHours',
  'verifyFreshnessGraceSec',
  'blockedCommands',
  'sensitiveRead',
  'writeGuards',
  'sensitiveExempt',
  'modelTiers',
  'maxLines',
  'requiredSections',
  'extraStacks',
  'capabilityMap',
  'hooksFile',
  'srcGlob',
  'promotionDir',
  'runtime',
  'spawn_agents',
];
const dead = CONSUMED.filter((k) => !code.includes(k));
if (dead.length) err(`配置键没有任何代码消费（看起来是门禁，实际不生效）：${dead.join(', ')}`);
else ok.push(`配置键均有消费者（${CONSUMED.length} 个）`);

// 4b. 剖面 B 的空间配置。这里是本项目最容易"配了不生效"的一段：
// projectKey / 字段 key / 状态 label 错一个，查询仍然成功，只是没有任何单子——
// 症状与"今天真的没有待办"完全一样。所以值域与消费情况必须在这里先判一遍。
const feishuCfg = json('harness.rules.json').value?.runtime?.feishu;
if (feishuCfg && typeof feishuCfg === 'object') {
  const need = [
    ['projectKey', feishuCfg.projectKey],
    ['workItemType', feishuCfg.workItemType],
    ['severity.field', feishuCfg.severity?.field],
    ['assigneeField', feishuCfg.assigneeField],
    ['newStatus', feishuCfg.newStatus],
  ];
  const empty = need.filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
  if (empty.length) err(`runtime.feishu 缺值：${empty.join(', ')} —— 剖面 B 会拼出坏 MQL 或取不到严重级，且不会报错`);

  const map = feishuCfg.severity?.map;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const bad = Object.entries(map).filter(([, v]) => !/^P[0-3]$/.test(String(v)));
    if (bad.length) err(`runtime.feishu.severity.map 的值必须是 P0-P3（门槛只认这四档）：${bad.map(([k, v]) => `${k}→${v}`).join(', ')}`);
    // 配了词表却没人读 = 换空间时改了配置、行为一点没变——比没配更难查。
    if (!code.includes('severityMap')) err('runtime.feishu.severity.map 没有任何代码消费 —— 改了配置不会改变分级，属于空转键');
  } else if (feishuCfg.severity && !map) {
    warn('runtime.feishu.severity.map 未配置，将退回内置词表（高/中/低 + P 档 + 英文）——换过空间的话词表大概率对不上');
  }
  if (empty.length === 0) ok.push(`剖面 B 空间：${feishuCfg.projectKey}.${feishuCfg.workItemType}（指派判据 ${feishuCfg.assigneeField}，严重级 ${feishuCfg.severity?.field}）`);
}

// 5. 门禁代码改动必须有对应测试
const testDir = join(ROOT, 'test');
const tests = existsSync(testDir) ? readdirSync(testDir).filter((n) => n.endsWith('.test.sh')) : [];
if (tests.length === 0) warn('test/ 下没有测试 —— 门禁坏掉时不会有人知道');
else ok.push(`门禁自测 ${tests.length} 个`);

// 6. 僵尸任务：stage 未完成且超过 7 天没动
const tasksDir = join(ROOT, '.ai/tasks');
if (existsSync(tasksDir)) {
  const WEEK = 864e5 * 7;
  for (const d of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(tasksDir, d.name, 'state.json');
    if (!existsSync(p)) {
      warn(`.ai/tasks/${d.name}/ 没有 state.json`);
      continue;
    }
    let st;
    try {
      st = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      err(`.ai/tasks/${d.name}/state.json 无法解析`);
      continue;
    }
    const age = Date.now() - statSync(p).mtimeMs;
    if (st.stage !== 'done' && age > WEEK) {
      warn(`${d.name} 停在 stage=${st.stage}，已 ${Math.round(age / 864e5)} 天未动 —— 视为僵尸，重建而非续跑`);
    }
  }
}

// 7. skill 覆盖
const skillsDir = join(ROOT, '.skills');
const skillNames = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
for (const name of [...new Set(stacksArr.map((s) => s.id).filter(Boolean))]) {
  const covered = skillNames.some((d) => {
    const p = join(skillsDir, d, 'SKILL.md');
    if (!existsSync(p)) return false;
    return new RegExp(`^stack:\\s*${name}\\s*$`, 'm').test(readFileSync(p, 'utf8'));
  });
  if (!covered) warn(`stack "${name}" 没有 skill —— 该栈 coder 的 Stage 0 会是空转`);
}

// 8. agent 源与产物
const srcDir = join(ROOT, 'agents');
const srcCount = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => f.endsWith('.agent.md')).length : 0;
if (srcCount === 0) err('agents/ 下没有 *.agent.md');
else ok.push(`agent 源 ${srcCount} 个`);
if (!existsSync(join(ROOT, '.ai/writes.json'))) warn('.ai/writes.json 不存在 —— 先跑 npm run build:agents');

// 8.5 agents.enabled：裁剪清单必须闭合（拼错名字 = 静默少生成一半 agent，体检必须报）
const srcNames = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => f.endsWith('.agent.md')).map((f) => f.replace(/\.agent\.md$/, '')) : [];
const enabledCfg = config.agents && config.agents.enabled;
if (enabledCfg !== undefined && enabledCfg !== null) {
  if (!Array.isArray(enabledCfg) || enabledCfg.length === 0) {
    err('agents.enabled 为空 —— 一个 agent 都不生成，等于没有 harness');
  } else {
    const unknown = enabledCfg.filter((n) => !srcNames.includes(n));
    if (unknown.length) err(`agents.enabled 含未知 agent：${unknown.join(', ')}`);
    if (!enabledCfg.includes('orchestrator')) err('agents.enabled 缺 orchestrator（唯一调度者，恒在）');
    if (!unknown.length && enabledCfg.includes('orchestrator')) {
      ok.push(`agents.enabled ${enabledCfg.length}/${srcNames.length} 个启用`);
    }
  }
}

// 9. 常驻规则长度：它每次会话都进上下文，越长越没人读
const AGENTS_LIMIT = 70;
const agentsMd = read('AGENTS.md');
if (agentsMd === null) {
  warn('AGENTS.md 不存在 —— 三个 CLI 都没有常驻规则入口');
} else {
  const n = agentsMd.split('\n').length;
  if (n > AGENTS_LIMIT) {
    warn(`AGENTS.md ${n} 行，超过 ${AGENTS_LIMIT} —— 多出来的内容该挪进 skill，常驻规则越长越没人读`);
  } else {
    ok.push(`AGENTS.md ${n}/${AGENTS_LIMIT} 行`);
  }
}

// 10. state 字段契约：文档标成"判据"的字段，必须真有代码读
// 起因（P3-10）：artifacts / risk_tier / trust_level / ui_scope 长期只有写入、没有读者。
// 字段在文档里写着"必填/有约束"，机器却从不看它——这比没有字段更糟：
// 人以为有控制，实际没有。契约文档写清了三档（判据/索引/声明），这里只钉死"判据"那一档。
const stateDoc = read('docs/06-reference/state-fields.md');
if (stateDoc === null) {
  warn('docs/06-reference/state-fields.md 不存在 —— state 字段没有契约说明，字段会继续变成注释桶');
} else {
  const gatedRows = stateDoc
    .split('\n')
    .filter((l) => l.startsWith('|') && /\|\s*判据/.test(l));
  const names = new Set();
  for (const row of gatedRows) {
    const cell = row.split('|')[1] || '';
    for (const m of cell.match(/`([a-z_]+)`/g) || []) names.add(m.replace(/`/g, ''));
  }
  const unread = [...names].filter((n) => !code.includes(n));
  if (!names.size) err('state-fields.md 里没有一行标为"判据" —— 契约文档空转，字段等级无从判断');
  else if (unread.length) err(`state-fields.md 标为判据但代码里没人读：${unread.join(', ')} —— 要么补读者，要么降级为"声明"`);
  else ok.push(`state 字段契约：${names.size} 个判据字段均有读者`);

  // 反向：代码读了的字段，契约里必须有。
  // 上一轮只查了"文档→代码"这一个方向，于是长出了反向版本：
  // checkStageExit 拿 deviations / known_issues 拦人，而契约文档写着 deviations 不是门禁输入、
  // known_issues 连表里都没有——两个字段没人知道要写，收口判据默认空转，体检还全绿。
  // 单方向体检比没体检更危险：它给出"已检查"的错觉。
  const docFields = new Set();
  for (const row of stateDoc.split('\n')) {
    if (!row.startsWith('|')) continue;
    const cell = row.split('|')[1] || '';
    for (const m of cell.match(/`([a-z][a-z0-9_]*)`/g) || []) docFields.add(m.replace(/`/g, ''));
    // 有些行把几个字段并列写在同一格（`related_task` / `baseline` / `affected_ids`），
    // 反引号那一步已收；这里兜没加反引号的裸字段名。
    for (const t of cell.match(/(?<![A-Za-z0-9_`])[a-z][a-z0-9_]{2,}(?![A-Za-z0-9_`])/g) || []) docFields.add(t);
  }

  // 只扫 hooks/lib/verify.mjs：判据的单一来源。
  // 扫全仓会得到一堆假字段（build-agents 里的 `meta` 是 agent frontmatter，
  // fs.stat 的 `st.isDirectory` 是另一个对象），而检查一旦开始报假阳性，
  // 人就会给它加白名单，最后白名单比检查还长——那等于检查消失了。
  // 代价：harness-cli / ci-verify 里另起的字段读取不在本检查范围内，
  // 但它们是消费方，读的是同一份 state，字段名必须先在 verify.mjs 出现。
  const verifySrc = read('hooks/lib/verify.mjs') || '';
  const stripped = verifySrc
    .replace(/import\.meta/g, '')
    // 剥字符串 → 再剥注释：代码里存在单引号字符串内含反引号的写法，
    // 先剥反引号会错配，把两个模板串之间的大段真实代码吞掉（实测过）。
    .replace(/'[^'\n]*'/g, "''")
    .replace(/"[^"\n]*"/g, '""')
    .replace(/`[\s\S]*?`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const IGNORE = new Set(['meta']);
  const readFields = new Set();
  for (const m of stripped.matchAll(/\bstate\.([a-z_][a-z0-9_]*)/g)) {
    if (!IGNORE.has(m[1])) readFields.add(m[1]);
  }
  // verify.mjs 里的 `meta` 只可能是 state.meta（migrate 就地赋值），所以 meta.X 也算。
  for (const m of stripped.matchAll(/\bmeta\.([a-z_][a-z0-9_]*)/g)) readFields.add(m[1]);
  const undocumented = [...readFields].filter((f) => !docFields.has(f));
  if (!readFields.size) {
    err('hooks/lib/verify.mjs 里读不到任何 state 字段 —— 扫描规则可能坏了，这条检查已空转');
  } else if (undocumented.length) {
    err(`代码读了但契约文档没写的 state 字段：${undocumented.join(', ')} —— 没人知道要写的字段等于空转的判据，补进 docs/06-reference/state-fields.md 并定档`);
  } else {
    ok.push(`state 字段契约：代码读取的 ${readFields.size} 个字段都在契约里（双向一致）`);
  }
}

// ---- 门禁在场性（演练 B1/B2：无 runner、批红规则配不出时，落地现场没人检查门禁在不在线） ----
// 走 env 而非配置键：这两项只在"这个仓库确实接着 GitLab"时才有意义，强制人人配置就是空转键（H8）。
// 未配连接 = 提醒"未检查"，不是"通过"；缺 runner = 阻塞（CI 是证据链的兜底执行者）；
// approval_rules 不可用 = 提醒（版本能力差异是事实，不是配置错误，处置见演练 B2 报告）。
const GL_URL = process.env.HARNESS_GITLAB_URL || '';
const GL_TOKEN = process.env.HARNESS_GITLAB_TOKEN || '';
const GL_PROJECT = process.env.HARNESS_GITLAB_PROJECT || '';
if (!GL_URL || !GL_TOKEN || !GL_PROJECT) {
  warns.push('门禁在场性未检查：未配置 HARNESS_GITLAB_URL / HARNESS_GITLAB_TOKEN / HARNESS_GITLAB_PROJECT。无 CI runner、批红规则缺位是演练实证过的流程断点——配置后此处给出结论');
} else {
  const glHeaders = { 'private-token': GL_TOKEN };
  const glGet = async (p) => {
    const res = await fetch(`${GL_URL.replace(/\/+$/, '')}/api/v4${p}`, { headers: glHeaders, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  try {
    const r = await glGet('/runners?active=true&per_page=5');
    const active = Array.isArray(r.json) ? r.json.length : 0;
    if (r.status === 200 && active > 0) ok.push(`门禁在场性：CI runner 在场（${active} 个活跃）`);
    else if (r.status === 200) errors.push('门禁在场性：CI 门禁缺位——没有活跃 runner，MR 无 pipeline，失败证据无机器拦截（演练 B1：失败日志标 completed 畅通进 MR）。先注册 runner 再谈"CI 兜底"');
    else warns.push(`门禁在场性：runner 查询异常 HTTP ${r.status}（不因外部抖动判红）`);
    const a = await glGet(`/projects/${encodeURIComponent(GL_PROJECT)}/approval_rules`);
    if (a.status === 200 && Array.isArray(a.json) && a.json.length > 0) ok.push(`门禁在场性：MR 批准规则在场（${a.json.length} 条）`);
    else if (a.status === 200) warns.push('门禁在场性：未配置 MR 批准规则——批红无机器强制，未批准也可合并（演练 B2）。建议 approvals_required ≥ 1');
    else if (a.status === 404) warns.push('门禁在场性：该 GitLab 版本不支持 approval_rules API——批红门禁无法机器强制（演练 B2），依赖分支保护与人工纪律');
    else warns.push(`门禁在场性：批准规则查询异常 HTTP ${a.status}`);
  } catch (e) {
    warns.push(`门禁在场性：连不上 GitLab（${e.message}）——检查不因网络抖动判红`);
  }
}

// 测试用到的外部命令：缺一个就会让几十条断言以"期望空"的形式集体变红，
// 看起来像功能坏了，其实只是机器上没装（实测：alpine 缺 curl → broker 套件 33 条假红；
// 缺 rsync → evidence 套件 31 条假红）。
// 只提醒、不判死：生产容器、CI、开发机的依赖面本来就不同，doctor 不该替人决定装什么。
const EXTERNAL_TOOLS = [
  ['bash', '全套 test/*.sh 与 hook 里的 bash 命令护栏'],
  ['git', '证据链自己 git init 建 fixture、broker 读 diffs'],
  ['curl', 'notify-broker / feishu-ws 探 healthz、发 webhook'],
];
const winExts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
const hasBin = (name) =>
  (process.env.PATH || '')
    .split(delimiter)
    .some((d) => winExts.some((ext) => {
      const p = join(d, name + ext);
      try {
        return existsSync(p) && !statSync(p).isDirectory();
      } catch {
        return false;
      }
    }));
const missingTools = EXTERNAL_TOOLS.filter(([t]) => !hasBin(t));
for (const [t, why] of missingTools) {
  warn(`${t} 不在 PATH 里 —— ${why}；缺它时相关套件会以"期望空"的形式假红（alpine: apk add ${t}）`);
}
if (!missingTools.length) ok.push(`外部命令齐备（${EXTERNAL_TOOLS.length} 个）`);

// 输出
console.log('[doctor] 配置体检\n');
if (templateMode) {
  console.log(`  说明：project.name 仍是 "${PLACEHOLDER_NAME}"，按模板态体检（占位目录只算提醒）。`);
  console.log('        接到真实项目后先改 harness.config.json 的 project.name 与 stacks，再重跑。\n');
}
for (const o of ok) console.log(`  ✓ ${o}`);
for (const w of warns) console.log(`  ! ${w}`);
for (const e of errors) console.log(`  ✗ ${e}`);
console.log('');
if (errors.length) {
  console.log(`结果：${errors.length} 个阻塞问题，${warns.length} 个提醒。这些问题会让门禁静默失效，先修再开工。`);
  process.exit(1);
}
console.log(`结果：通过（${warns.length} 个提醒）`);
