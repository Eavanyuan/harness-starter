#!/usr/bin/env node
/**
 * L2 端到端：真 GitLab CE（本机 :8929）→ 真 webhook → 真 broker → 真账本。
 *
 * 为什么 L1 全绿了还要 L2：mock 只能证明「我以为 GitLab 发什么」，证明不了
 * 「GitLab 真的发什么」。方案 D 的全部风险都压在这三个假设上——
 *   1. push 事件里 commits[] 的 author 是谁（尤其是 MR 合并那一刻）；
 *   2. `/repository/commits/:sha/diff` 的返回形状（new_path / diff 前缀行）；
 *   3. 分支保护 + webhook 密钥在真实实例上真的生效。
 * 这三条一旦和 mock 不一致，L1 的 43 条断言全绿也没有意义。
 *
 * 跑法：
 *   node test/e2e/gitlab-decision.e2e.mjs            # 需先起 harness-gitlab 容器
 *   npm run e2e
 * 前置：gitlab-arm64/run-harness-gitlab.sh（HTTP :8929，root 密码见 env）
 * 环境：GITLAB_E2E_URL / GITLAB_E2E_ROOT_PASSWORD / GITLAB_E2E_KEEP=1（保留项目便于排查）
 *
 * 退出码：0 全过；1 有断言红；78 环境没起来（不强求进 gate，见 package.json 的 e2e 单独命令）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const BASE = (process.env.GITLAB_E2E_URL || 'http://127.0.0.1:8929').replace(/\/+$/, '');
const ROOT_PW = process.env.GITLAB_E2E_ROOT_PASSWORD || 'HarnessE2E!2026';
// 每次跑用带时间戳的路径：GitLab 的删除是"7 天后真删"，同名路径在缓刑期内一直被占，
// 固定名字会让第二次跑直接 400 path already taken（本地一次性环境不值得为此关实例策略）。
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const PROJ = `${process.env.GITLAB_E2E_PROJECT || 'harness-e2e-rs'}-${STAMP}`;
const SECRET = 'e2e-webhook-secret';
const KEEP = process.env.GITLAB_E2E_KEEP === '1';
const ADMIN_TOKEN = process.env.GITLAB_E2E_ADMIN_TOKEN || '';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, actual, expect) {
  if (String(actual) === String(expect)) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}  (期望 ${expect}，实际 ${actual})`);
    fail++;
    failures.push(`${name}：期望 ${expect}，实际 ${actual}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- GitLab API
let adminToken = ADMIN_TOKEN;
async function api(method, path, body, token = adminToken, { allowFail = false } = {}) {
  const res = await fetch(`${BASE}/api/v4${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok && !allowFail) throw new Error(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, json };
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return { raw: s }; } };

/** 管理员令牌：优先 env；否则用 root 密码走 OAuth password grant（不需要 docker exec）。 */
async function adminTokenOf() {
  if (adminToken) return adminToken;
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'password', username: 'root', password: ROOT_PW }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`拿 root 令牌失败：HTTP ${res.status}（密码是否为 ${ROOT_PW}？）`);
  const j = await res.json();
  adminToken = j.access_token;
  return adminToken;
}

async function ensureUser(username, name, email) {
  const found = await api('GET', `/users?username=${encodeURIComponent(username)}`);
  if (Array.isArray(found.json) && found.json.length) return found.json[0];
  const { json } = await api('POST', '/users', {
    username, name, email, password: 'Kx7#pQ2mZvL9', skip_confirmation: true,
  });
  return json;
}

async function ensurePat(userId, name) {
  const { json } = await api('POST', `/users/${userId}/personal_access_tokens`, {
    name, scopes: ['api', 'write_repository'], expires_at: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
  });
  if (!json?.token) throw new Error(`PAT 没返回明文 token：${JSON.stringify(json).slice(0, 200)}`);
  return json.token; // 只在创建时返回一次
}

/** 容器回连宿主机用哪个地址：Docker Desktop 的 host.docker.internal 在本机解析成 IPv6 ULA，
 *  而 webhook 投递端有时又走 IPv4，两个族都要能命中才稳定 → 统一用宿主 LAN IPv4。 */
