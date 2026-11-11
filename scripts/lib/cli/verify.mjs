/**
 * verify —— 统一验证入口（checklist §36 的直接产物：判据的洞不表现为失败，表现为绿灯）。
 *
 * 现状问题是"生效点位太窄"：同样的判据，只有挂了这个 CLI hook 的那条路会被执行，
 * 换工具写 state、换 CLI、人手动 commit，全都绕过去。要让判据不再依赖入口，
 * 就得有一个"只看磁盘、不看谁来问"的调用方式——就是这个命令。
 *
 * 为什么是 spawn 而不是 import：ci-verify.mjs 是带副作用的脚本（顶层 process.exit + 一堆 IO），
 * import 会立刻执行一遍并接管本进程。判据只能有一份，所以这里不实现第二套判定，
 * 只把参数翻译过去——两份实现必然分叉，然后出现"harness verify 说过了、CI 说没过"。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { die } from './shared.mjs';

export function cmdVerify(target, opts) {
  const script = join(target, 'scripts', 'ci-verify.mjs');
  if (!existsSync(script)) {
    die(`${target} 里没有 scripts/ci-verify.mjs —— 这不是装过 harness 的项目（先跑 harness init）`);
  }
  const argv = [script];
  if (opts.file) argv.push('--file', opts.file);
  if (opts.json) argv.push('--json');
  argv.push('--mode', opts.mode);
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit' });
  if (r.error) die(`调用 ci-verify 失败：${r.error.message}`);
  // status 为 null 表示被信号杀掉：不能当成 0（那会把崩溃读成"通过"）。
  return r.status === null ? 1 : r.status;
}
