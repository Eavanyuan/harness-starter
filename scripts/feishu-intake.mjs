#!/usr/bin/env node
/**
 * `harness feishu` 的流程编排：读配置、连飞书、调读取或确认、打印结果。
 * 判定与副作用都在 lib/feishu-intake.mjs 里（依赖全部可注入，测试不经过这里）。
 * 本文件只负责把真实的外部依赖接上去：飞书 OAuth 凭据与项目接口。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureToken } from './lib/feishu-oauth.mjs';
import { connect, resolveEndpoint } from './lib/feishu-project-mcp.mjs';
import { IntakeError, validateIntakeCfg, parseWorkItemRef, runIntake, confirmIntake } from './lib/feishu-intake.mjs';

export { IntakeError };

export async function cmdFeishu(target, ref, opts = {}, deps = {}) {
  const ensureToken_ = deps.ensureToken ?? ensureToken;
  const connect_ = deps.connect ?? connect;
  const root = resolve(target);
  let rules;
  try {
    rules = JSON.parse(readFileSync(join(root, 'harness.rules.json'), 'utf8'));
  } catch (e) {
    throw new IntakeError(`${root} 下读不到 harness.rules.json（${e.message}）。请在 harness 仓库根目录运行，或把仓库路径作为第一个参数`, 64);
  }
  const feishu = rules?.runtime?.feishu;
  if (!feishu?.projectKey) {
    throw new IntakeError('runtime.feishu.projectKey 没配（harness.rules.json）——不知道读哪个飞书空间', 1);
  }
  const cfg = validateIntakeCfg(feishu.intake);
  // 先校验入参、再碰网络：ID 写错不该先走一遍登录（外部依赖排在判定后面）
  const { workItemId } = parseWorkItemRef(ref);
  // 接口地址的取法与 task-loop 一致：环境变量优先，其次配置的 issuer，最后缺省地址。
  const endpoint = resolveEndpoint() || `${feishu.issuer || 'https://project.feishu.cn'}/mcp_server/v1`;

  let client;
  try {
    const token = await ensureToken_();
    client = await connect_(endpoint, { token, client: 'harness-feishu-intake' });
  } catch (e) {
    throw new IntakeError(`连不上飞书项目接口：${e.message}。凭据问题请重新登录：node scripts/feishu-auth.mjs login`, 1);
  }

  const common = { ref, projectKey: feishu.projectKey, cfg, call: client.call, root };

  if (opts.confirm) {
    const r = await confirmIntake({
      ...common,
      type: opts.confirm,
      by: opts.by,
      slug: opts.slug,
      tier: opts.tier,
      baseline: opts.baseline,
    });
    console.log(`[harness] 已建档：${r.slug}（类型 ${r.type}，档位 ${r.tier}）`);
    console.log(`  档案：${r.statePath}`);
    console.log(`  来源：飞书工作项 ${r.workItemId}；确认人：${opts.by}（已记入档案）`);
    console.log(`  待决 ${r.blockers} 项已写成阻断，流程停在当前阶段。`);
    if (!r.checkRan) {
      console.log('  仓库校验没跑成——这不算通过：');
      for (const l of r.verifyLines) console.log(`    ${l.trim()}`);
    } else if (r.verified) {
      console.log('  仓库校验：新档案没有红项');
      if (!r.repoClean) console.log('  （仓库里另有红项，与这个新任务无关——可用 node scripts/harness-cli.mjs verify . 查看）');
    } else {
      console.log('  仓库校验：未通过——');
      for (const l of r.verifyLines) console.log(`    ${l.trim()}`);
    }
    console.log(r.blockers ? '下一步（回答待决项之后流程才会继续）：' : '下一步：');
    console.log(`    node scripts/harness-cli.mjs resume . ${r.slug}`);
    return r.verified ? 0 : 1;
  }

  const r = await runIntake({ ...common, targetLabel: target === '.' ? '' : target });
  console.log(readFileSync(r.summaryPath, 'utf8'));
  console.log(`摘要已存：${r.summaryPath}`);
  return 0;
}
