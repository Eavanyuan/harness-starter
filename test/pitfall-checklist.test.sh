#!/usr/bin/env bash
# pitfall-checklist.md 结构核对。
#
# 为什么需要它：这份清单是「换项目也能带走」的经验，写错一条就会把下一个人带偏——
# 2026-11-24 实测：#52 把「秒败」判成连接层问题，#53 把一个猜测写成了解析机制，
# 两条都被后续证据推翻，而清单没有任何检查，错着挂了一天。
#
# 核三件事：
#   1. 结构：小节标题条数 = 实际条数；编号 1..N 连续且自上而下递增
#   2. 事实：已被推翻的说法不得回潮；应有的事实陈述必须在
#   3. 引用：SKILL.md / README.md 里的条数与清单一致
#
# 用法：bash test/pitfall-checklist.test.sh     全部通过退出 0
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"

python3 - "$HERE" <<'PY'
import re
import sys

ROOT = sys.argv[1].rstrip('/') + '/'
LIST = ROOT + '.skills/deployment/references/pitfall-checklist.md'
SKILL = ROOT + '.skills/deployment/SKILL.md'
README = ROOT + 'README.md'
TOTAL = 53
APPENDED = range(48, TOTAL + 1)      # 「后续实战追记」小节的编号

problems = []
lines = open(LIST, encoding='utf-8').read().split('\n')

# ---- 1. 结构：小节条数、编号 ----
SEC_RE = re.compile(r'^## (.+?)（(\d+) 条')   # 兼容「（6 条）」与「（6 条，#48–53）」
ROW_RE = re.compile(r'^\| (\d+) \|')
sections, order, sec_of, cur = {}, [], {}, None
for n, line in enumerate(lines, 1):
    if line.startswith('## '):
        m = SEC_RE.match(line)
        if not m:
            problems.append(f'第 {n} 行小节标题缺「（N 条）」: {line}')
            cur = None
            continue
        cur = m.group(1)
        sections[cur] = {'declared': int(m.group(2)), 'rows': 0}
        order.append(cur)
        continue
    m = ROW_RE.match(line)
    if m:
        if cur is None:
            problems.append(f'第 {n} 行表格行不在任何小节内: #{m.group(1)}')
        else:
            sections[cur]['rows'] += 1
            sec_of[int(m.group(1))] = cur

ids = sorted(sec_of)
if ids != list(range(1, TOTAL + 1)):
    problems.append(f'编号不是 1..{TOTAL} 各恰好一次，缺: {sorted(set(range(1, TOTAL + 1)) - set(ids))}')
in_file = [int(m.group(1)) for l in lines for m in [ROW_RE.match(l)] if m]
if in_file != sorted(in_file):
    problems.append('编号未自上而下递增')
for name in order:
    if sections[name]['declared'] != sections[name]['rows']:
        problems.append(f'小节「{name}」标题写 {sections[name]["declared"]} 条，实际 {sections[name]["rows"]} 条')
if not lines[0].startswith(f'# 部署已知坑清单（{TOTAL} 条'):
    problems.append(f'标题总条数不是 {TOTAL}: {lines[0][:40]}')


def row(i):
    return next((l for l in lines if l.startswith(f'| {i} |')), '')


# ---- 2. 事实：被推翻的不得回潮，应陈述的必须在 ----
REFUTED = {
    52: ['秒败+仅 1 条 request = 连接层', '执行器 38 连败'],
    53: ['模型按**项目/会话偏好**解析', '真相层'],
}
REQUIRED = {
    51: ['admit.skipped', 'misfireGraceMs'],                  # #51 结论成立，不得被误改
    52: ['秒败 ≠ 连接层', '同一连接在别处有没有成功运行'],
    53: ['**未查明**：定时任务新起一轮时按什么规则解析模型', '只生效了一拍', '真实执行会话'],
}
for i, texts in REFUTED.items():
    for t in texts:
        if t in row(i):
            problems.append(f'#{i} 仍含已推翻的说法: {t}')
for i, texts in REQUIRED.items():
    for t in texts:
        if t not in row(i):
            problems.append(f'#{i} 缺少应有内容: {t}')
for i in APPENDED:
    if sec_of.get(i) != '后续实战追记':
        problems.append(f'#{i} 不在「后续实战追记」节，而在: {sec_of.get(i)}')

# ---- 3. 外部引用的条数 ----
skill = open(SKILL, encoding='utf-8').read()
for stale in ('47 条已知坑', '（47 条'):
    if stale in skill:
        problems.append(f'SKILL.md 仍有旧条数: {stale}')
if '首批 47 条蒸馏自' not in skill:
    problems.append('SKILL.md 未区分「蒸馏 47 条」与「追记 6 条」')
readme = open(README, encoding='utf-8').read()
if len(re.findall(r'53 条已知坑', readme)) != 2:
    problems.append('README 的「53 条已知坑」引用不是 2 处')

for name in order:
    print(f'  {name:<12} {sections[name]["rows"]:>2} 条')
print('问题:', problems or '无')
sys.exit(1 if problems else 0)
PY
