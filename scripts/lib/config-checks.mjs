/**
 * 配置值的形状校验（纯函数，给 doctor 用）。
 *
 * 为什么单独成文件：这些判据的价值全在"能不能变红"。写在 doctor.mjs 里就只能靠
 * 改仓库的 harness.rules.json 来验证——而 doctor 本身在门禁里跑，改坏配置再改回来
 * 会让整条链路在中间态判红，测不下去。抽出来后可以喂任意字符串，断言"该红的红"。
 */

/**
 * GitLab 接入地址。空值 = 未接入（返回 null，不算错误：接入是扩展条件）。
 * 两类真实踩车：
 *   1. 整段 API 地址粘进来（https://git.example.com/api/v4）——代码还会再拼一次 /api/v4，
 *      于是每次请求都 404，报错看起来像"接口不存在"，没人会想到是配置多了两个路径段；
 *   2. 少了协议头（git.example.com）——fetch 直接抛 failed to parse URL。
 */
export function checkGitlabUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) return `runtime.gitlab.url 不是 http(s) 地址：${u}（缺协议头，fetch 会直接抛 URL 解析失败）`;
  if (/\/api\/v4\/?$/i.test(u)) return `runtime.gitlab.url 写成了 API 地址（${u}）——要填实例根地址，代码自己会拼 /api/v4`;
  if (/\/api\/v4\//i.test(u)) return `runtime.gitlab.url 里带了 API 路径段（${u}）——只填到实例根地址为止`;
  return null;
}
