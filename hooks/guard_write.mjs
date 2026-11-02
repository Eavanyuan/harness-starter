#!/usr/bin/env node
/**
 * PreToolUse(Write | Edit | MultiEdit | NotebookEdit) 门禁 —— fail-closed。
 *
 * 为什么需要它：agent.md 里的 `writes` 是说明，不是约束。
 * 只要工具集里有 Write，它就能写仓库里的任何路径，文档里写「只写 docs/」并不拦得住。
 * 把「能写哪」变成机制，只有两条路：裁剪工具集（粗粒度），或拦路径（本文件）。
 *
 * 三类判据，都基于路径而非 agent 身份：
 *   generated → 手改必然被下一次 build 覆盖，直接拒
 *   protected → 考卷区（门禁代码、配置、模板、agent 定义），改它要走人工放行
 *   sensitive → 凭据类文件，一律拒
 *
 * 为什么不做「这个 agent 只能写自己 writes 声明的路径」：
 *   CLI 的 PreToolUse 载荷里没有 agent 名，判不出是谁在写。硬要模拟就得靠 state 自报身份，
 *   而身份本身就是被约束对象的自述——那只是把「自觉」换了个位置。
 *
 * 放行受保护区：hooks/write-allowlist.txt
 *   格式：<路径 glob> | <原因> | <YYYY-MM-DD>
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson } from './lib/verify.mjs';
import { WRITE_TOOLS, writeTarget } from './lib/write_tools.mjs';
import { recordDeny } from './lib/ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function emit(decision, reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
  if (decision === 'deny') {
    console.error(reason);
    process.exit(2);
  }
}

function deny(reason, suggestion, subject) {
  recordDeny('guard_write', 'deny', `${reason}｜${suggestion || ''}`, { target: subject });
  emit('deny', `[guard_write] 已拦截：${reason}${suggestion ? `\n做法：${suggestion}` : ''}`);
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8'));
  } catch {
    deny('harness.config.json 无法读取，写入白名单缺失', '修复配置后重试，不要直接放行', 'harness.config.json');
  }
}

/** `**` 与 `*` 的区别必须保留：前者跨目录，后者不跨。用占位符避免二次替换。 */
function globToRe(glob) {
  let s = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  s = s
    .replace(/\*\*\//g, '\u0000S')
    .replace(/\*\*/g, '\u0000A')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000S/g, '(?:.*/)?')
    .replace(/\u0000A/g, '.*');
  return new RegExp('^' + s + '$');
}

function activeAllowlist() {
  const p = join(ROOT, 'hooks/write-allowlist.txt');
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
if (!WRITE_TOOLS.has(tool)) process.exit(0);

const input = payload.tool_input || {};
const target = writeTarget(input);
if (!target) process.exit(0);

const abs = isAbsolute(target) ? target : resolve(ROOT, target);
const rel = relative(ROOT, abs).split('\\').join('/');

if (rel.startsWith('..') || isAbsolute(rel)) {
  deny(`写入仓库外路径：${target}`, '只改本仓库内的文件；仓库外操作属于环境变更，交给人做', target);
}

const guards = (loadConfig().gates || {}).writeGuards || {};

function hit(list) {
  return (list || []).find((g) => globToRe(g).test(rel));
}

// 示例文件必须先判：否则 deny 提示"改写 .env.example"，而它自己又被 sensitive 拦住，
// 门禁就把自己给出的唯一出路堵死了（这是上一版真实存在的死循环）。
const exempt = hit(guards.sensitiveExempt);
const sensitive = exempt ? null : hit(guards.sensitive);
if (sensitive) {
  const example = (guards.sensitiveExempt || [])[0] || '.env.example';
  deny(
    `写入凭据类文件 ${rel}`,
    `凭据不进仓库。确需示例，写 ${example.replace('**/', '')}（只放字段名与假值，不放真实凭据）`,
    rel
  );
}

const generated = hit(guards.generated);
if (generated) {
  deny(
    `${rel} 是生成物（命中 ${generated}），手工修改会在下一次 build 被覆盖`,
    '改 agents/*.agent.md 或 harness.config.json，然后跑 npm run build:agents',
    rel
  );
}

const protectRule = hit(guards.protected);
if (protectRule) {
  const allowed = activeAllowlist().some((g) => globToRe(g).test(rel));
  if (!allowed) {
    deny(
      `${rel} 属于受保护区（命中 ${protectRule}）——门禁代码、配置、模板与 agent 定义不允许在任务中被顺手改动`,
      `若确实是本任务的一部分，由人往 hooks/write-allowlist.txt 加一行：\n    ${rel} | <为什么必须改> | <YYYY-MM-DD>\n然后说明改动并补测试，再继续`,
      rel
    );
  }
  console.error(`[guard_write] 受保护区已放行（allowlist）：${rel}`);
}

process.exit(0);
