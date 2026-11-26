#!/usr/bin/env python3
"""RS-飞书任务接入.md 与证据文件的一致性核对。

核三个方向：
  结构  模板必备章节、每个 US 的验收标准、章节编号连续、交叉引用指得对。
  事实  文档里引用的实测数字，必须与 feishu-mcp-capabilities.json 里落的值一致。
        数字不写死在本脚本里——一律从证据文件读；证据重跑后数字变了，检查自动跟随。
  边界  「读不到飞书云文档正文」这条否定性主张必须与证据一致。它是本功能最重要的
        边界（决定了方案要改设计），所以单独核，不混在数字核对里。

不查的（也查不了）：文档里标了「未入证据文件」的主张，例如 PDF 页数。只能人工复核。

这份检查自己犯过的错（都靠"故意改坏看它红不红"查出来的，改之前先别删这些用例）：
  1. 只核数字、不核否定性主张——把文档改成"能读云文档"时是绿的。
  2. 检查"原来的引用还在不在"——把 §2.2-B 改指 §7 时是绿的。
  3. 子节引用的字母写死成 A–H——引用 §2.2-Z 时两条规则都不触发。
  4. 「核心需求」计数的正则多了一层反斜杠，计数恒为 0，却在输出里打印 R1–R0 没人发现。

用法：python3 test/rs-feishu-intake.test.py [仓库根]     全部通过退出 0
"""
import json
import re
import sys

ROOT = sys.argv[1].rstrip('/') + '/' if len(sys.argv) > 1 else './'
RS = ROOT + 'docs/01-requirements/RS-飞书任务接入.md'
EVIDENCE = ROOT + 'docs/06-reference/feishu-mcp-capabilities.json'

bad = []
md = open(RS, encoding='utf-8').read()
ev_text = open(EVIDENCE, encoding='utf-8').read()
try:
    ev = json.loads(ev_text)
except ValueError as e:
    print('证据文件不是合法 JSON:', e)
    sys.exit(1)

# =====================================================================
# 一、结构
# =====================================================================
heads = [line for line in md.split('\n') if line.startswith('## ')]
for need in ('背景', '用户故事', '核心需求', '非功能约束', '范围外', '术语表', '开放问题'):
    if not any(need in h for h in heads):
        bad.append('缺章节: %s' % need)

us_blocks = re.split(r'^### US-', md, flags=re.M)[1:]
for blk in us_blocks:
    title = blk.split('\n')[0][:30]
    if '**验收标准**' not in blk:
        bad.append('US %s: 缺验收标准' % title)
    if not re.search(r'- Given .+ When .+ Then', blk):
        bad.append('US %s: 无 Given/When/Then' % title)

nums = [int(re.match(r'## (\d+)', h).group(1)) for h in heads]
if nums != list(range(1, len(heads) + 1)):
    bad.append('章节编号不连续: %s' % nums)
title_of = {}
for h in heads:
    n = int(re.match(r'## (\d+)', h).group(1))
    title_of[n] = h[3:].split('（')[0].strip()

# ---- 交叉引用：检查「现在的每一处引用指得对不对」 ----
# 规则与具体引用无关：某句话在谈某个主题时，它引用的章节标题必须包含与该主题相容的词。
# 这样无论引用被改成什么，指错了都能查出来。
TOPIC_TO_ALLOWED_TITLE_WORDS = [
    ('现有机制', ('核心需求', '核对')),       # 「复用现有机制」→ 讲机制的地方
    ('无此能力', ('核对', '范围外')),         # 「做不到」→ 前提核对或范围外
    ('待决', ('开放问题',)),
]
# 主引用：§ 后面是章节号，且不跟小数点（§2.2 开头的 §2 不算主引用）
main_refs = [(m.start(), int(m.group(1))) for m in re.finditer(r'§(\d+)(?![\d.])', md)]
for pos, n in main_refs:
    if n not in title_of:
        bad.append('交叉引用 §%d 指向不存在的章节' % n)
        continue
    ctx = md[max(0, pos - 45):pos + 45]
    for topic, allowed in TOPIC_TO_ALLOWED_TITLE_WORDS:
        if topic in ctx and not any(w in title_of[n] for w in allowed):
            bad.append('§%d 所在句子谈「%s」，但 §%d 是「%s」' % (n, topic, n, title_of[n]))

# ---- §2.2 小节：A–H 每行都要有「实际情况」 ----
i22 = md.find('### 2.2')
i3 = md.find('## 3 ')
rows22 = set()
if i22 < 0 or i3 < 0 or i22 > i3:
    bad.append('找不到「### 2.2」到「## 3」这一段')
