// feishu-intake 的断言与用例。由 test/feishu-intake.test.sh 调起，不单独运行。
//
// 用法：node assert.mjs <lib 路径> <套件名> [仓库根]
// 输出每个断言的 ✓/✗，末行计数；有失败退出 1。
//
// 对外依赖（飞书调用、下载、PDF 解析、文件读写）全部用假的，不起网络、不占端口。
// 只有两类用例外：真实建档用例在一个仓库副本上跑真的 init-harness.sh 与 ci-verify。
//
// 断言写法的几条规矩（test-quality.md）：
//   · 精确集合，不用 includes——「读到了一些字段」挡不住「该出现的附件没出现」；
//   · 负向用例除了断言报错，还断言错误信息、且没有留下任何文件；
//   · 建议与推荐值用仓库里真实的解析器（decisions.mjs）验证，不自己另写一套判断。
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [libPath, suite, repoRoot] = process.argv.slice(2);
const lib = await import(pathToFileURL(libPath).href);
// 真实的解析器：待决项的推荐值必须能被它原样解析，否则 resume 回填时会失败。
// 路径相对本测试文件定位，不相对被测文件——被测文件可能是临时目录里的变异副本。
const { parseDecision, optionList } = await import(new URL('../scripts/lib/cli/decisions.mjs', import.meta.url).href);
// 编排层（scripts/feishu-intake.mjs）没有注入式的测试面，唯一要钉的点用依赖注入钉：入参先于网络。
const cli = await import(new URL('../scripts/feishu-intake.mjs', import.meta.url).href);

const results = [];
const ok = (cond, name) => results.push({ name, pass: !!cond, detail: '' });
const eq = (actual, expected, name) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  results.push({ name, pass: a === e, detail: a === e ? '' : `期望 ${e.slice(0, 160)}，实际 ${a.slice(0, 160)}` });
};
// target 可以是 promise，或「调用它就会抛错」的函数——同步抛错的函数直接传返回值是包不住的。
const rejects = async (target, code, messagePart, name) => {
  try {
    await (typeof target === 'function' ? target() : target);
    results.push({ name, pass: false, detail: '没有报错' });
  } catch (e) {
    const pass = e.name === 'IntakeError' && (code == null || e.code === code) && (!messagePart || String(e.message).includes(messagePart));
    results.push({ name, pass, detail: pass ? '' : `错误是 ${e.name} code=${e.code}：${String(e.message).slice(0, 140)}` });
  }
};

const CFG = {
  dir: '.ai/intake',
  fields: { description: ['描述'], behaviorChange: ['用户行为变更说明'], impact: ['影响范围（by Dev）'] },
  attachmentFields: ['附件'],
  typeMap: { feature: ['需求', 'Feature'], bugfix: ['缺陷', 'Defect'], ask: ['任务'] },
  noChangeMarkers: ['无变化', '无'],
  minDescriptionLength: 20,
};
const BASE_FIELDS = [
  { field_key: 'description', field_name: '描述', field_type: 'multi-text' },
  { field_key: 'field_bc', field_name: '用户行为变更说明', field_type: 'multi-text' },
  { field_key: 'field_imp', field_name: '影响范围（by Dev）', field_type: 'multi-text' },
  { field_key: 'field_att', field_name: '附件', field_type: 'multi-file' },
  { field_key: 'field_iter', field_name: '迭代周期', field_type: 'workitem_related_select' },
];

/** 假的飞书通道：记录每次调用，按工具名返回夹具数据。 */
function fakeFeishu(o = {}) {
  const calls = [];
  const id = o.id ?? '9001';
  const brief = {
    work_item_attribute: {
      work_item_id: id, work_item_name: o.name ?? '测试工作项',
      work_item_type: { key: 'k1', name: o.typeName ?? 'Defect' },
      work_item_status: { key: 'S1', name: 'New' },
      role_members: o.owners === undefined ? [{ role: 'Owner', name: '负责人', members: [{ name: '张三' }, { name: '李四' }] }, { role: 'Reporter', name: '报告人', members: [{ name: '王五' }] }] : o.owners,
      update_time: o.updatedAt ?? '2026-11-26T10:00:00+08:00',
    },
  };
  const fieldConfig = { list: o.fields ?? BASE_FIELDS };
  const values = o.values ?? {
    description: { string_value: o.description ?? '把仪表板导出功能补上导出范围的选择，并在导出后提示文件位置。' },
    field_bc: { string_value: o.behaviorChange ?? '无变化' },
    field_imp: { string_value: '仪表板' },
    field_att: { key_label_value_list: o.attachments ?? [{ key: 'https://project.feishu.cn/att/1', label: '报告.pdf' }] },
  };
  const row = { moql_field_list: [{ key: 'work_item_id', value: { long_value: Number(id) } }, ...Object.entries(values).map(([key, value]) => ({ key, value }))] };
  const call = async (name) => {
    calls.push(name);
    if (name === 'get_workitem_brief') return JSON.stringify(brief);
    if (name === 'list_workitem_field_config') { if (o.fieldConfigError) throw new Error('字段表读取超时'); return JSON.stringify(fieldConfig); }
    if (name === 'search_by_mql') { if (o.mqlError) throw new Error('ErrMetadataError: metadata error'); return JSON.stringify({ data: { '1': [row] } }); }
    if (name === 'list_related_workitem') { if (o.relatedError) throw new Error('关联读取超时'); return JSON.stringify(o.relatedShape ?? { list: [{ id: 'R1', name: '迭代 26.1', work_item_type_key: 'Defect', project_key: 'space_x' }] }); }
    if (name === 'list_workitem_comments') return JSON.stringify(o.comments ?? [{ comment_id: 'c1', content: '一条评论', file_url: '' }]);
    if (name === 'get_download_url') return JSON.stringify({ download_url: 'https://project.feishu.cn/dl/1', sign: 'sig', is_multipart: false });
    throw new Error('夹具没准备这个工具：' + name);
  };
  return { call, calls };
}

