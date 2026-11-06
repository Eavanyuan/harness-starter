/**
 * 决策从 git 里来 —— 让"批红"走一条不需要入站口的边。
 *
 * 背景：内网里最贵的是「飞书 → broker」那条边（要么长连接，要么公网反代 + 证书 + 验签）。
 * 而「GitLab → broker」全在内网，是唯一天然可达的边。把决策动作放到 GitLab 上做，
 * 入站问题整体消失：飞书只负责"找人"，人打开 RS 文档把开放问题那行的状态改成
 * 「已裁决：A」并提交，broker 从 push 事件的 diff 里读出来落账。
 *
 * 顺带修掉一个更深的问题：飞书回投的 operator.open_id 是**请求体声明**的，谁拿到
 * FEISHU_VERIFY_TOKEN 都能声称自己是任何人；而 git commit 的 author 是 Git 服务器记的，
 * 客户端伪造不了。这条路径的身份可信度反而更高。
 *
 * 边界：broker 在这里**不写仓库**——commit 本身就是账。所以重复推送的后果只是日志里
 * 多一条记录，不会造成账实不符；这里的幂等是"少记一条噪音"，不是"防重复写"。
 */

/** markdown 表格分隔行（|---|---|），不是数据行。 */
const SEPARATOR = /^[:\-\s]+$/;

/**
 * 拆一行 markdown 表格。不是表格行返回 null。
 * 首尾的 `|` 必须先剥掉再 split，否则会多出两个空单元格，把「状态列」算错位置。
 */
export function splitTableRow(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s.startsWith('|')) return null;
  const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  return cells.length >= 2 ? cells : null;
}

/**
 * 从单元格里读出裁决。状态列必须是最后一列，且以「已裁决」开头。
 * 结论取「（」之前那一段——括号里是批红人和时间戳，属于附注不是选项。
 * 返回 null 表示这行不是一次裁决（还是"开放"，或者被人改成别的说明文字）。
 */
export function readDecision(cells) {
  const status = cells[cells.length - 1];
  const m = /^已裁决\s*[：:]\s*(.+)$/.exec(status);
  if (!m) return null;
  const choice = m[1].split(/[（(]/)[0].trim();
  if (!choice) return null;
  return { blocker_id: cells[0], choice };
}

/**
 * 从一份文件 diff 里抽出"这次新增的裁决行"。
 *
 * 只看 `+` 行：`-` 行是被改掉的旧值，认它等于把已经作废的结论又落一次账。
 * 同一个 OP 在同一个 diff 里出现多次（比如文件被整体重排）时，以最后一次为准。
 *
 * 只认 `+++` 之外的 `+` 行：`+++ b/path` 是 diff 头，不是内容。
 */
export function parseDecisionRowsFromDiff(diff) {
  const found = new Map();
  for (const line of String(diff == null ? '' : diff).split('\n')) {
    if (line[0] !== '+' || line.startsWith('+++')) continue;
    const cells = splitTableRow(line.slice(1));
    if (!cells) continue;
    if (SEPARATOR.test(cells[0])) continue; // 分隔行/空 id
    const d = readDecision(cells);
    if (d) found.set(d.blocker_id, d); // 后者覆盖前者
  }
  return [...found.values()];
}

/** 从整篇文档里读（push 拿不到 diff 时的兜底，也可用于校验"账实是否一致"）。 */
export function parseDecisionRowsFromText(text) {
  const found = new Map();
  for (const line of String(text == null ? '' : text).split('\n')) {
    const cells = splitTableRow(line);
    if (!cells || SEPARATOR.test(cells[0])) continue;
    const d = readDecision(cells);
    if (d) found.set(d.blocker_id, d);
  }
  return [...found.values()];
}

/**
 * 幂等键集合：`<sha>:<blocker_id>`。
 * 不用无限增长的 Set——broker 是常驻进程，跑几个月能攒出几十万个 key。
 */
export function createSeenKeys({ limit = 2000 } = {}) {
  const set = new Set();
  const order = [];
  return {
    has: (k) => set.has(k),
    add(k) {
      if (set.has(k)) return;
      set.add(k);
      order.push(k);
      if (order.length > limit) set.delete(order.shift());
    },
  };
}
