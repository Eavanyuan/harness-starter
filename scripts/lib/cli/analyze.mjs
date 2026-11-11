/** analyze —— 机械探测事实视图（只读，报告默认落项目外）。 */
import { existsSync, lstatSync, readlinkSync, realpathSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { analyze, renderMap } from '../analyzer.mjs';
import { die, writeAtomic } from './shared.mjs';

/**
 * 宽松 realpath：路径还不存在时，解析最近存在的祖先，再拼回剩余段。
 * 用它判"这个路径最终落在哪"——纯词法比较挡不住 `ln -s target/leak /tmp/rep` 这类绕过。
 * 悬挂 symlink（目标还不存在）必须用 lstat + readlink 手动跟，否则会把链接名
 * 当成普通路径段，判定就漏过去了。
 */
function realpathLoose(p) {
  let cur = resolve(p);
  const rest = [];
  for (let guard = 0; guard < 32; guard++) {
    if (existsSync(cur)) break;
    let st = null;
    try { st = lstatSync(cur); } catch { st = null; }
    if (st && st.isSymbolicLink()) {
      const linkTarget = readlinkSync(cur);
      cur = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(cur), linkTarget);
      continue;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  const base = existsSync(cur) ? realpathSync(cur) : cur;
  return rest.length ? join(base, ...rest) : base;
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function cmdAnalyze(target, outRaw, inProject, maxEdges) {
  if (!existsSync(target)) die(`目标不存在：${target}`);
  const out = outRaw ? resolve(outRaw) : join(dirname(target), `${basename(target)}-harness-report`);
  if (!inProject) {
    // 词法判定 + realpath 判定：只做前者的话，`ln -s <target>/leak /tmp/rep` 就能把报告写进目标项目。
    const targetReal = realpathSync(target);
    const outReal = realpathLoose(out);
    if (isInside(out, target) || isInside(outReal, targetReal)) {
      die(`--out 落在目标项目内：${out}${outReal !== out ? `（经 symlink 解析为 ${outReal}）` : ''}（报告默认写到项目外；确要放进去加 --in-project）`);
    }
  }
  mkdirSync(out, { recursive: true });
  const report = analyze(target, Number.isFinite(maxEdges) ? { maxEdges } : {});
  writeAtomic(join(out, 'analysis.json'), JSON.stringify(report, null, 2) + '\n');
  writeAtomic(join(out, 'PROJECT-MAP.md'), renderMap(report));
  console.log(`[harness] analyze 完成（只读，未改动目标目录）：`);
  console.log(`  ${join(out, 'analysis.json')}`);
  console.log(`  ${join(out, 'PROJECT-MAP.md')}`);
  for (const w of report.warnings) console.log(`  ! ${w}`);
  for (const r of report.risks) console.log(`  ! ${r}`);
  if (report.edges_truncated) {
    console.log(`  ! 明细边已截断：${report.edges_truncated.kept}/${report.edges_truncated.total}（结论字段按全量算；要全量加 --full-edges）`);
  }
}
