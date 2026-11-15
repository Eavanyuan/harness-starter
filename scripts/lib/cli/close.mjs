/**
 * close —— 任务一键收尾（2026-11-14，U4/U5/U7 修复）。
 *
 * 为什么需要它：S 档从 init 到 done 的"最小合法路径"此前只存在于读过源码的人脑子里
 * ——gate 日志要在特定状态组合下产生（自指：gate 校验的状态还没引用它自己的证据），
 * 收尾要手填 todos 的 verify/audit 四项、retro 命名、多轮状态翻转。走查定性为 S1。
 * close 把这条路固化成一个命令：
 *
 *   1. 前置检查：todos 全完成（收尾 gate TODO 除外，缺则自动补 pending）
 *   2. retro：artifacts.retro 已指文件则用之；缺则按新规生成 retro/<slug>-*.md 模板
 *   3. bootstrap：stage 落到 impl、gate TODO pending → 跑 gate（verify-run --task 包装，
 *      日志带归属头）→ 绿则翻 done（gate TODO completed + ci/retro 记 pass）；
 *      红则状态还原、指路日志路径，exit 1
 *   4. 幂等：已 done 直接说已收尾
 *
 * gate 命令固定为 npm run gate（在目标仓跑）——测试桩化见 test/harness-cli.test.sh §52 注释。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { die, writeAtomic, assertWritableUnder, nowIso } from './shared.mjs';
import { migrate, checkStageExit } from '../../../hooks/lib/verify.mjs';

export function cmdClose(target, slug, opts = {}) {
  if (!slug) die('用法: harness close <项目> <slug> [--by <名字>]', 64);
  const statePath = join(target, `.ai/tasks/${slug}/state.json`);
  if (!existsSync(statePath)) die(`任务不存在：${statePath}`, 64);
  let state;
  try {
    state = migrate(JSON.parse(readFileSync(statePath, 'utf8'))).state;
  } catch (e) {
    die(`state 无法解析：${e.message}`, 1);
  }
  if (state.stage === 'done') {
    console.log(`已收尾过：${slug}（stage=done）——无事可做`);
    return 0;
  }

  const meta = state.meta || {};
  const tier = meta.flow_tier || 'S';

  // ---- 1. gate TODO：缺则补 pending；其余 TODO 必须已完成 ----
  let todos = Array.isArray(state.todos) ? state.todos : [];
  // 日志/TODO id 按 slug 派生：固定 id 会在第二个任务上撞归属保护
  // （verify-run 拒绝覆盖被他人引用的证据——实测 usability-fixes 后 ack-hotfix 即撞）。
  const gateId = `CLOSE-GATE-${String(slug).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)}`;
  let gateTodo = todos.find((t) => t.id === gateId);
  if (!gateTodo) {
    gateTodo = {
      id: gateId,
      title: '收尾 gate 全量（close 自动）',
      status: 'pending',
      files: [],
      verify: null,
      ooda_stage: 'act',
      audit: null,
    };
    todos.push(gateTodo);
  }
  const open = todos.filter((t) => t.id !== gateId && t.status !== 'completed' && t.status !== 'done');
  if (open.length) {
    die(`还有 ${open.length} 个 TODO 未完成（${open.map((t) => t.id).join('、')}）——先做完或移出本任务，close 只管收尾`, 1);
  }
  const logRel = (gateTodo.verify && gateTodo.verify.log_path) || `.ai/verify/${gateId}.log`;

  // ---- 2. retro：新规要求文件名以 slug 开头（checkRetroLanding）----
  let artifacts = state.artifacts && typeof state.artifacts === 'object' ? state.artifacts : {};
  if (Array.isArray(artifacts)) artifacts = {};
  if (!artifacts.retro) {
    const retroRel = `retro/${slug}-收尾.md`;
    const retroAbs = join(target, retroRel);
    if (!existsSync(retroAbs)) {
      mkdirSync(join(target, 'retro'), { recursive: true });
      writeFileSync(retroAbs, `# ${slug} 收尾（close 生成模板）\n\n> 由 harness close 于 ${nowIso().slice(0, 10)} 生成——把做了什么、留下什么经验填进来，\n> 三五行就够；空模板交差会被 CR 打回。\n\n## 做了什么\n\n（TODO）\n\n## 留下的经验\n\n（TODO）\n`);
    }
    artifacts.retro = retroRel;
  }
  const retroAbs = join(target, artifacts.retro);
  if (!existsSync(retroAbs)) die(`artifacts.retro 指向的文件不存在：${artifacts.retro}`, 1);

  // ---- 3. 状态整形：S 档补缺的 skipped 站（逐站记名），review 记 pass ----
  let hist = Array.isArray(state.stage_history) ? state.stage_history : [];
  const had = new Set(hist.map((h) => h && h.stage).filter(Boolean));
  if (tier === 'S') {
    for (const st of ['rs', 'adr', 'fs_review', 'wbs']) {
      if (!had.has(st)) hist.push({ stage: st, gate: 'deferred', waived_by: 'S 档裁剪（close 补记）：无该阶段产出要求' });
    }
  }
  if (!had.has('impl')) hist.push({ stage: 'impl', gate: 'pass' });
  if (!had.has('review')) hist.push({ stage: 'review', gate: 'pass', note: 'close 收尾（套件见 CLOSE-GATE 日志）' });

  // 进入前完整快照（复审 A#1：旧版只快照 stage/todos，失败回滚不落盘还谎报"已还原"，
  // 磁盘残留 bootstrap 态——0374794 即实证）。失败时按快照 writeAtomic 回写。
  const prevState = JSON.parse(JSON.stringify(state));
  const finish = () => {
    gateTodo.status = 'completed';
    gateTodo.verify = { log_path: logRel, command: 'npm run gate（harness close）' };
    gateTodo.ooda_stage = 'audit';
    gateTodo.audit = {
      compile: 'PASS（gate 全量）',
      tests: 'gate 全量绿（见日志）',
      feature_complete: 'close 一键收尾',
      quality_clean: '日志带归属头（verify-run --task）',
    };
    hist.push({ stage: 'ci', gate: 'pass', note: `close：gate 全量绿（${logRel}）` });
    hist.push({ stage: 'retro', gate: 'pass', note: artifacts.retro });
    state.stage = 'done';
    // 零业务 TODO 的收尾（只有 CLOSE-GATE）：done-exit 判据要求说明为什么没有 todos
    if (!todos.some((t) => t.id !== gateId)) {
      state.meta = { ...meta, no_todo_reason: 'close 收尾：无业务 TODO（证据型/演练型任务），验证见 CLOSE-GATE 日志' };
    }
    state.stage_history = hist;
    state.artifacts = artifacts;
    state.todos = todos;
    state.gate_result = { stage: 'done', last_check: nowIso(), checks: [{ name: 'close: gate+retro+证据', pass: true }] };
    const exit = checkStageExit(state, target);
    if (exit.length) {
      rollback();
      die(`收尾判据未过（状态已按进入前快照回写）：\n${exit.map((f) => `  ✗ ${f.reason}`).join('\n')}`, 1);
    }
    writeAtomic(assertWritableUnder(target, `.ai/tasks/${slug}/state.json`), JSON.stringify(state, null, 2) + '\n');
  };
  const rollback = () => {
    writeAtomic(assertWritableUnder(target, `.ai/tasks/${slug}/state.json`), JSON.stringify(prevState, null, 2) + '\n');
  };

  // bootstrap 写盘：stage=impl + gate TODO pending —— 让 gate 的 verify:state 不校验
  // "done 需要一份它自己即将产出的证据"（自指困境，U5）。
  state.stage = 'impl';
  gateTodo.status = 'pending';
  state.todos = todos;
  state.stage_history = hist;
  state.artifacts = artifacts;
  writeAtomic(assertWritableUnder(target, `.ai/tasks/${slug}/state.json`), JSON.stringify(state, null, 2) + '\n');

  // ---- 4. 跑 gate（verify-run 包装：归属头 + 标准日志）----
  // 只跑真 gate：S 档折叠判据只认 cmd 含 npm run gate 的日志——留命令注入口等于
  // 教人造过不了判据的假证据（测试要提速就在目标仓把 gate 脚本桩化，命令行不变）。
  const gateCmd = 'npm run gate';
  console.log(`[close] ${slug}：bootstrap(impl) → 跑 gate：${gateCmd}`);
  const r = spawnSync('bash', [join(target, 'scripts/verify-run.sh'), '--task', slug, gateId, '--', ...gateCmd.split(' ')], {
    cwd: target,
    stdio: 'inherit',
    env: process.env,
  });
  const code = r.status;
  const logAbs = resolve(target, logRel);
  if (code !== 0 || !existsSync(logAbs)) {
    rollback();
    die(`gate 未过（exit=${code}）。日志：${logRel}\n状态已按进入前快照回写（${prevState.stage}）——修完重跑 close；不要手工改 state 绕`, 1);
  }
  finish();
  console.log(`[close] ${slug} 收尾完成：stage=done，gate 证据 ${logRel}，retro ${artifacts.retro}。`);
  console.log(`[close] 记得把证据日志与 retro 随代码提交入库（CI 口径只认 git 里的事实）。`);
  return 0;
}
