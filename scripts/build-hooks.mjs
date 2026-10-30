#!/usr/bin/env node
/**
 * hook 接线生成器 —— 与 build-agents 同一个思路：接线是配置，不该被手抄三遍。
 *
 * 之前的状态：hooks 只写进 .claude/settings.json，.zcode/ 下只有 agents 和 commands。
 * ZCode 不读 Claude 的 settings，于是"hook 硬拦"在 ZCode 会话里完全不存在，
 * 而 doctor 只查 .claude/settings.json，体检照样显示"✓ hook 已注册 4 个"。
 * 门禁在，但只在一个 CLI 里在 —— 这比没有门禁更危险，因为它会让人以为有。
 *
 * 现在：hooks/hooks.manifest.json 是唯一源，本脚本生成
 *   .claude/settings.json   {hooks:{事件:[{matcher,hooks:[{type:'command',command,timeout}]}]}}
 *   .zcode/config.json      {hooks:{enabled:true,events:{事件:[{matcher,hooks:[{type:'process',command,args}]}]}}}
 *
 * 两种形态的差异不是笔误，是两个 CLI 的真实契约：
 *   Claude 用一整个 shell 命令字符串 + 秒级 timeout；
 *   ZCode 用 argv 数组（不走 shell）+ 毫秒级 timeoutMs，且必须显式 hooks.enabled=true。
 *
 * 用法：
 *   node scripts/build-hooks.mjs            # 生成
 *   node scripts/build-hooks.mjs --check    # 只校验是否漂移（CI 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
]);

function fail(msg) {
  console.error(`[build-hooks] ${msg}`);
  process.exit(1);
}

const config = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8'));
  } catch (e) {
    fail(`harness.config.json 无法解析：${e.message}`);
  }
})();

const manifestPath = join(ROOT, (config.hooks && config.hooks.manifest) || 'hooks/hooks.manifest.json');
if (!existsSync(manifestPath)) fail(`找不到 hook manifest：${manifestPath}`);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/* ---------- 校验：manifest 里引用的脚本必须存在，事件名必须合法 ---------- */

const problems = [];
const events = manifest.events || {};
if (Object.keys(events).length === 0) problems.push('hooks.manifest.json 的 events 为空 —— 生成出来等于没有门禁');

for (const [event, groups] of Object.entries(events)) {
  if (!EVENTS.has(event)) problems.push(`未知事件：${event}`);
  if (!Array.isArray(groups) || groups.length === 0) problems.push(`${event} 下没有 matcher 分组`);
  for (const g of groups || []) {
    if (!Array.isArray(g.hooks) || g.hooks.length === 0) problems.push(`${event} 分组里没有 hook`);
    for (const h of g.hooks || []) {
      if (!h.script) problems.push(`${event} 里有 hook 没写 script`);
      else if (!existsSync(join(ROOT, h.script))) problems.push(`${event} 引用了不存在的脚本：${h.script}`);
      if (h.timeout !== undefined && !(Number(h.timeout) > 0)) problems.push(`${h.script} 的 timeout 必须是正数秒`);
    }
  }
}

if (problems.length) {
  console.error('[build-hooks] manifest 有问题：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

/* ---------- 渲染 ---------- */

function renderClaude() {
  const hooks = {};
  for (const [event, groups] of Object.entries(events)) {
    hooks[event] = groups.map((g) => {
      const entry = {};
      if (g.matcher) entry.matcher = g.matcher;
      entry.hooks = g.hooks.map((h) => ({
        type: 'command',
        command: `node ${h.script}`,
        ...(h.timeout ? { timeout: Number(h.timeout) } : {}),
      }));
      return entry;
    });
  }
  return { hooks };
}

function renderZcode() {
  const out = {};
  for (const [event, groups] of Object.entries(events)) {
    out[event] = groups.map((g) => {
      const entry = {};
      // ZCode 的 matcher 是 JS 正则字符串，必须锚定，否则 "Bash|Read" 会子串命中
      if (g.matcher) entry.matcher = `^(${g.matcher})$`;
      entry.hooks = g.hooks.map((h) => ({
        type: 'process',
        command: 'node',
        args: [h.script],
        enabled: true,
        ...(h.timeout ? { timeoutMs: Number(h.timeout) * 1000 } : {}),
      }));
      return entry;
    });
  }
  // 不写 $schema：ZCode 的配置 schema 是严格校验的，多一个它不认识的顶层键可能导致整份配置被拒，
  // 而"被拒"的表现是 hook 静默不执行 —— 与我们要防的失效模式同型。
  return {
    hooks: {
      enabled: true,
      timeoutMs: manifest.timeoutMs || 60000,
      maxOutputBytes: manifest.maxOutputBytes || 32768,
      events: out,
    },
  };
}

const targets = config.targets || {};
const outputs = [];

for (const name of ['claude', 'zcode']) {
  const t = targets[name];
  if (!t || !t.enabled || !t.hooksFile) continue;
  const body = name === 'claude' ? renderClaude() : renderZcode();
  outputs.push({ name, path: t.hooksFile, content: JSON.stringify(body, null, 2) + '\n' });
}

if (outputs.length === 0) fail('没有启用的 target 带 hooksFile —— 生成物会是空的');

/* ---------- 写盘 / 漂移检测 ---------- */

let drift = 0;
for (const o of outputs) {
  const abs = join(ROOT, o.path);
  const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;

  // 只覆盖 hooks 段，保留文件里的其它键（permissions / model / provider 等是使用者自己的配置，
  // 生成器把它们抹掉，等于每次 build 都重置一次别人的环境）。
  let base = {};
  if (current) {
    try {
      base = JSON.parse(current);
    } catch (e) {
      fail(`${o.path} 现有内容不是合法 JSON：${e.message}（先修好它，生成器不会替你猜）`);
    }
  }
  const content = JSON.stringify({ ...base, ...JSON.parse(o.content) }, null, 2) + '\n';
  const same = current === content;

  if (CHECK) {
    if (!same) {
      console.error(`  ✗ ${o.path} 与 hooks.manifest.json 不一致（跑 npm run build:hooks）`);
      drift++;
    } else {
      console.log(`  ✓ ${o.path}`);
    }
    continue;
  }

  if (same) {
    console.log(`  = ${o.path}（未变化）`);
  } else {
    writeFileSync(abs, content);
    console.log(`  ✓ ${o.path}`);
  }
}

if (CHECK) {
  if (drift) {
    console.error(`[build-hooks] ${drift} 个接线文件漂移，CI 应判红`);
    process.exit(1);
  }
  console.log('[build-hooks] hook 接线与 manifest 一致');
}