else:
    sec22 = md[i22:i3]
    rows22 = set(re.findall(r'^\| ([A-Z]) \|', sec22, re.M))
    for tag in 'ABCDEFGH':
        if tag not in rows22:
            bad.append('§2.2 缺 %s 行' % tag)
            continue
        cells = re.search(r'^\| %s \|(.*)$' % tag, sec22, re.M).group(0).split('|')
        if len(cells) < 6 or not cells[3].strip():
            bad.append('§2.2 %s 行缺「实际情况」' % tag)
# 子节引用 §2.2-X：X 必须是小节里真实存在的行。不限定 X 的范围——按文件里实际有的行来判，
# 否则引用范围之外的字母（如 §2.2-Z）两条规则都不触发。
for tag in sorted(set(re.findall(r'§2\.2-([A-Za-z])', md))):
    if tag.upper() not in rows22:
        bad.append('§2.2-%s 指向不存在的小节行（小节现有: %s）' % (tag, ''.join(sorted(rows22))))

# =====================================================================
# 二、事实：文档数字必须与证据一致
# =====================================================================
work = ev.get('work_item_read', {})
tools = ev.get('tools', {})
fc = work.get('field_config', {})
mql_fields = work.get('search_by_mql', {}).get('fields', [])


def mql_text_length(field_name):
    """按字段中文名取纯文本长度（不是整个 JSON 值对象的长度——两者口径不同）。"""
    for f in mql_fields:
        if f.get('name') == field_name:
            return f.get('text_length')
    return None


repro = mql_text_length('报告人的复现步骤')
multi_text = fc.get('by_type', {}).get('multi-text', {}).get('count')
att = ev.get('attachment', {})
att_bytes = att.get('bytes') if att.get('ok') is True else None


def forms(fmt, value):
    """证据值存在时返回「文档里应出现的形式」，否则返回空（表示证据里没有）。"""
    return [fmt % value] if value else []


# (证据值, 文档里应出现的形式, 说明)。证据值为 None → 文档不得引用。
expected = [
    (tools.get('total'), forms('%d 个工具', tools.get('total')), '工具总数'),
    (tools.get('by_class', {}).get('read'), forms('只读 %d', tools.get('by_class', {}).get('read')), '只读工具数'),
    (fc.get('total_fields'), forms('%d 个字段', fc.get('total_fields')), '字段总数'),
    (fc.get('random_key_count'), forms('%d 个的 key', fc.get('random_key_count')), '随机 key 字段数'),
    (multi_text, forms('%d 个富文本字段', multi_text), '富文本字段数'),
    (repro, forms('%d 字的复现步骤', repro), '复现步骤字数'),
    (att_bytes, forms('%d 字节', att_bytes), '附件字节数'),
]
for value, want, label in expected:
    if value is None:
        bad.append('证据缺「%s」，无法支撑文档' % label)
    elif not any(f in md for f in want):
        bad.append('文档未按证据写「%s」（证据值 %s）' % (label, value))

# 两个接口的 ID 类型不同：证据必须确实不同，文档必须把差异写出来
bt = work.get('get_workitem_brief', {}).get('id_type')
mt = work.get('search_by_mql', {}).get('id_type')
if not bt or not mt or bt == mt:
    bad.append('证据里两个接口的 ID 类型缺失或相同（brief=%s, MQL=%s），撑不起「类型不同」' % (bt, mt))
if not ('数字' in md and '字符串' in md):
    bad.append('文档未写出两个接口 ID 类型的差异')

# brief 传 fields 不返回描述：证据必须为 false，文档必须这么写
wf = work.get('get_workitem_brief', {}).get('with_fields_param', {})
if wf.get('description_returned') is not False:
    bad.append('证据里 brief 传 fields 后描述「返回了」或缺失，与文档主张相反')
if '传 `fields` 实测也未返回' not in md:
    bad.append('文档未写 brief 传 fields 不返回描述')

# =====================================================================
# 三、边界：否定性主张必须与证据一致（两个方向都查）
# =====================================================================
doc = ev.get('doc_reading', {})
has_doc_tool = bool(doc.get('matching'))
claims_not_readable = re.search(r'没有任何一个能读[^。\n]*(云文档|正文)|无此能力|读不了', md) is not None
claims_readable = re.search(r'(可以|能够|支持|可通过)[^。\n]{0,30}(读取|读)[^。\n]{0,20}(云文档|文档正文|多维表格)', md) is not None

