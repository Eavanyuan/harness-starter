/**
 * 审核路由规则库 —— harness.rules.json 的唯一解释器。
 *
 * review-router / ai-review / harness-broker 三个入口共读这一份逻辑（checklist §7：
 * 同一判据出现在两处就是分歧的开始）。改动路由行为 = 改 harness.rules.json，不是改这里。
 *
 * fail-closed 约定（checklist §3）：规则缺失/非法抛 RulesError，调用方必须以非 0 退出，
 * 不许把「读不到规则」当「没有审核要跑」。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class RulesError extends Error {}

/** glob → 正则：* 单层、** 任意层。只支持这两种通配，够路由用，别长成第二个 glob 引擎。 */
export function globToRegExp(glob) {
  let s = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 跨目录前缀：`a/**/b` 也应命中 `a/b`；裸 `**` = 任意
        if (glob[i + 2] === '/') { s += '(?:.*/)?'; i += 3; }
        else { s += '.*'; i += 2; }
      } else { s += '[^/]*'; i += 1; }
    } else if ('\\^$.|?+()[]{}'.includes(c)) { s += `\\${c}`; i += 1; }
    else { s += c; i += 1; }
  }
  return new RegExp(`^${s}$`);
}

const matchAny = (patterns, file) => patterns.some((p) => globToRegExp(p).test(file));

export function loadRules(root) {
  const p = join(root, 'harness.rules.json');
  if (!existsSync(p)) throw new RulesError(`规则文件不存在：${p}（审核路由缺配置 = 门禁缺位，拒绝空跑）`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new RulesError(`规则文件不是合法 JSON：${p}：${e.message}`);
  }
  if (raw.schema_version !== 1) throw new RulesError(`不支持的 schema_version=${raw.schema_version}（当前支持 1）`);
  const reviews = raw.reviews;
  if (!reviews || typeof reviews !== 'object' || Array.isArray(reviews)) {
    throw new RulesError('rules.reviews 必须是对象（键=审核类型）');
  }
  for (const [id, r] of Object.entries(reviews)) {
    if (r.always) continue; // evidence 类：无路径无清单，只声明 runner
    if (!Array.isArray(r.paths) && r.paths_from !== 'projects') {
      throw new RulesError(`reviews.${id} 缺 paths 或 paths_from`);
    }
    if (!r.checklist || typeof r.checklist !== 'string') {
      throw new RulesError(`reviews.${id} 缺 checklist（AI 判据清单文件）`);
    }
  }
  return raw;
}

/** harness.config.json 的项目目录集合（v2 projects 数组 + v1 stacks 对象都认）。读不到返回 []。 */
export function projectDirs(root) {
  const p = join(root, 'harness.config.json');
  if (!existsSync(p)) return [];
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'));
    const list = Array.isArray(c.projects) ? c.projects : Object.values(c.stacks || {});
    return list.map((x) => x && x.dir).filter((d) => typeof d === 'string');
  } catch {
    return [];
  }
}

/** cr 的源码模式：projects 目录优先，无配置仓库用 fallback_paths 兜底。 */
function patternsFor(review, root) {
  if (review.paths_from !== 'projects') return { patterns: review.paths, via: 'paths' };
  const dirs = projectDirs(root).filter((d) => d && d !== '.');
  const dot = projectDirs(root).some((d) => d === '.');
  const patterns = [...dirs.map((d) => `${d}/**`)];
  if (dot) patterns.push('**/*.java', '**/*.go', '**/*.py', '**/*.ts', '**/*.vue', '**/*.js');
  if (!patterns.length) return { patterns: review.fallback_paths || [], via: 'fallback' };
  return { patterns, via: 'projects' };
}

/**
 * 变更文件 → 该跑哪些审核。纯函数、零 LLM、零 IO（规则与配置由调用方先 load）。
 * 返回 { changed, noise, reviews:[{id,title,files,via,approval_role}], trivial }。
 * trivial=true 表示全是噪声文件——任何审核（含 evidence）都不跑。
 */
export function route(rules, root, changedFiles) {
  const noisePaths = (rules.skip && rules.skip.noise_paths) || [];
  const all = [...new Set(changedFiles.filter(Boolean))];
  const noise = all.filter((f) => matchAny(noisePaths, f));
  const real = all.filter((f) => !matchAny(noisePaths, f));

  const out = [];
  for (const [id, r] of Object.entries(rules.reviews)) {
    if (r.always) {
      if (real.length > 0) out.push({ id, title: r.title, files: real, via: 'always', approval_role: r.approval_role });
      continue;
    }
    const { patterns, via } = patternsFor(r, root);
    const files = real.filter((f) => matchAny(patterns, f));
    if (files.length > 0) out.push({ id, title: r.title, files, via, approval_role: r.approval_role });
  }
  return { changed: real.length, noise, reviews: out, trivial: real.length === 0 };
}
