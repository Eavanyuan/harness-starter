/**
 * 校验核心库 —— hook 与 CI 共用同一份逻辑。
 *
 * 为什么必须共用：如果 hook 校一套、CI 校另一套，两边迟早不一致；
 * 更糟的是 CI 更松，于是"本地被拦、提交却能过"，门禁就成了摆设。
 *
 * 但"共用"不等于"等权"。两种执行环境的**可观测事实**不同：
 *
 *   本地 hook 跑在开发者工作树里，mtime 真实，能判"日志是不是这次改完才跑的"。
 *   CI 跑在全新 checkout 上，git 不保存 mtime —— 检出后所有文件 mtime 都是检出时刻，
 *   按检出顺序可比，按语义不可比。同一份完全合规的证据，在 CI 上会被 mtime 规则误杀。
 *
 * 所以按 mode 分两套判据，而不是让 CI 去猜：
 *
 *   local：存在 + exit_code=0 + 日志晚于**与 HEAD 有差异的**源码 + 未超时效（verifyFreshnessHours）
 *   ci   ：存在 + exit_code=0 + 声明文件存在 + 日志已入库（git 可复现的事实）
 *
 * CI **不判新鲜度**。这不是妥协，是承认边界：git 里没有"什么时候跑的"这个事实，
 * 只有"这个文件在不在这个 commit 里"。假装能判，就会像之前那样把合规 PR 判红。
 * 新鲜度由本地 hook 兜第一道，人审兜第二道（见 .ai/rules/verification.md）。
 *
 * 只做可判定的检查：文件存在、正则匹配、mtime 比较、字段齐备。
 * 任何需要"理解代码质量"的判断都不放在这里。
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkCompleteness as checkDocCompleteness,
  missingDeclarations as missingDocDeclarations,
  docKinds,
  declaredPathOf,
  declaredFile,
} from './doc_completeness.mjs';

/** 仓库根：以库文件位置为准，不依赖 cwd（hook 可能被从任意目录唤起）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const AUDIT_KEYS = ['compile', 'tests', 'feature_complete', 'quality_clean'];
export const OODA_STAGES = ['observe', 'orient', 'decide', 'act', 'audit'];

/**
 * state schema 版本化（方案 §9）：趁 .ai/tasks 还没有存量做，成本≈0。
 * 迁移链按版本号逐步升级；不可识别的版本显式报错而非静默跳过（失效点 15：
 * 枚举不闭合的"版本"会让未知形态的 state 绕过所有校验）。
 * 注意：migrate 只产出"校验视图"，hook 不改写落盘内容——缺 schema_version 的
 * 存量 state 按链首（0）升级后校验，磁盘上一个字节都不动。
 */
export const SCHEMA_VERSION = 1;

const MIGRATIONS = {
  // 0 → 1：任务类型与追溯字段（change/bugfix 双入口）。只补默认值，不删既有字段。
  0: (s) => {
    s.meta = s.meta || {};
    if (s.meta.task_type === undefined || s.meta.task_type === null) s.meta.task_type = 'feature';
    return s;
  },
};

export function migrate(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('state 不是对象，无法迁移');
  }
  state.meta = state.meta || {};
  let v = state.meta.schema_version;
  if (v === undefined || v === null) v = 0;
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`meta.schema_version 非法：${JSON.stringify(v)}（必须是整数）`);
  }
  if (v > SCHEMA_VERSION) {
    throw new Error(`state schema v${v} 高于本工具已知版本 v${SCHEMA_VERSION}——升级 harness 后再校验这份 state`);
  }
  const from = v;
  while (v < SCHEMA_VERSION) {
    MIGRATIONS[v](state);
    v += 1;
    state.meta.schema_version = v;
  }
  return { state, from, to: SCHEMA_VERSION };
}

/**
 * TODO 状态枚举必须闭合（失效点 15）：校验器只挑 completed/done 处理时，
 * 拼错的 status（complted / Complete / 已完成）会被当成"未完成"静默跳过——
 * TODO 就从证据链里蒸发了，CI 照样绿灯。done 是 completed 的历史别名，保留兼容。
 */
export const TODO_STATUSES = ['pending', 'doing', 'completed', 'done'];

/**
 * 任务类型与追溯字段（变更/修复流程的机器可判子集）。
 * change/bugfix 的完整流程裁剪表在 guides/需求变更与Bug修复.md，
 * 这里只判"有没有"，不判"对不对"——影响分析质量归 CR 人审。
 * 缺省 feature：老 state 没有该字段时零影响，不制造一次全量迁移。
 */
export const TASK_TYPES = ['feature', 'change', 'bugfix'];
export const CHANGE_TIERS = [1, 2, 3];

/** 基线只接受 git commit hash（7-40 位十六进制）。RS 修订号这类形态机器验证不了，不收。 */
export const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/;

/** 日志头长度上限。只看头部，避免大日志拖慢 hook。 */
const LOG_HEAD_BYTES = 4000;

/**
 * #16（实测：裸构建输出被当证据）：标准头必须是**结构化前几行**，不是"文件里任何位置"。
 * `# cmd` / `# exit_code:` 必须出现在前 5 行——把别处贴来的 BUILD SUCCESS 补个头混进来，
 * 机器分不出来；窗口限死之后，非 verify-run.sh 产的日志一概不算证据。
 */
const LOG_HEADER_LINES = 5;

export function readHead(absPath, bytes = LOG_HEAD_BYTES) {
  const buf = readFileSync(absPath);
  return buf.subarray(0, bytes).toString('utf8');
}

