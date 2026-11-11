/** remove —— 按 manifest 卸载（安全内核总说明见 ./init.mjs 头注：只删声明归属的文件，绝不 glob 批量删）。 */
import { readFileSync, existsSync, statSync, lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { MANIFEST, die, assertWritableUnder, sha256, readManifest } from './shared.mjs';

/** remove 永不触碰：用户数据、证据、备份、版本库。 */
const NEVER_REMOVE = ['.git', '.ai/tasks', '.ai/verify', '.ai/ledger', '.ai/locks', '.ai/backup', 'node_modules'];

/**
 * 路径上是否有 symlink（返回第一段的相对路径，无则 null）。
 * remove 用它做"跳过并说明"：用户把 .claude/commands 链到 dotfiles 仓库是合法用法，
 * 直接 die 会把整场卸载打断在半途（已删的删了、剩下的没动、manifest 还在）。
 */
function symlinkInPath(target, rel) {
  const abs = resolve(target, rel);
  const relBack = relative(target, abs);
  if (relBack === '' || relBack.startsWith('..') || isAbsolute(relBack)) return '(越界)';
  let cur = target;
  for (const part of relBack.split('/')) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch { continue; }
    if (st.isSymbolicLink()) return relative(target, cur) || cur;
  }
  return null;
}

export function cmdRemove(target, opts) {
  const { dryRun, yes, force } = opts;
  const m = readManifest(target);
  if (!m) die(`没有 ${MANIFEST}——不知道装过什么，拒绝盲删（方案 §6：绝不 glob 批量删）`);
  if (m.corrupt) die(`manifest 无法解析（先人工核对再删）`);

  const notes = [];
  if (m.status === 'pending' || m.status === 'incomplete') notes.push(`manifest 状态是 ${m.status}：上次安装未完成，按现有记录清理（可能残留少量未记录文件，人工核对）`);

  // 外来文件：安装前就存在、不是本工具建的东西（v4 起记录）。它们可能还留在生成物目录里，
  // 但归属不是我们的——删了就是删用户的东西。
  const foreign = new Set(((m.foreign || []).filter((p) => typeof p === 'string')));
  if ((m.version || 0) < 4) notes.push('manifest 是旧版（无 foreign 记录）：只保护 hash 能证明未改过的文件；如担心误删用户既有文件，先重跑一次 init 再 remove');

  const victims = [];
  for (const f of m.files || []) {
    if (f.action !== 'create') continue; // skip/conflict 的文件不是我们写的，留下
    if (NEVER_REMOVE.some((n) => f.path === n || f.path.startsWith(n + '/'))) continue;
    if (f.path === MANIFEST) continue;
    victims.push({ path: f.path, sha256: f.sha256 || null });
  }
  for (const g of m.generated || []) {
    // v3 起生成物条目带安装时 hash（{path, sha256}）；旧版是裸路径字符串——
    // 无 hash 的条目在下方按"改过"保护，绝不盲删（评审 P1）。
    const e = typeof g === 'string' ? { path: g, sha256: null } : g;
    if (!e || typeof e.path !== 'string') continue;
    if (foreign.has(e.path)) continue;
    const abs = join(target, e.path);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      // 旧版 manifest（v1 早期）把目录当生成物：绝不递归删，否则连带用户自加的文件。
      notes.push(`manifest 里的 ${e.path} 是目录（旧版格式）：跳过，重跑 init 后 manifest 会升级成文件清单再清理`);
      continue;
    }
    if (NEVER_REMOVE.some((n) => e.path === n || e.path.startsWith(n + '/'))) continue;
    victims.push({ path: e.path, sha256: e.sha256 || null });
  }

  const existing = victims.filter((v) => existsSync(join(target, v.path)));
  // 判"安装后被改过"：hash 不符 = 改过。**没有 hash 可比对（旧版 manifest）或读失败，同样按改过保护**——
  // 宁可误保留让人 --force，不可把用户改过的文件静默删掉（评审 P1：sha256 为 null 曾被当成"没改过"直接删）。
  const modified = existing.filter((v) => {
    if (v.sha256 === null || v.sha256 === undefined) return true;
    try { return sha256(readFileSync(join(target, v.path), 'utf8')) !== v.sha256; } catch { return true; }
  });
  // 路径上有 symlink 的条目：跳过并说明，不中断整场卸载。
  // 把 .claude/commands 链到 dotfiles 仓库是合法用法；die 会删一半停下，
  // 而错误信息还写着"拒绝写入"（这里是删，不是写）。
  const linked = [];
  const removable = [];
  for (const v of existing) {
    const linkAt = symlinkInPath(target, v.path);
    if (linkAt) { linked.push({ path: v.path, at: linkAt }); continue; }
    removable.push(v);
  }

  console.log(`[harness] remove ${target}${dryRun ? '（dry-run）' : yes && (force || !modified.length) ? '' : '（预览）'}`);
  for (const v of existing) console.log(`  - ${v.path}${modified.some((x) => x.path === v.path) ? '  ! 安装后被改过' : ''}`);
  console.log(`  永不触碰：${NEVER_REMOVE.join('、')}；非本工具创建的文件一概不动（只删 manifest 列出的文件）`);
  if (foreign.size) console.log(`  用户既有文件（v4 foreign 记录，永不删）：${[...foreign].join('、')}`);
  // 按 symlink 根聚合：同一个链接下几十个文件不该刷几十行
  const byLink = new Map();
  for (const l of linked) byLink.set(l.at, (byLink.get(l.at) || 0) + 1);
  for (const [at, n] of byLink) {
    console.log(`  ! ${at}/ 是 symlink：其下 ${n} 个文件跳过不删（删到链接指向的外部内容不是卸载的意思）`);
  }
  for (const n of notes) console.log(`  · ${n}`);

  if (modified.length && !force) {
    console.log(`\n  ! ${modified.length} 个文件在安装后被修改过（或来自无 hash 的旧版 manifest）：${modified.map((v) => v.path).join('、')}`);
    console.log('    这些改动可能是你的活，盲目删会丢。确认要删就加 --force（或先自行备份）；');
    console.log('    旧版 manifest 的条目重跑一次 init 即可补上 hash，之后 remove 就能精确识别。');
    if (!dryRun) {
      // 明确非零退出：给了 --yes 却一个文件都没删，如果 exit 0，脚本会当成"卸载完成"。
      console.log('    本次未删除任何文件（exit 2）。');
      process.exitCode = 2;
    }
    return;
  }
  if (dryRun || !yes) return;

  let removed = 0;
  for (const v of removable) {
    const abs = assertWritableUnder(target, v.path);
    rmSync(abs, { force: true });
    removed++;
    // 只回收因此变空的目录：遇到非空立刻停，绝不递归删
    let dir = dirname(v.path);
    while (dir && dir !== '.' && dir !== '/') {
      const dAbs = join(target, dir);
      try {
        if (!statSync(dAbs).isDirectory() || readdirSync(dAbs).length > 0) break;
        rmdirSync(dAbs); // 目录必须 rmdirSync：rmSync 非递归删目录会 ERR_FS_EISDIR
      } catch { break; }
      dir = dirname(dir);
    }
  }
  rmSync(assertWritableUnder(target, MANIFEST), { force: true });
  // 有跳过项时不能说"干净"——那正是"把声明当门禁"的反面：输出必须与现场一致。
  if (linked.length) {
    console.log(`  已删除 ${removed} 项 + ${MANIFEST}；${linked.length} 项因 symlink 保留，请人工确认。`);
  } else {
    console.log(`  已删除 ${removed} 项 + ${MANIFEST}。退出干净，欢迎回来。`);
  }
}
