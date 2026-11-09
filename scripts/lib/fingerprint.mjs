/**
 * 失败指纹（T4a）—— 把"同一次失败在不同运行里看起来不同"的部分剥掉，剩下的才是身份。
 *
 * 输入形态（评审 B 的三件坏事逐一对症）：
 *   1. `✗ <用例名>  (期望 X，实际 Y)` —— 共享 check() 的输出。期望/实际是**参数**不是身份：
 *      同一断言失败两次，参数值可以不同（计数、路径、时间戳），必须剥；
 *      且本仓库存在两种参数顺序的 check 变体（期望/实际 谁先谁后都有），剥"尾部含期望或实际的括号段"一网打尽。
 *   2. `✗ <硬编码文案>`（hooks/writing/writes 里无例名的行）—— 文案即身份，直接用（截断保稳定）。
 *   3. ANSI 颜色码 —— \033[31m✗\033[0m 是三段，先剥色再匹配，否则同一行两次解析结果不同。
 *
 * 套件归属：指纹 = `<suite>::<归一化正文>`。基线比对按套件隔离——失败挪了套件算两个身份，
 * 宁可误报引入（人会看到豁免流程）也不漏报（漏了就把存量红放行进主干）。
 */
const ANSI = /\x1b\[[0-9;]*m/g;
const TRAILING_PARAMS = /\s*[（(][^()（）]*(?:期望|实际|expected|actual)[^()（）]*[)）]\s*$/i;
const MAX_FP = 100;

export function normalizeLine(line) {
  return String(line).replace(ANSI, '').replace(/\s+/g, ' ').trim();
}

/** 单行 → 指纹。非 ✗ 行返回 null（成功行/计数行/日志正文都不是失败身份）。 */
export function failureFingerprint(rawLine) {
  const s = normalizeLine(rawLine);
  if (!s.startsWith('✗') && !s.startsWith('x ')) return null;
  let body = (s.startsWith('✗') ? s.slice(1) : s.slice(2)).trim();
  // 剥尾部参数括号（可能两层：外层期望实际 + 内层数组值）——只剥含参数关键词的，普通括号注释保留
  let prev = null;
  while (prev !== body) {
    prev = body;
    body = body.replace(TRAILING_PARAMS, '');
  }
  body = body.trim();
  if (!body) body = '(无例名的失败行)';
  return body.length > MAX_FP ? `${body.slice(0, MAX_FP)}…` : body;
}

/**
 * 全量输出 → 失败指纹列表（去重保序）。同指纹多次出现计一次——
 * 重试把同一断言打了三遍 ✗，身份只有一个（重复次数不是归因依据）。
 */
export function extractFailures(text, { suite = '?' } = {}) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    const fp = failureFingerprint(line);
    if (fp == null) continue;
    const id = `${suite}::${fp}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, suite, fingerprint: fp });
  }
  return out;
}

/**
 * 集合差（归因的核心一步）：MR 失败 − 基线失败。
 *   introduced：MR 有、基线没有 → 真引入（T4b 进修复循环）
 *   inherited ：两边都有 → 基线同款（T4b 的豁免候选，须指纹相同才可豁免）
 *   resolved  ：基线有、MR 没有 → 顺手修好的存量红（信息项，不参与判定）
 */
export function setDiff(mrFailures, baselineFailures) {
  const base = new Set(baselineFailures.map((f) => f.id));
  const mr = new Set(mrFailures.map((f) => f.id));
  return {
    introduced: mrFailures.filter((f) => !base.has(f.id)),
    inherited: mrFailures.filter((f) => base.has(f.id)),
    resolved: baselineFailures.filter((f) => !mr.has(f.id)),
  };
}
