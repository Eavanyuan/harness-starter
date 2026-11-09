/**
 * 订阅三档投递（T2）—— 事件 × 人 → card / digest / ledger。
 *
 * 三条铁律（RS US-3 / US-4）：
 *   1. 订阅只能"延迟"消息，不能"吞"消息：降档必带 escalateAfter，aging 巡检按事件自身 SLO 升回 card；
 *   2. "必须我批"类事件（mustAct）对当事人下限是 digest——过滤太狠 = 人不在环 = 循环在门口断；
 *   3. mode:all / focused / minimal 三档个人总开关；无订阅配置 = all（向后兼容：现状全推卡）。
 *
 * 纯函数模块：broker 与 task-loop 共读；持久化（aging 队列）单独在 createNotifyQueue。
 */
export const TIERS = ['card', 'digest', 'ledger'];
const DEFAULT_ESCALATE_H = 4; // 通用缺省：4h 后 aging 升回 card
const MUSTACT_ESCALATE_H = 2; // 打回修复完成类：循环在等人，等不起 4h

/** 规范化一个人的订阅：mode 缺省 focused；rules 数组逐条校验，坏条目显式抛（不静默跳）。 */
export function personSub(rules, key = 'default') {
  const subs = rules?.notify?.subscriptions;
  if (!subs || !subs.persons || !subs.persons[key]) {
    return { mode: 'all', rules: [] }; // 未配置 = 全量接（现状行为）
  }
  const p = subs.persons[key];
  const mode = p.mode || 'focused';
  if (!['all', 'focused', 'minimal'].includes(mode)) {
    throw new Error(`subscriptions.persons.${key}.mode 非法：${mode}（all|focused|minimal）`);
  }
  for (const [i, r] of (p.rules || []).entries()) {
    if (!r || typeof r.when !== 'object' || !r.when.type) {
      throw new Error(`subscriptions.persons.${key}.rules[${i}] 缺 when.type`);
    }
    if (!TIERS.includes(r.delivery)) {
      throw new Error(`subscriptions.persons.${key}.rules[${i}].delivery 非法：${r.delivery}（card|digest|ledger）`);
    }
  }
  return { mode, rules: p.rules || [], defaultDelivery: (rules?.notify?.subscriptions?.defaults?.delivery) || 'digest' };
}

function matchWhen(when, evt) {
  if (when.type !== evt.type) return false;
  if (when.severity && !when.severity.includes(evt.severity)) return false;
  if (when.mr && !when.mr.includes(evt.mr)) return false;
  if (when.authors && !when.authors.includes(evt.author)) return false;
  if (when.project && !when.project.includes(evt.project)) return false;
  if (typeof when.within_days === 'number' && !(typeof evt.dueInDays === 'number' && evt.dueInDays <= when.within_days)) return false;
  return true;
}

/**
 * 事件分类。evt: { type, mustAct?, severity?, mr?, author?, project?, dueInDays?, sloHours? }
 * 返回 { tier, escalateAfterMs, matched, reason }——reason 人话，进账本（subscription_matched）。
 */
export function classify(evt, sub) {
  const matched = sub.rules.find((r) => matchWhen(r.when, evt));
  let tier;
  let escalateH;
  let reason;
  if (sub.mode === 'all') {
    tier = 'card';
    reason = 'mode=all 全量接';
  } else if (matched) {
    tier = matched.delivery;
    escalateH = matched.escalate_hours;
    reason = `规则命中 ${matched.when.type}`;
  } else if (sub.mode === 'minimal') {
    tier = 'ledger';
    reason = 'mode=minimal 未命中规则';
  } else {
    tier = sub.defaultDelivery || 'digest';
    reason = 'focused 未命中规则，走默认档';
  }
  // 铁律 2：必须我批的事件下限 digest——个人偏好不能把循环的门关死
  if (evt.mustAct && tier === 'ledger') {
    tier = 'digest';
    reason += '；mustAct 下限提升为 digest';
  }
  // 铁律 1：digest 必带升级时间（延迟不吞）；ledger 是明确弃权，不参与 aging——
  // 若 ledger 也升回 card，"弃权"就退化成"延迟"，三档失去意义
  let escalateAfterMs = 0;
  if (tier === 'digest') {
    const h = evt.sloHours ?? escalateH ?? (evt.mustAct ? MUSTACT_ESCALATE_H : DEFAULT_ESCALATE_H);
    escalateAfterMs = Math.round(h * 3600_000);
  }
  return { tier, escalateAfterMs, matched: !!matched, reason };
}

/**
 * 通知队列（aging 巡检的持久层）：落 JSON 文件（部署侧 ledger 目录，gitignore 域）。
 * 语义：add 入队未投递项；due() 取"到升级时间仍未投递"的项（该升 card 了）；
 * flushDigest() 取未投递项给整点摘要；markSent 落投递方式后即出队（文件不留尸）。
 */
export function createNotifyQueue({ file, writeFileSyncImpl, readFileSyncImpl, existsSyncImpl, now = Date.now }) {
  const read = () => {
    try {
      return JSON.parse(readFileSyncImpl(file, 'utf8'));
    } catch {
      return [];
    }
  };
  const write = (list) => writeFileSyncImpl(file, JSON.stringify(list, null, 1));
  return {
    add(evt, { tier, escalateAfterMs }) {
      const list = read();
      list.push({ id: `${evt.type}:${evt.mr || evt.project || ''}:${now()}`, evt, tier, addedAt: now(), escalateAt: now() + escalateAfterMs, sentAt: null });
      write(list);
    },
    due() {
      const t = now();
      return read().filter((x) => !x.sentAt && x.escalateAt <= t);
    },
    pending() {
      return read().filter((x) => !x.sentAt);
    },
    markSent(id, via) {
      write(read().map((x) => (x.id === id ? { ...x, sentAt: now(), via } : x)));
    },
    size() {
      return this.pending().length;
    },
  };
}

/** digest 摘要卡（整点摘要的渲染）：N 条未投递事件一屏列出，不逐条展开防轰炸。 */
export function renderDigestCard(entries) {
  const byType = {};
  for (const e of entries) (byType[e.evt.type] ||= []).push(e);
  const lines = Object.entries(byType).map(([t, list]) => {
    const who = list.map((x) => x.evt.mr ? `!${x.evt.mr}` : x.evt.project || '').filter(Boolean).slice(0, 3).join('、');
    return `- **${t}** ×${list.length}${who ? `（${who}${list.length > 3 ? ' 等' : ''}）` : ''}`;
  });
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: `📮 摘要：${entries.length} 条未升级通知` } },
      elements: [
        { tag: 'markdown', content: `${lines.join('\n')}\n\n<font color="grey">摘要 = 已按你的订阅降档；到升级时间仍未处理的会单独再推。回复"我的通知设置"可调档位。</font>` },
      ],
    },
  };
}
