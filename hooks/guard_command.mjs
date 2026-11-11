#!/usr/bin/env node
/**
 * PreToolUse(Bash | Read) 门禁 —— fail-closed。
 *
 * 三个职责：
 *   Bash  → ① 高危命令黑名单（删数据、强推、绕过校验、管道执行远程脚本）
 *           ② 写类重定向 / 复制 / in-place 编辑的目标路径（与 guard_write 同一套判据）
 *           ③ 读类命令的敏感文件（与 Read 的 sensitiveRead 同一套判据）
 *   Read  → 敏感文件禁读（.env / 私钥 / 凭据）
 *
 * 为什么 Bash 也要判路径：只拦 Write/Edit 等于留了一条主干道。
 * `echo '{...}' > .ai/tasks/x/state.json` 不经过 guard_state，
 * `cat .env` 不经过 sensitiveRead —— 规则再多，有一条不经过它的路，威慑力就打折。
 *
 * allowlist 是**段级豁免**，不是整条命令的短路：
 *   早先命中前缀就 exit 0，于是 `mvn test; git push --force` 整条放行。
 *   现在先按 `;` `&&` `||` 换行切段，逐段判；allowlist 只豁免它命中的那一段，
 *   且**不豁免**路径判据（没有任何一条命令前缀应该允许写凭据文件）。
 *
 * 已知边界（写清楚，不假装）：
 *   · 变量拼出来的路径（`$D/state.json`）拿不到展开值；
 *   · `node -e` / `python -c` 里的写文件调用不在词法判据内（`bash -c` 已递归覆盖）；
 *   · 这些靠 CR 与人审兜，不是靠这里加正则。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, blockedRules, GENERIC_RULE_HINT } from './lib/verify.mjs';
import { recordDeny } from './lib/ledger.mjs';
import { analyzeCommand } from './lib/shell.mjs';
import { classifyPath, loadGuards } from './lib/path_guards.mjs';
import { globToRe } from './lib/glob.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 提示分两层：规则自己的修法（rule.hint）+ 任何规则都成立的例外出口（allowlist）。
 * 早先把两者揉成一段共用文案，结果 -DskipTests 的提示在讲强推——被拦的人照着改，改不好。
 * 例外路径则一段都不能少：没有出口的门禁，最后一定被人整体关掉。
 */
function deny(reason, suggestion, target, rule = 'deny') {
  const hint = suggestion || GENERIC_RULE_HINT;
  const escape = '例外出口：hooks/allowlist.txt 写 <命令前缀> | <原因> | <YYYY-MM-DD>，到期自动失效';
  // 账本里记**具体哪条规则**，不是笼统的 "deny"：
  // 只记 hook 名的话，npm run ledger:report 只能告诉你"命令门禁拦了 286 次"，
  // 说不出是哪条规则在拦——那正是判断误拦率需要的那个数字。
  recordDeny('guard_command', rule, `${reason}｜${hint}`, { target });
  const msg = `[guard_command] 已拦截：${reason}\n建议：${hint}\n${escape}`;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: msg,
      },
    })
  );
  console.error(msg);
  process.exit(2);
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8'));
  } catch {
    deny('harness.config.json 无法读取，安全清单缺失', '修复配置后重试，不要直接放行', 'harness.config.json');
  }
}

/** 未过期的 allowlist 条目。过期的自动失效，不需要人清理。 */
function activeAllowlist() {
  const p = join(ROOT, 'hooks/allowlist.txt');
  if (!existsSync(p)) return [];
  const today = new Date().toISOString().slice(0, 10);
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('|').map((s) => s.trim()))
    .filter((parts) => parts.length >= 3 && parts[2] >= today)
    .map((parts) => parts[0]);
}

/** 命令行里的路径 → 仓库相对路径（`~` 展开；仓库外得到 `../…`，不参与仓库内 glob）。 */
function repoRel(p) {
  let s = String(p || '');
  if (s === '~' || s.startsWith('~/')) s = join(homedir(), s.slice(1));
  const abs = isAbsolute(s) ? s : resolve(ROOT, s);
  return relative(ROOT, abs).split('\\').join('/');
}

const payload = readStdinJson();
if (payload === null) deny('hook 输入无法解析，按 fail-closed 处理', null, '(stdin payload)');

const tool = payload.tool_name || '';
const input = payload.tool_input || {};
const config = loadConfig();
const gates = config.gates || {};

