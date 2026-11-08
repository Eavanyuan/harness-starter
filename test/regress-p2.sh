#!/usr/bin/env bash
# P2 缺陷复现 —— 红灯日志的生成器，**不进 gate**，也永远不"通过"。
#
# 用法：bash test/regress-p2.sh
#
# 为什么需要它：三条缺陷（config 形状不校验 / 证据链被管道洗绿 / broker 口径与另两个入口不一致）
# 修好之后，"新加的断言真的能抓住旧行为吗"只能靠把旧实现装回去验。手工做这件事的代价是
# 一不小心把工作树改成半坏状态，所以这里改成：整体复制到临时目录，只在那份副本里退回旧实现。
#
# 退回的三份文件取自 HEAD（本轮修复还没提交，HEAD 就是修复前）：
#   scripts/lib/review-rules.mjs · scripts/harness-broker.mjs · scripts/verify-run.sh
#
# 注意：HEAD 也缺**前两批未提交**的判据修复，所以红灯里会夹带那几批的旧行为
# （例如 verify-run 的 --task 归属检查、broker 的绑定面横幅）。要分辨某条红是不是
# 本轮三个缺陷造成的，看它的措辞：本轮的都在"config 形状 / pipefail / 配置错误留痕"这三类上。
#
# 退出码恒为 1：复现即失败，红灯日志本来就该长这样（verify.mjs 要求 exit_code≠0）。
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
# 关键：把自己的传导关掉。本脚本通常是被 scripts/verify-run.sh 调起来的，
# 而它会导出一个只做 `set -o pipefail` 的 BASH_ENV（P2-2 的修复本身）。
# 如果不 unset，副本里那些 `bash -c 'a | b'` 会继承 pipefail，
# 于是"管道洗绿"这条缺陷被**我自己的修复**盖住了，复现日志里一条红都看不到。
unset BASH_ENV
# -P：副本目录本身不能是软链形态（macOS 的 /tmp、/var/folders 都是软链），
# 否则副本里 `node <abs>/scripts/lib/notify.mjs` 会触发另一类"静默空转"，
# 把复现日志变成一堆与本缺陷无关的红。
TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo"

# 只复制工作树，不带 .git / node_modules：三套用例都只用 node 内建模块与本地 mock
tar -C "$HERE" --exclude .git --exclude node_modules -cf - . 2>/dev/null | tar -C "$TMP/repo" -xf -

cd "$TMP/repo" || exit 1
for f in scripts/lib/review-rules.mjs scripts/harness-broker.mjs scripts/verify-run.sh; do
  git -C "$HERE" show "HEAD:$f" > "$f" || { echo "取不到 HEAD:$f"; exit 1; }
  echo "[复现] 已退回旧实现：$f"
done

red=0
for suite in test/review-router.test.sh test/verify-run.test.sh test/notify-broker.test.sh; do
  out="$TMP/$(basename "$suite").out"
  if bash "$suite" >"$out" 2>&1; then
    # 旧实现居然全绿 = 新断言抓不住这个缺陷，比缺陷本身更值得报
    echo "[复现] $(basename "$suite") 仍然全绿 —— 断言是空转的"
  else
    red=$((red + 1))
    echo "[复现] $(basename "$suite") 变红，失败用例："
    # 去掉颜色再按字节匹配 ✗（U+2717）：断言失败行是这里唯一想要的输出
    perl -pe 's/\e\[[0-9;]*m//g' "$out" | LC_ALL=C grep -aF $'\xe2\x9c\x97' | sed 's/^ */       /'
  fi
done

echo
echo "[复现] 三套里 $red 套变红（期望 3）"
[ "$red" -eq 3 ] || echo "[复现] 少于 3 套变红：有断言没抓住旧行为，先修断言再谈修复"
echo "[复现] 这是修复前的失败记录，exit 1 是本次运行的结论"
exit 1
