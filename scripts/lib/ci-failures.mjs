/**
 * CI 失败提取与轻量归因（ci-fail-trigger，2026-11-17）。
 *
 * 定位：把「我提的 MR、CI 红了」变成结构化失败清单 + 引入/继承判定 + 会话工单。
 * 与 T4a（fingerprint.mjs）的关系：那套认的是**本仓库** bash 测试的 ✗ 行；CI 日志是
 * 多栈的（javac / surefire / pytest / jest / go …），这里做多栈识别，但**身份哲学**沿用：
 * 一行 → 稳定 id（剥易变位：行号、绝对路径前缀、runner 时间戳），重复失败计一次。
 *
 * 归因基线用**目标分支最新流水**的失败集合（远端 CI 结果，不本地实跑双树——idmp 全量
 * 测试一轮太重；T4a 的 merge-base 双树实跑留给需要本地复现的场景）。基线取不到时明说
 * "无法取基线"，失败仍列全但标注归因未知——不猜。
 *
 * 日志形态来源：git.tdengine.net rd-app/idmp MR !1896 pipeline 80351 实测（2026-11-16）。
 */
import { normalizeLine, setDiff } from './fingerprint.mjs';

/** 剥 GitLab runner 行前缀：`2026-11-16T10:41:13.890073Z 01O [ERROR] …` → `[ERROR] …` */
export function stripRunnerPrefix(line) {
  return String(line).replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+\S+\s+/, '');
}

/**
 * 路径归一：同一个文件在不同 job 里绝对前缀不同（实测 `/root/gitlab-runner/builds/xxx/0/rd-app/idmp/tda-server/src/…`
 * vs `/workspace/tda-server/src/…`）。取源码根标记（src/app/pkg/cmd/internal）起的相对段，
 * 取不到就退化为文件名——宁可粗而稳，不可细而漂。
 */
export function normalizeCodePath(p) {
  // Windows 反斜杠先归一（CR 🟡#1：C:\a\src\X.java 与 D:\b\src\X.java 得是同一个文件）
  const norm = String(p).replace(/\\/g, '/');
  const m = norm.match(/([^\s/]+\/(?:src|app|pkg|cmd|internal)\/\S+)$/);
  if (m) return m[1];
  const base = norm.split('/').pop();
  return base || norm;
}

/** javac 编译错：`[ERROR] /abs/path/File.java:[93,29] variable x is already defined …` */
const JAVAC = /^\[ERROR\]\s+(\S+?\.(?:java|kt|scala|ts)):\[(\d+)(?:,(\d+))?\]\s+(.+)$/;
/** surefire 测试失败明细：`[ERROR]   com.x.Class.method:42 expected … but was …` */
const SUREFIRE = /^\[ERROR\]\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)+)\.(\w+):\d+\s+(.*)$/;
/** 汇总/噪声行：不是失败身份 */
const NOISE = /^\[ERROR\]\s+(?:Tests run:|COMPILATION ERROR|BUILD FAILURE|Failures?:|Errors?:|\^+$|->)/i;
const PYTEST = /^FAILED\s+(\S+?::\S+)/;
const GO = /^--- FAIL: (\S+)/;
const JEST = /^[✕x]\s+(.{4,})$/;

/**
 * 单行 → { fingerprint, kind }；非失败行返回 null。
 * fingerprint 是稳定身份（剥行号/列号/绝对前缀/尾参数），body 保留原文供工单展示。
 */
export function ciFailure(line) {
  // 先 normalizeLine（剥 ANSI）再剥 runner 前缀：时间戳被色码包裹时（\u001b[90m2026-…\u001b[0m），
  // 直接剥前缀不命中、JAVAC 的 ^[ERROR] 锚也不命中，整行漏收（CR 🟡#1 探针实证）。
  const n = normalizeLine(stripRunnerPrefix(normalizeLine(line)));
  if (!n) return null;
  // 本仓库 ✗ 行（与 fingerprint.mjs 同判据：✗ 开头）——CI 上跑 harness 套件时就是它
  if (n.startsWith('✗') && n.slice(1).trim()) {
    return { fingerprint: n.slice(1).trim().slice(0, 100), kind: 'check', body: n };
  }
  if (NOISE.test(n)) return null;
  let m = n.match(JAVAC);
  if (m) {
    return { fingerprint: `${normalizeCodePath(m[1])} ${m[4].slice(0, 80)}`, kind: 'javac', body: n, file: normalizeCodePath(m[1]), line: m[2] };
  }
  m = n.match(SUREFIRE);
  if (m) {
    return { fingerprint: `${m[1]}.${m[2]}`.slice(0, 120), kind: 'test', body: n };
  }
  m = n.match(PYTEST);
  if (m) return { fingerprint: m[1].slice(0, 120), kind: 'test', body: n };
  m = n.match(GO);
  if (m) return { fingerprint: m[1], kind: 'test', body: n };
  m = n.match(JEST);
  if (m && !/^\d/.test(m[1])) {
    // jest 行尾的 (12 ms) 耗时不是身份——同一断言两次运行 12ms/15ms 会变两个指纹（CR 🟡#1）
    const body = m[1].replace(/\s*\(\d+\s*m?s\)\s*$/, '').trim();
    return { fingerprint: (body || m[1]).slice(0, 100), kind: 'test', body: n };
  }
  return null;
}