function hostForContainer() {
  if (process.env.GITLAB_E2E_HOOK_BASE) return process.env.GITLAB_E2E_HOOK_BASE;
  for (const nic of ['en0', 'en1']) {
    const r = spawnSync('ipconfig', ['getifaddr', nic], { encoding: 'utf8' });
    const ip = (r.stdout || '').trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return `http://${ip}`;
  }
  return 'http://host.docker.internal';
}

// ---------------------------------------------------------------- git
function gitUrl(token) {
  const u = new URL(BASE);
  return `${u.protocol}//oauth2:${token}@${u.host}/root/${PROJ}.git`;
}
/** 令牌不能进日志：报错里出现的 URL 一律打码。 */
const mask = (s) => String(s).replace(/oauth2:[^@\s]+@/g, 'oauth2:***@');
function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${mask(args.join(' '))} 失败：${mask(r.stderr || '').trim().slice(0, 400)}`);
  return r;
}
/** 新建项目/新加成员后，仓库初始化与授权缓存都有几秒延迟——git 侧表现为 404，
 *  但 API 侧已经 200。硬等一次就断言等于让环境噪声冒充产品缺陷，这里退避重试。 */
async function cloneWithRetry(target, token) {
  mkdirSync(target, { recursive: true });
  let last;
  for (let i = 0; i < 12; i++) {
    const r = git(target, ['clone', '--quiet', gitUrl(token), target], { allowFail: true });
    if (r.status === 0) return;
    last = r;
    await sleep(2000);
  }
  throw new Error(`git clone 一直失败（12 次 / 24s）：${mask(last?.stderr || '').trim().slice(0, 300)}`);
}

function decideInFile(dir, op, choice, who) {
  const p = join(dir, 'docs/RS-x.md');
  const text = readFileSync(p, 'utf8');
  const esc = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\|\\s*${esc}\\s*\\|[^|]*\\|)[^|]*(\\|)$`, 'm');
  if (!re.test(text)) throw new Error(`种子文档里没有 ${op} 行`);
  const stamp = `已裁决：${choice}（${who} @ 2026-11-07 20:00 git 批红）`;
  writeFileSync(p, text.replace(re, `$1 ${stamp} $2`));
}
function commitAndPush(dir, token, { branch = 'main', message, name, email }) {
  git(dir, ['add', '-A']);
  git(dir, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', message]);
  const sha = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  git(dir, ['push', gitUrl(token), `HEAD:refs/heads/${branch}`]);
  return sha;
}

// ---------------------------------------------------------------- 账本
const EVENTS = () => join(process.env.HARNESS_LEDGER_DIR, 'events.jsonl');
function events() {
  if (!existsSync(EVENTS())) return [];
  return readFileSync(EVENTS(), 'utf8').split('\n').filter(Boolean).map((l) => safeJson(l));
}
const ofType = (t) => events().filter((e) => e.type === t);
async function waitFor(pred, ms = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events().find(pred);
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

// ---------------------------------------------------------------- main
const stateDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'harness-e2e-'));
process.env.HARNESS_LEDGER_DIR = join(stateDir, 'ledger');
process.env.HARNESS_LEDGER_SOURCE = 'selftest';
mkdirSync(process.env.HARNESS_LEDGER_DIR, { recursive: true });

