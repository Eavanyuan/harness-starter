/**
 * runtime —— 把宿主会话的能力自检结论写回 harness.config.json（P3-⑤）。
 *
 * 为什么需要它：config 的 runtime 三项（spawn_agents / shell / ask_user）声明的是
 * "这个宿主会话能不能派子 agent / 跑命令 / 问人"。声明 unknown 时 orchestrator 每次
 * 会话都要重新试错自检（TDC 的教训：按 spawn 流程起手，到 impl 才发现没有 spawn）。
 * 自检一次、写回一次，下一次会话直接读事实。
 *
 * 语义约定（与 orchestrator 的直做/派发分流一致）：
 *   yes  = 本宿主确认可用（走 spawn / shell / ask_user 流程）
 *   no   = 确认不可用（orchestrator 按 direct 模式推进，并在 deviations 记明）
 *   unknown = 没验证过（不许用这条覆盖一个已知结论——只能从未知走向已知，
 *             或者显式 --reset 回到未知；防误写倒退）
 *
 * 写回走 harness-cli 而不是让 agent 手改 config：值域校验 + 键白名单只有一处。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { die, writeAtomic } from './shared.mjs';

const KEYS = { spawn_agents: 'agent.spawn', shell: 'shell.exec', ask_user: 'ask_user' };
const VALUES = new Set(['yes', 'no', 'unknown']);

export function cmdRuntime(target, pairs, opts = {}) {
  const entries = Object.entries(pairs || {}).filter(([k, v]) => KEYS[k] && String(v).trim() !== '');
  if (!entries.length) die('用法: harness runtime <项目> --spawn_agents yes|no --shell yes|no --ask_user yes|no [--reset] [--by <名字>]', 64);

  const cfgPath = join(target, 'harness.config.json');
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    die(`harness.config.json 无法读取/解析：${e.message}`, 1);
  }
  cfg.runtime = cfg.runtime && typeof cfg.runtime === 'object' ? cfg.runtime : {};

  const changed = [];
  for (const [k, v] of entries) {
    if (!VALUES.has(v)) die(`${k} 的值只能是 yes / no / unknown（未知事实请先自检，不要猜）`, 64);
    const prev = cfg.runtime[k];
    // unknown 只能被"更有信息量的值"覆盖，不能反向抹掉已知结论；确要重置走 --reset 显式声明。
    if (!opts.reset && v === 'unknown' && (prev === 'yes' || prev === 'no')) {
      die(`${k} 已是 ${String(prev)}，不许静默退回 unknown（要重置加 --reset，并说明为什么）`, 64);
    }
    cfg.runtime[k] = v;
    changed.push(`${k}: ${String(prev)} → ${v}`);
  }
  if (opts.reset) cfg.runtime.note = `--reset 于 ${new Date().toISOString().slice(0, 10)} 由 ${opts.by || '（未记名）'} 执行`;
  else delete cfg.runtime.note;

  writeAtomic(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`runtime 已写回 ${target}/harness.config.json：`);
  for (const c of changed) console.log(`  · ${c}`);
  console.log('下次会话的 SessionStart 会读到这个值，orchestrator 不再重新试错。');
  return 0;
}
