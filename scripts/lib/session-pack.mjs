/**
 * 会话打包器（T5）—— headless 会话的 prompt 组装与产物验收。
 *
 * 设计依据：每轮新会话 + 制品交接（ADR/评审定案）。会话不靠记忆，靠两样东西：
 *   1. 入口：打包器给它的 curated prompt（评论/bug 详情 + 受限上下文 + 尝试日志）；
 *   2. 出口：会话把结论写成**文件**（todo/acks/resolves/round-N 日志），runner 读文件
 *      代办 API 动作（发评论、resolve、push）——会话永不直接持有凭据与网络。
 *
 * 上下文纪律（同 ai-review 的预打包）：只带相关文件与评论原文，不带整仓库；
 * round-N 日志是续轮会话的唯一记忆通道（换法重试裁决的依据）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROTOCOL_COMMON = `
## 工作协议（严格遵守）
1. 你在一个独立的 worktree 里工作，只改本目录相关文件；不要动 .ai/task-loop/ 之外的流程文件。
2. 结束前**必须**在会话产物目录写出以下文件（缺失任何一件 = 本轮无效）：
   - todo.json：[{ "id": "<评论/缺陷编号>", "issue": "<一句话>", "action": "<做了什么>" }]
   - acks.json：[{ "discussion_id": "...", "note_id": "...", "body": "已确认：<理解>；修复方案：<方案>" }]（无则空数组）
   - resolves.json：[{ "discussion_id": "..." }]（本页确认已修复、可 resolve 的讨论）
   - round-<N>.md：本轮日志——做了什么、为什么这么改、验证结果、**如果还有下轮建议试什么**（这是下一轮会话唯一的记忆）
3. 只输出协议要求的结论到文件；不要在 stdout 写长篇解释。
`;

/** 剖面 A 的 R1（确认+首轮修复合一）。comments: GitLab discussions 展开后的待处理评论。 */
export function buildR1ProfileA({ mr, comments, changedFiles = [], headless }) {
  const cmts = comments.map((c) => `- [${c.discussion_id}/${c.note_id}] @${c.author}：${c.body}`).join('\n');
  return {
    prompt: `你是 MR 打回修复执行者。MR !${mr.iid}「${mr.title}」被评审打回，共 ${comments.length} 条未解决意见。

## 打回意见（原文）
${cmts}

## 本次变更涉及的文件（上下文锚，按需读取）
${changedFiles.map((f) => `- ${f}`).join('\n') || '-（无）'}

${PROTOCOL_COMMON}
4. 修复完成后运行项目验证命令（见 worktree 内 AGENTS.md 的 verify 约定），证据留日志；
5. acks 逐条对应打回意见；resolve 只勾你确已修复的。`,
    artifacts: ['todo.json', 'acks.json', 'resolves.json', 'round-1.md'],
  };
}

/** 剖面 A 的续轮（R2/R3）：失败指纹 + 前轮日志随包——同根因连续两轮即必须换法。 */
export function buildRnProfileA({ mr, comments, round, prevJournals, failureFingerprints = [] }) {
  const journals = prevJournals.map((j, i) => `### 第 ${i + 1} 轮日志\n${j}`).join('\n\n');
  const fps = failureFingerprints.map((f) => `- ${f}`).join('\n');
  return {
    prompt: `你是 MR !${mr.iid} 修复的第 ${round} 轮（上限 3 轮）。CI 归因判定为"引入失败"，回修复循环。

## 本轮失败指纹（基线集合差得出的引入项）
${fps || '-（无）'}

## 历轮日志（你唯一的记忆——同根因连续两轮未解，本轮必须换方法，不许更用力重复）
${journals || '-（无）'}

${PROTOCOL_COMMON.replace('<N>', String(round))}`,
    artifacts: ['todo.json', 'round-' + round + '.md'],
  };
}

/** 剖面 B 的 R1（复现+首轮修复合一）。bug：MQL 取回的缺陷单字段。 */
export function buildR1ProfileB({ bug, repo, baseRef = 'main' }) {
  return {
    prompt: `你是 bug 热修执行者。飞书缺陷单 ${bug.work_item_id}「${bug.name}」（严重级 ${bug.severity || '?'}）已认领。

## 缺陷详情
${bug.description || bug.desc || '（MQL 未取到描述，见 worktree 外的单据链接）'}
${bug.extra || ''}

## 目标仓库与基线
- 仓库：${repo}（worktree 已从 ${baseRef} 切好）
- 追溯：任务已按 --type bugfix --related feishu:${bug.work_item_id} 建档（remote_id 双向锚）

${PROTOCOL_COMMON.replace('<N>', '1')}
4. **复现闸先行**：先写一个红测试复现问题并跑到红（这是修复的前提，也是回归测试的底子）；
   尝试多种合理复现路径后仍复现不了 → todo.json 写明尝试过的路径，ack 阶段直接停（不要硬修）；
5. 复现成功 → 同会话继续修复到红测试转绿，再跑项目验证命令留证据。`,
    artifacts: ['todo.json', 'round-1.md'],
  };
}

/**
 * 产物验收（fail-closed）：会话退出后 runner 调它。缺件/坏 JSON → 无效会话，
 * 由上层计为一次失败轮次（消耗预算），不静默当作"没问题"。
 */
export function readSessionArtifacts(dir, { expected }) {
  const missing = [];
  const out = {};
  for (const name of expected) {
    const p = join(dir, name);
    if (!existsSync(p)) { missing.push(name); continue; }
    if (name.endsWith('.json')) {
      try { out[name] = JSON.parse(readFileSync(p, 'utf8')); } catch { missing.push(`${name}(非法JSON)`); }
    } else {
      out[name] = readFileSync(p, 'utf8');
    }
  }
  if (missing.length) {
    return { ok: false, missing, reason: `会话产物缺失或损坏：${missing.join('、')}——本轮无效（fail-closed，不计成功）` };
  }
  // acks/resolves 结构校验：runner 要拿它们调 API，形状不对会在 API 层炸
  for (const key of ['acks.json', 'resolves.json', 'todo.json']) {
    if (out[key] !== undefined && !Array.isArray(out[key])) {
      return { ok: false, missing: [key], reason: `${key} 不是数组——协议违约` };
    }
  }
  return { ok: true, artifacts: out };
}