/** 解析 verify 日志头里的 exit_code（只认前 LOG_HEADER_LINES 行）。格式见 scripts/verify-run.sh。 */
export function parseExitCode(head) {
  for (const line of head.split('\n').slice(0, LOG_HEADER_LINES)) {
    const m = line.match(/^#\s*exit_code:\s*(-?\d+)\s*$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * #17（实测：同一事实三个版本 27/6/16，谁也无法对账）：
 * audit.tests 写了 N/M 形态时，日志头的 `# tests: total=T` 必须能对上（M === T）。
 * 旧日志没有计数行则跳过（不追溯存量）；新日志由 verify-run.sh 从 surefire-reports
 * 提取计数写进头部——`mvn -q` 会把 Tests run 从 stdout 吞掉，成功证据里必须另给数字。
 */
export function checkAuditTestsMatch(todo, repo) {
  const tests = todo.audit && todo.audit.tests;
  if (typeof tests !== 'string') return { ok: true };
  const m = tests.match(/(\d+)\s*\/\s*(\d+)/);
  if (!m || !todo.verify || !todo.verify.log_path) return { ok: true };
  const abs = resolve(repo, todo.verify.log_path);
  if (!existsSync(abs)) return { ok: true };
  const t = readHead(abs).match(/^#\s*tests:.*total=(\d+)/m);
  if (!t) return { ok: true };
  if (Number(m[2]) !== Number(t[1])) {
    return { ok: false, reason: `audit.tests 写 ${m[1]}/${m[2]}，日志头是 total=${t[1]}——手工摘要与日志对不上，以日志为准改 audit` };
  }
  return { ok: true };
}

/** 读 harness.config.json；缺失或损坏时返回 null，由调用方决定默认值。 */
export function loadConfig(repo = REPO_ROOT) {
  try {
    return JSON.parse(readFileSync(join(repo, 'harness.config.json'), 'utf8'));
  } catch {
    return null;
  }
}

function git(repo, args) {
  try {
    // 只去**尾部**空白，绝不整体 trim()。
    // 原因（实测）：`git status --porcelain` 的每条目以 2 位状态位开头，工作区改动
    // 是 " M path"——前导空格是数据的一部分。整体 trim() 会吃掉**第一条**的前导空格，
    // 之后固定 slice(3) 就多切一个字符：" M pom.xml" → "om.xml"。
    // 而 git 按路径字母序输出，Maven 仓库里 pom.xml 几乎总是第一条，于是"最该被抓到的
    // 那个基建文件"恰好被切坏：INFRA_RE 匹配不上它，未声明改动判据整条漏判。
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\s+$/, '');
  } catch {
    return null;
  }
}

export function isGitRepo(repo) {
  return git(repo, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/**
 * 改动条目（含 git 状态符）。`gitChangedFiles()` 只给路径，这里给路径 + 状态。
 *
 * 为什么需要状态：未跟踪（`??`）和"改了已跟踪的文件"是两种完全不同的事。
 * 未跟踪只说明仓库里有东西没入库（可能是别人留下的半成品、构建产物、整片新目录），
 * 拿它当"改动了构建基建"的证据，会让一个本来很准的判据在大仓库里天天报红。
 * 判据只对 git 已经知道的东西发火（M/A/D/R），未跟踪的只提示。
 */
export function gitStatusEntries(repo) {
  // -uall：未跟踪目录要展开成文件。
  // 默认（-unormal）会把新增目录压成一行 "?? .github/"，于是新目录**里面**的
  // 基建文件（.github/workflows/*.yml、新模块的 pom.xml）永远拿不到具体路径，
  // INFRA_RE 也就永远匹配不上——"新增一个 CI 配置目录"正好从这条缝里过去。
  const out = git(repo, ['status', '--porcelain', '-uall']);
  if (!out) return [];
  const entries = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    // 状态位固定 2 字符 + 1 空格，之后是路径。**不能**先 trim：
    // 未跟踪是 "?? path"、工作区修改是 " M path"，前导空格是状态位的一部分。
    const code = line.slice(0, 2).trim();
    const p = line.slice(3);
    // 重命名/复制条目是 "old -> new"（porcelain v1 不用 -z 时的形态）。
    // 直接拿去 resolve 会得到一个不存在的路径，候选集里那个真实改动就被漏掉了。
    const arrow = p.indexOf(' -> ');
    const path = (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"(.*)"$/, '$1');
    if (!path || path.startsWith('.ai/')) continue;
    entries.push({ path, status: code });
  }
  return entries;
}

export function gitChangedFiles(repo) {
  return gitStatusEntries(repo).map((e) => e.path);
}

/**
 * 该路径是否已被 git 跟踪。
 * 返回 true / false；仓库不是 git 仓库时返回 null（无从判断）。
 */
export function gitTracked(repo, relPath) {
  if (!isGitRepo(repo)) return null;
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], {
      cwd: repo,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** `**` 跨目录、`*` 不跨目录、`{a,b}` 是或。与 guard_write 的 glob 语义保持一致。 */
function globToRe(glob) {
  let s = glob.replace(/\{([^{}]*)\}/g, (_, inner) => '\u0001' + inner.split(',').join('\u0002') + '\u0003');
  s = s
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000S')
    .replace(/\*\*/g, '\u0000A')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:')
    .replace(/\u0002/g, '|')
    .replace(/\u0003/g, ')')
    .replace(/\u0000S/g, '(?:.*/)?')
    .replace(/\u0000A/g, '.*');
  return new RegExp('^' + s + '$');
}

/** 各栈声明的源码 glob（v2 projects 数组 + v1 stacks 对象统一提取）。 */
export function stackSourceGlobs(config) {
  const projects = Array.isArray(config && config.projects)
    ? config.projects
    : Object.values((config && config.stacks) || {});
  return projects
    .map((s) => s && s.srcGlob)
    .filter(Boolean);
}

/**
 * 高危命令规则的规范形态。
 *
 * 两种写法都收（失效点教训：改格式不能把存量配置一次性打死）：
 *   "正则"                      —— 建议文案留空，由调用方给通用文案
 *   { "pattern": "...", "hint": "..." } —— 每条规则给**自己的**修复建议
 *
 * 为什么必须有 hint：15 条规则共用一段"强推类改用 --force-with-lease"的文案，
 * 拦到 -DskipTests 时给出的建议与实际问题无关——被拦的人照着提示修，修不好。
 * 文案错位不算安全漏洞，但它让门禁从"教人改对"退化成"挡路"。
 */
export function blockedRules(gates) {
  const out = [];
  for (const item of (gates && gates.blockedCommands) || []) {
    if (typeof item === 'string') {
      out.push({ pattern: item, hint: null });
    } else if (item && typeof item.pattern === 'string') {
      out.push({ pattern: item.pattern, hint: typeof item.hint === 'string' ? item.hint : null });
    }
  }
  return out;
}

/** 规则的通用兜底文案：不知道具体是哪类时，只给出唯一确定正确的出路。 */
export const GENERIC_RULE_HINT =
  '这条规则没有等价的安全写法；确实需要例外时写入 hooks/allowlist.txt（<命令前缀> | <原因> | <YYYY-MM-DD>），到期自动失效';

/**
 * 证据链校验。mode 决定判据强度，默认 local（hook 侧）。
 *
 * opts:
 *   mode        'local' | 'ci'
 *   config      已解析的 harness.config.json（省一次读盘）
 *   now         当前时间（测试注入用）
 */
export function checkVerify(todo, repo, opts = {}) {
  const mode = opts.mode === 'ci' ? 'ci' : 'local';
  const config = opts.config || loadConfig(repo) || {};
  const gates = config.gates || {};

  if (gates.requireVerifyLog === false) {
    return { ok: true, reason: 'requireVerifyLog=false，跳过证据校验' };
  }

  const v = todo.verify;
  if (!v || !v.log_path) {
    return { ok: false, reason: '缺少 verify.log_path（没有证据就不算完成）' };
  }
  const abs = resolve(repo, v.log_path);
  if (!existsSync(abs)) {
    return { ok: false, reason: `verify 日志不存在：${v.log_path}` };
  }

  const head = readHead(abs);
  const code = parseExitCode(head);
  if (code === null) {
    return { ok: false, reason: `日志缺少 exit_code 头（格式见 scripts/verify-run.sh）` };
  }
  if (code !== 0) {
    return { ok: false, reason: `日志 exit_code = ${code}，不是 0` };
  }

  const declared = Array.isArray(todo.files) ? todo.files : [];

  if (mode === 'ci') {
    // CI 只认 git 里存在的事实：文件在不在、日志进没进版本库。
    const missing = declared.filter((f) => !existsSync(resolve(repo, f)));
    if (missing.length) {
      return { ok: false, reason: `声明的源码文件不存在：${missing.slice(0, 3).join(', ')}` };
    }
    const tracked = gitTracked(repo, v.log_path);
    if (tracked === false) {
      return { ok: false, reason: `${v.log_path} 未入库（证据必须随代码提交，git 里查不到就等于没跑）` };
    }
    return { ok: true, reason: 'ok（CI 口径：存在 + exit_code=0 + 已入库）' };
  }

  // 以下仅本地：mtime 是这里唯一可观测的事实，但它比看上去弱得多。
  //
  // 候选集 = TODO 自报的 files ∪ 栈内被改动的源码（srcGlob 命中）。
  // 只取自报的 files 会被"少报一个文件"绕过：日志只要晚于那一个文件就算新鲜，
  // 而另一个真正改了源码的文件比日志还新。取并集，任一新于日志就重跑。
  //
  // 关键修正（新克隆的仓库实测）：文件的 mtime 不是"上次编辑时间"，是"上次写到
  // 磁盘的时间"。clone / checkout / switch 会把整棵树的 mtime 按检出顺序重排一遍，
  // 于是"日志比源码旧"变成排序的副产品——上一版在全新 clone 的仓库里把 14 个历史
  // 任务全判成"日志早于最后一次源码修改"，而 git status 是空的，文件一个字节没变。
  //
  // 判据的分界不是"谁比谁新"，而是"这个时间差能不能用检出解释掉"：
  //   · 工作树里有差异（M/A/R/??）= 真改过，mtime 就是编辑时间，**零容忍**；
  //   · 与 HEAD 一致的文件 = mtime 可能是检出产物，落在检出窗口内的差不作数，
  //     只有超出窗口（默认 120s，gates.verifyFreshnessGraceSec）才算"之后被写过"。
  // 这样 clone 的毫秒级乱序不再误报，而"改完提交了却没重跑"（分钟级以上）照样拦得住。
  const dirty = gitStatusEntries(repo);
  const dirtyRel = new Set(dirty.map((e) => e.path));
  const globs = stackSourceGlobs(config);
  const graceMs = Math.max(0, Number(gates.verifyFreshnessGraceSec ?? 120)) * 1000;

  const candidates = [
    ...new Set([
      ...declared,
      ...dirty.map((e) => e.path).filter((f) => globs.some((g) => globToRe(g).test(f))),
    ]),
  ]
    .map((f) => resolve(repo, f))
    .filter((p) => existsSync(p));

  // 统一验证类 TODO（files: []）没有自报文件，此时任何未提交改动都算嫌疑对象；
  // 但只在"它确实什么都没声明"时才这样兜——否则一个无关的 README 改动
  // 会让所有历史任务一起变红，等于换个姿势制造同一类误报。
  const pool = candidates.length
    ? candidates
    : declared.length === 0
      ? dirty.map((e) => resolve(repo, e.path)).filter((p) => existsSync(p))
      : [];

  const logStat = statSync(abs);
  if (pool.length > 0) {
    const newest = pool.reduce((acc, p) => {
      const mtime = statSync(p).mtimeMs;
      const rel = relative(repo, p);
      // 干净文件：扣掉检出窗口，只有"窗口之外还被写过"才算数
      return Math.max(acc, dirtyRel.has(rel) ? mtime : mtime - graceMs);
    }, 0);
    if (logStat.mtimeMs <= newest) {
      return {
        ok: false,
        reason: 'verify 日志早于最后一次源码修改，疑似复述历史输出（请真的重跑一次）',
      };
    }
  }

  const hours = Number(gates.verifyFreshnessHours || 0);
  if (hours > 0) {
    const ageH = ((opts.now ?? Date.now()) - logStat.mtimeMs) / 3600e3;
    if (ageH > hours) {
      return {
        ok: false,
        reason: `verify 日志已是 ${Math.round(ageH)} 小时前（上限 ${hours}h），重跑一次再标完成`,
      };
    }
  }

  if (pool.length === 0) {
    // 工作树里没有与本任务相关的未提交改动：没有可比较的事实，不是"不新鲜"。
    // 判 ok 但把依据说清楚——否则下一个人会以为这里漏判了。
    return { ok: true, reason: 'ok（工作树无相关未提交改动，mtime 无信息量，只校验时效）' };
  }

  return { ok: true, reason: 'ok' };
}

/** 审计四项齐备性。只查"有没有填"，不查"填得对不对"。 */
export function checkAudit(todo) {
  const audit = todo.audit || todo.audit_result || {};
  const missing = AUDIT_KEYS.filter((k) => !(k in audit));
  if (missing.length) {
    return { ok: false, reason: `缺审计项：${missing.join(', ')}` };
  }
  return { ok: true, reason: 'ok' };
}

/** OODA 不得跳阶段：新建 TODO 不能直接以 act/done 收尾。 */
export function checkOoda(todo) {
  const stage = todo.ooda_stage;
  if (!stage) return { ok: false, reason: '缺少 ooda_stage，无法证明从 observe 起' };
  if (!OODA_STAGES.includes(stage)) {
    return { ok: false, reason: `ooda_stage 非法：${stage}` };
  }
  if (stage === 'act' || stage === 'done') {
    return { ok: false, reason: `ooda_stage=${stage}，疑似跳过 observe/orient/decide` };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * 对一份 todos 做完整校验，返回所有失败项。
 * pending / doing 不做证据校验——会话还没走到那一步，校了会把会话卡死。
 * 但 status 必须先过枚举：非法值直接判失败，不给"拼错状态 = 免检"留口子。
 */
export function validateTodos(todos, repo, opts = {}) {
  const failures = [];
  for (const todo of todos || []) {
    const id = todo.id || '(无 id)';

    if (!TODO_STATUSES.includes(todo.status)) {
      failures.push({
        id,
        rule: 'status',
        reason: `status 非法：${JSON.stringify(todo.status)}（合法值：${TODO_STATUSES.join(' / ')}）。非法状态不触发证据校验，等于把 TODO 藏出门禁`,
      });
      continue;
    }

    if (todo.status !== 'completed' && todo.status !== 'done') continue;

    // 决策型工作包（#12，两次实测暴露）：T0 这类"人裁决决策包"没有可跑的命令，
    // verify 日志形态根本不存在——它的证据就是 blockers 数组本身（是否全 resolved，
    // 在 checkTaskTraceability 里按 state 级校验）。这里只保留 ooda 检查，
    // 免审计四项与 verify 日志，否则决策包永远无法合法完成。
    if (todo.kind === 'decision') {
      const oodaD = checkOoda(todo);
      if (!oodaD.ok) failures.push({ id, rule: 'ooda', reason: oodaD.reason });
      continue;
    }

    // #15（license-center-sms 实测）：verify 字段被塞了字符串路径而非 {log_path} 对象。
    // 写作会话的直觉是把 verify 当"链接栏"用——提前拦下并给出正确形态的示例，
    // 比在 checkVerify 里报"缺少 log_path"（信息不指向修复方式）教育性好得多。
    if (typeof todo.verify === 'string') {
      failures.push({
        id,
        rule: 'verify',
        reason: `verify 是字符串（${todo.verify.slice(0, 40)}…），必须是对象：{ "log_path": "<路径>" }——直接改 state 里的形态即可`,
      });
      continue;
    }

    const audit = checkAudit(todo);
    if (!audit.ok) failures.push({ id, rule: 'audit', reason: audit.reason });

    const ooda = checkOoda(todo);
    if (!ooda.ok) failures.push({ id, rule: 'ooda', reason: ooda.reason });

    const verify = checkVerify(todo, repo, opts);
    if (!verify.ok) failures.push({ id, rule: 'verify', reason: verify.reason });

    // #17：verify 过了才对账 audit 数字（verify 没过的场景它自己的报错更重要）
    const tm = checkAuditTestsMatch(todo, repo);
    if (!tm.ok) failures.push({ id, rule: 'audit', reason: tm.reason });
  }
  return failures;
}

/**
 * 阶段链只有一份。
 *
 * 此前 STAGE_NEXT 长在 scripts/harness-cli.mjs 里，而 init-harness.sh 自己造了个
 * `stage:"intake"`——一个不在任何链上的阶段名。于是新建的任务从第一天起就站在
 * 状态机之外：resume 认不出"下一阶段是谁"，ci-verify 只判 todos 不判 stage，
 * 拼错的 `fs-review`（连字符）照样绿。阶段名是判据，不是标签，必须单源 + 闭合。
 *
 * 次序依据（`wbs` 曾排在 `fs_review` 之前，已调整）：
 *   RS 定稿 → ADR 选型（架构决策先于详细设计）→ FS 评审 → WBS 拆解 → 实现。
 *
 * 为什么 wbs 必须在 fs_review 之后：WBS 要求每个叶子有可验收标准，而验收标准只能来自
 * FS 的行为定义。FS 没评审就拆任务，拆的是想象；等 FS 补齐后 WBS 又不回头，于是要么
 * 出现悬空任务（做出来没人要），要么漏做（FS 小节没有对应任务）。**次序错了，
 * 后面的门禁再严也补不回来**——门禁只能判"这一阶段做完了没有"，判不了"在错误的输入上做完"。
 */
export const STAGE_CHAIN = ['rs', 'adr', 'fs_review', 'wbs', 'impl', 'review', 'ci', 'retro', 'done'];
export const STAGE_NEXT = Object.fromEntries(STAGE_CHAIN.slice(0, -1).map((s, i) => [s, STAGE_CHAIN[i + 1]]));
/** 阶段序号：用来判"是否已越过某阶段"，而不是拼字符串比大小。 */
export const STAGE_INDEX = Object.fromEntries(STAGE_CHAIN.map((s, i) => [s, i]));

/**
 * 已退休的阶段链序 —— 判"是否相邻"时一并认。
 *
 * 为什么要它：2026-11-02 把 `wbs` 从 `fs_review` 之前挪到了之后。存量 state 的
 * `stage_history` 是按当时**确实是正式链**的次序记的（见 TDC 真实数据
 * `rs → wbs → adr → fs_review → impl`），拿新链去判相邻，必然把合规的历史记成
 * "跳阶且没记名"。一次判据变更把过去判红，人只有两条路：改历史，或把跳阶检查关掉——
 * 两条都比保留旧链更糟（改历史=伪造，关检查=永久失明）。
 *
 * 边界（它不是"什么顺序都放行"的开关）：
 *   · 只登记**曾经当过正式链**的次序，一条一行，带退休日期与原因；
 *   · 只认前进方向（与现行链同律），旧链里 `fs_review → wbs` 这种逆序照样判跳阶；
 *   · 任何一条链上都不相邻的，仍然要求 `waived_by` 记名。
 * 所以这里补的是"这一对当时不是跳阶"这个事实，不是给跳阶开后门。
 */
export const RETIRED_STAGE_CHAINS = [
  {
    id: 'v1',
    chain: ['rs', 'wbs', 'adr', 'fs_review', 'impl', 'review', 'ci', 'retro', 'done'],
    retired_on: '2026-11-02',
    why: 'wbs 早于 adr/fs_review：拆任务时 FS 还没评审，叶子验收标准只能凭想象，且拆完不回头',
  },
];

/** 某一对相邻阶段是否属于某条链的前进方向。 */
function isForwardStep(chain, from, to) {
  const i = chain.indexOf(from);
  return i >= 0 && chain[i + 1] === to;
}

/**
 * from → to 之间被越过的每一站，是否都在 history 里具名 defer 过。
 *
 * 这是"跳阶"与"链序不同"的分界线：S 档任务把 wbs/adr/fs_review 逐个 defer（每站写了理由），
 * 再 fs_review → impl —— 每一站都有签字，只是现行链把 wbs 排在 impl 前一位。
 * 只看落点 waived_by 会把这种正当裁剪误判成跳阶；而不看中间站，又会让"整段悄悄跳过"蒙混过去。
 * 逆序（to 在 from 之前）不认：退回去不是跳过，是走错。
 */
function everySkippedNamed(hist, from, to) {
  const i = STAGE_CHAIN.indexOf(from);
  const j = STAGE_CHAIN.indexOf(to);
  if (i < 0 || j <= i) return false;
  return STAGE_CHAIN.slice(i + 1, j).every((s) => {
    const e = hist.find((h) => h && h.stage === s);
    return !!e && typeof e.waived_by === 'string' && !!e.waived_by.trim();
  });
}

/** 档位枚举（S/M/L/XL）。档位本身不改变判据强度，只记录"这套流程被裁剪过"。 */
export const FLOW_TIERS = ['S', 'M', 'L', 'XL'];
export const RISK_TIERS = ['LOW', 'MEDIUM', 'HIGH'];

/**
 * 阶段名/档位/跳阶的机器可判子集。**只判"是不是链上的合法位置"，不判"该不该到这"**——
 * "这个任务值不值得走 L 档"是人的判断，机器判不了。
 *
 * 跳阶（如 wbs → impl）不禁止，但必须记名：`waived_by` 为空按 fail 计。
 * 这条是 P2-5 的落点——此前流程裁剪只写在文档里，state 里跳过三个阶段
 * 和一个阶段都没跳长得一模一样。
 */
export function checkStage(state) {
  if (!state || typeof state !== 'object') return [];
  const failures = [];
  const meta = state.meta || {};

  if (!STAGE_CHAIN.includes(state.stage)) {
    failures.push({
      id: '(task)',
      rule: 'stage',
      reason: `stage 非法：${JSON.stringify(state.stage)} —— 合法值只有 ${STAGE_CHAIN.join(' → ')}（阶段名拼错=站在状态机之外，所有按阶段的门禁都会静默跳过）`,
    });
  }
  if (meta.flow_tier !== undefined && meta.flow_tier !== null && !FLOW_TIERS.includes(meta.flow_tier)) {
    failures.push({
      id: '(task)',
      rule: 'stage',
      reason: `meta.flow_tier 非法：${JSON.stringify(meta.flow_tier)}（合法值：${FLOW_TIERS.join(' / ')}）`,
    });
  }
  if (meta.risk_tier !== undefined && meta.risk_tier !== null && !RISK_TIERS.includes(meta.risk_tier)) {
    failures.push({
      id: '(task)',
      rule: 'stage',
      reason: `meta.risk_tier 非法：${JSON.stringify(meta.risk_tier)}（合法值：${RISK_TIERS.join(' / ')}）`,
    });
  }

  const hist = Array.isArray(state.stage_history) ? state.stage_history : [];
  const retired = RETIRED_STAGE_CHAINS.map((c) => c.id).join('/');
  const createdAt = Date.parse(meta.created_at || '');
  // 退休链只对"退休之前就已存在的任务"成立。没有这道时间闸，旧链序就是永久第二条合法路径：
  // 新任务照抄一份旧 state 就永远"合法跳阶"，retired_on 沦为一个没人读的注释字段
  //（实测：2026-11-06 新建的任务走的正是 2026-11-02 退休的 rs → wbs → adr → fs_review）。
  const legacyChains = RETIRED_STAGE_CHAINS.filter((c) => {
    const retiredAt = Date.parse(c.retired_on);
    if (!Number.isFinite(createdAt) || !Number.isFinite(retiredAt)) return false; // 判不了就不给豁免
    return createdAt <= retiredAt + 86_400_000 - 1; // retired_on 当天建的任务仍算旧账
  });
  for (let i = 1; i < hist.length; i++) {
    const from = hist[i - 1] && hist[i - 1].stage;
    const to = hist[i] && hist[i].stage;
    if (!STAGE_CHAIN.includes(to) || from === to) continue;
    if (isForwardStep(STAGE_CHAIN, from, to)) continue;
    // 旧链上相邻 = 当时不是跳阶，是事实（链序改过一次，见 RETIRED_STAGE_CHAINS）
    if (legacyChains.some((c) => isForwardStep(c.chain, from, to))) continue;
    // 越过的每一站都具名 defer 过 = 不是"悄悄跳过"，只是链序把新阶段插在了中间
    if (everySkippedNamed(hist, from, to)) continue;
    const who = hist[i] && hist[i].waived_by;
    if (typeof who !== 'string' || !who.trim()) {
      failures.push({
        id: '(task)',
        rule: 'skip',
        reason: `stage_history 里 ${JSON.stringify(from)} → ${JSON.stringify(to)} 不是相邻阶段，且未记名豁免（waived_by 为空）—— 现行链与适用退休链 ${retired} 都比对过仍不相邻，跳阶可以，但要有人签字`,
      });
    }
  }
  return failures;
}

/**
 * 当前阶段的门禁是否**已评估且全 pass**。
 *
 * 起因（P1-1，已实测复现）：resume 曾把 gate `pass:false` + 2 个未完成 TODO 的 impl
 * 直接推进 review，history 还记成 `impl/pass`——门禁的结论被推进动作改写了。
 * 推进的前提是"这一阶段的门禁真的跑过且都过了"，而不是"没有 blocker 了"。
 */
export function stageGate(state) {
  const g = (state && state.gate_result) || {};
  const checks = Array.isArray(g.checks) ? g.checks : [];
  if (!checks.length) {
    return { evaluated: false, failed: [], reason: '本阶段门禁尚未评估（gate_result.checks 为空）—— 先按阶段清单跑一遍并写回结果' };
  }
  // done 收尾时 gate_result 记的是 retro 的结论：推进阶段本身不改写上一阶段的记录
  // （改了就等于伪造一次没跑过的检查），所以 done 认 retro 的那份。
  const allowed = state.stage === 'done' ? ['done', 'retro'] : [state.stage];
  if (g.stage && state.stage && !allowed.includes(g.stage)) {
    return {
      evaluated: false,
      failed: [],
      reason: `gate_result 记的是 ${g.stage} 阶段，当前在 ${state.stage} —— 换阶段后门禁必须重新评估，旧结论不能顺延`,
    };
  }
  const failed = checks.filter((c) => !c || c.pass !== true);
  return {
    evaluated: true,
    failed,
    reason: failed.length ? `${failed.map((c) => (c && c.name) || '?').join('、')} 未通过` : null,
    last: g.last_check || null,
  };
}

/**
 * impl 阶段的退出条件：TODO 必须收尾。
 *
 * 只对 impl 生效，不外推到 review/ci：那两阶段的门禁是"CR 阻断项清零""流水线绿"，
 * 机器判不了，硬套 TODO 收尾会给出一种"看起来在把关"的假象。
 * 空 todos 不报错（S 档琐碎任务可以不留 TODO），但"实现完了却留着 doing"必须拦。
 */
export function checkStageTodoClosure(state) {
  if (!state || state.stage !== 'impl') return [];
  const failures = [];
  for (const todo of state.todos || []) {
    if (todo.status !== 'completed' && todo.status !== 'done') {
      failures.push({
        id: todo.id || '(无 id)',
        rule: 'stage',
        reason: `stage=impl 但该 TODO 状态是 ${JSON.stringify(todo.status)} —— 实现阶段收尾前所有 TODO 必须完成（未做的移出本任务并写明去向，不要留着声明"做完了"）`,
      });
    }
  }
  return failures;
}

/**
 * stage=done 的退出条件（orchestrator 的收尾定义）：所有 TODO 必须收尾。
 * 空 todos 允许——S 档琐碎任务可以不留 TODO，但不允许留半个未完成的。
 * 但"空 todos + done"必须留下一句为什么：否则删光 todos 就能把任何任务判成完工，
 * 这是最便宜的一条全绿捷径。
 * hook 与 CI 共用这条判据，两边口径一致（失效点 7）。
 */
export function checkStageExit(state) {
  if (!state || state.stage !== 'done') return [];
  const failures = [];
  const todos = state.todos || [];
  for (const todo of todos) {
    if (todo.status !== 'completed' && todo.status !== 'done') {
      failures.push({
        id: todo.id || '(无 id)',
        rule: 'exit',
        reason: `stage=done 但该 TODO 状态是 ${JSON.stringify(todo.status)} —— 收尾前所有 TODO 必须完成`,
      });
    }
  }
  const meta = state.meta || {};
  const noTodoReason = typeof meta.no_todo_reason === 'string' ? meta.no_todo_reason.trim() : '';
  if (todos.length === 0 && !noTodoReason) {
    failures.push({
      id: '(task)',
      rule: 'exit',
      reason: 'stage=done 但 todos 为空且 meta.no_todo_reason 没写理由 —— 零 TODO 可以是合法的（S 档琐碎任务），但必须说清为什么，否则"删光 todos"就是最便宜的全绿捷径',
    });
  }

  // #19（实测：@InternalApi 计划要求被静默省略）：deviations 从声明升为判据——
  // 收口时每条偏离必须有处置结论（fixed / acknowledged+记名），"记了但没人看"不算闭环。
  for (const d of state.deviations || []) {
    if (!d || !d.disposition) {
      failures.push({
        id: '(task)',
        rule: 'exit',
        reason: `偏离未处置：${String((d && d.what) || JSON.stringify(d)).slice(0, 60)} —— done 前逐条给结论（disposition: fixed | acknowledged + by 记名）`,
      });
    }
  }

  // #21（实测：console 3 例红灯只活在 audit.tests 文本里，不可查询）：
  // known_issues 必须逐条闭环——id/现象/根因/归属 TODO/结论，收口时 resolution 不能为空。
  for (const k of state.known_issues || []) {
    if (!k || !k.resolution) {
      failures.push({
        id: (k && k.id) || '(task)',
        rule: 'exit',
        reason: `known_issues 未闭环：${String((k && k.symptom) || '').slice(0, 50)} —— 收口前逐条写结论（resolution + owner_todo 收口）`,
      });
    }
  }
  return failures;
}

/**
 * 产物索引 —— **提示性，不是门禁**。
 *
 * 设计取舍（P3-10 的结论）：`artifacts` 只负责"产物在哪"，不负责"产物够不够"。
 *   · 做成门禁（路径必须存在且是 string）会把"声明"当"事实"：agent 写个空文件也能过，
 *     而且真实存量里它已经长成了注释桶（TDC 那份 state 里混着 null 和一段说明文字），
 *     严格校验会当场把合规任务判红；
 *   · 直接删字段则会毁掉唯一能把产物串起来的索引，下次续跑只能 glob 猜（失效点 §18）。
 * 所以：读出来、显示出来、缺了只提示，不参与 exit code。
 * 产物合格与否归 stage gate（checkStageTodoClosure / checkStageExit / 人工 review）。
 */
export function artifactIndex(state, repo = REPO_ROOT) {
  const raw = state && typeof state.artifacts === 'object' && state.artifacts !== null ? state.artifacts : {};
  const entries = [];
  const odd = [];
  // 只想把"显然不是路径的东西"分出来展示（含空格的句子、中文说明），**不据此判任何东西**：
  // 这是展示分类，不是判据。真实存量里 artifacts 已经混进过整段说明（TDC 的 promotion_note），
  // 把它算成"产物缺失"会制造假告警，把人训练成无视这一节。
  //
  // 解析规则与完备性检查共用 declaredFile（单源）：两套"怎么算路径"必然分叉，
  // 然后出现"索引说文件在、完备性说读不出路径"。中文/空格文件名在两边都算路径。
  for (const [key, val] of Object.entries(raw)) {
    if (val === null) {
      entries.push({ key, path: null, exists: null });
      continue;
    }
    if (typeof val !== 'string') {
      odd.push({ key, type: Array.isArray(val) ? 'array' : typeof val });
      continue;
    }
    const p = val.trim();
    if (!p) {
      odd.push({ key, type: 'empty' });
      continue;
    }
    const file = declaredFile(p);
    if (!file) {
      odd.push({ key, type: 'text' });
      continue;
    }
    entries.push({ key, path: file, exists: existsSync(resolve(repo, file)) });
  }
  return { entries, odd };
}

/**
 * 文档完备性（RS / FS / WBS）—— 判据实现在 doc_completeness.mjs，
 * 这里只做"把阶段链传进去"的转接：链是单源，判据库不自己存一份。
 *
 * 与 artifactIndex 的分工：索引回答"产物在哪"（提示性），完备性回答"写全了没有"
 * （按阶段判死）。两者都不回答"内容对不对"——那是 SR 报告与人审。
 */
export function checkCompleteness(state, repo = REPO_ROOT) {
  return checkDocCompleteness(state, repo, { stageChain: STAGE_CHAIN });
}

/**
 * 已越过产出阶段、但 artifacts 里没登记的文档。**提示用，不判死**——
 * 检查范围由声明决定，不声明就检不到；这个边界必须说出来，否则"完备性通过"
 * 会被读成"文档没问题"。
 */
export function missingDeclarations(state) {
  return missingDocDeclarations(state, STAGE_CHAIN);
}

/** RS/FS/WBS 的登记口径（key / label / 产出阶段），供 CLI 展示用。 */
export { docKinds, declaredPathOf };

/**
 * change/bugfix 任务的追溯链校验（机器可判子集，hook 与 CI 共用）。
 *
 * 设计原则（对应 checklist §15 的教训——别把声明当门禁）：
 *   - 只校验"字段存在且非空"这类可判定事实；
 *   - 变更档位选 1/2/3 是否合理、affected_ids 是否列全，归 CR 人审；
 *   - 归属类校验（related_task 必填、change 必须有 baseline）建任务时就该满足，
 *     任何时候缺了都拦；完成态才校验追溯产出（affected_ids / 回归 TODO），
 *     因为做到一半时它们天然还是空的。
 *
 * repo：工作树根。存在性与 git 事实（commit 在不在历史里、日志入没入库）相对它判定；
 * 不是 git 仓库时跳过 git 类检查——判不了的不假装判，由 CI（必有 git）兜底。
 */
export function checkTaskTraceability(state, repo = REPO_ROOT) {
  if (!state || typeof state !== 'object') return [];
  const meta = state.meta || {};
  const type = meta.task_type === undefined || meta.task_type === null ? 'feature' : meta.task_type;
  const failures = [];

  if (!TASK_TYPES.includes(type)) {
    failures.push({
      id: '(task)',
      rule: 'task_type',
      reason: `task_type 非法：${JSON.stringify(type)}（合法值：${TASK_TYPES.join(' / ')}）`,
    });
    return failures;
  }

  // #9（实测：单栈收编项目里 frontend TODO 无栈可依却静默通过）：
  // todo.stack 必须是已注册栈（stacks ∪ skills.extraStacks ∪ harness），枚举闭合。
  // 只在配置存在时生效——校验的目标是"TODO 与已收编配置的漂移"，没有配置就没有
  // 漂移可言；且 ci-verify --file 要能独立校验任意 state（夹具/临时态没有配置）。
  const cfg = loadConfig(repo);
  if (cfg) {
    const projectIds = Array.isArray(cfg.projects)
      ? cfg.projects.map((p) => p.id)
      : Object.keys(cfg.stacks || {});
    const legalStacks = new Set([
      ...projectIds,
      ...(((cfg.skills || {}).extraStacks) || []),
      'harness',
    ]);
    for (const t of state.todos || []) {
      if (t.stack && !legalStacks.has(t.stack)) {
        failures.push({
          id: t.id || '(task)',
          rule: 'trace',
          reason: `todo.stack=${JSON.stringify(t.stack)} 不是已注册栈（合法值：${[...legalStacks].join(' / ')}）——要么在 harness.config.json 注册该栈，要么改 TODO 的 stack`,
        });
      }
    }
  }

  // #12：决策型工作包的完成证据 = 全部 blocker 已 resolved（state 内自洽，机器可查）。
  for (const t of state.todos || []) {
    if (t.kind !== 'decision' || (t.status !== 'completed' && t.status !== 'done')) continue;
    const unresolved = (state.blockers || []).filter((b) => !b.resolved);
    if (unresolved.length) {
      failures.push({
        id: t.id || '(task)',
        rule: 'trace',
        reason: `决策工作包已标完成，但仍有 ${unresolved.length} 条 blocker 未决——决策没落全，完成态不成立`,
      });
    }
  }

  if (type === 'feature') return failures;

  const related = meta.related_task;
  if (!related || typeof related !== 'string') {
    failures.push({ id: '(task)', rule: 'trace', reason: 'change/bugfix 任务缺 related_task（未关联原任务或发现来源，追溯链无从建立）' });
  } else if (/^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]{1,64}$/.test(related)) {
    // 外部来源（feishu:<单号>，task-loop 剖面 B）：锚在 meta.remote_id 而非 .ai/tasks/。
    // 校验降为"remote_id 与 related_task 前后一致"——两个地方各写各的等于没有锚。
    const r = meta.remote_id;
    const expect = /^([a-z][a-z0-9-]*):([A-Za-z0-9._/-]{1,64})$/.exec(related);
    if (!r || typeof r !== 'object' || r.source !== expect[1] || r.id !== expect[2]) {
      failures.push({ id: '(task)', rule: 'trace', reason: `外部来源锚不一致：related_task=${related} 与 meta.remote_id（${JSON.stringify(r)}）对不上——回写找不到平台实例` });
    }
  } else if (!existsSync(join(repo, '.ai/tasks', related, 'state.json'))) {
    // init 建档时验证过一次，但 meta 之后可以被改写——每次落盘都复核，防关联被改断。
    failures.push({ id: '(task)', rule: 'trace', reason: `关联任务不存在：${related}（related_task 被改错或原任务已删，追溯链断裂）` });
  }

  if (state.stage !== 'done') return failures;

  const ids = meta.affected_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string' || !x.trim())) {
    failures.push({
      id: '(task)',
      rule: 'trace',
      reason: '完成态的 change/bugfix 必须在 meta.affected_ids 列出受影响需求/模块 ID（空数组 = 影响分析没做）',
    });
  }

  if (type === 'change') {
    const baseline = meta.baseline;
    if (!baseline || typeof baseline !== 'string') {
      failures.push({ id: '(task)', rule: 'trace', reason: 'change 任务缺 baseline（需求基线必须是 commit hash，不锚定的关联会两头漂移）' });
    } else if (!COMMIT_HASH_RE.test(baseline)) {
      failures.push({ id: '(task)', rule: 'trace', reason: `baseline 必须是 7-40 位 commit hash（RS 是活文档，${JSON.stringify(baseline)} 这种形态机器验证不了，等于没锚）` });
    } else if (isGitRepo(repo) && git(repo, ['cat-file', '-e', `${baseline}^{commit}`]) === null) {
      failures.push({ id: '(task)', rule: 'trace', reason: `baseline ${baseline} 在仓库历史里不存在（commit 拼错或来自别的仓库）` });
    }
    if (!CHANGE_TIERS.includes(meta.change_tier)) {
      failures.push({
        id: '(task)',
        rule: 'trace',
        reason: `完成态的 change 必须在 meta.change_tier 标注影响档位（1=文案/展示 2=局部行为 3=契约/跨栈，合法值：${CHANGE_TIERS.join(' / ')}）`,
      });
    }
  }

  if (type === 'bugfix') {
    const regressions = (state.todos || []).filter(
      (t) => t && t.kind === 'regression' && (t.status === 'completed' || t.status === 'done')
    );
    if (regressions.length === 0) {
      failures.push({
        id: '(task)',
        rule: 'trace',
        reason: '完成态的 bugfix 必须有 kind="regression" 且已完成的复现测试 TODO（先复现再修复，缺它等于口头声称修好了）',
      });
    }
    for (const t of regressions) {
      const fail = checkRedLog(t, repo);
      if (fail) failures.push({ id: t.id || '(无 id)', rule: 'trace', reason: fail });
    }
  }

  return failures;
}

/** 红灯日志：修复前的失败运行记录。机器判存在性与形态，"是不是真跑出来的"归 CR。 */
function checkRedLog(todo, repo) {
  const p = todo.red_log_path;
  if (!p || typeof p !== 'string') {
    return '回归测试 TODO 缺 red_log_path（修复前必须留一次失败运行的红灯日志，格式同 verify-run.sh）';
  }
  const abs = resolve(repo, p);
  if (!existsSync(abs)) return `红灯日志不存在：${p}`;
  const code = parseExitCode(readHead(abs));
  if (code === null) return `红灯日志缺少 exit_code 头：${p}（格式见 scripts/verify-run.sh）`;
  if (code === 0) return `红灯日志 exit_code=0 —— 修复前的复现运行必须是失败（红灯），exit 0 说明这不是复现记录`;
  if (gitTracked(repo, p) === false) return `红灯日志未入库：${p}（证据必须随代码提交）`;
  return null;
}

export function formatFailures(failures) {
  return failures.map((f) => `  [${f.rule}] ${f.id} — ${f.reason}`).join('\n');
}

/** 读 hook 的 stdin JSON；解析失败返回 null（由调用方决定 fail-open 还是 closed）。 */
export function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 找 repo 根：以 cwd 为准，CI 从仓库根执行。hook 请用 REPO_ROOT。 */
export function repoRoot() {
  return process.cwd();
}