# 「读不到」这条边界必须写在它该写的地方——§2.2-A 那一行（讲「关联文档」的前提核对行）。
# 不在整个文档里找：同一句话在正文里还出现两三次，只在 §2.2-A 行被删掉时，
# 「全文里还有」会让检查照样通过（第三版实测漏掉）。位置丢了就是丢了。
NOT_READABLE_IN_ROW = re.compile(r'没有任何一个能读[^|]*云文档[^|]*正文|无此能力|读不了')
row_a = re.search(r'^\| A \|(.*)$', sec22, re.M)
row_a_text = row_a.group(0) if row_a else ''
boundary_in_row_a = bool(row_a and NOT_READABLE_IN_ROW.search(row_a_text))

if not boundary_in_row_a:
    bad.append('§2.2-A 行里没有「读不到飞书云文档正文」的结论（边界必须写在这一行，写到别处不算）')
if not claims_not_readable:
    bad.append('文档未明确写出「读不到飞书云文档正文」这条边界')
if has_doc_tool and claims_not_readable:
    bad.append('证据显示有可读文档的工具（%s），但文档称读不到' % doc.get('matching'))
if not has_doc_tool and claims_readable:
    bad.append('文档称能读云文档正文，但证据 doc_reading 无对应工具')
if (doc.get('result') == '无对应工具') != (not has_doc_tool):
    bad.append('证据 doc_reading 自相矛盾: result=%s matching=%s' % (doc.get('result'), doc.get('matching')))
if doc.get('question') is None or doc.get('result') is None:
    bad.append('证据缺 doc_reading，无法核对「读不到文档」这条边界')

# =====================================================================
# 四、证据文件自身：不得含敏感/异常字面量；计数与名单自洽
# =====================================================================
LEAK = [
    ('JWT', r'eyJ[A-Za-z0-9_-]{20,}'),
    ('端点以外的地址', r'https?://(?!project\.feishu\.cn/mcp_server)[^\s"]+'),
    ('下载签名', r'"sign"\s*:\s*"[0-9a-f-]{36}"'),
    ('邮箱', r'[\w.+-]+@[\w-]+\.[\w.]+'),
    ('长数字 ID', r'\b\d{17,20}\b'),
    ('序列化残渣', r'"undefined"|"\[object Object\]"|\bNaN\b'),
]
for label, pat in LEAK:
    if re.search(pat, ev_text):
        bad.append('证据文件含%s' % label)
if att.get('ok') is not True:
    bad.append('证据里附件下载未成功（ok=%s），不能支撑「附件可读」' % att.get('ok'))

names = [t.get('name', '') for t in tools.get('names', [])]
n_read = sum(1 for n in names if re.match(r'^(get|list|search|query|fetch|read|check|test)', n, re.I))
n_write = sum(1 for n in names if re.match(r'^(add|create|update|delete|upload|transition|remove|push|set|batch|edit|publish|reset)', n, re.I))
if len(names) != tools.get('total'):
    bad.append('证据里工具名单 %d 个，但 total 写 %s' % (len(names), tools.get('total')))
if (n_read, n_write) != (tools.get('by_class', {}).get('read'), tools.get('by_class', {}).get('write')):
    bad.append('证据里工具分类计数与按规则重算不一致（重算 read=%d write=%d，证据 %s）' % (n_read, n_write, tools.get('by_class')))
# 「读不到文档」依赖名单里确实没有读文档的工具——按名单重算，不只信 result 字段
doc_like = [n for n in names if re.search(r'doc|wiki|sheet|bitable|drive|file_content|read_file', n, re.I)]
if sorted(doc_like) != sorted(doc.get('matching', [])):
    bad.append('证据 doc_reading.matching 与按名单重算不一致（重算 %s）' % doc_like)

# =====================================================================
# 核心需求表的行数单独数出来并打印；它恒为 0 曾是第 4 个漏掉的错，所以要打出来让人看见
n_req = sum(1 for line in md.split('\n') if re.match(r'^\| R[0-9]+ \|', line))
if n_req == 0:
    bad.append('核心需求表一行都没识别到（期望 R1 起）')
main_nums = sorted(set(n for _, n in main_refs))
sub_refs = sorted(set(re.findall(r'§2\.2-([A-Za-z])', md)))

print('  章节 %d 个 | US %d 个 | §2.2 前提核对 %d 行 | 核心需求 %d 条' % (
    len(heads), len(us_blocks), len(rows22), n_req))
print('  证据支撑的数字: ' + '  '.join('%s=%s' % (label, value) for value, _, label in expected))
print('  ID 类型: brief=%s / MQL=%s | 读文档工具: %s' % (bt, mt, doc_like or '无'))
print('  主引用章节号: %s | 小节引用: %s' % (main_nums, ['§2.2-' + t for t in sub_refs]))
print('问题:', bad or '无')
sys.exit(1 if bad else 0)
