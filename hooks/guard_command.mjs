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
import { readStdinJson } from './lib/verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function deny(reason, suggestion) {
  const msg = `[guard_command] 已拦截：${reason}${suggestion ? `\n建议：${suggestion}` : ''}`;
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
    deny('harness.config.json 无法读取，安全清单缺失', '修复配置后重试，不要直接放行');
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
if (payload === null) deny('hook 输入无法解析，按 fail-closed 处理');

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

  for (const pattern of gates.blockedCommands || []) {
    const re = new RegExp(pattern);
    if (re.test(cmd)) {
      deny(
        `命中高危命令规则 /${pattern}/`,
        '改用 --force-with-lease 之类的可回滚形式；确需执行请写入 .claude/hooks/allowlist.txt 并注明原因与到期日'
      );
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
        '不要读原始文件。改为读示例文件（.env.example）或让用户提供脱敏后的字段名'
      );
    }
  }
  process.exit(0);
}

process.exit(0);
