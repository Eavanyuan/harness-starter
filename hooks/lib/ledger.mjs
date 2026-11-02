/**
 * deny ledger —— 拦截面观测，纯追加、不参与任何判定。
 *
 * 存在的理由：guard_* 的每次拒绝此前只写 stderr 就丢了，而这是 harness
 * 最密集的改进信号（哪条规则在拦、拦了谁、拦得对不对）。没有这份基线，
 * "误拦率高不高"永远只能靠印象争论。等 Harness² 立项再补就是零基线起步。
 *
 * 边界（与 hook 主体的 fail-closed 严格区分）：
 *   - ledger 写入失败绝不影响 hook 判定——观测是 fail-open 的，
 *     观测挂了就把门禁也挂掉，等于用一个次要功能绑架主功能；
 *   - 只记录 hook 名 / 规则 / 拦截对象（target）/ 说明摘要，不记录文件内容；
 *   - v1 本地观测（.gitignore），是否随分支入库由 Harness² 多人信号层决策。
 *
 * 为什么必须有 target：只记"命中了哪条规则"得不出误拦率——同一条规则拦的是
 * 真实高危命令还是无害命令，差别全在被拦的那一条上。target 就是"拦了谁"。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './verify.mjs';

/** detail 只保留头部，避免整段命令/路径把 ledger 撑爆。 */
function head(s, n = 200) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function recordDeny(hook, rule, detail, opts = {}) {
  try {
    // 自测流量必须与真实拦截分开记，否则 ledger 作为"误拦率基线"的价值直接归零：
    // 装完跑一次 hook 自测就会往账本里灌几十条必然命中的探测，看账的人分不清
    // 哪些是门禁在拦真实工作、哪些是测试在打靶。默认 tool；测试侧显式标 selftest。
    // HARNESS_LEDGER=off 供"就是不想留痕"的批量场景（如 CI 里跑全量自测）。
    const source = process.env.HARNESS_LEDGER_SOURCE || 'tool';
    if (process.env.HARNESS_LEDGER === 'off') return;
    const dir = process.env.HARNESS_LEDGER_DIR || join(opts.root || REPO_ROOT, '.ai/ledger');
    mkdirSync(dir, { recursive: true });
    const entry = { ts: new Date().toISOString(), source, hook, rule, target: head(opts.target, 160), detail: head(detail) };
    appendFileSync(join(dir, 'deny.jsonl'), JSON.stringify(entry) + '\n');
  } catch (e) {
    // 红线：观测失败不改变判定结果，只留一条 stderr 提示。
    console.error(`[ledger] 记录失败（不影响本次判定）：${e.message}`);
  }
}

/**
 * #22（实测：编码时段 ledger 零条——只有 deny 才留痕，"门禁当时在不在线"无法自证）：
 * 记非拦截类事件（session 启动等）到同目录 events.jsonl。与 deny 分文件：
 * 误拦率统计只读 deny.jsonl，不会被心跳稀释。
 */
export function recordEvent(hook, type, detail = {}, opts = {}) {
  try {
    if (process.env.HARNESS_LEDGER === 'off') return;
    const dir = process.env.HARNESS_LEDGER_DIR || join(opts.root || REPO_ROOT, '.ai/ledger');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'events.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), source: process.env.HARNESS_LEDGER_SOURCE || 'tool', hook, type, detail }) + '\n'
    );
  } catch (e) {
    console.error(`[ledger] 事件记录失败（不影响会话）：${e.message}`);
  }
}