/** 内存里的文件系统：能精确说出写过哪些文件。 */
function memIo(root, o = {}) {
  const files = new Map();
  return {
    root, files,
    exists: (p) => files.has(p),
    readText: (p) => { if (!files.has(p)) throw new Error('读不到：' + p); return String(files.get(p)); },
    write: (p, data) => { files.set(p, data); },
    mkdir: (p) => { files.set(p, '<目录>'); },
    download: async () => (o.downloadOk === false ? { ok: false, status: 403 } : { ok: true, status: 200, contentType: o.contentType ?? 'application/pdf', data: Buffer.from('%PDF-1.4 假文件') }),
    extractPdf: async () => (o.pdfOk === false ? { ok: false, error: '没有 pypdf' } : { ok: true, text: 'PDF 正文内容' }),
  };
}
const intakeOf = async (o = {}, ioOpts = {}) => {
  const fx = fakeFeishu(o);
  const io = memIo('/repo', ioOpts);
  const r = await lib.runIntake({ ref: o.ref ?? '9001', projectKey: 'space_x', cfg: CFG, call: fx.call, io });
  return { fx, io, r };
};
const itemOf = (o) => ({ fields: o.fields ?? [], attachments: o.attachments ?? [], links: o.links ?? [], unread: o.unread ?? [], type: { name: o.typeName ?? 'Defect' }, notesLength: o.notesLength ?? 0 });
const fld = (role, status, text = '') => ({ role, name: role, status, text });

