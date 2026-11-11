/**
 * 评审包 —— 给审核人「该看什么」，不是「改了什么」。
 *
 * 背景：PR 的 diff 对代码有用，对文档基本是噪声。一段需求被重写，diff 显示删 40 行
 * 加 45 行，审核人得自己脑补语义，于是评审退化成翻两页点批准。真正缺的是三件事：
 * 缺什么（首版）、哪几节被动过（改版）、该谁来签。
 *
 * 输出 markdown，可直接贴进 PR 描述。它不写 state、不落任何文件——生成物每次都能重算，
 * 没有"报告过期"这个状态要维护。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { die, listOpenTasks } from './shared.mjs';
import {
  migrate,
  checkCompleteness,
  missingDeclarations,
  docKinds,
  declaredPathOf,
  STAGE_NEXT,
} from '../../../hooks/lib/verify.mjs';

/** 该谁签：审核人分离时，最贵的成本是"审核人不知道该看哪里"。 */
const DOC_REVIEWERS = {
  rs: '业务/产品 owner + 测试负责人（可测性）',
  fs: '技术负责人 + 实现方（能不能落地）+ 测试',
  wbs: '实现方 + 测试（各任务能否独立验证）',
};

/** git 单次调用；失败返回 null——非 git 仓库、无历史都属于"判不了"，不假装判。 */
function gitOut(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/** 定稿版本的 pin：git blob sha。它是可复现的事实（`git cat-file -p` 能验证），不是自造哈希。 */
function blobOf(repo, rel) {
  const sha = (gitOut(repo, ['hash-object', '--', rel]) || '').trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : '—';
}

function commitList(repo, rel, n = 3) {
  const out = gitOut(repo, ['log', `-n${n}`, '--date=short', '--format=%h|%an|%ad|%s', '--', rel]);
  return (out || '').trim() ? out.trim().split('\n') : [];
}

/**
 * 最近一次提交动过哪些小节。
 *
 * 只认"标题行有增删"是不够的：文档评审里最常见的改动是**在某一节里补内容**，
 * 标题一个字都没变。所以按 hunk 的新起始行号反查它落在哪一节——这才是审核人
 * 真正需要的"哪几节被动过"。
 *
 * 行号归节只在 sha === HEAD 时可靠（否则新文件的行号与那个 commit 对不上，
 * 会把改动算到隔壁小节）。对不上就退化成只报标题变化，不猜。
 */
function touchedSections(repo, rel, sha, text) {
  const diff = gitOut(repo, ['show', '--unified=0', '--format=', sha, '--', rel]);
  if (!diff) return [];

  const heads = [];
  text.split('\n').forEach((line, i) => {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) heads.push({ line: i + 1, title: m[1] });
  });
  const head = (gitOut(repo, ['rev-parse', 'HEAD']) || '').trim();
  const aligned = head.startsWith(sha);

  const sectionAt = (ln) => {
    let hit = null;
    for (const h of heads) {
      if (h.line <= ln) hit = h;
      else break;
    }
    return hit ? hit.title : '文首';
  };

  const out = new Set();
  for (const line of diff.split('\n')) {
    const mh = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?/.exec(line);
    if (mh) {
      if (!aligned) continue;
      const start = Number(mh[1]);
      const count = mh[2] === undefined ? 1 : Number(mh[2]);
      if (count === 0) out.add(sectionAt(Math.max(1, start)));
      for (let i = 0; i < count; i++) out.add(sectionAt(start + i));
      continue;
    }
    const mt = /^[+-]##\s+(.+?)\s*$/.exec(line);
    if (mt) out.add(mt[1]);
  }
  return [...out];
}

