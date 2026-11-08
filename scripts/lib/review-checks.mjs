/**
 * L0 机器判据 —— 脚本能判的绝不用 AI（省 100% token，且结论确定）。
 *
 * 注册表模式：harness.rules.json 的 machine_checks[].id 必须命中这里的键，
 * 未知 id 抛错（checklist §15：枚举外的值显式报错，不静默跳过——静默跳过等于判据不存在）。
 *
 * 边界：这里只判「存在性/格式」，不判「好不好」。命中即候选，不是判决；
 * yellow 项进报告供人参考，red 项阻断（ai-review 退出码 1）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export class CheckError extends Error {}

const SEV = new Set(['red', 'yellow']);
const finding = (severity, rule, file, message) => ({ severity, rule, file, message });

function readText(root, file) {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return null; // 文件读不到（新增即删/改名）由调用方把文件名带给 AI 层；机器层不猜
  }
}

/** 必填章节（RS/FS 共用同一逻辑）：模板小节标题形如 `## 1 概述`，按章节名子串命中标题行。 */
function requiredSections(check, root, files) {
  const out = [];
  const sections = check.sections || [];
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const text = readText(root, file);
    if (text == null) continue;
    const headings = text.split('\n').filter((l) => /^##\s/.test(l));
    for (const s of sections) {
      if (!headings.some((h) => h.includes(s))) {
        out.push(finding(check.severity, check.id, file, `缺必填章节「${s}」（对照 templates/RS-需求规格.md）`));
      }
    }
  }
  return out;
}

/** 每个 US 块必须有「验收标准」且至少一条 Given/When/Then 行。 */
function rsAcceptanceTestable(check, root, files) {
  const out = [];
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const text = readText(root, file);
    if (text == null) continue;
    const lines = text.split('\n');
    const usHeads = [];
    lines.forEach((l, i) => { if (/^###\s+US-\d/.test(l)) usHeads.push(i); });
    for (let u = 0; u < usHeads.length; u++) {
      const from = usHeads[u];
      const to = u + 1 < usHeads.length ? usHeads[u + 1] : lines.length;
      const block = lines.slice(from, to).join('\n');
      const hasAc = /\*\*验收标准\*\*/.test(block);
      const hasGwt = /-?\s*Given.+When.+Then/.test(block);
      if (!hasAc || !hasGwt) {
        out.push(finding(check.severity, check.id, file, `${lines[from].replace(/^###\s+/, '')}：验收标准缺失或无 Given/When/Then 可测条目`));
      }
    }
  }
  return out;
}

/** ADR 引用存在性：正文里的 commit hash 与反引号路径必须真实存在。 */
function adrRefsExist(check, root, files) {
  const out = [];
  for (const file of files.filter((f) => f.endsWith('.md'))) {
    const text = readText(root, file);
    if (text == null) continue;
    // 含 a-f 的 7-40 位十六进制才算 hash（纯数字多是日期/编号）；git cat-file 验证
    const hashes = [...new Set((text.match(/\b[0-9a-f]{7,40}\b/g) || []).filter((h) => /[a-f]/.test(h)))];
    for (const h of hashes) {
      let ok = false;
      try { execFileSync('git', ['-C', root, 'cat-file', '-e', `${h}^{commit}`], { stdio: 'ignore' }); ok = true; } catch { ok = false; }
      if (!ok) out.push(finding(check.severity, check.id, file, `引用的 commit 在仓库历史中不存在：${h}`));
    }
    const paths = [...new Set((text.match(/`([^`\n]+)`/g) || []).map((s) => s.slice(1, -1)).filter((p) => p.includes('/') && !p.includes(' ')))];
    for (const p of paths) {
      if (!existsSync(join(root, p))) out.push(finding(check.severity, check.id, file, `引用的路径不存在：${p}`));
    }
  }
  return out;
}

const REGISTRY = {
  rs_required_sections: requiredSections,
  fs_required_sections: requiredSections,
  rs_acceptance_testable: rsAcceptanceTestable,
  adr_refs_exist: adrRefsExist,
};

/** 跑一组机器判据。check.severity 非法或 id 未注册 → 抛 CheckError（fail-closed）。 */
export function runMachineChecks(checks, root, files) {
  const out = [];
  for (const check of checks || []) {
    if (!check || typeof check.id !== 'string') throw new CheckError(`machine_check 缺 id：${JSON.stringify(check)}`);
    const fn = REGISTRY[check.id];
    if (!fn) throw new CheckError(`未知机器判据 id：${check.id}（可用：${Object.keys(REGISTRY).join(', ')}）`);
    if (!SEV.has(check.severity)) throw new CheckError(`machine_checks[${check.id}].severity 只能是 red|yellow，收到 ${check.severity}`);
    out.push(...fn(check, root, files));
  }
  return out;
}