// =====================================================================
if (suite === 'unit') {
  // ---- parseWorkItemRef ----
  eq(lib.parseWorkItemRef('7176122491'), { workItemId: '7176122491' }, 'ID：纯数字');
  eq(lib.parseWorkItemRef(' 9001 '), { workItemId: '9001' }, 'ID：两端空白被去掉');
  eq(lib.parseWorkItemRef('https://project.feishu.cn/space/x/work_item/7176122491'), { workItemId: '7176122491' }, '链接：work_item 路径');
  eq(lib.parseWorkItemRef('https://project.feishu.cn/x?work_item_id=7176122491&tab=1'), { workItemId: '7176122491' }, '链接：work_item_id 参数');
  eq(lib.parseWorkItemRef('https://project.feishu.cn/space/x/7176122491#detail'), { workItemId: '7176122491' }, '链接：路径末尾的数字');
  await rejects(() => lib.parseWorkItemRef('abc'), 64, '认不出工作项', '认不出的输入被拒，并说明');
  await rejects(() => lib.parseWorkItemRef('https://project.feishu.cn/space/x'), 64, '认不出工作项', '链接里没有 ID 被拒');

  // ---- resolveFieldKeys ----
  const r1 = lib.resolveFieldKeys(BASE_FIELDS, { description: ['描述'], behaviorChange: ['用户行为变更说明'], rootCause: ['根因分析（By Dev）'] });
  eq(r1.resolved, { description: 'description', behaviorChange: 'field_bc' }, '字段名解析成 key');
  eq(r1.missing.length, 1, '该类型没有的字段进未解析清单');
  ok(r1.missing[0].includes('rootCause') && r1.missing[0].includes('根因分析'), '未解析项点名是哪个字段、配置的什么名称');
  eq(lib.resolveFieldKeys([{ field_key: 'k', field_name: 'Root Cause  (By Dev)' }], { x: ['root cause(by dev)'] }).resolved, { x: 'k' }, '名称匹配忽略大小写与空白');

  // ---- validateIntakeCfg ----
  eq(lib.validateIntakeCfg({ ...CFG, minDescriptionLength: undefined }).minDescriptionLength, 20, '缺省描述长度阈值');
  await rejects(() => lib.validateIntakeCfg({ ...CFG, dir: '' }), 1, 'dir', '缺存放目录被拒，并点名');
  await rejects(() => lib.validateIntakeCfg({ ...CFG, fields: {} }), 1, 'fields', '字段配置为空被拒');
  await rejects(() => lib.validateIntakeCfg({ ...CFG, fields: { description: ['描述'], x: [] } }), 1, 'fields.x', '字段名为空数组被拒，并点名');
  await rejects(() => lib.validateIntakeCfg({ ...CFG, typeMap: { Feature: ['需求'] } }), 1, 'typeMap.Feature', '映射表的桶名拼错被拒');
  await rejects(() => lib.validateIntakeCfg({ ...CFG, dir: '../outside' }), 1, '仓库外', '存放目录指向仓库外被拒');
  await rejects(() => lib.validateIntakeCfg({ ...CFG, minDescriptionLength: 'abc' }), 1, 'minDescriptionLength', '阈值不是数字被拒');

  // ---- extractLinks / extractEmbeddedImages ----
  const noise = '在 IDMP 2.0.3.3-http://2.0.3.3 和数据版本 2.0.2.9-http://2.0.2.9 上测试';
  eq(lib.extractLinks(noise), [], '版本号写法不是链接（真实噪声）');
  const mixed = '见 https://git.example.com/a/b/-/merge_requests/1972 。文档 https://x.feishu.cn/docx/AbCdEf123 与 https://example.com/page,';
  eq(lib.extractLinks(mixed).map((l) => [l.kind, l.url]), [
    ['other', 'https://git.example.com/a/b/-/merge_requests/1972'],
    ['feishu_doc', 'https://x.feishu.cn/docx/AbCdEf123'],
    ['other', 'https://example.com/page'],
  ], '链接分类：普通外链与飞书文档，尾部标点被去掉');
  eq(lib.extractLinks('截图 ![image](https://project.feishu.cn/box/stream/v1/abc) 这里'), [], '内嵌图片不算链接');
  eq(lib.extractEmbeddedImages('截图 ![image](https://project.feishu.cn/box/stream/v1/abc) 和 ![图](https://project.feishu.cn/box/stream/v1/def)'),
    ['https://project.feishu.cn/box/stream/v1/abc', 'https://project.feishu.cn/box/stream/v1/def'], '内嵌图片地址被取出');
  eq(lib.extractEmbeddedImages('IDMP Security and Permissions Issue Tracker v1.10.pdf'), [], '文件名文字不是图片');

  // ---- classify ----
  const five = (q) => q.type === 'human_decision' && typeof q.question === 'string' && q.question.trim() !== '' && Array.isArray(q.evidence) && q.evidence.length > 0;
  const shapeOk = (qs) => qs.every((q) => five(q) && /^FI-[1-9]\d*$/.test(q.id) && optionList(q).length > 0 && q.multi === false
    && (!q.recommendation || (parseDecision(q, q.recommendation).error == null && parseDecision(q, q.recommendation).ids.length > 0)));
  const plain = () => itemOf({ fields: [fld('description', 'read', '把仪表板导出功能补上导出范围的选择，并在导出后提示文件位置。'), fld('behaviorChange', 'read', '无变化')] });

  const c1 = lib.classify(plain(), CFG);
  eq([c1.suggested, c1.confidence, c1.questions.length], ['bugfix', 'high', 0], '缺陷 + 描述充分 + 无行为变更 → bugfix，把握高，无待决项');
  ok(c1.evidence.some((e) => e.includes('按配置表对应 bugfix')), '类型建议带依据（来自配置表）');
  eq(lib.classify(itemOf({ typeName: 'Feature', fields: plain().fields }), CFG).suggested, 'feature', '需求类 → feature');
  const c2 = lib.classify(itemOf({ typeName: '任务', fields: plain().fields }), CFG);
  eq([c2.suggested, c2.questions.length], [null, 1], '任务类 → 无建议，并列为待决项');
  eq(optionList(c2.questions[0]).length, 3, '类型待决项给出三种类型可选');
  const c3 = lib.classify(itemOf({ typeName: '版本发布', fields: plain().fields }), CFG);
  eq([c3.suggested, c3.questions.length], [null, 1], '不在映射表里的类型 → 无建议，并列为待决项');
  const changed = itemOf({ fields: [fld('description', 'read', '把仪表板导出功能补上导出范围的选择，并在导出后提示文件位置。'), fld('behaviorChange', 'read', '导出按钮从右上角移到左上角')] });
  const c4 = lib.classify(changed, CFG);
  eq(c4.questions.length, 1, '行为变更说明写了内容 → 列为待决项（是不是 change 要人定）');
  ok(c4.questions[0].question.includes('导出按钮从右上角移到左上角'), '待决项原样带出字段里写的内容');
  eq(lib.classify(itemOf({ fields: [fld('description', 'read', '足够长的描述内容，超过二十个字的阈值，用来测试。')] }), CFG).questions.length, 0, '没有行为变更字段不算矛盾，不产生待决项');
  const short = lib.classify(itemOf({ fields: [fld('description', 'read', '坏了'), fld('behaviorChange', 'read', '无')] }), CFG);
  eq([short.confidence, short.questions.length], ['low', 1], '描述过短 → 把握低，并列为待决项');
  ok(shapeOk(short.questions), '待决项形状完整，推荐值能被真实解析器解析');
  const withDoc = itemOf({ fields: plain().fields, links: [{ url: 'https://x.feishu.cn/wiki/AbC', kind: 'feishu_doc', status: 'not_read' }] });
  const c5 = lib.classify(withDoc, CFG);
  eq(c5.questions.length, 1, '有读不到的飞书文档 → 列为待决项');
  ok(c5.questions[0].recommendation === '关键：我来提供内容（写进 NOTES.md 后重跑）', '材料待决项给保守推荐（宁可多要一次材料，不缺着料确认）');
  const shortWithNotes = lib.classify(itemOf({ fields: [fld('description', 'read', '坏了')], notesLength: 120 }), CFG);
  ok(shortWithNotes.questions[0].recommendation === '按现有描述和补充材料继续', '描述过短但人已补了材料 → 推荐按现有材料继续，不再硬要重写');
  const badAtt = itemOf({ fields: plain().fields, attachments: [{ status: 'download_failed' }] });
  eq(lib.classify(badAtt, CFG).questions.length, 1, '附件下载失败 → 列为待决项');
  const many = lib.classify(itemOf({ typeName: '任务', fields: [fld('description', 'read', '短')], attachments: [{ status: 'parse_failed' }], links: [{ kind: 'feishu_doc' }] }), CFG);
  eq(many.questions.length, 3, '计数恒等式：类型不确定 + 验收不清 + 读不到的材料 = 3 项');
  // 全组合：只要给了类型建议，就必须有来自配置表的依据；待决项编号连续且唯一
  let violations = 0;
  for (const typeName of ['Defect', 'Feature', '任务', '版本发布', '']) {
    for (const desc of ['', '坏了', '足够长的描述内容，超过二十个字的阈值，用来测试。']) {
      for (const bc of [undefined, '无变化', '界面变了']) {
        for (const extra of [{}, { links: [{ kind: 'feishu_doc' }] }, { attachments: [{ status: 'download_failed' }] }]) {
          const fields = [];
          if (desc !== undefined) fields.push(fld('description', desc === '' ? 'empty' : 'read', desc));
          if (bc !== undefined) fields.push(fld('behaviorChange', 'read', bc));
          const r = lib.classify(itemOf({ typeName, fields, ...extra }), CFG);
          if (r.suggested && !r.evidence.some((e) => e.includes('按配置表对应'))) violations += 1;
          const ids = r.questions.map((q) => q.id);
          if (new Set(ids).size !== ids.length || !shapeOk(r.questions)) violations += 1;
        }
      }
    }
  }
  eq(violations, 0, '全组合 240 种：有建议必有依据；待决项编号唯一、形状完整、推荐值可解析');

  // ---- 只读闸 ----
  let forwarded = 0;
  const raw = async () => { forwarded += 1; return '{}'; };
  await rejects(() => lib.readOnlyCall(raw).call('add_comment', {}), 1, '拒绝调用「add_comment」', '只读闸：写工具被拒，并说明原因');
  eq(forwarded, 0, '只读闸：被拒的请求没有发给真实通道');
  await lib.readOnlyCall(raw).call('get_workitem_brief', {});
  eq(forwarded, 1, '只读闸：白名单内的读取工具照常放行');
}

