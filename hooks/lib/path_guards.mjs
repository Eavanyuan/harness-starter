/**
 * 路径分类的单一实现：Write/Edit 门禁与 Bash 门禁必须用同一套判据。
 *
 * 为什么抽出来：Bash 通道补上之后，`echo x > hooks/guard_command.mjs` 与
 * `Write(hooks/guard_command.mjs)` 会不会被拦，取决于两个文件里的两份 glob 与两份顺序。
 * 顺序尤其容易错：示例文件必须在 sensitive 之前判，否则门禁会把自己给出的唯一出路堵死。
 * 这种事只能有一个地方能改错。
 */
import { firstHit } from './glob.mjs';

/** 从配置取写入门禁规则（缺省为空对象，判定自然全放——由 doctor 负责报告缺配置）。 */
export function loadGuards(config) {
  return ((config && config.gates) || {}).writeGuards || {};
}

/**
 * 分类一个仓库相对路径。返回各分类命中的 pattern（未命中为 null）。
 * 顺序：sensitiveExempt → sensitive → generated → protected。
 */
export function classifyPath(rel, guards) {
  const g = guards || {};
  const exempt = firstHit(g.sensitiveExempt, rel);
  return {
    rel,
    exempt,
    sensitive: exempt ? null : firstHit(g.sensitive, rel),
    generated: firstHit(g.generated, rel),
    protect: firstHit(g.protected, rel),
  };
}
