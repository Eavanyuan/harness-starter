#!/usr/bin/env node
/**
 * harness-cli —— 把本仓库作为模板装进目标项目（harness-builder v1）。
 * 方案：docs/plans/2026-10-30-harness-builder-final.md
 *
 * 本文件是薄入口：只做参数解析与子命令分发。实现按域拆在 scripts/lib/cli/：
 *   check / detect / analyze / init / remove / verify / resume(+decisions) / abandon / review-packet
 * 共享工具（die / usage / safeTarget / 原子写 / manifest / preflight / survey）在
 * scripts/lib/cli/shared.mjs。init 的安全内核说明见 scripts/lib/cli/init.mjs 头注。
 */
import { usage, safeTarget } from './lib/cli/shared.mjs';
import { cmdCheck } from './lib/cli/check.mjs';
import { cmdDetect } from './lib/cli/detect.mjs';
import { cmdAnalyze } from './lib/cli/analyze.mjs';
import { cmdInit } from './lib/cli/init.mjs';
import { cmdRemove } from './lib/cli/remove.mjs';
import { cmdVerify } from './lib/cli/verify.mjs';
import { cmdResume } from './lib/cli/resume.mjs';
import { cmdAbandon } from './lib/cli/abandon.mjs';
import { cmdReviewPacket } from './lib/cli/review-packet.mjs';
import { cmdRuntime } from './lib/cli/runtime.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
// 每个动词显式声明自己接受的 flag：拼错/不支持的 flag 直接 usage，
// 不能让它被当成 positional 静默吞掉（--stack-dir svc-a 就曾这样把目录当参数丢掉）。
const VALUE_FLAGS = { analyze: ['--out', '--max-edges'], init: ['--agents', '--stack-dir'], resume: ['--by', '--from', '--except', '--ack-strikes'], verify: ['--mode', '--file'], abandon: ['--reason', '--by'], runtime: ['--spawn_agents', '--shell', '--ask_user', '--by'] };
const BOOL_FLAGS = { detect: ['--json'], analyze: ['--in-project', '--full-edges'], init: ['--dry-run'], remove: ['--dry-run', '--yes', '--force'], resume: ['--advance', '--accept-suggested'], 'review-packet': ['--first'], verify: ['--json'], runtime: ['--reset'] };
const valueFlags = new Set(VALUE_FLAGS[cmd] || []);
const boolFlags = new Set(BOOL_FLAGS[cmd] || []);
const flags = new Set();
const values = {};
const positional = [];
/** --decide / --resolve 都可重复（一次给多条），因此单独收集，不能走"一个 flag 一个值"的 values。 */
const decides = [];
const resolves = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--decide' || a === '--resolve') {
    if (cmd !== 'resume') { console.error(`[harness] ${a} 只用于 resume`); usage(); }
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) { console.error(`[harness] ${a} 需要 <id>=<内容>`); usage(); }
    (a === '--decide' ? decides : resolves).push(v);
  } else if (valueFlags.has(a)) {
    // 下一个 token 是另一个 flag 说明这个开关漏了值：`init t --stack-dir --dry-run`
    // 会把 --dry-run 当成目录名吞掉，dry-run 于是静默失效——与拼错 flag 同型。
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) {
      console.error(`[harness] ${a} 需要一个值`);
      usage();
    }
    values[a] = v;
  } else if (a.startsWith('--')) {
    if (!boolFlags.has(a)) { console.error(`[harness] 未知或不适用当前子命令的 flag：${a}`); usage(); }
    flags.add(a);
  } else positional.push(a);
}

switch (cmd) {
  case 'check': process.exit(cmdCheck(safeTarget(positional[0], true))); break;
  case 'detect': cmdDetect(safeTarget(positional[0], true), flags.has('--json')); break;
  case 'analyze': cmdAnalyze(safeTarget(positional[0], true), values['--out'], flags.has('--in-project'), flags.has('--full-edges') ? 0 : (values['--max-edges'] !== undefined ? Number(values['--max-edges']) : undefined)); break;
  case 'init': cmdInit(safeTarget(positional[0]), { dryRun: flags.has('--dry-run'), agentsMode: values['--agents'] || 'full', stackDir: values['--stack-dir'] || null }); break;
  case 'remove': cmdRemove(safeTarget(positional[0]), { dryRun: flags.has('--dry-run'), yes: flags.has('--yes'), force: flags.has('--force') }); break;
  case 'resume': {
    // 决策必须记名：无记名决策事后无法追责，也无法区分"人拍的板"和"模型自己认的"。
    const writing = decides.length || resolves.length || values['--from'] || flags.has('--accept-suggested');
    if (writing && !values['--by']) {
      console.error('[harness] 回填决策/阻断必须带 --by <决策人>：无记名记录等于没有记录');
      usage();
    }
    if (writing && !values['--by'].trim()) {
      console.error('[harness] --by 不能为空');
      usage();
    }
    process.exit(
      cmdResume(safeTarget(positional[0], true), positional[1] || null, {
        decide: decides,
        resolve: resolves,
        by: (values['--by'] || '').trim(),
        advance: flags.has('--advance'),
        from: values['--from'] || null,
        ackStrikes: (values['--ack-strikes'] || '').trim(),
        acceptSuggested: flags.has('--accept-suggested'),
        except: (values['--except'] || '').split(',').map((s) => s.trim()).filter(Boolean),
      })
    );
    break;
  }
  case 'verify': {
    // 口径在这里也要闭合一次：ci-verify 自己会拒未知值，但参数解析层先拦，
    // 才能在**启动子进程之前**给出 usage，而不是把一个半截命令传下去。
    const mode = values['--mode'] || 'ci';
    if (mode !== 'ci' && mode !== 'local') {
      console.error(`[harness] --mode 只接受 ci|local，收到：${mode}`);
      usage();
    }
    process.exit(cmdVerify(safeTarget(positional[0], true), { mode, json: flags.has('--json'), file: values['--file'] || null }));
    break;
  }
  case 'review-packet': {
    process.exit(cmdReviewPacket(safeTarget(positional[0], true), positional[1] || null, { first: flags.has('--first') }));
    break;
  }
  case 'abandon': {
    process.exit(
      cmdAbandon(safeTarget(positional[0], true), positional[1] || null, {
        reason: values['--reason'] || '',
        by: values['--by'] || '',
      })
    );
    break;
  }
  case 'runtime': {
    // P3-⑤：宿主能力自检结论写回 config。值域与键白名单在 runtime.mjs 里唯一处校验。
    process.exit(
      cmdRuntime(safeTarget(positional[0], true), {
        spawn_agents: values['--spawn_agents'] || '',
        shell: values['--shell'] || '',
        ask_user: values['--ask_user'] || '',
      }, { reset: flags.has('--reset'), by: (values['--by'] || '').trim() })
    );
    break;
  }
  default: usage();
}
