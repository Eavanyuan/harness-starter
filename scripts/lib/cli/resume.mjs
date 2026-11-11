/**
 * 任务恢复 —— 把"停在门禁上等人"的状态接回来。
 *
 * 为什么必须有这个动词：状态机停在 blocker 上是**正确**行为，但此前没有任何工具
 * 帮人从那里继续。真实项目（TDC 第一个任务）停在 adr、8 条决策等人裁决，
 * 用户回来后只能手工改 state.json —— 而手改正是门禁最该防的动作（漏 resolved_by、
 * 忘了重跑 gate、把 stage 直接推到下一阶段）。resume 把人肉操作变成一条可复查的命令。
 *
 * 三件事，且只做这三件：
 *   1. 报清现状：阶段、待决 blocker（带选项与建议）、可立即开工的 TODO；
 *   2. 回填决策：`--decide D1=<选择> --by <人>`（能力/环境类阻断用 `--resolve B1=<怎么解决的>`），
 *      缺 --by 一律拒绝（无记名决策 = 幽灵决策）；
 *   3. 重跑可机器判的门禁：决策齐备 → 该检查转 pass，无未决 blocker 且 TODO 校验通过 → 推进阶段。
 *
 * 不做的：不替你选（选项是人的事）、不改产物正文（ADR 表格的书面记录归人）、
 * 不跳过 gate（推进必须真的满足条件）。
 */
// 阶段链不自留一份：STAGE_NEXT 从 hooks/lib/verify.mjs 引入（单源）。
// 此前它长在这里，而 init-harness.sh 另造了 `stage:"intake"`——链上的判据和
// 建任务时写的值各说各话，新任务第一天就站在状态机之外。
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { die, writeAtomic, assertWritableUnder, listOpenTasks, nowIso } from './shared.mjs';
import {
  validateTodos,
  migrate,
  checkStageExit,
  checkRetroLanding,
  checkTaskTraceability,
  checkStage,
  checkStageTodoClosure,
  stageGate,
  artifactIndex,
  STAGE_NEXT,
  formatFailures,
} from '../../../hooks/lib/verify.mjs';
import {
  decisionComplete,
  optionList,
  triage,
  TRIAGE_LABEL,
  parseDecision,
  applyDecision,
  renderDecisionsMd,
  parseDecisionsMd,
  recheckAdrHumanDecisions,
} from './decisions.mjs';

