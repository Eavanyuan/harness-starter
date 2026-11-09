/**
 * git CAS 认领（T3 / ADR D2）—— 跨机互斥的唯一共享点是 git 本身。
 *
 * 认领 = 在远端创建 claims 分支：`git push <remote> <sha>:refs/heads/claims/<kind>-<id>`。
 * 创建成功即独占（服务端原子）；分支已存在且非快进 → 被拒（非快进拒绝即认领失败）。
 * 评审修正：自定义 refs/claims/* 命名空间 GitLab 会拒收，落在 heads/ 斜杠分支下等价成立。
 *
 * 僵尸认领（TTL 过期）不自动抢：按 blocked 处理并升级——删引用再重建是两步操作，
 * 有竞争窗口；"MR 被锁死"升级给人比静默抢占更安全（ADR D2 裁决原文）。
 */
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

export function claimRef(kind, id) {
  // id 先过一遍字符白名单：认领引用会被拼进 git 命令行，宽松字符集等于注入面
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(id))) {
    throw new Error(`认领 id 含非法字符：${id}（允许字母数字._-）`);
  }
  return `refs/heads/claims/${kind}-${id}`;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * 尝试认领。返回 { claimed: true, ref } 或 { claimed: false, reason: 'taken'|'zombie', ageMs }。
 *
 * 关键修正（T3 实测打脸）：不能 push 现有 sha——两个竞争者用同一 sha push 同一 ref，
 * 第二次是 no-op 成功（同 sha 不构成非快进），两边都以为自己认领了。
 * 认领必须是**唯一内容的新提交**：空树 commit-tree + 运行时身份（host/pid/纳秒）作消息，
 * 后推者与远端分支必然分叉 → 非快进拒绝。committerdate 即认领时间，TTL 判定天然成立。
 */
export function claim({ cwd, remote, kind, id, ttlMs = 24 * 3600_000, now = Date.now, runId }) {
  const ref = claimRef(kind, id);
  const who = runId || `${hostname() || 'host'}-${process.pid}-${now()}`;
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  try {
    const sha = execFileSync('git', ['-C', cwd, 'commit-tree', EMPTY_TREE, '-m', `claim ${kind}-${id} by ${who}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(cwd, ['push', remote, `${sha}:${ref}`]);
    return { claimed: true, ref, sha };
  } catch (e) {
    const err = String(e.stderr || e.message);
    if (!/rejected|fetch first|non-fast-forward|already exists|pre-receive/i.test(err)) throw e;
    // 读现有认领的提交时间判僵尸（读不到按"在世"处理——宁可误报在世也不误抢）
    try {
      const out = git(cwd, ['ls-remote', remote, ref]);
      const remoteSha = (out.trim().split('\t')[0] || '').trim();
      if (!remoteSha) return { claimed: false, reason: 'taken', ref };
      const dateStr = git(cwd, ['show', '-s', '--format=%cI', remoteSha]).trim();
      const ageMs = now() - Date.parse(dateStr);
      if (Number.isFinite(ageMs) && ageMs > ttlMs) return { claimed: false, reason: 'zombie', ageMs, ref };
      return { claimed: false, reason: 'taken', ref };
    } catch {
      return { claimed: false, reason: 'taken', ref };
    }
  }
}

/** 释放认领（任务终态后清理；失败不抛——残留由 TTL 兜底）。 */
export function release({ cwd, remote, kind, id }) {
  try {
    git(cwd, ['push', remote, `:${claimRef(kind, id)}`]);
    return true;
  } catch {
    return false;
  }
}
