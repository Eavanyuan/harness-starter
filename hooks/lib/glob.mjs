/**
 * 唯一的 glob 引擎。
 *
 * 之前有四份实现（guard_write / verify / resolve-skills / review-rules），
 * 语义各自漂了一点：
 *   · guard_write 不认 {a,b}，verify 认 —— 同一个 pattern 两处判定可以不同；
 *   · resolve-skills 的 a/+doublestar+/b 不匹配 a/b，review-rules 匹配。
 * 「同一份配置在两处得出不同结论」正是最难查的一类问题：两边都不算错，只是不同。
 * 现在只留一份，谁要 glob 就从这里 import（scripts → hooks/lib 是既有的依赖方向，
 * harness-cli 早就这么引 verify.mjs 了）。
 *
 * 语义固定为：
 *   单星号     单层（不跨目录分隔符）
 *   双星号     任意层
 *   双星号+/   零层或多层前缀：a/<双星号>/b 命中 a/b，也命中 a/x/b
 *   {a,b}      或（只做一层，不支持嵌套）
 */

const BRACE_OPEN = '\u0001';
const BRACE_SEP = '\u0002';
const BRACE_CLOSE = '\u0003';
const GLOBSTAR_SLASH = '\u0000S';
const GLOBSTAR = '\u0000A';

/** glob → 正则（永远整串匹配）。 */
export function globToRe(glob) {
  let s = String(glob == null ? '' : glob).trim();
  // 花括号先换成占位符：里面的 { } 之后会被当作普通字符转义掉，顺序反了就丢了。
  s = s.replace(/\{([^{}]*)\}/g, (_, inner) => BRACE_OPEN + inner.split(',').join(BRACE_SEP) + BRACE_CLOSE);
  s = s
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(BRACE_OPEN, 'g'), '(?:')
    .replace(new RegExp(BRACE_SEP, 'g'), '|')
    .replace(new RegExp(BRACE_CLOSE, 'g'), ')')
    .replace(new RegExp(GLOBSTAR_SLASH, 'g'), '(?:.*/)?')
    .replace(new RegExp(GLOBSTAR, 'g'), '.*');
  return new RegExp('^' + s + '$');
}

/** 一堆 pattern 里第一个命中的（返回 pattern 本身，便于报错点名）。 */
export function firstHit(patterns, value) {
  for (const p of patterns || []) {
    if (globToRe(p).test(value)) return p;
  }
  return null;
}

/** 任一条命中。 */
export function matchAny(patterns, value) {
  return firstHit(patterns, value) !== null;
}