export function cmdResume(target, slug, opts) {
  const tasksDir = join(target, '.ai/tasks');

  if (!slug) {
    const tasks = listOpenTasks(tasksDir);
    if (!tasks.length) die(`没有任务可恢复：${tasksDir} 下没有 state.json（先 bash scripts/init-harness.sh <slug> 建档）`, 64);
    console.log(`[harness] resume ${target} —— ${tasks.length} 个任务`);
    let pending = 0;
    for (const t of tasks) {
      if (!t.state) { console.log(`  ! ${t.slug}  state.json 无法解析`); pending += 1; continue; }
      const open = (t.state.todos || []).filter((x) => x.status !== 'completed' && x.status !== 'done').length;
      const blockers = (t.state.blockers || []).filter((b) => !b.resolved);
      if (t.state.stage !== 'done' && blockers.length) pending += 1;
      console.log(`  · ${t.slug}  stage=${t.state.stage || '?'}  未完成 TODO ${open}  未决 blocker ${blockers.length}`);
    }
    console.log(`\n逐条处理：node scripts/harness-cli.mjs resume ${target} <slug>`);
    return pending ? 3 : 0;
  }

  const statePath = join(tasksDir, slug, 'state.json');
  if (!existsSync(statePath)) die(`任务不存在：${statePath}`, 64);
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (e) {
    die(`${statePath} 不是合法 JSON：${e.message}（先修文件，resume 不会替你重写）`, 64);
  }
  state = migrate(state).state;

  const blockers = state.blockers || [];
  /** 决策单路径：固定放在任务目录里，与 state.json 同级、一起入库。 */
  const mdAbs = join(tasksDir, slug, 'DECISIONS.md');

  console.log(`[harness] resume ${slug}`);
  console.log(`  stage  ${state.stage}${STAGE_NEXT[state.stage] ? `（下一阶段 ${STAGE_NEXT[state.stage]}）` : ''}  ·  ${(state.todos || []).length} 个 TODO`);

  // ---- 产物索引（提示性，不参与判定） ----
  // artifacts 只回答"产物在哪"，不回答"产物够不够"（后者归 stage gate）。
  // 所以这里只列路径与存在性：缺了提示、形状怪了提示，都不改 exit code——
  // 把声明当门禁会给出"路径存在=产物合格"的假安全感（失效点 §15）。
  {
    const idx = artifactIndex(state, target);
    if (idx.entries.length || idx.odd.length) {
      const missing = idx.entries.filter((e) => e.exists === false);
      console.log(
        `  产物索引  ${idx.entries.filter((e) => e.exists === true).length}/${idx.entries.filter((e) => e.exists !== null).length} 存在` +
          (missing.length ? `（缺 ${missing.length}）` : '')
      );
      for (const e of idx.entries) {
        if (e.path === null) continue;
        console.log(`    ${e.exists ? '·' : '!'} ${e.key.padEnd(14)} ${e.path}`);
      }
      if (missing.length) console.log('    ! 缺的产物先按目录约定找（docs/0x-*/、.ai/tasks/<slug>/artifacts/），找到后把实际路径写回 artifacts');
      for (const o of idx.odd) {
        console.log(`    ! artifacts.${o.key} 是 ${o.type}，不是路径 —— 索引只收路径；说明性内容请放 meta.notes（本提示不改写你的 state）`);
      }
    }
  }

  // ---- 回填 ----
  // --decide 只作用于 human_decision（人拍的板）；
  // --resolve 作用于其余 blocker（能力缺失/环境问题），同样必须记名——
  // 否则"能力阻断"会变成一句谁也说不清什么时候消失的备注。
  const dirty = [];
  const record = (b, ids, text, kind) => {
    if (decisionComplete(b) && b.decision !== text) {
      die(
        `${b.id} 已有结论「${b.decision}」（${b.resolved_by}）。改结论请显式给出新的 --${kind} ${b.id}=<内容> 并说明理由，resume 不会静默改写已生效的记录`,
        64
      );
    }
    applyDecision(b, ids, text, opts.by);
    dirty.push(`${b.id}=${text}`);
  };
  const fill = (specs, kind) => {
    for (const spec of specs) {
      const eq = spec.indexOf('=');
      if (eq <= 0) die(`--${kind} 需要 <id>=<内容> 形式，收到：${spec}`, 64);
      const id = spec.slice(0, eq).trim();
      const value = spec.slice(eq + 1).trim();
      if (!value) die(`--${kind} ${id}= 没有给内容`, 64);
      const b = blockers.find((x) => x.id === id);
      if (!b) die(`没有 id 为 ${id} 的 blocker（现有：${blockers.map((x) => x.id).join('、') || '无'}）`, 64);
      if (kind === 'decide' && b.type !== 'human_decision') {
        die(`${id} 不是待裁决决策（type=${b.type}）——能力/环境类阻断用 --resolve ${id}=<怎么解决的>`, 64);
      }
      if (kind === 'resolve' && b.type === 'human_decision') {
        die(`${id} 是要人拍板的决策（type=human_decision）——用 --decide ${id}=<选择> 记录，别用 --resolve 混过去`, 64);
      }
      if (kind === 'decide') {
        // 决策必须落在选项表内：否则 options 只是装饰，机器无法判断"人到底选了啥"（§16）。
        const parsed = parseDecision(b, value);
        if (parsed.error) die(`${id} ${parsed.error}`, 64);
        record(b, parsed.ids, parsed.text, 'decide');
      } else {
        record(b, [], value, 'resolve');
      }
    }
  };
  fill(opts.decide, 'decide');
  fill(opts.resolve, 'resolve');

  // ---- 从决策单读回 ----
  // 载体从"一次 stdout"变成"一份可留存的文件"：能入库、能转发、能在手机上改、能隔天再填。
  if (opts.from) {
    const fromAbs = existsSync(opts.from)
      ? opts.from
      : existsSync(join(target, opts.from))
        ? join(target, opts.from)
        : join(target, '.ai/tasks', slug, opts.from);
    if (!existsSync(fromAbs)) die(`决策单不存在：${fromAbs}`, 64);
    const entries = parseDecisionsMd(readFileSync(fromAbs, 'utf8'));
    if (!entries.length) {
      die(`${fromAbs} 里没有任何已填的「回填：」或勾选项——先把它填了再读，空单读进来等于什么都没说`, 64);
    }
    for (const e of entries) {
      const b = blockers.find((x) => x.id === e.id);
      if (!b) {
        console.log(`  ! 决策单里的 ${e.id} 在 state 里不存在，跳过（单子过期了？重跑 resume 会重新生成）`);
        continue;
      }
      if (b.type !== 'human_decision') {
        console.log(`  ! ${e.id} 是非决策类阻断，决策单填不了它，跳过`);
        continue;
      }
      const raw = e.fill || e.checks.join(',');
      const parsed = parseDecision(b, raw);
      if (parsed.error) die(`${e.id} ${parsed.error}`, 64);
      record(b, parsed.ids, parsed.text, 'decide');
    }
  }

  // ---- 批量接受建议 ----
  // 只作用于第三节（default_ok=true）：有安全默认、且 blocker 作者显式授权过。
  // 第一、二节必须逐条填——批量批掉"需要你拍板"的事，等于把授权自己给自己。
  if (opts.acceptSuggested) {
    const except = new Set(opts.except || []);
    for (const b of blockers) {
      if (b.type !== 'human_decision' || decisionComplete(b)) continue;
      if (triage(b) !== 'default') continue;
      if (except.has(b.id)) continue;
      if (!b.recommendation) {
        console.log(`  ! ${b.id} 标了 default_ok 却没有 recommendation，无法按建议接受，留给你手填`);
        continue;
      }
      const parsed = parseDecision(b, b.recommendation);
      if (parsed.error || !parsed.ids.length) {
        // 建议文本映射不到选项，说明这条没有"机器可判的默认值"。
        // 以前这里退化成"记自由文本 + decision_ids: []"，于是批量接受成了绕过枚举校验的后门：
        // 前面 --decide 严、--accept-suggested 松，同一个字段两种口径（§16）。
        console.log(
          `  ! ${b.id} 的 recommendation 映射不到任何选项（${parsed.error || '没解析出编号'}）—— 这条留给你手填，不给假默认`
        );
        continue;
      }
      record(b, parsed.ids, parsed.text, 'decide');
    }
    if (!dirty.length) console.log('  （没有可批量接受的项：第三节为空，或都已定过）');
  }


  // ---- 报告待决项（回填之后重新算：刚回填的那几条不该再出现在"待裁决"里） ----
  // 分三档呈现，不按数组顺序平铺：8 条同权铺开的结果是"这么多，回头再说"，
  // 停点就失效了。人真正要先想的通常只有 2–3 条。
  const openNow = blockers.filter((b) => !b.resolved);
  const decisions = openNow.filter((b) => b.type === 'human_decision');
  const others = openNow.filter((b) => b.type !== 'human_decision');
  const groups = { block: [], defer: [], default: [] };
  for (const b of decisions) groups[triage(b)].push(b);

  if (decisions.length) {
    for (const key of ['block', 'defer', 'default']) {
      const list = groups[key];
      if (!list.length) continue;
      console.log(`\n  ${TRIAGE_LABEL[key]}（${list.length} 项）：`);
      for (const b of list) {
        console.log(`   ${b.id}  ${b.question}`);
        const opts = optionList(b);
        if (opts.length) console.log(`        ${b.multi ? '多选' : '单选'}：${opts.map((o) => `${o.id}. ${o.label}`).join('   ')}`);
        if (b.recommendation) console.log(`        建议：${b.recommendation}`);
        if (b.defer_until) console.log(`        前置：${b.defer_until} 完成后再定`);
        for (const e of (b.evidence || []).slice(0, 2)) console.log(`        依凭：${e}`);
      }
    }
    if (groups.default.length) {
      console.log(`\n  批量处理：node scripts/harness-cli.mjs resume <项目> ${slug} --accept-suggested --by <你的名字>${' '}`);
      console.log(`  逐条处理：填 ${relative(target, mdAbs) || mdAbs} 的「回填：」行，再 --from DECISIONS.md`);
    } else {
      console.log(`\n  逐条处理：填 ${relative(target, mdAbs) || mdAbs} 的「回填：」行，再 --from DECISIONS.md`);
    }
  }
  if (others.length) {
    console.log(`\n  非决策类阻断 ${others.length} 项（决策单填不了，需补能力或换会话后重跑）：`);
    for (const b of others) {
      console.log(`   ${b.id}  ${b.question}`);
      if (b.remediation) console.log(`        补什么：${b.remediation.missing || '—'}；谁：${b.remediation.who || '—'}；重跑：${b.remediation.rerun || '—'}`);
    }
  }

  // ---- 可开工清单：blocked_by 全部已解（决策解了 / TODO 完成） ----
  const resolvedIds = new Set(blockers.filter((b) => b.resolved).map((b) => b.id));
  const doneTodos = new Set((state.todos || []).filter((t) => t.status === 'completed' || t.status === 'done').map((t) => t.id));
  const readyNow = (state.todos || []).filter(
    (t) =>
      t.status !== 'completed' &&
      t.status !== 'done' &&
      (t.blocked_by || []).every((d) => resolvedIds.has(d) || doneTodos.has(d))
  );
  console.log(`\n  可立即开工：${readyNow.length ? readyNow.map((t) => `${t.id}(${t.stack})`).join(' ') : '无——依赖未解或已全部完成'}`);

  // ---- 机器可判的门禁 ----
  // 顺序有讲究：adr 的决策检查先按"回填后的 state"刷新，再算 gate 结论。
  // 反过来就会出现同一个进程里自相矛盾——刚把决策填完，报告里还是上一轮的 fail。
  if (state.stage === 'adr') recheckAdrHumanDecisions(state);

  const problems = [];
  // 收尾判据单独一列：它不是"校验失败"，而是"还没到推进的时候"。
  // impl 进行中本来就该有 pending/doing——把它算成失败会让每一次中途 resume 都报红，
  // 而报红多了人就学会无视（比不报更糟）。
  let closure = [];
  try {
    problems.push(...checkStage(state));
    problems.push(...validateTodos(state.todos || [], target, { mode: 'local' }));
    problems.push(...checkStageExit(state, target));
    problems.push(...checkRetroLanding(state, target));
    problems.push(...checkTaskTraceability(state, target));
    closure = checkStageTodoClosure(state);
  } catch (e) {
    problems.push({ id: '(task)', rule: 'check', reason: `校验异常：${e.message}` });
  }

  // 门禁结论不能由"推进"这个动作代替：见 stageGate 的注释（P1-1 实测复现过
  // gate=fail 被推成 history.gate=pass）。
  const gate = stageGate(state);

  // 阻断只算"必须现在定"的档：defer_until / default_ok 的项本来就允许先干再定，
  // 把它们也算进阻塞，等于三档分诊白做——屏幕分了档，判定还按一档算。
  const stillOpen = (state.blockers || []).filter((b) => !b.resolved);
  const blockingNow = stillOpen.filter((b) => b.type !== 'human_decision' || triage(b) === 'block');
  const deferredNow = stillOpen.filter((b) => !blockingNow.includes(b));

  const gateReady = gate.evaluated && gate.failed.length === 0;
  const canAdvance =
    blockingNow.length === 0 && problems.length === 0 && closure.length === 0 && gateReady && !!STAGE_NEXT[state.stage];

  // 三次打回降档（P2-①）：同一阶段被反复进入 ≥3 次后，机械拦截不再提供增量信息，
  // 只提供"怎么绕过它"的动机。计数口径是**同阶段重复进入次数**——不是 gate=fail 条数：
  // 实测（ai-review-notify ci↔retro 三轮）真实 state 里 gate 只有 pass/deferred，
  // 循环靠"同一阶段反复出现"表达，数 fail 永远数不到（第一版就数错了，复审抓回）。
  // 降档不是免检：仍要求具名放行（--ack-strikes <人>），推进时记进 stage_history；
  // 其他拦截（blocker/校验/收尾）也一律不降档。
  const strikes = (Array.isArray(state.stage_history) ? state.stage_history : []).filter(
    (h) => h && h.stage === state.stage
  ).length;
  const strikeLeniency =
    gate.failed.length > 0 && strikes >= 3 && !!opts.ackStrikes && blockingNow.length === 0 && problems.length === 0 && closure.length === 0;
  if (gate.failed.length && strikes >= 3 && !opts.ackStrikes && opts.advance) {
    console.log(
      `\n  ! 同一阶段（${state.stage}）已第 ${strikes} 次打回——机械拦截不再提供增量信息。\n` +
        `    确属应放行（例如门禁误判、或失败项确已知且被接受）：加 --ack-strikes <你的名字> 具名降档；\n` +
        `    否则修完重跑门禁。降档会记进 stage_history，不是无痕豁免。`
    );
  }

  if (problems.length) {
    console.log(`\n  机器校验未通过（${problems.length} 项）：\n${formatFailures(problems)}`);
  }
  if (!gate.evaluated) {
    console.log(`\n  门禁未就绪：${gate.reason}`);
  } else if (gate.failed.length) {
    console.log(`\n  门禁未通过（${gate.failed.length} 项）：${gate.reason}。修完重跑该阶段门禁并把结果写回 gate_result.checks。`);
  }
  if (closure.length) {
    // 用判据原文而不是另写一句：同一件事两套措辞，迟早有一处说错。
    console.log(`\n  推进前还差（${closure.length} 项，不挡你看进度，只挡推进）：\n${formatFailures(closure)}`);
  }
  if (blockingNow.length) {
    // 决策与能力分开数：混在一行会让人以为"换个会话就能全解"。
    const dec = blockingNow.filter((b) => b.type === 'human_decision');
    const cap = blockingNow.filter((b) => b.type !== 'human_decision');
    const parts = [];
    if (dec.length) parts.push(`${dec.length} 项待决（${dec.map((b) => b.id).join('、')}）`);
    if (cap.length) parts.push(`${cap.length} 项要补能力（${cap.map((b) => b.id).join('、')}）`);
    console.log(`\n  仍卡在：${parts.join(' ＋ ')}。`);
  }
  if (deferredNow.length) {
    console.log(
      `  可稍后定：${deferredNow.length} 项（${deferredNow.map((b) => b.id).join('、')}）—— 不挡推进，但别忘了回来填。`
    );
  }

  // ---- 落盘 ----
  if (dirty.length) {
    const target2 = assertWritableUnder(target, `.ai/tasks/${slug}/state.json`);
    writeAtomic(target2, JSON.stringify(state, null, 2) + '\n');
    console.log(`\n  已回填：${dirty.join('、')}（决策人 ${opts.by}）`);
  }

  // ---- 刷新决策单（幂等） ----
  // 停完第一次跑 resume 就有单子可填，不用另学一个动词。
  // 但**绝不覆盖人已经填好还没应用的输入**——那是最贵的内容，冲掉一次人就不再用它了。
  const mdPending = (state.blockers || []).filter((b) => b.type === 'human_decision' && !decisionComplete(b));
  if (mdPending.length) {
    const next = renderDecisionsMd(slug, state, target);
    let prev = null;
    if (existsSync(mdAbs)) {
      try {
        prev = readFileSync(mdAbs, 'utf8');
      } catch {
        prev = null;
      }
    }
    const unfilled = prev
      ? parseDecisionsMd(prev).filter((e) => {
          const b = (state.blockers || []).find((x) => x.id === e.id);
          return b && b.type === 'human_decision' && !decisionComplete(b);
        })
      : [];
    if (unfilled.length && !opts.from) {
      console.log(
        `  ! ${relative(target, mdAbs)} 里有你填好但还没应用的 ${unfilled.length} 项（${unfilled.map((e) => e.id).join('、')}）——` +
          `先用 --from DECISIONS.md 读回来；本次没有覆盖你的填写`
      );
    } else if (prev !== next) {
      writeAtomic(assertWritableUnder(target, `.ai/tasks/${slug}/DECISIONS.md`), next);
      console.log(`  · 决策单：${relative(target, mdAbs)}`);
    }
  }

  // ---- 推进 ----
  if (opts.advance && !canAdvance && !strikeLeniency) {
    const why = blockingNow.length
      ? `${blockingNow.length} 个必须现在定的 blocker 未解（${blockingNow.map((b) => b.id).join('、')}）`
      : problems.length
        ? `${problems.length} 项机器校验未过`
        : closure.length
          ? `本阶段还有 ${closure.length} 个 TODO 未收尾（${closure.map((c) => c.id).join('、')}）`
          : !gate.evaluated
          ? `门禁未评估：${gate.reason}`
          : gate.failed.length
            ? `门禁未通过：${gate.reason}`
            : '当前阶段没有下一阶段（已在 done）';
    die(`不能推进：${why}`, 3);
  }
  if ((canAdvance || strikeLeniency) && (opts.advance || dirty.length)) {
    const from = state.stage;
    const to = STAGE_NEXT[from];
    const hist = Array.isArray(state.stage_history) ? state.stage_history : [];
    const last = hist[hist.length - 1];
    if (last && last.stage === from && !last.exited_at) {
      last.exited_at = nowIso();
      // 这里的 gate 结论必须是**实际评估出来的**，不是"没报错就算过"。
      last.gate = problems.length || !gateReady ? 'fail' : 'pass';
    }
    hist.push({
      stage: to,
      entered_at: nowIso(),
      exited_at: null,
      gate: 'pending',
      waived_by: strikeLeniency ? `${opts.ackStrikes}（三次打回降档：${from} 连续第 ${strikes} 次 gate=fail 后具名放行）` : null,
      agent: 'harness-cli resume',
      model: null,
      skill_versions: {},
      note: `由 resume 推进（上一阶段 gate=${problems.length || !gateReady ? 'fail' : 'pass'}；阻塞项 0，另有 ${deferredNow.length} 项可稍后定）。下一阶段门禁需在此阶段内重新评估`,
    });
    state.stage_history = hist;
    state.stage = to;
    // 推进后把 gate_result 显式清成「本阶段尚未评估」。
    //
    // 原来的做法是"原样保留上一次检查"——听起来诚实，实际留下了更糟的东西：
    // 新阶段的 state 里躺着**上一阶段**的结论。ci-verify 只在 stage 对不上时报警，
    // 于是 `{stage: adr, checks:[{pass:false}]}` 跟着任务漂到 impl，没人知道 impl 到底评没评。
    // TDC 那份 state 就是这么来的（stage=impl，gate_result.stage=adr），最后靠人手清。
    //
    // 清成空 checks 而不是写 pass：工具不能替人补一次没跑过的检查，那正是 §15。
    // stageGate() 对空 checks 的判词是"尚未评估"，这才是真的状态。
    state.gate_result = {
      stage: to,
      last_check: null,
      checks: [],
      note: `由 resume 从 ${from} 推进；本阶段门禁尚未评估`,
    };
    writeAtomic(assertWritableUnder(target, `.ai/tasks/${slug}/state.json`), JSON.stringify(state, null, 2) + '\n');
    console.log(`\n  → 推进：${from} → ${to}。本阶段门禁已清空（未评估），下一步按 ${to} 的门禁准备产物并写回 gate_result。`);
    return 0;
  }

  if (canAdvance) console.log(`\n  条件已满足，加 --advance 推进到 ${STAGE_NEXT[state.stage]}。`);
  // "可稍后定"的项不再影响退出码：三档分诊的意义就是让第二节不挡路。
  // 但机器校验未过仍返回 3——那是失败，不是待办。
  return blockingNow.length || problems.length ? 3 : 0;
}