if (tool === 'Bash') {
  const cmd = String(input.command || '');
  if (!cmd) process.exit(0);

  const shellCfg = gates.shell || {};
  const guards = loadGuards(config);
  const stateGlob = shellCfg.stateGlob || '.ai/tasks/*/state.json';
  const evidenceGlob = shellCfg.evidenceGlob || '.ai/verify/**';
  const sensitiveRead = gates.sensitiveRead || [];

  let segments;
  try {
    segments = analyzeCommand(cmd, shellCfg);
  } catch (err) {
    deny(
      `命令无法解析（${err.message}）`,
      '把命令拆成更简单的形式重试；解析不了就不放行（fail-closed）',
      cmd,
      'shell:parse'
    );
  }

  /** 一次写操作的目标路径判定。allowlist 不参与——没有任何前缀该允许写这些路径。 */
  function judgeWrite(w) {
    const rel = repoRel(w.path);
    if (globToRe(stateGlob).test(rel)) {
      deny(
        `shell 直接改写任务状态 ${rel}（via ${w.via}）`,
        '用 Write / Edit 改 state.json：它会先过证据校验。' +
          '重定向 / cp / sed -i 都绕开了那道校验，于是"没证据的完成态"可以落盘——这正是本门禁存在的理由',
        rel,
        'shell:state-rewrite'
      );
    }
    if (globToRe(evidenceGlob).test(rel)) {
      deny(
        `shell 直接写证据目录 ${rel}（via ${w.via}）`,
        '用 bash scripts/verify-run.sh --task <slug> <id> -- <命令>：日志头的 cmd / exit_code 由它生成。' +
          '手写一份日志与"真跑过一次"在文件上无法区分，所以只能认这一条路',
        rel,
        'shell:evidence-forge'
      );
    }
    const cls = classifyPath(rel, guards);
    if (cls.sensitive) {
      deny(
        `shell 写入凭据类文件 ${rel}（via ${w.via}）`,
        '凭据不进仓库。要写示例就写 .env.example（只放字段名与假值）',
        rel,
        'shell:write-sensitive'
      );
    }
    if (cls.generated) {
      deny(
        `${rel} 是生成物（命中 ${cls.generated}），shell 改写会在下一次 build 被覆盖`,
        '改源（agents/*.agent.md 或 harness.config.json）后跑 npm run build:agents',
        rel,
        'shell:write-generated'
      );
    }
    if (cls.protect) {
      deny(
        `${rel} 属于受保护区（命中 ${cls.protect}），不允许用 shell 顺手改`,
        `门禁代码 / 配置 / 模板 / agent 定义只能走 Write|Edit + hooks/write-allowlist.txt 的人工放行：\n` +
          `    ${rel} | <为什么必须改> | <YYYY-MM-DD>`,
        rel,
        'shell:write-protected'
      );
    }
  }

  /** 敏感读判定。含反斜杠的 token 是正则片段（`grep "\.env"`），不是路径。 */
  function judgeRead(r) {
    const p = String(r.path || '');
    if (!p || p.includes('\\')) return;
    for (const pattern of sensitiveRead) {
      if (new RegExp(pattern, 'i').test(p)) {
        deny(
          `尝试用 ${r.via} 读取敏感文件：${p}`,
          '不要读原始凭据。改为读示例文件（.env.example）或让用户提供脱敏后的字段名',
          p,
          `shell:read-sensitive:${pattern}`
        );
      }
    }
  }

  const allow = activeAllowlist();
  // allowlist 不能成为"把脚本送进解释器"的许可证：前缀只描述一条命令，不描述管道。
  const pipesToInterpreter = /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\|\s*(?:python[0-9.]*|perl|node|ruby)\b/;

  for (const seg of segments) {
    for (const w of seg.writes) judgeWrite(w);
    for (const r of seg.reads) judgeRead(r);

    const allowed = !pipesToInterpreter.test(seg.text) && allow.find((prefix) => seg.text.startsWith(prefix));
    if (allowed) {
      console.error(`[guard_command] allowlist 命中，放行该段：${seg.text.slice(0, 60)}`);
      continue;
    }

    for (const rule of blockedRules(gates)) {
      const re = new RegExp(rule.pattern);
      if (re.test(seg.text)) {
        deny(`命中高危命令规则 /${rule.pattern}/`, rule.hint || GENERIC_RULE_HINT, seg.text, rule.pattern);
      }
    }
  }
  process.exit(0);
}

if (tool === 'Read') {
  const path = String(input.file_path || input.path || '');
  if (!path) process.exit(0);

  for (const pattern of gates.sensitiveRead || []) {
    if (new RegExp(pattern, 'i').test(path)) {
      deny(
        `尝试读取敏感文件：${path}`,
        '不要读原始文件。改为读示例文件（.env.example）或让用户提供脱敏后的字段名',
        path,
        pattern
      );
    }
  }
  process.exit(0);
}

process.exit(0);
