/**
 * GitLab 接入配置的**唯一解析入口**。
 *
 * 为什么必须只有一处：上一版 runner 只认 `GITLAB_URL`/`GITLAB_TOKEN`，
 * doctor 只认 `HARNESS_GITLAB_*`。于是一个人把 runner 配好了、也跑通了，
 * doctor 仍然在喊"未配置"——两个进程读的不是同一个键，"配好了"这句话就没有公共含义。
 *
 * 来源优先级（先到先得，空串按"没配"处理）：
 *   url    : GITLAB_URL → HARNESS_GITLAB_URL → runtime.gitlab.url
 *   token  : GITLAB_TOKEN → HARNESS_GITLAB_TOKEN → $HOME/.harness/task-loop/gitlab-token
 *   project: HARNESS_GITLAB_PROJECT → GITLAB_PROJECT（只有 doctor 用得到）
 *
 * env 在配置之前：env 是"这次运行临时指到别处"（CI 指假服务器、临时借别人的实例），
 * 配置是"这个仓库平时接哪"。反过来的话，临时覆盖就会被仓库配置吃掉，
 * 而症状是"我明明指过去了，怎么还在连老实例"——最难查的一类。
 *
 * token 为什么额外支持文件：定时器把环境变量写进 launchd plist / systemd unit，
 * 那是全机可读的（plist 默认 0644）。凭据走 0600 文件，与环境变量等价但不多开一个读者。
 *
 * 接入是**扩展条件**：url 或 token 任一为空即"未接入"，调用方应跳过而不是报错。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TOKEN_FILE = join('.harness', 'task-loop', 'gitlab-token');

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

export function resolveGitlabConfig({ rules = null, env = process.env, home = homedir() } = {}) {
  const c = (rules?.runtime?.gitlab && typeof rules.runtime.gitlab === 'object') ? rules.runtime.gitlab : {};
  const url = firstNonEmpty(env.GITLAB_URL, env.HARNESS_GITLAB_URL, c.url).replace(/\/+$/, '');
  const fromEnv = firstNonEmpty(env.GITLAB_TOKEN, env.HARNESS_GITLAB_TOKEN);
  let token = fromEnv;
  let tokenSource = fromEnv ? 'env' : 'none';
  if (!token) {
    try {
      const t = readFileSync(join(home, TOKEN_FILE), 'utf8').trim();
      if (t) { token = t; tokenSource = 'file'; }
    } catch { /* 没有文件就是没配，不是错误 */ }
  }
  return {
    url,
    token,
    tokenSource,
    tokenFile: join(home, TOKEN_FILE),
    project: firstNonEmpty(env.HARNESS_GITLAB_PROJECT, env.GITLAB_PROJECT),
    // 接入判定：url 与 token 同时在手才算接上。只有一半仍按未接入处理，
    // 但调用方必须把缺的那一半说出来——静默跳过会让人以为"没有这个需求"。
    configured: !!(url && token),
    missing: [!url && 'url', !token && 'token'].filter(Boolean),
  };
}

/** token 文件权限：0600 之外都可能被同机其他用户读到。文件不存在返回 null。 */
export function tokenFileMode({ home = homedir() } = {}) {
  const f = join(home, TOKEN_FILE);
  if (!existsSync(f)) return null;
  try {
    const mode = statSync(f).mode & 0o777;
    return { file: f, mode: mode.toString(8), loose: (mode & 0o077) !== 0 };
  } catch {
    return null;
  }
}
