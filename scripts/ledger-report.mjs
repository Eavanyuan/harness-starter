#!/usr/bin/env node
/**
 * deny ledger 的读取端 —— 误拦率的出口。
 *
 * 为什么必须有这个文件：ledger 此前只写不读。写了没人看，等于把"最密集的改进信号"
 * 丢进一个谁也打不开的抽屉；而"这条规则误拦多不多"永远只能靠印象争论。
 * 观测面缺了读取端，观测本身就成了空转配置（和 doctor 要抓的"空转配置键"同型）。
 *
 * 只做统计，不改任何东西：
 *   · 按 hook × 规则聚合（哪条规则在拦）；
 *   · 按 source 分开（selftest 是自测打靶，混进来会把真实基线冲成噪声）；
 *   · 按 target 聚合出 Top N（同一条规则反复拦同一类对象 = 大概率规则写宽了）；
 *   · 读 events.jsonl 回答"那段时间门禁到底在不在线"（判据各拦了几次之前先确认门开着）。
 *
 * 用法：
 *   node scripts/ledger-report.mjs [--days 30] [--top 10] [--json]
 *   HARNESS_LEDGER_DIR 可指向别的账本目录（自测/多仓库时用）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

let days = 30;
let top = 10;
let json = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') json = true;
  else if (a === '--days' || a === '--top') {
    const v = argv[i + 1];
    if (!v || v.startsWith('--') || !/^\d+$/.test(v)) {
      console.error(`[ledger] ${a} 需要一个正整数`);
      process.exit(64);
    }
    if (a === '--days') days = Number(v);
    else top = Number(v);
    i++;
  } else {
    console.error(`[ledger] 未知参数：${a}`);
    console.error('用法：node scripts/ledger-report.mjs [--days N] [--top N] [--json]');
    process.exit(64);
  }
}

const dir = process.env.HARNESS_LEDGER_DIR || join(ROOT, '.ai/ledger');
const file = join(dir, 'deny.jsonl');

if (!existsSync(file)) {
  console.log(`[ledger] 没有账本：${file}`);
  console.log('[ledger] 这说明还没发生过拦截，或者门禁根本没接上（后者先跑 npm run doctor）。');
  process.exit(0);
}

const since = Date.now() - days * 864e5;
const rows = [];
let bad = 0;
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const e = JSON.parse(line);
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t < since) continue;
    rows.push(e);
  } catch {
    bad += 1; // 半行/被截断：计数但不猜内容
  }
}

// events.jsonl 是**在线心跳**，不是拦截记录。
// 只有 deny 一个方向留痕时，"门禁在线但没拦人"和"门禁根本没接上"在数据上长得一模一样——
// 实测里 TDC 15:00–16:00 零拦截，是规则没触发还是 hook 没接，谁也说不出来。
const eventsFile = join(dir, 'events.jsonl');
const events = [];
if (existsSync(eventsFile)) {
  for (const line of readFileSync(eventsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const t = Date.parse(e.ts);
      if (Number.isFinite(t) && t < since) continue;
      events.push({ ...e, _t: Number.isFinite(t) ? t : null });
    } catch {
      /* 与 deny 同一套容错：坏行不猜内容 */
    }
  }
}
const bump0 = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const byEventType = new Map();
const onlineHours = new Set();
for (const e of events) {
  bump0(byEventType, e.type || '?');
  if (e._t !== null) onlineHours.add(new Date(e._t).toISOString().slice(0, 13));
}
const lastEvent = events.filter((e) => e._t !== null).sort((a, b) => b._t - a._t)[0] || null;

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

const bySource = new Map();
const byRule = new Map();
const byTarget = new Map();
for (const r of rows) {
  bump(bySource, r.source || 'tool');
  bump(byRule, `${r.hook || '?'}｜${r.rule || '?'}`);
  if (r.target) bump(byTarget, `${r.hook || '?'}｜${r.target}`);
}

const real = rows.filter((r) => (r.source || 'tool') !== 'selftest');

if (json) {
  const dump = (m) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, count: n }));
  console.log(
    JSON.stringify(
      {
        window_days: days,
        total: rows.length,
        real: real.length,
        selftest: rows.length - real.length,
        unparsable_lines: bad,
        by_source: dump(bySource),
        by_rule: dump(byRule),
        by_target: dump(byTarget),
        events: {
          total: events.length,
          by_type: dump(byEventType),
          online_hours: onlineHours.size,
          last: lastEvent ? lastEvent.ts : null,
        },
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log(`[ledger] 最近 ${days} 天：${rows.length} 条拦截（真实 ${real.length}，自测 ${rows.length - real.length}）`);
if (bad) console.log(`  ! ${bad} 行无法解析（被截断或并发写坏），未计入统计`);

if (!real.length) {
  console.log('  没有任何真实拦截记录。要么规则一次没触发（可能压根没接上），要么确实很干净。');
  process.exit(0);
}

if (events.length) {
  console.log(
    `\n  门禁在线记录（events）：${events.length} 条，覆盖 ${onlineHours.size} 个整点，最近一次 ${lastEvent ? lastEvent.ts : '—'}`
  );
  for (const [k, n] of [...byEventType.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }
  console.log('  → 有在线记录再谈拦截率：它证明"这段时间门禁是接上的"，拦截次数才有分母。');
} else {
  console.log('\n  没有 events 记录 —— 无法证明门禁在任意时段在线。');
  console.log('  只有 deny 留痕时，"没拦人"和"没接上"看起来一样。先跑 npm run doctor 看接线。');
}

console.log('\n  按规则（真实拦截）：');
const byRuleReal = new Map();
for (const r of real) bump(byRuleReal, `${r.hook || '?'}｜${r.rule || '?'}`);
for (const [k, n] of [...byRuleReal.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`    ${String(n).padStart(4)}  ${k}`);
}
const hot = [...byRuleReal.entries()].sort((a, b) => b[1] - a[1])[0];
if (hot && hot[1] >= 5) {
  console.log(`\n  ! ${hot[0]} 拦了 ${hot[1]} 次 —— 到 5 次以上就该回看被拦的原话，`);
  console.log('    确认是"真在防"还是"规则写宽了"。误拦不会自己消失，只会让人学会绕过门禁。');
}

console.log('\n  被拦对象 Top：');
for (const [k, n] of [...byTarget.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`    ${String(n).padStart(4)}  ${k}`);
}

console.log('\n  怎么看：同一 target 反复出现 = 规则或写法有系统性问题；');
console.log('  只出现在一两条上 = 大概率是个案，看一眼原话再决定改不改规则。');