let broker = null;
let brokerPort = 0;
function startBroker(extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'scripts/harness-broker.mjs'), '--port', '0'], {
    env: {
      ...process.env,
      // 绑 0.0.0.0：容器侧用宿主 LAN IPv4 回连（见 hostForContainer 的注释）。
      HOST: '0.0.0.0',
      GITLAB_URL: BASE,
      GITLAB_TOKEN: process.env.GITLAB_TOKEN || '',
      GITLAB_WEBHOOK_SECRET: SECRET,
      GITLAB_DEFAULT_BRANCH: 'main',
      HARNESS_RULES_ROOT: join(stateDir, 'rules'),
      FEISHU_MODE: 'http',
      FEISHU_VERIFY_TOKEN: 'e2e-feishu-token',
      FEISHU_WEBHOOK_URL: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    const m = /PORT (\d+)/.exec(String(d));
    if (m) brokerPort = Number(m[1]);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[broker] ${d}`));
  return child;
}
const stopBroker = () => new Promise((r) => { if (!broker) return r(); broker.once('exit', r); broker.kill('SIGTERM'); broker = null; });

async function main() {
  // ---- 0. 环境自检（不满足就 78，不假装通过）----
  console.log(`\n== 0. 环境 ${BASE} ==`);
  let signIn = '000';
  try { signIn = String((await fetch(`${BASE}/users/sign_in`, { signal: AbortSignal.timeout(5000) })).status); } catch { /* 未启动 */ }
  if (signIn !== '200') {
    console.log(`  \x1b[33m[skip]\x1b[0m GitLab 未就绪（/users/sign_in = ${signIn}）：先跑 gitlab-arm64/run-harness-gitlab.sh`);
    process.exitCode = 78;
    return;
  }
  await adminTokenOf();
  const me = await api('GET', '/user');
  check('用 root 令牌能认出管理员身份', me.json.is_admin, true);
  // broker 的 GITLAB_TOKEN 必须是 PAT：broker 用 `private-token` 头调 API，
  // 而 OAuth access token 走这个头会 401（Bearer 才行）。用错的表现是
  // "webhook 收到了、200 也回了，但一封决策都没落账" —— 最难查的那种。
  const brokerToken = ADMIN_TOKEN || await ensurePat(me.json.id, `e2e-broker-${Date.now()}`);

  // ---- 1. 种子：项目 / 两个用户 / RS 文档 ----
  console.log('\n== 1. 种子数据 ==');
  const rootNs = await api('GET', '/namespaces?search=root');
  const nsId = (rootNs.json.find((n) => n.path === 'root' && n.kind === 'user') || rootNs.json[0]).id;

  const existing = await api('GET', `/projects/${encodeURIComponent(PROJ)}`, undefined, adminToken, { allowFail: true });
  if (existing.status === 200) await api('DELETE', `/projects/${existing.json.id}`);  const { json: proj } = await api('POST', '/projects', {
    name: PROJ, path: PROJ, namespace_id: nsId, initialize_with_readme: true,
    default_branch: 'main', merge_method: 'merge', only_allow_merge_if_pipeline_succeeds: false,
  });
  check('项目建成，默认分支是 main', proj.default_branch, 'main');

  const alice = await ensureUser('alice', 'Alice 甲', 'alice@harness.test');
  const bob = await ensureUser('bob', 'Bob 乙', 'bob@harness.test');
  const alicePat = await ensurePat(alice.id, `e2e-alice-${Date.now()}`);
  const bobPat = await ensurePat(bob.id, `e2e-bob-${Date.now()}`);
  // alice = Maintainer（能直接 push 受保护的 main，模拟"有权批红的人"）
  // bob   = Developer（只能走 MR；这样 scenario 4 里"名单外的人把结论合进 main"才是真实威胁模型）
  await api('POST', `/projects/${proj.id}/members`, { user_id: alice.id, access_level: 40 });
  await api('POST', `/projects/${proj.id}/members`, { user_id: bob.id, access_level: 30 });
  check('alice 是 Maintainer', (await api('GET', `/projects/${proj.id}/members/all/${alice.id}`)).json.access_level, 40);
  check('bob 是 Developer', (await api('GET', `/projects/${proj.id}/members/all/${bob.id}`)).json.access_level, 30);
  check('main 受保护（非 Maintainer 不能直推）',
    (await api('GET', `/projects/${proj.id}/protected_branches/main`, undefined, adminToken, { allowFail: true })).status, 200);
  // 默认保护策略是「Merge 也要 Maintainer」，那 Developer 连 MR 都合不了（API 回 401，
  // 不是 403——这是 GitLab 反直觉的地方）。真实团队通常是"能合不能直推"，
  // 所以重建一次保护规则：merge 放宽到 Developer，push 仍限 Maintainer。
  // 没有 PATCH 接口，只能先删再建；且 allowed_to_* 数组在 CE 下不生效
  // （传了也被忽略，merge 仍是 40），要用单值 merge_access_level / push_access_level。
  await api('DELETE', `/projects/${proj.id}/protected_branches/main`);
  await api('POST', `/projects/${proj.id}/protected_branches`, {
    name: 'main', push_access_level: 40, merge_access_level: 30,
  });
  const pb = (await api('GET', `/projects/${proj.id}/protected_branches/main`)).json;
  check('main 允许 Developer 合并（MR 路径通）',
    pb.merge_access_levels.map((l) => l.access_level).join(','), '30');
  check('main 仍只允许 Maintainer 直推', pb.push_access_levels.map((l) => l.access_level).join(','), '40');

  // PAT 立刻可用是后面所有 git 操作的前提；单独断言一次，免得把"令牌没生效"误诊成"克隆失败"
  const patProbe = await fetch(`${BASE}/api/v4/user`, { headers: { 'private-token': alicePat } });
  check('alice 的 PAT 能通过 git-over-http 认证', (await patProbe.json()).username, 'alice');

  mkdirSync(join(stateDir, 'rules'), { recursive: true });
  copyFileSync(join(ROOT, 'harness.rules.json'), join(stateDir, 'rules/harness.rules.json'));
  const setApprovers = (list) => {
    const p = join(stateDir, 'rules/harness.rules.json');
    const j = safeJson(readFileSync(p, 'utf8'));
    j.notify.git_decision.approvers = list;
    writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  };

  const aliceDir = join(stateDir, 'alice');
  const bobDir = join(stateDir, 'bob');
  mkdirSync(aliceDir, { recursive: true });
  await cloneWithRetry(aliceDir, alicePat);
  mkdirSync(join(aliceDir, 'docs'), { recursive: true });
  writeFileSync(join(aliceDir, 'docs/RS-x.md'), [
    '# RS-X 需求规格',
    '',
    '## 7 开放问题',
    '',
    '| 编号 | 问题 | 状态 |',
    '|---|---|---|',
    '| OP-1 | 用哪个方案 | 开放 |',
    '| OP-2 | 灰度还是全量 | 开放 |',
    '| OP-3 | 特性分支上的结论 | 开放 |',
    '| OP-4 | 名单外的人合进来的 | 开放 |',
    '| OP-5 | 重投幂等 | 开放 |',
    '',
  ].join('\n'));
  const seedSha = commitAndPush(aliceDir, alicePat, {
    message: 'docs: 种子 RS 文档（5 条开放问题）', name: 'Alice 甲', email: 'alice@harness.test',
  });
  check('种子提交推送成功', seedSha.length, 40);

  // 分支保护是方案 D 的实际守门人（approvers 留空时全靠它）：这里直接试一次 bob 直推 main。
  // 必须先造一个真提交——推同一个 commit 是 "Everything up-to-date"，退出码 0，
  // 会把"保护生效"误判成"没生效"。
  await cloneWithRetry(bobDir, bobPat);
  writeFileSync(join(bobDir, 'probe.txt'), 'bob was here\n');
  git(bobDir, ['add', '-A']);
  git(bobDir, ['-c', 'user.name=Bob 乙', '-c', 'user.email=bob@harness.test', 'commit', '-m', 'probe: 直推试试']);
  const blocked = git(bobDir, ['push', gitUrl(bobPat), 'HEAD:refs/heads/main'], { allowFail: true });
  check('bob 直推 main 被分支保护挡下（方案 D 的最后一道门）', blocked.status !== 0, true);
  check('挡下时给的是 GitLab 的拒绝（不是网络错误）',
    /protected branch|not allowed|pre-receive|You are not allowed/i.test(blocked.stderr || ''), true);
  git(bobDir, ['reset', '--hard', 'HEAD~1']); // 恢复干净状态给后面的 MR 用

  // ---- 2. webhook + broker ----
  console.log('\n== 2. webhook → broker ==');
  broker = startBroker({ GITLAB_TOKEN: brokerToken });
  for (let i = 0; i < 100 && !brokerPort; i++) await sleep(100);
  check('broker 起来了', brokerPort > 0, true);
  const health = await (await fetch(`http://127.0.0.1:${brokerPort}/healthz`)).json();
  check('healthz 报 http 模式', health.feishu.mode, 'http');

  // 内网 webhook 默认被 GitLab 拦掉（"Invalid url given"）：这是现实中部署方案 D 的
  // 第一个坑——broker 就在内网，不放行内网请求等于这条路根本走不通。
  await api('PUT', '/application/settings', { allow_local_requests_from_web_hooks_and_services: true });
  check('实例已放行内网 webhook',
    (await api('GET', '/application/settings')).json.allow_local_requests_from_web_hooks_and_services, true);

  const hookBase = hostForContainer();
  const { json: hook } = await api('POST', `/projects/${proj.id}/hooks`, {
    url: `${hookBase}:${brokerPort}/webhook/gitlab`,
    token: SECRET, push_events: true, merge_requests_events: false, enable_ssl_verification: false,
  });
  check(`webhook 指向 broker（容器可达地址 ${hookBase}）`, hook.url.includes(`${brokerPort}/webhook/gitlab`), true);

  // 容器能否回连宿主机：这是"内网里唯一可达的那条边"是否真的通的物理前提
  const probe = spawnSync('docker', ['exec', 'harness-gitlab', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
    '--max-time', '5', `${hookBase}:${brokerPort}/healthz`], { encoding: 'utf8' });
  check('容器内能打到 broker（回连地址通）', (probe.stdout || '').trim(), '200');

  // ---- 3. 默认分支上的裁决 ----
  console.log('\n== 3. 默认分支：alice 改 OP-1 → 落账 ==');
  decideInFile(aliceDir, 'OP-1', 'A', 'Alice 甲');
  const sha1 = commitAndPush(aliceDir, alicePat, {
    message: 'docs(RS-x): OP-1 裁 A', name: 'Alice 甲', email: 'alice@harness.test',
  });
  const e1 = await waitFor((e) => e.type === 'decision_landed' && e.detail?.blocker === 'OP-1');
  check('真实 push 触发了 decision_landed', Boolean(e1), true);
  check('落账结论是 A', e1?.detail?.choice, 'A');
  check('身份取 git author（Alice 甲）', e1?.detail?.by, 'Alice 甲');
  check('来源标 via=git', e1?.detail?.via, 'git');
  check('落账带真实 sha 前 8 位', e1?.detail?.commit, sha1.slice(0, 8));
  check('落账带文件路径', e1?.detail?.file, 'docs/RS-x.md');

  // GitLab 侧投递记录：证明 webhook 真发出去了、broker 真的回了 200（而不是本地自嗨）。
  // 首次投递可能因网络族/连接复用失败而被 GitLab 重试，所以按"最终有一次 200"判定。
  let delivery = null;
  for (let i = 0; i < 60; i++) {
    const { json } = await api('GET', `/projects/${proj.id}/hooks/${hook.id}/events`);
    const hit = json.find((e) => e.response_status === '200' && JSON.stringify(e.request_data).includes(sha1));
    if (hit) { delivery = hit; break; }
    await sleep(1000);
  }
  check('GitLab 记到一次成功投递（broker 回 200）', Boolean(delivery), true);

  // ---- 4. 解析器假设核对：真 diff 形状 ----
  console.log('\n== 4. 真实 diff 形状（解析器的三个假设） ==');
  const { json: diffs } = await api('GET', `/projects/${proj.id}/repository/commits/${sha1}/diff`);
  const d0 = diffs.find((d) => d.new_path === 'docs/RS-x.md');
  check('diff 有 new_path 字段', Boolean(d0), true);
  check('新增行以 "+" 开头且能读出「已裁决」', /^\+.*已裁决：A/m.test(d0.diff), true);
  check('被改的旧行是 "-" 行（不能被当成结论）', /^-\|\s*OP-1\s*\|.*开放/m.test(d0.diff), true);

  // ---- 5. MR 合并：合并那一刻的 author 是谁 ----
  console.log('\n== 5. MR 合并（alice 改 → bob 合） ==');
  git(aliceDir, ['checkout', '-q', '-b', 'feat/op2']);
  decideInFile(aliceDir, 'OP-2', 'B', 'Alice 甲');
  const sha2 = commitAndPush(aliceDir, alicePat, {
    branch: 'feat/op2', message: 'docs(RS-x): OP-2 裁 B', name: 'Alice 甲', email: 'alice@harness.test',
  });
  const { json: mr } = await api('POST', `/projects/${proj.id}/merge_requests`, {
    source_branch: 'feat/op2', target_branch: 'main', title: 'OP-2 裁 B', remove_source_branch: false,
  });
  for (let i = 0; i < 40; i++) {
    const st = (await api('GET', `/projects/${proj.id}/merge_requests/${mr.iid}`)).json;
    if (st.detailed_merge_status === 'mergeable') break;
    await sleep(500);
  }
  const merged = await api('PUT', `/projects/${proj.id}/merge_requests/${mr.iid}/merge`, {
    merge_commit_message: 'Merge branch feat/op2', should_remove_source_branch: false,
  }, bobPat, { allowFail: true });
  check('bob（Developer）能合这个 MR', merged.status, 200);
  if (merged.status !== 200) console.log(`     ↳ 合并被拒原因：${JSON.stringify(merged.json).slice(0, 200)}`);

  await waitFor((e) => e.type === 'decision_landed' && e.detail?.blocker === 'OP-2');
  await sleep(4000); // 给"第二条账"留出出现的窗口：去重失效这类缺陷是慢半秒才现形的
  const op2 = events().filter((e) => e.type === 'decision_landed' && e.detail?.blocker === 'OP-2');
  const who = op2.map((e) => e.detail.by).join(',');
  // 关键断言：一次合并只应落一条账，且身份是"真正改文档的人"。
  // 若 GitLab 的 push 同时带上原提交和合并提交，这里会变成 "Alice 甲,Bob 乙" —— 那就是
  // 一次决策落两次账（账本噪音），必须在 broker 侧按 push 去重。
  check('一次合并只落一条账（不因合并提交重复落账）', op2.length, 1);
  check('身份是改文档的 alice，不是合并的 bob', who, 'Alice 甲');

  // ---- 6. 特性分支不落账 ----
  console.log('\n== 6. 特性分支：还没生效，不落账 ==');
  const before6 = events().length;
  git(aliceDir, ['checkout', '-q', 'main']);
  git(aliceDir, ['checkout', '-q', '-b', 'feat/op3']);
  decideInFile(aliceDir, 'OP-3', 'C', 'Alice 甲');
  commitAndPush(aliceDir, alicePat, {
    branch: 'feat/op3', message: 'docs(RS-x): OP-3 裁 C（未合）', name: 'Alice 甲', email: 'alice@harness.test',
  });
  await sleep(4000);
  check('特性分支的「已裁决」没有落账', events().filter((e) => e.detail?.blocker === 'OP-3').length, 0);
  check('这批 push 一条 decision_landed 都没有（连摘要都不该升级成账）',
    events().slice(before6).filter((e) => e.type === 'decision_landed').length, 0);

  // ---- 7. approvers 名单：名单外的人合进来 = 不落账 ----
  console.log('\n== 7. approvers 名单（fail-closed） ==');
  setApprovers(['alice@harness.test']);
  git(aliceDir, ['checkout', '-q', 'main']);
  // bob 的克隆是早先做的，本地 origin/main 已经落后；先 fetch 再开分支，
  // 否则分支基线是旧 main，合并时同一批表格行会冲突（422 Branch cannot be merged）。
  git(bobDir, ['fetch', '--quiet', gitUrl(bobPat), '+refs/heads/main:refs/remotes/origin/main']);
  git(bobDir, ['checkout', '-q', '-B', 'feat/op4', 'origin/main']);
  mkdirSync(join(bobDir, 'docs'), { recursive: true });
  decideInFile(bobDir, 'OP-4', 'D', 'Bob 乙');
  commitAndPush(bobDir, bobPat, {
    branch: 'feat/op4', message: 'docs(RS-x): OP-4 裁 D（名单外）', name: 'Bob 乙', email: 'bob@harness.test',
  });
  const { json: mr4 } = await api('POST', `/projects/${proj.id}/merge_requests`, {
    source_branch: 'feat/op4', target_branch: 'main', title: 'OP-4 裁 D', remove_source_branch: false,
  });
  let mr4State = null;
  for (let i = 0; i < 40; i++) {
    mr4State = (await api('GET', `/projects/${proj.id}/merge_requests/${mr4.iid}`)).json;
    if (['mergeable', 'conflict'].includes(mr4State.detailed_merge_status)) break;
    await sleep(500);
  }
  check('MR 无冲突（分支基线是最新 main）', mr4State.detailed_merge_status, 'mergeable');
  const merged4 = await api('PUT', `/projects/${proj.id}/merge_requests/${mr4.iid}/merge`,
    { should_remove_source_branch: false }, bobPat, { allowFail: true });
  // 合并必须真的发生，否则"没 rejected"只是"根本没事件"——绿色假象
  check('bob 把这条 MR 合进了 main（名单外的人确实能合）', merged4.status, 200);
  const rej = await waitFor((e) => e.type === 'decision_rejected' && e.detail?.blocker === 'OP-4');
  check('名单外的人改的记 decision_rejected', Boolean(rej), true);
  check('拒绝原因是 author_not_approver', rej?.detail?.reason, 'author_not_approver');
  check('名单外的人改的没有落账', events().filter((e) => e.type === 'decision_landed' && e.detail?.blocker === 'OP-4').length, 0);

  // ---- 8. 重投幂等（用 GitLab 真实发出的 payload 回放）----
  console.log('\n== 8. 同一份真实 payload 重投 ==');
  setApprovers([]);
  const { json: d2 } = await api('GET', `/projects/${proj.id}/hooks/${hook.id}/events`);
  const real = d2.find((e) => JSON.stringify(e.request_data).includes(sha1))?.request_data;
  check('能从 GitLab 投递记录里取回真实 payload', Boolean(real?.commits?.length), true);
  const before8 = events().filter((e) => e.type === 'decision_landed').length;
  const replay = await fetch(`http://127.0.0.1:${brokerPort}/webhook/gitlab`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gitlab-token': SECRET }, body: JSON.stringify(real),
  });
  const replayBody = await replay.json();
  check('重投返回 200', replay.status, 200);
  check('重投没有再落账（landed 为空）', (replayBody.landed || []).length, 0);
  check('账本里的落账条数没变', events().filter((e) => e.type === 'decision_landed').length, before8);

  // ---- 9. 读不到 diff：真 GitLab 给 404，broker 仍回 200 但必须留痕 ----
  console.log('\n== 9. diff 读不到（真 404） ==');
  const failedBefore = ofType('decision_landed_failed').length;
  const ghost = JSON.parse(JSON.stringify(real));
  ghost.commits = [{ id: 'deadbeef'.repeat(5), author: { name: 'Alice 甲', email: 'alice@harness.test' }, added: [], modified: ['docs/RS-x.md'] }];
  const r9 = await fetch(`http://127.0.0.1:${brokerPort}/webhook/gitlab`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gitlab-token': SECRET }, body: JSON.stringify(ghost),
  });
  check('不存在的 commit：仍回 200（不打 GitLab 重试风暴）', r9.status, 200);
  const failed = await waitFor(() => ofType('decision_landed_failed').length > failedBefore);
  check('读不到 diff 显式留痕 decision_landed_failed', Boolean(failed), true);

  // ---- 10. 鉴权 ----
  console.log('\n== 10. webhook 鉴权 ==');
  const noTok = await fetch(`http://127.0.0.1:${brokerPort}/webhook/gitlab`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(real),
  });
  check('不带 token 的 webhook 被拒', noTok.status, 403);

  // ---- 收尾 ----
  await stopBroker();
  if (!KEEP) await api('DELETE', `/projects/${proj.id}`, undefined, adminToken, { allowFail: true });
}

try {
  await main();
} catch (e) {
  console.log(`\n\x1b[31m[e2e] 中断：${e.message}\x1b[0m`);
  fail++;
  failures.push(`中断：${e.message}`);
} finally {
  await stopBroker();
  // 红了就保现场：账本是判断"卡在哪一段"的唯一证据，删掉等于把事故现场擦干净。
  if (!KEEP && fail === 0) { try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* 保留 */ } }
  console.log(`\n== 结果：${pass} 过 / ${fail} 红 ==`);
  if (fail) {
    console.log('失败清单：');
    failures.forEach((f) => console.log(`  - ${f}`));
    console.log(`现场保留在 ${stateDir}`);
    const ev = join(stateDir, 'ledger/events.jsonl');
    if (existsSync(ev)) {
      console.log('账本尾部：');
      readFileSync(ev, 'utf8').trim().split('\n').slice(-8).forEach((l) => console.log('  ' + l.slice(0, 300)));
    }
  }
  process.exitCode = fail ? 1 : process.exitCode || 0;
}