/**
 * 整段 trace → 失败清单（去重保序，跨形态）。suite 填 job 名（调用方），
 * 这里给占位 '?'，fetchPipelineFailures 会按 job 重标。
 */
export function extractCiFailures(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    const f = ciFailure(line);
    if (!f) continue;
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    out.push({ id: f.fingerprint, suite: '?', fingerprint: f.fingerprint, kind: f.kind, body: (f.body || '').slice(0, 160), file: f.file, line: f.line });
  }
  return out;
}

/**
 * 拉一条流水线的失败清单：failed jobs → 逐 job 拉 trace → 合并去重。
 * trace 可能上百 KB：不全文返回，每 job 只留前几条失败行原文（工单定位用）。
 */
export async function fetchPipelineFailures({ url, token, projectId, pipelineId, fetchImpl = fetch, maxJobs = 5, excerptPerJob = 8 }) {
  const api = async (path, asText = false) => {
    const res = await fetchImpl(`${url}/api/v4${path}`, { headers: { 'private-token': token } });
    if (!res.ok) throw new Error(`GitLab ${path} HTTP ${res.status}`);
    return asText ? res.text() : res.json();
  };
  const jobs = await api(`/projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=100`);
  const allFailed = jobs.filter((j) => j.status === 'failed');
  const failed = allFailed.slice(0, maxJobs);
  const byJob = [];
  const seen = new Map();
  let traceFailures = 0; // trace 拉取失败的 job 数（CR 🔴#1：空清单必须能区分"没识别出"与"没拿到"）
  for (const j of failed) {
    let trace = '';
    let traceOk = true;
    try { trace = await api(`/projects/${projectId}/jobs/${j.id}/trace`, true); } catch { traceOk = false; traceFailures += 1; }
    const fs = extractCiFailures(trace);
    const excerpt = trace.split('\n').filter((l) => /\[ERROR\]|FAILED|--- FAIL|[✗✕]/.test(l)).slice(0, excerptPerJob);
    byJob.push({ job: j.name, stage: j.stage, webUrl: j.web_url, traceOk, failureCount: fs.length, failures: fs.map((f) => ({ ...f, suite: j.name })), excerpt });
    for (const f of fs) if (!seen.has(f.fingerprint)) seen.set(f.fingerprint, { ...f, suite: j.name });
  }
  // 一个流水线里多 job 同因编译错是常态（实测 api-test 与 compile-and-upload 同一份报错）：
  // 合并清单以指纹去重，job 名留在 suite——工单里能看出"哪些 job 因它红的"。
  const merged = [...seen.values()];
  // 透明度（CR 🟡#3）：截断/拉取失败要看得见，不静默缩视角——调用方据此告警与落账
  return {
    pipelineId,
    failedJobs: failed.map((j) => ({ name: j.name, stage: j.stage, webUrl: j.web_url })),
    failures: merged,
    byJob,
    failedJobTotal: allFailed.length,      // 超过 maxJobs 时 > failedJobs.length：还有没看的
    jobsPageTruncated: jobs.length >= 100, // jobs 本身翻页截断（>100 个 job 的流水线）
    traceFailures,                         // >0：至少一个 job 的日志没拿到，归因视角不完整
  };
}

/** 目标分支最新流水（作归因基线）。取不到返回 null——调用方明说"无法取基线"，不猜。 */
export async function fetchLatestPipelineForRef({ url, token, projectId, ref, fetchImpl = fetch }) {
  const res = await fetchImpl(`${url}/api/v4/projects/${projectId}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`, { headers: { 'private-token': token } });
  if (!res.ok) throw new Error(`GitLab pipelines?ref=${ref} HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;
  return { id: list[0].id, status: list[0].status, sha: list[0].sha };
}

/**
 * 轻量归因：MR 失败集合 vs 基线（目标分支最新流水）失败集合。
 * 复用 T4a 的 setDiff 语义：introduced=真引入（要修）；inherited=基线同款（不在本 MR 修）；
 * resolved=基线有而 MR 没有（顺手修好的存量红，信息项）。
 * baseline 传 null = 无法取基线：全部按 introduced 列出并标注 baselineKnown:false（保守但不静默）。
 */
export function attributeCi({ mine, baseline }) {
  if (!baseline) {
    return { baselineKnown: false, baselineStatus: 'unknown', introduced: mine, inherited: [], resolved: [] };
  }
  const diff = setDiff(mine, baseline.failures || []);
  return {
    baselineKnown: true,
    baselineStatus: baseline.status ?? (baseline.failures ? 'failed' : '?'),
    baselinePipelineId: baseline.pipelineId ?? baseline.id ?? null,
    introduced: diff.introduced,
    inherited: diff.inherited,
    resolved: diff.resolved,
  };
}