// =====================================================================
if (suite === 'intake') {
  // B1 正常路径
  const a = await intakeOf();
  eq(a.r.calls, ['get_workitem_brief', 'list_workitem_field_config', 'search_by_mql', 'list_workitem_comments', 'list_related_workitem', 'get_download_url'], '全流程调用的工具恰好是这六个读取工具（精确集合）');
  eq(a.r.item.fields.map((f) => [f.role, f.status]), [['description', 'read'], ['behaviorChange', 'read'], ['impact', 'read']], '三个字段都读到');
  eq(a.r.item.attachments.map((x) => [x.name, x.origin, x.status]), [['报告.pdf', 'field', 'parsed']], '附件字段里的 PDF 被下载并解析（回归钉：曾静默丢失）');
  eq(a.r.classification.suggested, 'bugfix', '建议类型');
  const written = [...a.io.files.keys()];
  ok(written.every((p) => p.startsWith('/repo/.ai/intake/9001')), '读取阶段只写进 .ai/intake/<id>/，不碰别的目录');
  ok(!written.some((p) => p.includes('.ai/tasks/')), '未确认不建档：没有任何文件写进 .ai/tasks');
  const summary = String(a.io.files.get('/repo/.ai/intake/9001/summary.md'));
  ok(summary.startsWith(lib.GENERATED_MARK), '摘要首行是生成标记');
  const saved = JSON.parse(String(a.io.files.get('/repo/.ai/intake/9001/item.json')));
  eq(saved.id, '9001', 'item.json 可解析，记录工作项 ID');
  for (const kw of ['需求摘要', '已读取', '没有读取到的', '任务类型建议', '需要你决定的事', '下一步', '依据：', '影响范围：']) ok(summary.includes(kw), `摘要含「${kw}」`);
  ok(summary.includes('状态：New'), '摘要里的状态是人读的名字，不是对象');
  ok(summary.includes('负责人：负责人 张三、李四 ／ 报告人 王五'), '摘要列出各角色的负责人');
  eq(a.r.item.related, [{ field: '迭代周期', id: 'R1', name: '迭代 26.1', typeKey: 'Defect' }], '关联工作项按关联字段逐个读出');
  eq(a.r.item.relatedFieldCount, 1, '关联字段的个数也记录（区分「读了是空」与「没得读」）');
  ok(summary.includes('| 关联工作项 | 已读 | 迭代周期「迭代 26.1」 |'), '摘要在总表里列出关联工作项');
  ok(summary.includes('（application/pdf）'), '附件行记录文件类型');
  eq(a.r.item.sourceUrl, null, '输入是数字 ID 时不编造工作项链接');
  const a2 = await intakeOf({ ref: 'https://project.feishu.cn/space/x/work_item/9001' });
  eq([a2.r.item.sourceUrl, String(a2.io.files.get('/repo/.ai/intake/9001/summary.md')).includes('https://project.feishu.cn/space/x/work_item/9001')],
    ['https://project.feishu.cn/space/x/work_item/9001', true], '输入是链接时，摘要里的来源带上这个链接');

  // B2 该类型没有配置的字段
  const b = await intakeOf({ typeName: '任务', fields: BASE_FIELDS.slice(0, 1) });
  eq(b.r.item.fields.map((f) => f.status), ['read', 'missing', 'missing'], '该类型没有的字段标为「该类型没有」');
  eq(b.r.item.unread.map((u) => u.kind), ['field_missing', 'field_missing', 'field_missing'], '缺的字段进未读取清单：两个描述类字段加一个附件字段');
  ok(b.r.item.unread.every((u) => u.reason.includes('没有这个名称')), '未读取原因说明是该类型没有这个名称');
  ok(String(b.io.files.get('/repo/.ai/intake/9001/summary.md')).includes('用户行为变更说明'), '摘要里列出了没读到的字段');

  // B3 查询失败
  const c = await intakeOf({ mqlError: true });
  eq([...new Set(c.r.item.fields.map((f) => f.status))], ['failed'], '查询失败时字段标为读取失败，不是空、也不是没有');
  eq(c.r.item.unread.map((u) => u.what), ['描述类字段与附件字段的取值'], '查询失败进未读取清单');
  ok(String(c.io.files.get('/repo/.ai/intake/9001/summary.md')).includes('metadata error'), '摘要里写出失败原因');
  eq(c.r.classification.questions.length, 2, '读不到描述 → 两项待决：验收不清、材料读取失败');

  // B4 附件下载失败
  const d = await intakeOf({}, { downloadOk: false });
  eq(d.r.item.attachments.map((x) => [x.status, x.error]), [['download_failed', '下载失败：HTTP 403']], '下载失败被记录，流程不中断');

  // B5 PDF 解析器不可用
  const e = await intakeOf({}, { pdfOk: false });
  eq(e.r.item.attachments[0].status, 'parse_failed', '解析不了时标为未解析');
  ok(e.io.files.has('/repo/.ai/intake/9001/attachments/1-报告.pdf'), '未解析的附件保留原件');

  // B6 读不到的飞书文档
  const f = await intakeOf({ description: '详见 https://x.feishu.cn/docx/AbCdEf123 里的说明，另外见 https://git.example.com/a/b 的改动。' });
  eq(f.r.item.links.map((l) => [l.kind, l.status]), [['feishu_doc', 'not_read'], ['other', 'not_read']], '链接被列出并标注读取状态');
  ok(f.r.item.links[0].reason.includes('没有读取文档正文的能力'), '飞书文档的未读取原因写明是接口没有这个能力');
  const fsum = String(f.io.files.get('/repo/.ai/intake/9001/summary.md'));
  ok(fsum.includes('未读取的飞书文档链接 1 个') && fsum.includes('https://x.feishu.cn/docx/AbCdEf123'), '摘要在「没有读取到的」里列出文档链接');

  // B7 评论附件与内嵌图片
  const g = await intakeOf({
    description: '截图为证 ![截图](https://project.feishu.cn/box/stream/v1/img1)',
    comments: [{ comment_id: 'c1', content: '看这个日志', file_url: 'https://project.feishu.cn/att/log' }, { comment_id: 'c2', content: '没附件', file_url: '' }],
  });
  eq(g.r.item.attachments.map((x) => x.origin).sort(), ['comment', 'embedded', 'field'], '三种来源的附件都被处理：字段、评论附件、描述内嵌图片');
  ok(String(g.io.files.get('/repo/.ai/intake/9001/summary.md')).includes('评论附件这一路没有实测过'), '评论附件在摘要里标注「此路径未实测」');

  // ---- 确认阶段：校验全部在建档之前；被拒不留文件、不调建档脚本 ----
  const itemFile = '/repo/.ai/intake/9001/item.json';
  const seeded = (questions = []) => { const io = memIo('/repo'); io.files.set(itemFile, JSON.stringify({ id: '9001', updatedAt: '2026-11-26T10:00:00+08:00', classification: { questions }, suggestedTier: 'S' })); return io; };
  const question = { id: 'FI-1', type: 'human_decision', question: '类型？', options: [{ id: '1', label: 'feature：新功能' }, { id: '2', label: 'bugfix：修缺陷' }], multi: false, evidence: ['规则判断不了'] };
  // confirm：返回 {err} 或 {r}，并带回建档脚本被调用的次数与参数
  const confirm = async (o) => {
    const io = o.io || seeded();
    const spawned = [];
    const p = lib.confirmIntake({ ref: '9001', type: 'feature', by: '测试者', projectKey: 'space_x', cfg: CFG, call: fakeFeishu().call, ...o, io,
      spawn: (cmd, args) => {
        spawned.push([cmd, ...args]);
        if (String(args[0]).endsWith('init-harness.sh')) io.files.set('/repo/.ai/tasks/feishu-9001/state.json', JSON.stringify({ meta: {}, stage: 'rs', blockers: [] }));
        if (args.includes('--json')) return o.ciResult ?? { status: 0, stdout: '[verify] 提示：1 条不判失败\n{"ok":true,"mode":"ci","root":"/repo","checked":[],"problems":[],"notices":[]}', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      } });
    return p.then((r) => ({ r, io, spawned }), (err) => ({ err, io, spawned }));
  };
  const noTaskFiles = (io) => [...io.files.keys()].every((p) => !p.includes('.ai/tasks'));

  const r1 = await confirm({ io: memIo('/repo') });
  ok(r1.err?.code === 64 && r1.err.message.includes('先读一次') && r1.spawned.length === 0, '没有读取结果 → 拒绝，建档脚本没被调用');
  const r2 = await confirm({ by: '' });
  ok(r2.err?.code === 64 && r2.err.message.includes('记名') && r2.spawned.length === 0, '缺 --by → 拒绝');
  const r3 = await confirm({ type: 'Feature' });
  ok(r3.err?.code === 64 && r3.spawned.length === 0, '类型写错大小写 → 拒绝（枚举闭合）');
  const r4 = await confirm({ type: 'change' });
  ok(r4.err?.code === 64 && r4.err.message.includes('需求基线') && r4.spawned.length === 0, 'change 没带需求基线 → 拒绝');
  const r5 = await confirm({ call: fakeFeishu({ updatedAt: '2026-11-26T18:00:00+08:00' }).call });
  ok(r5.err?.code === 1 && r5.err.message.includes('有更新') && r5.spawned.length === 0 && noTaskFiles(r5.io), '工作项在读取后有更新 → 拒绝，不留档案');
  const dup = seeded(); dup.files.set('/repo/.ai/tasks/feishu-9001/state.json', '{"已有":"任务"}');
  const r6 = await confirm({ io: dup });
  ok(r6.err?.code === 1 && r6.err.message.includes('已经存在') && r6.spawned.length === 0, '同名任务已存在 → 不覆盖');
  const r7 = await confirm({ slug: 'Bad Slug' });
  ok(r7.err?.code === 64 && r7.spawned.length === 0, '任务名不合规范 → 拒绝');

  // 合法路径：建档参数、阻断写入、阶段不变
  const okCase = await confirm({ io: seeded([question]) });
  eq(okCase.spawned[0], ['bash', 'scripts/init-harness.sh', 'feishu-9001', 'S', '--type', 'feature'], 'feature 建档命令：档位取建议值，不带来源参数');
  const st = JSON.parse(okCase.io.files.get('/repo/.ai/tasks/feishu-9001/state.json'));
  eq([st.blockers, st.stage], [[question], 'rs'], '未答的待决问题原样写进档案；阶段停在 rs');
  eq([st.meta.related_task, st.meta.remote_id], ['feishu:9001', { source: 'feishu', id: '9001' }], 'feature 的来源在这里补上');
  ok(st.meta.confirmed_by === '测试者' && typeof st.meta.confirmed_at === 'string' && st.meta.confirmed_at.length > 0, '确认人与确认时间落进档案（记名不只用来校验）');
  eq([okCase.r.verified, okCase.r.repoClean, okCase.r.checkRan], [true, true, true], '校验器返回干净的 JSON → 三个判定都真');
  const bx = await confirm({ io: seeded(), type: 'bugfix' });
  eq(bx.spawned[0].slice(-4), ['--type', 'bugfix', '--related', 'feishu:9001'], 'bugfix 建档带来源参数');
  const ch = await confirm({ io: seeded(), type: 'change', baseline: 'abc1234' });
  eq(ch.spawned[0].slice(-4), ['--related', 'feishu:9001', '--baseline', 'abc1234'], 'change 建档带来源与需求基线');
  const tl = await confirm({ io: seeded(), tier: 'M', slug: 'my-task' });
  eq(tl.spawned[0].slice(1, 5), ['scripts/init-harness.sh', 'my-task', 'M', '--type'], '可用 --slug 与 --tier 覆盖任务名和档位');

  // 校验器三种结果的三种判定：没跑成 ≠ 通过；点名新任务才算新任务的；只有别的任务红不影响 verified
  const badCi = await confirm({ ciResult: { status: 0, stdout: '输出被截断了', stderr: '' } });
  ok(badCi.r.verified === false && badCi.r.checkRan === false && String(badCi.r.verifyLines[0]).includes('没有跑成'), '校验器输出解析不了 → 判「没跑成」，不得当成通过');
  const mineRed = await confirm({ ciResult: { status: 1, stdout: '{"ok":false,"problems":["feishu-9001: FTI2 [verify] 日志红"]}' } });
  ok(mineRed.r.verified === false && mineRed.r.verifyLines[0].includes('feishu-9001:'), '点名新任务的问题 → verified=false，原样列出');
  const othersRed = await confirm({ ciResult: { status: 1, stdout: '{"ok":false,"problems":["other-task: 红"]}' } });
  eq([othersRed.r.verified, othersRed.r.repoClean], [true, false], '只有别的任务红 → 新档案仍 verified，整仓 repoClean=false');

  // B7d 返回形态不认识：不把「形态不认识」当成「没有」——评论、关联、负责人三条路逐个验
  const unknown = await intakeOf({ comments: { foo: 1 }, owners: '张三', relatedShape: { weird: true } });
  ok(unknown.r.item.unread.some((u) => u.what === '评论' && u.reason.includes('形态不认识')), '评论返回形态不认识 → 报出来，不当作没有评论');
  ok(unknown.r.item.unread.some((u) => u.what.includes('关联工作项') && u.reason.includes('形态不认识')), '关联返回形态不认识 → 报出来');
  ok(unknown.r.item.unread.some((u) => u.what === '负责人'), '负责人返回形态不认识 → 报出来');
  const matQ = unknown.r.classification.questions.find((q) => q.question.includes('关键'));
  ok(!!matQ && matQ.recommendation === '关键：我来提供内容（写进 NOTES.md 后重跑）', '形态不认识汇入「材料是否关键」待决项，带保守推荐');
  ok(String(unknown.io.files.get('/repo/.ai/intake/9001/summary.md')).includes('负责人：返回的形态不认识，没有取到'), '摘要里负责人一行写明「形态不认识」');
  const noOwners = await intakeOf({ owners: null });
  eq(noOwners.r.item.ownersState, 'absent', '返回里没有角色成员字段 = absent，不算失败');
  ok(!noOwners.r.item.unread.some((u) => u.what === '负责人'), 'absent 不进失败清单');

  // B8 摘要被人改过 → 不覆盖
  const h1 = await intakeOf();
  const summaryPath = '/repo/.ai/intake/9001/summary.md';
  const edited = '我手写的验收标准：导出后要弹提示。\n';
  h1.io.files.set(summaryPath, edited);
  h1.io.files.set('/repo/.ai/intake/9001/NOTES.md', '补充：只导出当前筛选结果。\n');
  const before = new Map(h1.io.files);
  await rejects(lib.runIntake({ ref: '9001', projectKey: 'space_x', cfg: CFG, call: fakeFeishu().call, io: h1.io }), 1, '没有覆盖', '摘要被人改过后，重跑不覆盖');
  eq(h1.io.files.get(summaryPath), edited, '人的编辑原样保留');
  eq(h1.io.files.get('/repo/.ai/intake/9001/NOTES.md'), before.get('/repo/.ai/intake/9001/NOTES.md'), '人的补充材料没被动');
  const i2 = await intakeOf();
  i2.io.files.set('/repo/.ai/intake/9001/NOTES.md', '补充：只导出当前筛选结果。');
  const again = await lib.runIntake({ ref: '9001', projectKey: 'space_x', cfg: CFG, call: fakeFeishu().call, io: i2.io });
  eq(again.item.notesLength, '补充：只导出当前筛选结果。'.length, '补充材料被读进摘要（字数）');
  const notesSum = String(i2.io.files.get('/repo/.ai/intake/9001/summary.md'));
  ok(notesSum.includes('人补充的材料（NOTES.md，') && notesSum.includes('补充：只导出当前筛选结果。'), '摘要列出补充材料的实际内容，不只是字数');

  // B9 认不出的输入：不写任何文件、不发任何请求（断的是真的通道，不是新造的）
  const j = memIo('/repo');
  const jb = fakeFeishu();
  await rejects(lib.runIntake({ ref: 'abc', projectKey: 'space_x', cfg: CFG, call: jb.call, io: j }), 64, '认不出工作项', '认不出的输入被拒');
  eq(j.files.size, 0, '被拒时没有写任何文件');
  eq(jb.calls.length, 0, '被拒时没有发出任何飞书请求');

  // B10 附件字段形态不认识
  const k = await intakeOf({ values: { description: { string_value: '足够长的描述内容，超过二十个字的阈值，用来测试。' }, field_bc: { string_value: '无变化' }, field_att: { string_value: '形态不对' } } });
  eq(k.r.item.attachments.length, 0, '形态不认识时没有附件可下载');
  ok(k.r.item.unread.some((u) => u.what === '附件字段' && u.reason.includes('形态不认识')), '形态不认识被报出来，没有当成「没有附件」');

  // B11 编排层：入参先于网络——ID 不合法时直接拒绝，不去碰凭据也不连接口
  let touched = 0;
  await rejects(() => cli.cmdFeishu('.', 'abc', {}, {
    ensureToken: async () => { touched += 1; return 't'; },
    connect: async () => { touched += 10; return { call: async () => '{}' };
  } }), 64, '认不出工作项', 'ID 不合法 → 在连飞书之前就被拒');
  eq(touched, 0, '被拒时没有碰凭据也没有连接口');

}

// =====================================================================
// 真实建档：在一个仓库副本上跑真的 init-harness.sh 与真的 ci-verify。
// 目的是回答「工具写下的状态能不能过它自己的门禁」——这条用假的是答不了的。
if (suite === 'confirm-real') {
  const steps = [];
  const step = (name, fn) => steps.push([name, fn]);
  let slug = '';
  const id = '9001';
  const cfg = lib.validateIntakeCfg(JSON.parse(readFileSync(join(repoRoot, 'harness.rules.json'), 'utf8')).runtime.feishu.intake);
  const io = { root: repoRoot, exists: (p) => existsSync(p), readText: (p) => readFileSync(p, 'utf8'), write: (p, d) => writeFileSync(p, d), mkdir: (p) => mkdirSync(p, { recursive: true }) };

  step('seed', async () => {
    // 先读取一次，产物落在副本里（类型「任务」→ 有一项类型待决）
    const fx = fakeFeishu({ id, typeName: '任务', attachments: [] });
    await lib.runIntake({ ref: id, projectKey: 'space_x', cfg, call: fx.call, io });
  });
  step('feature', async () => {
    const fx = fakeFeishu({ id, typeName: '任务' });
    const r = await lib.confirmIntake({ ref: id, type: 'feature', by: '测试者', projectKey: 'space_x', cfg, call: fx.call, root: repoRoot });
    slug = r.slug;
    const st = JSON.parse(readFileSync(r.statePath, 'utf8'));
    eq([st.meta.task_type, st.meta.remote_id, st.meta.flow_tier], ['feature', { source: 'feishu', id }, 'S'], 'feature 建档：类型、来源、档位都对');
    eq([st.blockers.length, st.blockers[0]?.type, st.blockers[0]?.id], [1, 'human_decision', 'FI-1'], '未答的待决问题写成了阻断');
    eq(st.meta.related_task, 'feishu:' + id, '来源工作项写进档案（feature 建档脚本不收来源参数，这里补上）');
    ok(r.verified, '新档案通过仓库校验' + (r.verified ? '' : '：' + r.verifyLines.join(' | ')));
    eq(r.calls, ['get_workitem_brief'], '确认阶段对飞书只发出一次概况读取');
  });
  step('resume-roundtrip', async () => {
    // 回来的路分两步，都是真实的 resume：先不带参数列出待决项并生成决策单，再带着答案回填。
    const listed = spawnSync('node', ['scripts/harness-cli.mjs', 'resume', '.', slug], { cwd: repoRoot, encoding: 'utf8' });
    ok(String(listed.stdout).includes('FI-1'), 'resume 列出了待决项（FI-1）');
    ok(existsSync(join(repoRoot, '.ai', 'tasks', slug, 'DECISIONS.md')), 'resume 生成了可留存的决策单');
    const decided = spawnSync('node', ['scripts/harness-cli.mjs', 'resume', '.', slug, '--decide', 'FI-1=1', '--by', '测试者'], { cwd: repoRoot, encoding: 'utf8' });
    ok(!/不是合法选项|没有 id 为|没有解析出/.test(String(decided.stdout) + String(decided.stderr)), 'resume 回填时没有报「选项不合法」');
    const st = JSON.parse(readFileSync(join(repoRoot, '.ai', 'tasks', slug, 'state.json'), 'utf8'));
    const b = st.blockers[0];
    eq([b.resolved, b.resolved_by, b.decision_ids], [true, '测试者', ['1']], '待决项被真实 resume 回填：已答、记名、落在选项表内');
  });
  step('bugfix', async () => {
    const fx = fakeFeishu({ id: '9002', typeName: 'Defect', attachments: [] });
    const io2 = io;
    await lib.runIntake({ ref: '9002', projectKey: 'space_x', cfg, call: fx.call, io: io2 });
    const r = await lib.confirmIntake({ ref: '9002', type: 'bugfix', by: '测试者', projectKey: 'space_x', cfg, call: fx.call, root: repoRoot });
    const st = JSON.parse(readFileSync(r.statePath, 'utf8'));
    eq([r.slug, st.meta.task_type, st.meta.related_task, st.meta.remote_id], ['feishu-9002', 'bugfix', 'feishu:9002', { source: 'feishu', id: '9002' }], 'bugfix 建档：来源锚由建档脚本写入');
    eq(st.blockers.length, 0, '缺陷 + 描述充分 → 没有待决项');
    ok(r.verified, 'bugfix 档案通过仓库校验');
  });
  for (const [name, fn] of steps) {
    try { await fn(); } catch (e) { results.push({ name: `用例 ${name} 抛了异常`, pass: false, detail: String(e.message).slice(0, 200) }); break; }
  }
}

// =====================================================================
// 变异检验用例：每条只断言一件事。被改坏的代码跑这里必须失败。
if (suite.startsWith('mutation-')) {
  const which = suite.slice('mutation-'.length);
  if (which === '1') {
    const c = lib.classify(itemOf({ fields: [fld('description', 'read', '足够长的描述内容，超过二十个字的阈值，用来测试。'), fld('behaviorChange', 'read', '界面变了')] }), CFG);
    eq(c.questions.length, 1, '行为变更写了内容必须产生待决项');
  } else if (which === '2') {
    const a = await intakeOf();
    eq(a.r.item.attachments.map((x) => x.status), ['parsed'], '附件字段的值是数组本身，必须被识别并下载');
  } else if (which === '3') {
    const a = await intakeOf();
    const p = '/repo/.ai/intake/9001/summary.md';
    a.io.files.set(p, '人改过的内容');
    await rejects(lib.runIntake({ ref: '9001', projectKey: 'space_x', cfg: CFG, call: fakeFeishu().call, io: a.io }), 1, '没有覆盖', '摘要被人改过后必须拒绝覆盖');
  } else if (which === '4') {
    let forwarded = 0;
    await rejects(() => lib.readOnlyCall(async () => { forwarded += 1; return '{}'; }).call('update_field', {}), 1, '拒绝调用', '写工具必须被只读闸拒绝');
    eq(forwarded, 0, '被拒的请求不得转发');
  } else if (which === '5') {
    const io = memIo('/repo');
    io.files.set('/repo/.ai/intake/9001/item.json', JSON.stringify({ id: '9001', updatedAt: '2026-11-26T10:00:00+08:00', classification: { questions: [] }, suggestedTier: 'S' }));
    const spawn = () => ({ status: 0, stdout: '', stderr: '' });
    await rejects(lib.confirmIntake({ ref: '9001', type: 'feature', by: '', projectKey: 'space_x', cfg: CFG, call: fakeFeishu().call, root: '/repo', io, spawn }), 64, '记名', '没有 --by 必须拒绝');
  } else if (which === '6') {
    const io = memIo('/repo');
    io.files.set('/repo/.ai/intake/9001/item.json', JSON.stringify({ id: '9001', updatedAt: '2026-11-26T10:00:00+08:00', classification: { questions: [] }, suggestedTier: 'S' }));
    const spawn = () => ({ status: 0, stdout: '', stderr: '' });
    await rejects(lib.confirmIntake({ ref: '9001', type: 'Feature', by: '测试者', projectKey: 'space_x', cfg: CFG, call: fakeFeishu().call, root: '/repo', io, spawn }), 64, '只接受', '类型枚举外的值必须拒绝');
  } else if (which === '7') {
    const a = await intakeOf();
    eq(a.r.item.related, [{ field: '迭代周期', id: 'R1', name: '迭代 26.1', typeKey: 'Defect' }], '关联工作项必须按关联字段逐个读出');
  } else if (which === '8') {
    const io = memIo('/repo');
    io.files.set('/repo/.ai/intake/9001/item.json', JSON.stringify({ id: '9001', updatedAt: '2026-11-26T10:00:00+08:00', classification: { questions: [] }, suggestedTier: 'S' }));
    const spawn = (cmd, args) => args.includes('--json')
      ? { status: 0, stdout: '{"ok":true,"problems":[]}', stderr: '' }
      : (io.files.set('/repo/.ai/tasks/feishu-9001/state.json', JSON.stringify({ meta: {}, stage: 'rs', blockers: [] })), { status: 0, stdout: '', stderr: '' });
    await lib.confirmIntake({ ref: '9001', type: 'feature', by: '测试者', projectKey: 'space_x', cfg: CFG, call: fakeFeishu().call, root: '/repo', io, spawn });
    const st = JSON.parse(io.files.get('/repo/.ai/tasks/feishu-9001/state.json'));
    ok(st.meta.confirmed_by === '测试者' && typeof st.meta.confirmed_at === 'string' && st.meta.confirmed_at.length > 0, '确认人与确认时间必须落盘');
  } else if (which === '9') {
    const io = memIo('/repo');
    io.files.set('/repo/.ai/intake/9001/item.json', JSON.stringify({ id: '9001', updatedAt: '2026-11-26T10:00:00+08:00', classification: { questions: [] }, suggestedTier: 'S' }));
    const spawn = (cmd, args) => args.includes('--json')
      ? { status: 0, stdout: '输出被截断了', stderr: '' }
      : (io.files.set('/repo/.ai/tasks/feishu-9001/state.json', JSON.stringify({ meta: {}, stage: 'rs', blockers: [] })), { status: 0, stdout: '', stderr: '' });
    const r = await lib.confirmIntake({ ref: '9001', type: 'feature', by: '测试者', projectKey: 'space_x', cfg: CFG, call: fakeFeishu().call, root: '/repo', io, spawn });
    eq([r.checkRan, r.verified], [false, false], '校验器输出判读不了必须判「没跑成」，不得当成通过');
  }
}

for (const r of results) {
  if (r.pass) console.log(`  ✓ ${r.name}`);
  else console.log(`  ✗ ${r.name}${r.detail ? `（${r.detail}）` : ''}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`结果：${results.length - failed} 通过，${failed} 失败（套件 ${suite}）`);
process.exit(failed ? 1 : 0);