export function cmdReviewPacket(target, slug, opts) {
  const tasksDir = join(target, '.ai/tasks');
  if (!existsSync(tasksDir)) die(`没有任务目录：${tasksDir}（先 bash scripts/init-harness.sh <slug>）`, 64);

  if (!slug) {
    const tasks = listOpenTasks(tasksDir);
    if (!tasks.length) die(`没有任务：${tasksDir} 下没有 state.json`, 64);
    console.log(`[harness] review-packet ${target} —— ${tasks.length} 个任务`);
    let pending = 0;
    for (const t of tasks) {
      if (!t.state) {
        console.log(`  ! ${t.slug}  state.json 无法解析`);
        continue;
      }
      let state;
      try {
        state = migrate(t.state).state;
      } catch (e) {
        console.log(`  ! ${t.slug}  ${e.message}`);
        continue;
      }
      const fails = checkCompleteness(state, target);
      const miss = missingDeclarations(state);
      if (fails.length) pending += 1;
      console.log(
        `  · ${t.slug.padEnd(30)} stage=${String(state.stage).padEnd(10)} 待补 ${fails.length}  未登记 ${miss.map((d) => d.label).join('/') || '—'}`
      );
    }
    console.log(`\n出完整评审包：node scripts/harness-cli.mjs review-packet ${target} <slug>`);
    return pending ? 1 : 0;
  }

  const statePath = join(tasksDir, slug, 'state.json');
  if (!existsSync(statePath)) die(`任务不存在：${statePath}`, 64);
  let state;
  try {
    state = migrate(JSON.parse(readFileSync(statePath, 'utf8'))).state;
  } catch (e) {
    die(`${statePath} 不是合法 JSON 或 schema 不可迁移：${e.message}`, 64);
  }

  const kinds = docKinds();
  const failures = checkCompleteness(state, target);
  const missing = missingDeclarations(state);
  const byDoc = new Map();
  for (const f of failures) {
    if (!byDoc.has(f.id)) byDoc.set(f.id, []);
    byDoc.get(f.id).push(f);
  }

  const rows = [];
  for (const k of kinds) {
    const p = declaredPathOf(state, k.key);
    const isPath = p && !/\s/.test(p) && !/[\u4e00-\u9fa5]/.test(p);
    if (!isPath) {
      rows.push({
        label: k.label,
        path: null,
        blob: '—',
        verdict: missing.some((m) => m.key === k.key) ? '**未登记**' : '未产出',
        first: null,
      });
      continue;
    }
    const exists = existsSync(resolve(target, p));
    const commits = exists ? commitList(target, p) : [];
    const fails = byDoc.get(k.label) || [];
    rows.push({
      label: k.label,
      path: p,
      blob: exists ? blobOf(target, p) : '—',
      verdict: exists ? (fails.length ? `✗ ${fails.length} 项待补` : '✓ 完备') : '**文件不存在**',
      // 首版判据不是 version 号（人编的），而是"这份文件在历史里有没有上一版"
      first: exists ? commits.length <= 1 : null,
      commits,
    });
  }
  const isFirst = opts.first || rows.every((r) => r.first !== false);

  const L = [];
  const push = (s = '') => L.push(s);
  push(`## 评审包 · ${slug}（${isFirst ? '首版' : '变更'}）`);
  push();
  push(
    `阶段 \`${state.stage}\`${STAGE_NEXT[state.stage] ? ` → \`${STAGE_NEXT[state.stage]}\`` : ''}` +
      ` · 档位 ${(state.meta && state.meta.flow_tier) || '?'} · 风险 ${(state.meta && state.meta.risk_tier) || '?'}`
  );
  push();
  push('### 产物与版本');
  push();
  push('| 产物 | 路径 | blob | 结论 |');
  push('|---|---|---|---|');
  for (const r of rows) push(`| ${r.label} | ${r.path ? '`' + r.path + '`' : '—'} | ${r.blob} | ${r.verdict} |`);

  push();
  push('### 待补（机器可判）');
  push();
  if (failures.length) {
    for (const f of failures) push(`- **${f.id}** \`[${f.rule}]\` ${f.reason}`);
  } else {
    push('无 —— 章节齐全、无占位符残留、覆盖闭合。');
    push('');
    push('> 这只说明「写全了」，不说明「写对了」。判内容归人。');
  }

  if (!isFirst) {
    push();
    push('### 本版改动');
    push();
    let any = false;
    for (const r of rows) {
      if (!r.commits || !r.commits.length) continue;
      any = true;
      const [sha, who, when, ...rest] = r.commits[0].split('|');
      push(`- \`${r.label}\` 最近一次：\`${sha}\` ${when} ${who} — ${rest.join('|')}`);
      const text = readFileSync(resolve(target, r.path), 'utf8');
      const secs = touchedSections(target, r.path, sha, text);
      if (secs.length) push(`  - 动过的小节：${secs.map((s) => `§${s}`).join('、')}`);
      const dirty = (gitOut(target, ['status', '--porcelain', '--', r.path]) || '').trim();
      if (dirty) push(`  - 未提交：\`${dirty.split('\n')[0]}\``);
    }
    if (!any) push('- 工作树里还没有可比较的历史（首版尚未入库）——按首版审。');
    push();
    push('> 行级 diff 不在这里复述（见 PR 页面）。这节只回答「哪几节被动过」，语义判断仍需人看。');
  }

  push();
  push('### 该谁签');
  push();
  for (const r of rows) {
    if (!r.path) continue;
    push(`- ${r.label}：${DOC_REVIEWERS[r.label.toLowerCase()] || '—'}`);
  }

  const openBlockers = (state.blockers || []).filter((b) => !b.resolved);
  if (openBlockers.length) {
    push();
    push('### 待决');
    push();
    for (const b of openBlockers) {
      const q = String(b.question || b.desc || b.what || b.reason || '').slice(0, 90);
      push(`- \`${b.id}\` [${b.type}] ${q}`);
    }
  }

  console.log(L.join('\n'));
  return failures.length ? 1 : 0;
}
