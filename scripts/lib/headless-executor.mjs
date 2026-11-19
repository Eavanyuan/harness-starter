/**
 * cli 执行器（T5-2/3/4，ADR-22）—— runner 认领后自己起无头会话，事件驱动零客户端通知。
 *
 * 与 autoclaw 执行器的关系：同一份工单协议（pack-*.md），两种宿主。autoclaw=宿主定时器
 * 轮询取件（本机缺省）；cli=本模块全责（worktree + hook 注入 + spawn + 产物验收 + 影子/推送）。
 *
 * 三条红线（RS 22 / ADR-22）：
 *   D6  hook 注入失败 → 抛错拒起（无门禁的会话=绕过全部写入门禁，宁可不跑）
 *   A   worktree 在目标仓**外部**（兄弟目录），hook 配置是 worktree 内**未跟踪**文件——
 *       harness 资产永不进目标仓 git 历史
 *   D4  shadow=true 只产不推——影子轮达标+人工批准才允许 push
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSessionArtifacts } from './session-pack.mjs';

const git = (args, opts = {}) => spawnSync('git', args, { encoding: 'utf8', ...opts });

/** 目标仓外部的 worktree 路径：兄弟目录 .tl-worktrees/<仓名>-<id>，零污染目标仓 status。 */
export function worktreePath(repoDir, id) {
  return join(dirname(resolve(repoDir)), '.tl-worktrees', `${basename(resolve(repoDir))}-${id}`);
}

/**
 * 建 worktree（tl-<id> 分支，起点 startRef）。残留先清（幂等：-B 重置到起点）。
 * 返回 { wt, branch }；失败抛错（git 错误原文带上）。
 */
export function prepareWorktree({ repoDir, id, startRef }) {
  const wt = worktreePath(repoDir, id);
  const branch = `tl-${id}`;
  git(['-C', repoDir, 'worktree', 'prune']);
  const r = git(['-C', repoDir, 'worktree', 'add', '-B', branch, wt, startRef]);
  if (r.status !== 0) throw new Error(`worktree 创建失败（${startRef}）：${(r.stderr || '').trim()}`);
  return { wt, branch };
}

/**
 * hook 注入（T5-3 / ADR-22 D3）：把 harness 根生成的 .claude/settings.json 复制进 worktree，
 * 相对命令（node hooks/X.mjs）改写为指向 harness 根的绝对路径——guard 按脚本位置定 ROOT，
 * 在目标仓 worktree 里跑仍读 harness 的门禁配置。写入的是**未跟踪**文件：永不 git add
 * （会话协议只 add 显式清单），随 worktree 删除消失，目标仓零 git 残留。
 * 读不到源配置 → 抛错（D6：宁可不跑，不裸奔）。
 */
export function injectHooks({ wt, harnessRoot }) {
  const src = join(harnessRoot, '.claude', 'settings.json');
  let raw;
  try {
    raw = readFileSync(src, 'utf8');
  } catch {
    throw new Error(`hook 注入失败：${src} 不存在——先 build:hooks（D6：无门禁的会话拒绝启动）`);
  }
  // 相对命令绝对化：node hooks/X.mjs → node <harnessRoot>/hooks/X.mjs
  const out = raw.replace(/(node\s+)hooks\//g, `$1${join(harnessRoot, 'hooks')}/`);
  const dst = join(wt, '.claude', 'settings.json');
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, out);
  return dst;
}

/**
 * 完整执行一轮 cli 会话。返回结构化结果（不直接记事件——事件口径归 runner）：
 *   { ok, reason?, wt?, branch?, pushed?, shadow?, noop?, commits? }
 * 失败不重试（预算在 runner 侧），worktree 保留现场（影子/失败轮供人查）。
 */
export function runCliExecutor({ harnessRoot, repoDir, id, startRef, packText, executor, expectedArtifacts, log = () => {} }) {
  const cli = executor.cli || {};
  const shadow = cli.shadow !== false; // 缺省影子（D4：上线闸，人工批准前不推）
  const timeoutMs = cli.timeoutMs ?? 45 * 60 * 1000;

  const { wt, branch } = prepareWorktree({ repoDir, id, startRef });
  injectHooks({ wt, harnessRoot }); // 抛错=拒起（D6）

  // 会话产物目录（harness 侧，不是 worktree）：runner 验收读这里
  const sessDir = join(harnessRoot, '.ai', 'task-loop', 'sess', String(id));
  mkdirSync(sessDir, { recursive: true });

  const header = [
    `## 会话环境（runner 注入）`,
    `- 工作目录（worktree，只在这里改代码）：${wt}`,
    `- 分支：${branch}（起点 ${startRef}）`,
    `- 产物目录（todo.json/round-1.md 等写到这里，不是 worktree）：${sessDir}`,
    `- ${shadow ? '【影子轮】产出修复与产物，但 runner 不会推送任何分支——照常完成全部工作' : '本轮产出将在验收通过后由 runner 推送分支'}`,
    '',
  ].join('\n');
  const prompt = header + packText;

  const r = spawnSync(cli.cmd, cli.args || [], { cwd: wt, input: prompt, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: `会话启动失败：${r.error.message}`, wt, branch };
  if (r.signal) return { ok: false, reason: `会话超时（${Math.round(timeoutMs / 60000)}min）被终止`, wt, branch };
  if (r.status !== 0) return { ok: false, reason: `会话 exit ${r.status}（worktree 保留现场）`, wt, branch, stdout: (r.stdout || '').slice(-2000) };

  // 产物验收（fail-closed）：缺件=本轮无效——不猜会话"大概做完了"
  const art = readSessionArtifacts(sessDir, { expected: expectedArtifacts || ['todo.json', 'round-1.md'] });
  if (!art.ok) return { ok: false, reason: art.reason, wt, branch };

  // 实际产出检查：worktree 里没有新提交 = 会话空转（产物齐但没干活）
  const cnt = git(['-C', wt, 'rev-list', '--count', `${startRef}..HEAD`]);
  const commits = Number((cnt.stdout || '0').trim()) || 0;
  if (commits === 0) return { ok: true, noop: true, wt, branch, commits: 0 };

  if (shadow) {
    log(`[task-loop] ${id} 影子轮：${commits} 个提交留在 ${branch}（不推送，worktree 保留供人工抽查）`);
    return { ok: true, shadow: true, wt, branch, commits };
  }

  // 非影子：验收通过才推。推的是修复分支（MR 源分支或 tl-<id>），绝不动目标分支
  const pushBranch = executor.pushBranch || branch;
  const p = git(['-C', wt, 'push', 'origin', `HEAD:refs/heads/${pushBranch}`]);
  if (p.status !== 0) {
    return { ok: false, reason: `推送失败（${pushBranch}）：${(p.stderr || '').trim().slice(0, 300)}——worktree 保留`, wt, branch, commits };
  }
  log(`[task-loop] ${id} 会话完成：${commits} 个提交已推 ${pushBranch}，worktree 清理`);
  git(['-C', repoDir, 'worktree', 'remove', '--force', wt]);
  return { ok: true, pushed: true, wt: null, branch, commits, pushBranch };
}
