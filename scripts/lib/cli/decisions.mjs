/**
 * resume 域的决策助手 —— 选项编号、三档分诊、决策单渲染/读回、adr 决策检查刷新。
 * 只被 resume.mjs 消费；判据与阶段链一律从 hooks/lib/verify.mjs 引（单源）。
 */
import { STAGE_NEXT } from '../../../hooks/lib/verify.mjs';
import { nowIso } from './shared.mjs';

/** 决策算不算"真回填"：三件缺一不可（选了什么、谁定的、什么时候）。 */
export function decisionComplete(b) {
  return b.resolved === true && typeof b.decision === 'string' && b.decision.trim() !== '' && typeof b.resolved_by === 'string' && b.resolved_by.trim() !== '';
}

/**
 * options 归一化成 {id,label}，id 从 1 起、与打印顺序一致。
 *
 * 起因（TDC 第一个任务）：屏幕上印的是 `选项：磁盘/存储 · CPU · 内存 · …`，
 * 要输入的却是 `--decide "D1=磁盘/存储+CPU+内存"` —— 人得先在脑子里把 `·` 拆开、
 * 再用 `+` 拼成另一个串。显示格式和输入格式不同构，每一步都在制造出错机会。
 * 现在两边共用同一份编号：看到的 1/2/3 就是填回去的 1/2/3。
 */
export function optionList(b) {
  const raw = Array.isArray(b.options) ? b.options : [];
  return raw.map((o, i) =>
    typeof o === 'string' ? { id: String(i + 1), label: o } : { id: String(o.id ?? i + 1), label: String(o.label ?? '') }
  );
}

/**
 * 分档：要人现在定 / 可以先干再定 / 按建议默认即可。
 * **只认显式字段，不猜**——从 recommendation 文本里推断"这条能不能缓"是语义判断，
 * 猜错了就是拿机器的臆测替代人的授权。没标就一律进"必须定"（宁可多问一句）。
 */
export function triage(b) {
  if (b.defer_until || b.blocking === false) return 'defer';
  if (b.default_ok === true) return 'default';
  return 'block';
}

export const TRIAGE_LABEL = {
  block: '一、必须现在决定',
  defer: '二、可以先干再定',
  default: '三、按建议默认即可（不同意才改）',
};

/**
 * 把人的写法解析成选项 id。
 * 接受：编号（`1,2` / `1 2` / `1、2`）、完整选项文本（整体匹配优先）。
 * 拒绝：既不是编号也不匹配任何选项的自由文本 —— 那会让选项表形同虚设（失效点 §16 枚举不闭合）。
 */
export function parseDecision(b, raw) {
  const opts = optionList(b);
  const input = String(raw == null ? '' : raw).trim();
  if (!opts.length) return { ids: [], text: input, error: null };
  const byId = new Map(opts.map((o) => [o.id, o]));

  // 整体匹配优先：有些选项本身含 `+` / `/` / 空格（如「客户级默认 + 实例级覆盖」），
  // 先按分隔符切会把它碎掉。
  const whole = opts.find((o) => o.label === input);
  if (whole) return { ids: [whole.id], text: whole.label, error: null };

  const tokens = input.split(/[,，、\s+]+/).filter(Boolean);
  const ids = [];
  const unknown = [];
  for (const t of tokens) {
    if (byId.has(t)) ids.push(t);
    else {
      const hit = opts.find((o) => o.label === t);
      if (hit) ids.push(hit.id);
      else unknown.push(t);
    }
  }
  if (unknown.length) {
    return {
      error: `「${unknown.join('、')}」不是合法选项。合法写法：${opts.map((o) => `${o.id}. ${o.label}`).join(' ／ ')}`,
    };
  }
  if (ids.length === 0) return { error: '没有解析出任何选项' };
  const uniq = [...new Set(ids)];
  if (!b.multi && uniq.length > 1) {
    return { error: `这是单选（multi 未置 true），只能填一个；收到 ${uniq.length} 个：${uniq.join('、')}` };
  }
  return { ids: uniq, text: uniq.map((i) => byId.get(i).label).join(' + '), error: null };
}

/** application 记录：把解析结果写进 blocker。decision 存可读文本（旧字段兼容），
 *  decision_ids 存机器可判的编号（新判据只认这个）。 */
export function applyDecision(b, ids, text, by) {
  b.resolved = true;
  b.resolved_at = nowIso();
  b.resolved_by = by;
  b.decision = text;
  b.decision_ids = ids;
}

/**
 * 渲染决策单。停点的信息本来就齐（问题/选项/建议/证据四要素都在 state.json 里），
 * 但 JSON 没人读、stdout 关掉就没。落成一份 markdown 才能留存、转发、隔天再定。
 */
