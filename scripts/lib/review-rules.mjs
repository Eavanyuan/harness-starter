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

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? '数组' : typeof v === 'object' ? '对象' : typeof v);

/**
 * 校验 config 的**形状**，不只是"能不能 parse"。
 *
 * 只判 parse 是不够的：`{"projects":"backend"}` 能解析、`{"projects":[{"id":"a"}]}`
 * 也能解析，两者都会让下面的 list 变成空数组 → cr 静默退到 fallback_paths，
 * 配置手滑一次，审核覆盖面就悄悄变窄（实测两种写法都 exit 0）。所以形状错也抛。
 */
function dirOf(where, x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) {
    throw new RulesError(`harness.config.json 的 ${where} 必须是对象（当前是 ${kindOf(x)}）`);
  }
  if (typeof x.dir !== 'string' || !x.dir.trim()) {
    throw new RulesError(`harness.config.json 的 ${where} 缺 dir（项目目录；仓库根目录写 "."）——cr 按项目槽路由依赖它`);
  }
  return x.dir;
}

/**
 * harness.config.json 的项目目录集合（v2 projects 数组 + v1 stacks 对象都认）。
 * 文件不存在返回 []（无配置仓库走 fallback，合法形态）；**存在但解析失败、或形状不对必须抛**
 * ——吞掉的话 cr 路由会静默降级到 fallback_paths，配置手滑一次，审核覆盖面就悄悄变窄
 * （checklist §2：失败不许退化成「没有变化」，P2-12 第五轮审查 / 第六轮补形状校验）。
 */
export function projectDirs(root) {
  const p = join(root, 'harness.config.json');
  if (!existsSync(p)) return [];
  let c;
  try {
    c = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new RulesError(`harness.config.json 存在但不是合法 JSON：${e.message}（cr 按项目槽路由依赖它）`);
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    throw new RulesError(`harness.config.json 顶层必须是对象（当前是 ${kindOf(c)}）`);
  }
  if ('projects' in c) {
    if (!Array.isArray(c.projects)) {
      throw new RulesError(`harness.config.json 的 projects 必须是数组（当前是 ${kindOf(c.projects)}）；v1 的 stacks 对象写法仍然支持，但只能选一种`);
    }
    return c.projects.map((x, i) => dirOf(`projects[${i}]${x && x.id ? `（id=${x.id}）` : ''}`, x));
  }
  if ('stacks' in c) {
    if (!c.stacks || typeof c.stacks !== 'object' || Array.isArray(c.stacks)) {
      throw new RulesError(`harness.config.json 的 stacks 必须是对象（键=栈名，值含 dir）（当前是 ${kindOf(c.stacks)}）`);
    }
    return Object.entries(c.stacks).map(([k, v]) => dirOf(`stacks.${k}`, v));
  }
  return [];
}

/** cr 的源码模式：projects 目录优先，无配置仓库用 fallback_paths 兜底。 */
function patternsFor(review, root) {
  if (review.paths_from !== 'projects') return { patterns: review.paths, via: 'paths' };
  // 只读一次配置：这个函数每类审核调一次，读两遍就是两倍 IO，也让"配置坏了"抛两次
  const all = projectDirs(root);
  const dirs = all.filter((d) => d && d !== '.');
  const patterns = [...dirs.map((d) => `${d}/**`)];
  if (all.includes('.')) patterns.push('**/*.java', '**/*.go', '**/*.py', '**/*.ts', '**/*.vue', '**/*.js');
  if (!patterns.length) return { patterns: review.fallback_paths || [], via: 'fallback' };
  return { patterns, via: 'projects' };
}

/**
 * 变更文件 → 该跑哪些审核。零 LLM；**不是纯函数**：经 patternsFor 读 harness.config.json，
 * 配置坏时抛 RulesError——三个入口都必须按 fail-closed 处理（router/ai-review exit 2，
 * broker 拒不落 500 并显式告知配置错误）。
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
