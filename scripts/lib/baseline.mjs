/**
 * merge-base 基线实跑（T4a / ADR D5）—— 归因的事实基础。
 *
 * 为什么不能读 main 上次的日志（评审 D5 裁决）：历史日志对应旧 commit，
 * 且主干可能正处于存量红（实测连红两天）——拿它当基线等于拿谣言当事实。
 * 基线必须在 **merge-base**（本 MR 与目标分支的最近公共祖先）上**现在实跑**：
 * 同一棵树、同一套命令，与 MR 侧输出做集合差，差异才可归因。
 *
 * 执行形态：临时 worktree（--detach 到 merge-base），不污染工作树；
 * 每个套件命令无论退出码都收全量输出（失败指纹在输出里，不在退出码里）；
 * **环境必须与 MR 侧一致**（实测教训：曾注入 HARNESS_LEDGER=off 想避污染，
 * 结果有套件的断言就是验账本写入的，基线被环境差异打红——基线红 ≠ 引入红，
 * 但会污染归因）。worktree 自带独立 .ai/ledger（REPO_ROOT 按模块路径解析），
 * 天然不污染主树，无需关账本；
 * git 操作失败直接抛（基线跑不出来 = 归因不可判 = 上层按"无法判定"拒绝，不猜）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { extractFailures } from './fingerprint.mjs';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function mergeBaseSha({ cwd, baseRef = 'origin/main', head = 'HEAD' }) {
  return git(cwd, ['merge-base', baseRef, head]);
}

/**
 * 在 merge-base 上实跑套件，收集失败指纹。
 * suites: [{ name, command: string[] , env? }]——name 进指纹的套件段（归因隔离键）。
 * 返回 { mergeBase, results: [{ name, exitCode, failures, outputHead }] }。
 */
export function runBaseline({ cwd, baseRef = 'origin/main', head = 'HEAD', suites, worktreeDir, spawnImpl }) {
  if (!Array.isArray(suites) || suites.length === 0) throw new Error('基线实跑至少要一个套件');
  const mb = mergeBaseSha({ cwd, baseRef, head });
  git(cwd, ['worktree', 'add', '--detach', worktreeDir, mb]);
  try {
    const results = suites.map((s) => {
      const r = (spawnImpl || spawnSync)(s.command[0], s.command.slice(1), {
        cwd: worktreeDir,
        env: { ...process.env, ...(s.env || {}) },
        encoding: 'utf8',
      });
      const out = `${r.stdout || ''}\n${r.stderr || ''}`;
      return {
        name: s.name,
        exitCode: r.status,
        failures: extractFailures(out, { suite: s.name }),
        outputHead: out.split('\n').slice(0, 5).join('\n'),
      };
    });
    return { mergeBase: mb, results };
  } finally {
    // worktree 清理失败不吞：残留 worktree 会卡住后续基线跑（目录占用），报出来让人清
    try { git(cwd, ['worktree', 'remove', '--force', worktreeDir]); } catch (e) {
      throw new Error(`基线 worktree 清理失败（手动清：git worktree remove --force ${worktreeDir}）：${e.message}`);
    }
  }
}
