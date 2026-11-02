#!/usr/bin/env node
/**
 * PreToolUse(Bash | Read) 门禁 —— fail-closed。
 *
 * 两个职责：
 *   Bash  → 高危命令黑名单拦截（删数据、强推、绕过校验、管道执行远程脚本）
 *   Read  → 敏感文件禁读（.env / 私钥 / 凭据）
 *
 * 黑名单与禁读清单在 harness.config.json 的 gates 里，改配置即可，不用改代码。
 * allowlist 支持带到期时间的一次性例外：hooks/allowlist.txt
 *   格式：<命令前缀> | <原因> | <YYYY-MM-DD>
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, blockedRules, GENERIC_RULE_HINT } from './lib/verify.mjs';
import { recordDeny } from './lib/ledger.mjs';

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

const payload = readStdinJson();
if (payload === null) deny('hook 输入无法解析，按 fail-closed 处理', null, '(stdin payload)');

const tool = payload.tool_name || '';
const input = payload.tool_input || {};
const config = loadConfig();
const gates = config.gates || {};

if (tool === 'Bash') {
  const cmd = String(input.command || '');
  if (!cmd) process.exit(0);

  const allowed = activeAllowlist().find((prefix) => cmd.startsWith(prefix));
  if (allowed) {
    console.error(`[guard_command] allowlist 命中，放行：${cmd.slice(0, 60)}`);
    process.exit(0);
  }

  for (const rule of blockedRules(gates)) {
    const re = new RegExp(rule.pattern);
    if (re.test(cmd)) {
      deny(`命中高危命令规则 /${rule.pattern}/`, rule.hint || GENERIC_RULE_HINT, cmd, rule.pattern);
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
