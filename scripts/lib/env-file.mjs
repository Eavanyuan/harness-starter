/**
 * 0600 凭据文件的**数据化**解析（不是 shell）。
 *
 * 为什么不用 `source`：定时器的执行体是一段 bash（`run-round.sh`），上一版它这样写：
 *   set -a; [ -f cred.env ] && . cred.env; set +a
 * 于是凭据文件变成**可执行代码**——谁能写它，谁就能以定时器身份执行任意命令。
 * 文件是 0600 没错，但那句话只挡住"别人读"，挡不住"别的进程写"（同用户的
 * 编辑器、安装脚本、`>>` 重定向都写得进去），而定时器以登录用户身份跑。
 * "凭据文件"和"远程代码执行入口"不该是同一个东西。
 *
 * 改成数据之后：只认 `KEY=VALUE`（`#` 注释、空行、`export ` 前缀照旧），
 * 认不出的行**报错**，既不猜也不执行。`$(...)`、反引号、`;`、`&&` 在这里只是普通字符，
 * 值原样保留——所以那种文件在旧实现里是 RCE，在这里是一行没人读的字符串。
 *
 * 优先级（与全局约定一致）：**进程 env > 文件**。文件是"这台机器平时用哪个凭据"，
 * env 是"这次临时指到别处"。反过来的话，临时覆盖会被文件吃掉，症状是
 * "我明明指过去了，怎么还在连老实例"——最难查的一类。
 * 定时器环境下进程 env 是空的（plist / unit 不写 Environment），所以定时器以文件为准。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 指向凭据文件的 env 键（安装器生成的 run-round.sh 会 export 它）。 */
export const ENV_FILE_KEY = 'HARNESS_ENV_FILE';
/** 默认落点：与安装器、`--status`、doctor 同一处，改名字要一起改。 */
export const ENV_FILE_REL = join('.harness', 'task-loop', 'task-loop.env');
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 去掉成对的引号外壳。**不做转义求值**：`\n` 就是两个字符，token 与 URL 都不需要它。 */
function unquote(v) {
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) return v.slice(1, -1);
  }
  return v;
}

/**
 * 解析凭据文件文本 → `[{ key, value, line }]`。
 *
 * 非法行抛错而**不回显原文**：那一行可能正是某个被手抖拼坏的 token，
 * 报错会被写进 cron 日志、贴进工单。行号足够定位，内容不该跟着流出去。
 */
export function parseEnvFile(text, { file = '<env-file>' } = {}) {
  const entries = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new Error(`${file}:${i + 1} 不是 KEY=VALUE 形状——文件里只允许 KEY=VALUE / 空行 / # 注释，`
        + '这一行既不会被当作命令执行，也不会被猜成某个键的值（内容不回显：它可能是一段被拼坏的凭据）');
    }
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      throw new Error(`${file}:${i + 1} 键名不合法："${key}"——只认 [A-Za-z_][A-Za-z0-9_]*`);
    }
    entries.push({ key, value: unquote(line.slice(eq + 1).trim()), line: i + 1 });
  }
  return entries;
}

/** 凭据文件路径：显式 `HARNESS_ENV_FILE` 优先，否则默认落点。 */
export function resolveEnvFile({ env = process.env, home = homedir() } = {}) {
  const explicit = String(env[ENV_FILE_KEY] ?? '').trim();
  return explicit ? { file: explicit, explicit: true } : { file: join(home, ENV_FILE_REL), explicit: false };
}

/**
 * 读文件并注入 `env`（默认 `process.env`）。
 *
 * 返回 `{ file, exists, mode, loaded, shadowed, warnings }`——`loaded` 是真正生效的键，
 * `shadowed` 是被进程 env 覆盖的键。两者分开是为了让"我改了文件怎么没反应"可回答：
 * 看 `shadowed` 就知道是环境变量在压它。
 *
 * 不存在的文件**不是错误**：凭据不在场 = 未接入（与 GitLab/飞书同一条判据）。
 * 存在但读不到（权限/目录）必须抛错——"文件在但读不了"和"没配"是两件事，
 * 混在一起会变成"token 明明配了却没生效"。
 */
export function loadEnvFile(file, { env = process.env, override = false } = {}) {
  const out = { file, exists: false, mode: null, loaded: [], shadowed: [], warnings: [] };
  if (!file) return out;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw new Error(`凭据文件读不了：${file}（${e.code || e.message}）`);
  }
  out.exists = true;
  try {
    const mode = statSync(file).mode & 0o777;
    out.mode = mode.toString(8).padStart(3, '0');
    // `cp` / `rsync` / 编辑器另存都会把 0600 变成 0644，而"能读这个文件"就是"能拿到 token"。
    // 只在 runtime 里告警而不中止：定时器停摆比权限过宽的代价更大，但这条告警必须看得见。
    if (mode & 0o077) out.warnings.push(`凭据文件权限 ${out.mode}（应 0600）：${file}——同机其他用户可读，chmod 600 修`);
  } catch { /* stat 失败不影响读取本身 */ }
  for (const { key, value } of parseEnvFile(text, { file })) {
    const cur = env[key];
    if (!override && cur !== undefined && String(cur).trim() !== '') { out.shadowed.push(key); continue; }
    env[key] = value;
    out.loaded.push(key);
  }
  return out;
}

/**
 * runner 与 doctor 的唯一入口：解析路径 + 读取 + 注入。
 * 两个进程各写一份的话，"定时器能跑"和"doctor 说没配"会同时成立。
 */
export function loadTaskLoopEnv(opts = {}) {
  const { file, explicit } = resolveEnvFile(opts);
  const res = loadEnvFile(file, opts);
  res.explicit = explicit;
  // 显式指定却不存在：多半是路径拼错，值得单独说一句（默认落点不存在则完全静默）
  res.missingExplicit = explicit && !res.exists;
  return res;
}
