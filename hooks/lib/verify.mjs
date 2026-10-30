/**
 * 校验核心库 —— hook 与 CI 共用同一份逻辑。
 *
 * 为什么必须共用：如果 hook 校一套、CI 校另一套，两边迟早不一致；
 * 更糟的是 CI 更松，于是"本地被拦、提交却能过"，门禁就成了摆设。
 *
 * 只做可判定的检查：文件存在、正则匹配、mtime 比较、字段齐备。
 * 任何需要"理解代码质量"的判断都不放在这里。
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

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

export function gitChangedFiles(repo) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim())
      .filter((p) => p && !p.startsWith('.ai/'));
  } catch {
    return [];
  }
}

/**
 * 三项机器校验。缺一不可：
 *   1. 文件存在            —— 防"不跑就声称跑过"
 *   2. 日志 exit_code = 0  —— 防"跑了但失败仍标 done"
 *   3. mtime 晚于源码       —— 防"复述上一次会话的输出"（最隐蔽的造假）
 */
export function checkVerify(todo, repo) {
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
  const sources = declared.map((f) => resolve(repo, f)).filter((p) => existsSync(p));
  const candidates = sources.length ? sources : gitChangedFiles(repo).map((f) => resolve(repo, f)).filter((p) => existsSync(p));

  if (candidates.length === 0) {
    return { ok: false, reason: '找不到任何已改动的源码文件，无法证明证据新鲜度' };
  }

  const logMtime = statSync(abs).mtimeMs;
  const newest = candidates.reduce((acc, p) => Math.max(acc, statSync(p).mtimeMs), 0);
  if (logMtime <= newest) {
    return {
      ok: false,
      reason: 'verify 日志早于最后一次源码修改，疑似复述历史输出（请真的重跑一次）',
    };
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
 * 只在 status 从非完成转为完成时调用——对 in_progress 也校验会把会话卡死。
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

    const verify = checkVerify(todo, repo);
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

/** 找 repo 根：以 cwd 为准，hook 与 CI 都从仓库根执行。 */
export function repoRoot() {
  return process.cwd();
}
