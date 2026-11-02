#!/usr/bin/env node
/**
 * SessionStart 提醒 —— fail-open。
 *
 * 上下文压缩或换人接手后，最容易丢的不是代码，而是"现在推进到哪了"。
 * 输出内容按 modelTiers 的 scaffold 档分流（这是 scaffold 的真实行为，不只是展示）：
 *   full  → 档位行 + 进行中的任务与卡点清单 + 接手提醒（逐 TODO 提醒）
 *   light → 档位行 + 一行豁免说明；不注入任务清单（强模型自己找 state.json）
 * 两种档位都不豁免技能加载与 verify 证据链——那些是门禁，不是脚手架。
 *
 * 为什么必须真的分流：modelTiers 曾经长期没有代码读它，文档却在宣传"定义分层"。
 * 配置不生效比配置不存在更糟。现在 scaffold 既被读取、也改变输出，doctor 的
 * "配置键均有消费者"与这里的分支互为印证。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT, loadConfig } from './lib/verify.mjs';
import { recordEvent } from './lib/ledger.mjs';

// HARNESS_ROOT 只给自测与 vendored 安装用，语义与 guard_state 一致。
const ROOT = process.env.HARNESS_ROOT ? resolve(process.env.HARNESS_ROOT) : REPO_ROOT;
const TASKS = join(ROOT, '.ai/tasks');

/** `claude-*` 这类前缀通配，够用即可，不引入 glob 库。 */
function matches(pattern, value) {
  if (!pattern || !value) return false;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(value);
}

function scaffoldInfo() {
  const config = loadConfig(ROOT);
  if (!config) return null;
  const model = process.env.HARNESS_MODEL || process.env.ZCODE_MODEL || process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || '';
  const tiers = config.modelTiers || [];
  if (!tiers.length) return null;

  if (!model) {
    const fallback = tiers.find((t) => t.scaffold === 'full') || tiers[0];
    return {
      line: `[harness] 未识别模型（设 HARNESS_MODEL 可判档）→ scaffold=${fallback.scaffold}`,
      scaffold: fallback.scaffold,
    };
  }

  const matched = tiers.find((t) => (t.agents || []).some((p) => matches(p, model)));
  if (!matched) {
    return {
      line: `[harness] 模型 ${model} 不在任何 modelTiers 里 → 按常规档 scaffold=full`,
      scaffold: 'full',
    };
  }
  return {
    line: `[harness] 模型 ${model} → scaffold=${matched.scaffold}（${matched.label || matched.id}）`,
    scaffold: matched.scaffold,
  };
}

/**
 * 能力自检行 —— 与 scaffold 档位无关，任何档位都打。
 *
 * 起因是真实事故（TDC 第一个任务）：writes.json 声明 orchestrator 有 agent.spawn，
 * 实际宿主会话根本没有派子 agent 的能力，于是 rs/wbs/adr 三阶段全靠 orchestrator 直做，
 * 到 impl 才卡住，整条流程白跑一半。声明与运行时的脱节无法在 hook 里判出来
 * （hook 不知道宿主有没有 spawn 工具），但可以在开场就把这件事摆到台面上：
 * 让它成为第一件被确认或推翻的事，而不是跑了一半才发现的偏离。
 */
function runtimeLine() {
  const config = loadConfig(ROOT);
  const rt = (config && config.runtime) || null;
  if (!rt) return null;
  const val = (k) => rt[k] || 'unknown';
  const pending = ['spawn_agents', 'shell', 'ask_user'].filter((k) => val(k) === 'unknown');
  return (
    `[harness] 能力自检：spawn_agents=${val('spawn_agents')} shell=${val('shell')} ask_user=${val('ask_user')}` +
    (pending.length
      ? `｜未验证：${pending.join('、')}——本会话第一件事是确认这些工具真实可用；缺哪项就按 direct 模式推进（本模型直做），并在 state.json 记录偏离`
      : '｜已声明，与本次实际可用工具不符时立刻改回 unknown 并记偏离')
  );
}

try {
  // #22：session 心跳入账（events.jsonl，与 deny.jsonl 分文件）。只有 deny 才留痕时，
  // "编码时段门禁到底在不在线"无法自证——这条心跳就是在线证明。
  recordEvent('session_start', 'session', {
    scaffold: (scaffoldInfo() || {}).scaffold || null,
    node: process.version,
  });

  const info = scaffoldInfo();
  const rtLine = runtimeLine();
  if (rtLine) console.log(rtLine);

  // light 档：豁免逐任务 TODO 提醒。流程脚手架只到这一行为止，
  // 技能加载与证据链是门禁，任何档位都照跑。
  // 注意：这里**不能 process.exit** —— "有人卡着等你拍板"要在读完 tasks 后才能判，
  // 所以先记下档位，读完之后再决定注入多少。
  const light = !!(info && info.scaffold === 'light');
  if (info) {
    console.log(info.line);
    if (light) console.log('[harness] scaffold=light：豁免逐任务 TODO 提醒（技能加载与证据链不豁免）');
  }

  if (!existsSync(TASKS)) process.exit(0);

  const states = [];
  for (const d of readdirSync(TASKS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(TASKS, d.name, 'state.json');
    if (!existsSync(p)) continue;
    try {
      states.push(JSON.parse(readFileSync(p, 'utf8')));
    } catch {
      states.push({ meta: { task: d.name }, stage: 'unparseable' });
    }
  }

  if (states.length === 0) process.exit(0);

  const doing = states.filter((s) => s.stage && s.stage !== 'done');
  const stuck = doing.filter((s) => (s.blockers || []).some((b) => !b.resolved));

  // light 档：TODO 清单豁免，但"有人卡在等你拍板"这件事不豁免。
  // 强模型能自己翻到 state.json 看进度，但它不会主动知道"这个停点是冲人来的"。
  // 开场把恢复命令摆出来，成本一行，省掉"任务停了三天没人管"。
  if (info && info.scaffold === 'light') {
    if (stuck.length) {
      console.log(`[harness] 有任务停在等人：${stuck.map((s) => s.meta?.task || '?').join('、')}（详见各 state.json）`);
      console.log(`[harness] 恢复入口：node scripts/harness-cli.mjs resume . <slug>`);
    }
    process.exit(0);
  }

  const lines = [];
  for (const s of doing.slice(0, 3)) {
    const todos = s.todos || [];
    const open = todos.filter((t) => t.status !== 'completed' && t.status !== 'done').length;
    const blocked = (s.blockers || []).filter((b) => !b.resolved).length;
    const name = s.meta?.task || '?';
    lines.push(
      `· ${name} — stage=${s.stage} tier=${s.meta?.flow_tier || '?'} 未完成 ${open} 项` +
        (blocked ? ` · ${blocked} 个 blocker 待决` : '')
    );
    // 只报"有几个待决"等于告诉你屋里有人却不给门牌号：恢复命令必须同时给出。
    if (blocked) lines.push(`    恢复：node scripts/harness-cli.mjs resume . ${name}   （决策单 .ai/tasks/${name}/DECISIONS.md）`);
  }

  if (lines.length) {
    console.log('[harness] 进行中的任务：');
    for (const l of lines) console.log(l);
    console.log('接手前先读对应 state.json；不要凭会话记忆推断进度。');
  }
} catch {
  process.exit(0);
}