export function renderDecisionsMd(slug, state, target) {
  const deciders = (state.blockers || []).filter((b) => b.type === 'human_decision');
  const open = deciders.filter((b) => !decisionComplete(b));
  const groups = { block: [], defer: [], default: [] };
  for (const b of open) groups[triage(b)].push(b);

  const L = [];
  L.push(`# 待决事项 · ${slug}`);
  L.push('');
  L.push('<!-- harness:decisions v1 本文件由 `harness-cli resume` 生成，可自由编辑；填好的部分会被读回 state.json -->');
  L.push('');
  L.push(`生成于 ${nowIso()}｜阶段 \`${state.stage}\`${STAGE_NEXT[state.stage] ? `（下一阶段 \`${STAGE_NEXT[state.stage]}\`）` : ''}｜待决 ${open.length} 项`);
  L.push('');
  L.push('**怎么填**：在每条的 `回填：` 后面写选项编号，多选用逗号分隔（例：`1,3`）；单选写一个编号。');
  L.push('可以直接在编辑器里改、也可以发给同事一起看。填完运行：');
  L.push('');
  L.push('```');
  L.push(`node scripts/harness-cli.mjs resume . ${slug} --from DECISIONS.md --by <你的名字>`);
  L.push('```');
  L.push('');
  L.push('只想全按建议来：`--accept-suggested --by <你的名字>`（只作用于第三节，第一、二节仍逐条填）。');
  L.push('');

  if (!open.length) {
    L.push('_当前没有待决事项。_');
    L.push('');
    return L.join('\n');
  }

  for (const key of ['block', 'defer', 'default']) {
    const list = groups[key];
    if (!list.length) continue;
    L.push('---');
    L.push('');
    L.push(`## ${TRIAGE_LABEL[key]}（${list.length} 项）`);
    L.push('');
    const hint = {
      block: '这几条不填，下一阶段进不去。每条都给了建议和依凭，多数情况照建议填编号即可。',
      defer: '有前置条件，先把前置做完再回来定；现在不挡路。',
      default: '建议本身就是安全默认，同意就 `--accept-suggested` 一次批掉。',
    }[key];
    L.push(`> ${hint}`);
    L.push('');
    for (const b of list) {
      L.push(`### ${b.id} ${b.question || '(未写问题)'}`);
      L.push('');
      const opts = optionList(b);
      if (opts.length) {
        L.push(`- 选项${b.multi ? '（多选）' : '（单选）'}`);
        for (const o of opts) L.push(`  - [ ] \`${o.id}\` ${o.label}`);
      }
      if (b.recommendation) L.push(`- 建议：${b.recommendation}`);
      if (b.defer_until) L.push(`- 前置：${b.defer_until} 完成后再定`);
      const ev = (b.evidence || []).slice(0, 4);
      if (ev.length) {
        L.push('- 依凭');
        for (const e of ev) L.push(`  - ${e}`);
      }
      L.push(`- 回填：${'_'.repeat(16)}`);
      L.push('');
    }
  }

  const others = (state.blockers || []).filter((b) => b.type !== 'human_decision' && !b.resolved);
  if (others.length) {
    L.push('---');
    L.push('');
    L.push(`## 附：非决策类阻断（${others.length} 项，本文件填不了）`);
    L.push('');
    L.push('> 这类要补能力或换会话，不是"选一个"能解决的。');
    L.push('');
    for (const b of others) {
      L.push(`### ${b.id} ${b.question || ''}`);
      L.push('');
      if (b.remediation) {
        L.push(`- 补什么：${b.remediation.missing || '—'}｜谁：${b.remediation.who || '—'}｜重跑：${b.remediation.rerun || '—'}`);
      }
      L.push('');
    }
  }
  return L.join('\n');
}

/** 读回决策单。只认两处：`回填：<内容>` 与 `- [x] \`<编号>\`` —— 结构越小越不会解析错。 */
export function parseDecisionsMd(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^#{2,4}\s+([A-Za-z]+-?\d+)\b\s*(.*)$/);
    if (h) {
      cur = { id: h[1], checks: [], fill: null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const t = line.match(/^[\s>*-]*回填[：:]\s*(.*)$/);
    if (t) {
      const v = t[1].replace(/[_＿*]/g, '').trim();
      if (v) cur.fill = v;
      continue;
    }
    const c = line.match(/^\s*-\s*\[[xX]\]\s*`?([^`\s]+)`?/);
    if (c) cur.checks.push(c[1]);
  }
  return out.filter((x) => x.fill || x.checks.length);
}

/** adr 阶段唯一可机器判的检查：决策记录齐备。其余检查保持原样（判不了的不假装判）。 */
export function recheckAdrHumanDecisions(state) {
  const checks = ((state.gate_result && state.gate_result.checks) || []).slice();
  const idx = checks.findIndex((c) => c && c.name === 'adr_human_decision_records');
  if (idx < 0) return null;
  const pending = (state.blockers || []).filter((b) => b.type === 'human_decision' && !decisionComplete(b));
  checks[idx] = pending.length
    ? { name: 'adr_human_decision_records', pass: false, detail: `${pending.map((b) => b.id).join('/')} 仍无人工决策记录（decision + resolved_by 都要有）` }
    : { name: 'adr_human_decision_records', pass: true, detail: '决策记录齐备' };
  state.gate_result = { ...(state.gate_result || {}), last_check: nowIso(), stage: state.stage, checks };
  return checks[idx].pass;
}
