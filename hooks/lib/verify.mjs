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
 *   local：存在 + exit_code=0 + 日志晚于源码 + 未超时效（verifyFreshnessHours）
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
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：以库文件位置为准，不依赖 cwd（hook 可能被从任意目录唤起）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const AUDIT_KEYS = ['compile', 'tests', 'feature_complete', 'quality_clean'];
export const OODA_STAGES = ['observe', 'orient', 'decide', 'act', 'audit'];

/** 日志头长度上限。只看头部，避免大日志拖慢 hook。 */
const LOG_HEAD_BYTES = 4000;

export function readHead(absPath, bytes = LOG_HEAD_BYTES) {
  const buf = readFileSync(absPath);
  return buf.subarray(0, bytes).toString('utf8');
}

/** 解析 verify 日志头里的 exit_code。格式见 scripts/verify-run.sh。 */
export function parseExitCode(head) {
  const m = head.match(/^#\s*exit_code:\s*(-?\d+)\s*$/m);
  return m ? Number(m[1]) : null;
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
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(repo) {
  return git(repo, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function gitChangedFiles(repo) {
  const out = git(repo, ['status', '--porcelain']);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter((p) => p && !p.startsWith('.ai/'));
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

/** 各栈声明的源码 glob。用来把"栈内源码改动"也算进新鲜度判断，而不只看 TODO 自报的 files。 */
export function stackSourceGlobs(config) {
  return Object.values((config && config.stacks) || {})
    .map((s) => s && s.srcGlob)
    .filter(Boolean);
}

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

  // 以下仅本地：工作树里 mtime 是真实事实。
  //
  // 候选集 = TODO 自报的 files ∪ 栈内被改动的源码（srcGlob 命中）。
  // 只取自报的 files 会被"少报一个文件"绕过：日志只要晚于那一个文件就算新鲜，
  // 而另一个真正改了源码的文件比日志还新。取并集，任一新于日志就重跑。
  const changed = gitChangedFiles(repo);
  const globs = stackSourceGlobs(config);
  const globMatched = globs.length ? changed.filter((f) => globs.some((g) => globToRe(g).test(f))) : [];

  const candidates = [
    ...new Set([
      ...declared.map((f) => resolve(repo, f)).filter((p) => existsSync(p)),
      ...globMatched.map((f) => resolve(repo, f)).filter((p) => existsSync(p)),
    ]),
  ];

  const pool = candidates.length
    ? candidates
    : changed.map((f) => resolve(repo, f)).filter((p) => existsSync(p));

  if (pool.length === 0) {
    return { ok: false, reason: '找不到任何已改动的源码文件，无法证明证据新鲜度' };
  }

  const logStat = statSync(abs);
  const newest = pool.reduce((acc, p) => Math.max(acc, statSync(p).mtimeMs), 0);
  if (logStat.mtimeMs <= newest) {
    return {
      ok: false,
      reason: 'verify 日志早于最后一次源码修改，疑似复述历史输出（请真的重跑一次）',
    };
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
 * 只在 status 已是 completed 时校验——in_progress 也校验会把会话卡死。
 */
export function validateTodos(todos, repo, opts = {}) {
  const failures = [];
  for (const todo of todos || []) {
    if (todo.status !== 'completed' && todo.status !== 'done') continue;
    const id = todo.id || '(无 id)';

    const audit = checkAudit(todo);
    if (!audit.ok) failures.push({ id, rule: 'audit', reason: audit.reason });

    const ooda = checkOoda(todo);
    if (!ooda.ok) failures.push({ id, rule: 'ooda', reason: ooda.reason });

    const verify = checkVerify(todo, repo, opts);
    if (!verify.ok) failures.push({ id, rule: 'verify', reason: verify.reason });
  }
  return failures;
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
