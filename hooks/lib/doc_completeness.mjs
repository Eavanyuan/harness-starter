/**
 * 文档完备性 —— RS / FS / WBS「写全了没有」。
 *
 * 为什么需要它：阶段门禁只能回答「这一阶段跑过评估没有」，回答不了「这份文档够不够
 * 让下一个人接着干」。首版评审尤其如此——没有 diff 可看，审核人面对 300 行新文档
 * 没有抓手，最后只能凭印象点批准。于是定稿看起来发生了，缺的东西照样缺。
 *
 * 这里只做**机器可判**的部分，判据都是"文档内部的客观事实"：
 *   1. 模板占位符残留（`<一句话描述>` 还在，就是这一段没填）—— 占位符集合从 templates/
 *      反推，不写死清单：改模板即改判据，不需要同步第二处。
 *   2. 模板章节齐全且非空（表格类章节「只有表头」= 没填）
 *   3. RS 每个用户故事有 ≥2 条 Given/When/Then（可测性）
 *   4. FS §2 追溯表对 RS 的覆盖率
 *   5. WBS 必需列齐全、每行有 spec_ref、spec_ref 指回存在的 FS 小节、FS 小节不悬空
 *
 * 刻意**不判**：内容对不对、方案好不好、「部分覆盖」是否可接受。那要读语义，是 SR 报告
 * 与人审的活。把判不了的东西塞进门禁，结果不是变严，是让人学会无视它（checklist §8）。
 *
 * 一条硬约束：**只有越过产出阶段之后才判**。写到一半的文档必然不完整，这时候判红等于
 * 逼人删掉 artifacts 声明——门禁反而训练出"别登记产物"的行为。写稿期的反馈归
 * `harness-cli review-packet`，它是按需的、不拦人的。
 *
 * 已知边界：检查范围由 `state.artifacts` 决定，不声明就检不到。这不假装能判——
 * `missingDeclarations()` 把"该声明却没声明"单独列出来，由调用方当提示展示。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 三种文档的登记口径。
 * template 是判据来源（占位符与章节都从它反推）；produced 是"产出它的阶段"，
 * 越过它之后才判完备性。
 */
const DOC_KINDS = [
  { key: 'rs', label: 'RS', template: 'RS-需求规格.md', produced: 'rs' },
  { key: 'fs', label: 'FS', template: 'FS-功能规格.md', produced: 'fs_review', aliases: ['fs_final'] },
  {
    key: 'wbs',
    label: 'WBS',
    template: 'WBS-任务拆分.md',
    produced: 'wbs',
    aliases: ['tasks'],
    suffix: '.wbs.md',
  },
];

/** WBS 拆分树必须有的列。缺列时先报列，不再往下逐行报（否则一处缺列变 20 条噪音）。 */
const WBS_REQUIRED_COLS = ['id', '任务', '验收标准', 'spec_ref', 'depends_on'];

const templateCache = new Map();

function readText(abs) {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function templateText(repo, name) {
  if (templateCache.has(name)) return templateCache.get(name);
  const t = readText(resolve(repo, 'templates', name));
  templateCache.set(name, t);
  return t;
}

/** 去掉围栏代码与行内代码：里面的尖括号是代码，不是占位符（`List<T>` 不该被当成没填）。 */
function stripCode(md) {
  return md
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** 引用块是模板自带的填写说明（`> 规则：…`），永远不算正文，也不该被当成占位符来源。 */
function withoutQuotes(md) {
  return md
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
}

/** 章节标题归一：去掉序号与标记，只留文字（`## 1 背景与痛点` → `背景与痛点`）。 */
function titleKey(t) {
  return String(t)
    .replace(/^[\s\d.、()（）一二三四五六七八九十§#]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 按 `## ` 切章节。围栏代码里的 `## ` 是注释不是标题，必须跳过——
 * 否则 FS 里贴一段 shell 注释，章节结构就乱了。
 */
function h2Sections(md) {
  const out = [];
  let cur = null;
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const m = /^##\s+(.+?)\s*$/.exec(line);
      if (m) {
        if (cur) out.push(cur);
        cur = { title: m[1], body: [] };
        continue;
      }
      if (/^#\s+/.test(line)) {
        if (cur) out.push(cur);
        cur = null;
        continue;
      }
    }
    if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ title: s.title, key: titleKey(s.title), body: s.body.join('\n') }));
}

function splitRow(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

const SEP_CELL = /^:?-{2,}:?$/;

/** 章节里的所有表格（一个章节可能有多张）。表头 + 数据行，分隔行丢掉。 */
function tables(body) {
  const blocks = [];
  let cur = null;
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    if (!l.startsWith('|')) {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = [];
    cur.push(l);
  }
  if (cur) blocks.push(cur);

  const out = [];
  for (const lines of blocks) {
    const cells = lines.map(splitRow);
    const sepIdx = cells.findIndex((c) => c.length > 0 && c.every((x) => x === '' || SEP_CELL.test(x)));
    const header = sepIdx > 0 ? cells[sepIdx - 1] : cells[0];
    const rows = cells.slice(sepIdx >= 0 ? sepIdx + 1 : 1).filter((c) => c.some((x) => x !== ''));
    if (header && header.some((x) => x !== '')) out.push({ header, rows });
  }
  return out;
}

/**
 * 章节填了没有。
 * 判"空"的两种形态：正文一行没有；或者只有一张**光表头**的表格——后者是最常见的
 * 假完备（模板表格原样留着，看起来有内容，其实一行数据都没填）。
 */
function bodyState(body) {
  let prose = 0;
  let fence = false;
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    if (/^(```|~~~)/.test(l)) {
      fence = !fence;
      prose += 1;
      continue;
    }
    if (fence) {
      if (l) prose += 1;
      continue;
    }
    if (!l || l.startsWith('>') || l.startsWith('|')) continue;
    prose += 1;
  }
  const rows = tables(body).reduce((n, t) => n + t.rows.length, 0);
  return { empty: prose === 0 && rows === 0, prose, rows };
}

/** 模板里所有 `<…>` 占位符。改模板即改判据，不需要维护第二份清单。 */
function placeholderSet(repo) {
  const set = new Set();
  for (const d of DOC_KINDS) {
    const t = templateText(repo, d.template);
    if (!t) continue;
    for (const m of stripCode(withoutQuotes(t)).matchAll(/<[^<>\n]{1,80}>/g)) set.add(m[0]);
  }
  return set;
}

function leftoverPlaceholders(text, set) {
  const body = stripCode(withoutQuotes(text));
  const hits = [];
  for (const ph of set) {
    if (body.includes(ph)) hits.push(ph);
  }
  return hits;
}

function usIds(text) {
  const ids = new Set();
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^###\s+(US-\d+)\b/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** US 小节正文（`### US-1 …` 到下一个同级或更高级标题）。 */
function h3Blocks(text) {
  const out = [];
  let cur = null;
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const m = /^###\s+(US-\d+)\b(.*)$/.exec(line);
      if (m) {
        if (cur) out.push(cur);
        cur = { id: m[1], body: [] };
        continue;
      }
      if (/^#{1,3}\s+/.test(line)) {
        if (cur) out.push(cur);
        cur = null;
        continue;
      }
    }
    if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map((b) => ({ id: b.id, body: b.body.join('\n') }));
}

/** FS §4.x 小节：WBS 的 spec_ref 要指回这里。 */
function fsSubsections(text) {
  const map = new Map();
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^#{3,4}\s+§?(\d+(?:\.\d+)+)/.exec(line);
    if (m) map.set(m[1], line.replace(/^#+\s+/, '').trim());
  }
  return map;
}

function sectionByKey(sections, key) {
  return sections.find((s) => s.key === key) || null;
}

/** FS §2 追溯表：抽出被覆盖的 US 与"部分/未覆盖"标记。 */
function traceRows(fsText) {
  const sec = sectionByKey(h2Sections(fsText), '需求追溯');
  if (!sec) return null;
  const t = tables(sec.body)[0];
  if (!t) return null;
  const rows = [];
  for (const cells of t.rows) {
    const id = cells.find((c) => /^US-\d+$/.test(c));
    if (!id) continue;
    const status = cells[cells.length - 1] || '';
    rows.push({ id, status });
  }
  return rows;
}

const PARTIAL_RE = /部分|未覆盖|未完整|否|✗|^—$|^-$/;

function declaredPath(arts, d) {
  if (!arts || typeof arts !== 'object') return null;
  const keys = [d.key, ...(d.aliases || [])];
  for (const k of keys) {
    const v = arts[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (d.suffix) {
    for (const v of Object.values(arts)) {
      if (typeof v === 'string' && v.trim().endsWith(d.suffix)) return v.trim();
    }
  }
  return null;
}

/** `docs/x/y.md` 这类才当路径；整句说明文字（含空格/中文）由 artifactIndex 单独提示。 */
function looksLikePath(p) {
  return !/\s/.test(p) && !/[\u4e00-\u9fa5]/.test(p);
}

function fmtList(arr, max = 3) {
  const shown = arr.slice(0, max).join('、');
  return arr.length > max ? `${shown} 等 ${arr.length} 处` : shown;
}

/**
 * 主判据。
 * @returns {Array<{id:string, rule:string, reason:string}>} 与 validateTodos 同形状
 */
export function checkCompleteness(state, repo, opts = {}) {
  const stageChain = Array.isArray(opts.stageChain) ? opts.stageChain : [];
  const failures = [];
  if (!state || typeof state !== 'object') return failures;

  const stageIdx = stageChain.indexOf(state.stage);
  if (stageIdx < 0) return failures; // 阶段名非法归 checkStage，这里不重复报

  const arts = state.artifacts && typeof state.artifacts === 'object' ? state.artifacts : {};
  const docs = new Map();
  const placeholders = placeholderSet(repo);

  for (const d of DOC_KINDS) {
    const doneIdx = stageChain.indexOf(d.produced);
    if (doneIdx < 0 || stageIdx <= doneIdx) continue;

    const raw = declaredPath(arts, d);
    if (!raw) continue; // 未声明：由 missingDeclarations 负责提示，不在这里判死
    if (!looksLikePath(raw)) continue;

    const abs = resolve(repo, raw);
    if (!existsSync(abs)) {
      failures.push({
        id: d.label,
        rule: 'path',
        reason: `artifacts 声明了 ${d.label} 在 ${raw}，但文件不存在 —— 声明与事实不符。先落盘，或把它改成 null（未产出）`,
      });
      continue;
    }
    const text = readText(abs);
    if (text === null) continue;
    docs.set(d.key, { path: raw, text });

    // 1. 占位符残留
    const left = leftoverPlaceholders(text, placeholders);
    if (left.length) {
      failures.push({
        id: d.label,
        rule: 'doc',
        reason: `${d.label} 里还有模板占位符没替换：${fmtList(left.map((x) => `\`${x}\``))} —— 占位符还在，说明这一段是模板原样留下的，不是写的内容`,
      });
    }

    // 2. 章节齐全且非空
    const tpl = templateText(repo, d.template);
    if (tpl) {
      const want = h2Sections(tpl).map((s) => s.key).filter((k) => k && !/^(产出|规则)/.test(k));
      const got = new Map(h2Sections(text).map((s) => [s.key, s]));
      const missing = [];
      const empty = [];
      for (const key of want) {
        const sec = got.get(key);
        if (!sec) missing.push(key);
        else if (bodyState(sec.body).empty) empty.push(key);
      }
      if (missing.length) {
        failures.push({
          id: d.label,
          rule: 'doc',
          reason: `${d.label} 缺模板章节：${missing.join('、')} —— 章节是评审的检查面，删一节等于把那一面藏起来（确不需要该节时改模板，不要只在文档里删）`,
        });
      }
      if (empty.length) {
        failures.push({
          id: d.label,
          rule: 'doc',
          reason: `${d.label} 有章节是空的：${empty.join('、')} —— 「只有表头没有数据行」也算空，那是看起来填了其实没填`,
        });
      }
    }

    // 3. RS：可测性
    if (d.key === 'rs') {
      const blocks = h3Blocks(text);
      const weak = [];
      for (const b of blocks) {
        const given = (b.body.match(/\bGiven\b/g) || []).length;
        const then = (b.body.match(/\bThen\b/g) || []).length;
        if (given < 2 || then < 2) weak.push(`${b.id}（Given×${given} / Then×${then}）`);
      }
      if (weak.length) {
        failures.push({
          id: d.label,
          rule: 'doc',
          reason: `${d.label} 这些用户故事的验收标准不足两条 Given/When/Then：${fmtList(weak, 5)} —— 没有可观测结果的验收标准，后面写不出断言，只能人肉验收`,
        });
      }
    }
  }

  // 4. FS ↔ RS 覆盖
  const rs = docs.get('rs');
  const fs = docs.get('fs');
  if (rs && fs) {
    const want = usIds(rs.text);
    const rows = traceRows(fs.text);
    if (want.size && !rows) {
      failures.push({
        id: 'FS',
        rule: 'cover',
        reason: 'FS 的 §2 需求追溯里读不到任何表格 —— 这一节是"每个 RS 条目落到哪"的唯一索引，缺了就无法判断有没有漏做需求',
      });
    } else if (want.size) {
      const covered = new Set(rows.map((r) => r.id));
      const miss = [...want].filter((id) => !covered.has(id));
      const partial = rows.filter((r) => PARTIAL_RE.test(r.status || '')).map((r) => r.id);
      if (miss.length) {
        failures.push({
          id: 'FS',
          rule: 'cover',
          reason: `RS 覆盖率不足：${miss.join('、')} 在 FS 追溯表里没有出现 —— 没出现的需求不会有人实现，也不会有人发现没人实现`,
        });
      }
      if (partial.length) {
        failures.push({
          id: 'FS',
          rule: 'cover',
          reason: `这些 US 在追溯表里标的是部分/未覆盖：${partial.join('、')} —— 定稿前要么补齐，要么把范围收掉（写进 RS §5 范围外）`,
        });
      }
    }
  }

  // 5. WBS 结构 + 与 FS 双向覆盖
  const wbs = docs.get('wbs');
  if (wbs) {
    const sec = sectionByKey(h2Sections(wbs.text), '拆分树');
    const table = sec ? tables(sec.body)[0] : null;
    if (!table) {
      failures.push({
        id: 'WBS',
        rule: 'wbs',
        reason: 'WBS 的 §1 拆分树里读不到表格 —— 任务清单只能落在 state.todos 里，就没有可评审的落点了',
      });
    } else {
      const norm = (s) => String(s).toLowerCase().replace(/[`*\s]/g, '');
      const header = table.header.map(norm);
      const colOf = (name) => header.indexOf(norm(name));
      const missingCols = WBS_REQUIRED_COLS.filter((c) => colOf(c) < 0);
      if (missingCols.length) {
        failures.push({
          id: 'WBS',
          rule: 'wbs',
          reason: `WBS 拆分树缺列：${missingCols.join('、')} —— spec_ref 尤其不能少：没有它，任务指不回 FS 小节，"悬空任务"在系统里天然不可见`,
        });
      } else {
        const iId = colOf('id');
        const iAcc = colOf('验收标准');
        const iRef = colOf('spec_ref');
        const iDep = colOf('depends_on');
        const ids = new Set();
        const refs = new Map(); // taskId -> §x.y
        const badRows = [];
        const dup = [];

        for (const cells of table.rows) {
          const id = cells[iId] || '(无 id)';
          if (ids.has(id)) dup.push(id);
          ids.add(id);
          const acc = cells[iAcc] || '';
          // 反引号/粗体是 markdown 的写法，不是引用的一部分：先剥掉再解析，
          // 否则 `` `fs#§4.1@abc` `` 会被判成"格式不对"，而对的是所有人都这么写。
          const refRaw = cells[iRef] || '';
          const ref = String(refRaw).replace(/[`*]/g, '').trim();
          const m = /^fs#\s*§?(\d+(?:\.\d+)*)/i.exec(ref);
          if (!acc || placeholderLike(acc, placeholders)) badRows.push(`${id} 无验收标准`);
          else if (!ref) badRows.push(`${id} 无 spec_ref`);
          else if (!m) badRows.push(`${id} 的 spec_ref 格式不对（应为 fs#§4.2@<blob7>，收到 ${String(refRaw).trim().slice(0, 24)}）`);
          else refs.set(id, m[1]);
        }
        if (dup.length) {
          failures.push({ id: 'WBS', rule: 'wbs', reason: `拆分树里 id 重复：${[...new Set(dup)].join('、')} —— 证据日志按 id 命名，会互相覆盖` });
        }
        if (badRows.length) {
          failures.push({ id: 'WBS', rule: 'wbs', reason: `拆分树这些行不可验收：${fmtList(badRows, 5)}` });
        }

        // depends_on 指向不存在的 id：最常见的是改名后漏改依赖，拓扑图看着还在
        if (iDep >= 0) {
          const danglingDep = [];
          for (const cells of table.rows) {
            const id = cells[iId];
            for (const dep of String(cells[iDep] || '').split(/[,，\s]+/)) {
              const d = dep.replace(/[`*]/g, '').trim();
              if (!d || d === '—' || d === '-') continue;
              if (!ids.has(d)) danglingDep.push(`${id}→${d}`);
            }
          }
          if (danglingDep.length) {
            failures.push({ id: 'WBS', rule: 'wbs', reason: `depends_on 指向不存在的任务：${fmtList(danglingDep, 5)}` });
          }
        }

        // 双向覆盖：spec_ref 指回的小节必须存在；FS 的每个 §4.x 必须有人做
        if (fs) {
          const subs = fsSubsections(fs.text);
          const dangling = [...refs.entries()].filter(([, ref]) => !subs.has(ref)).map(([id, ref]) => `${id}→§${ref}`);
          if (dangling.length) {
            failures.push({
              id: 'WBS',
              rule: 'cover',
              reason: `这些任务指向的 FS 小节不存在：${fmtList(dangling, 5)} —— 悬空任务，做出来是没人要的功能（要么 FS 改过而 WBS 没回填，要么拆任务时凭印象写的小节号）`,
            });
          }
          if (subs.size) {
            const used = new Set(refs.values());
            const orphan = [...subs.keys()].filter((k) => !used.has(k));
            if (orphan.length) {
              failures.push({
                id: 'WBS',
                rule: 'cover',
                reason: `FS 这些详细设计小节没有任何 WBS 任务对应：§${orphan.join('、§')} —— 漏做，且交付前发现不了。确不需实现就把它挪出 §4（比如并入 §9 测试要点或标注"不做"）`,
              });
            }
          }
        }
      }
    }
  }

  return failures;
}

function placeholderLike(text, set) {
  const s = stripCode(String(text)).trim();
  if (!s) return true;
  for (const ph of set) if (s.includes(ph)) return true;
  return false;
}

/**
 * 该登记却没登记的产物。**提示用，不判死**：
 * 检查范围由 artifacts 决定，不声明就检不到——这个边界要说出来，
 * 否则"完备性通过"会被读成"文档没问题"。
 */
export function missingDeclarations(state, stageChain = []) {
  if (!state || typeof state !== 'object') return [];
  const idx = stageChain.indexOf(state.stage);
  if (idx < 0) return [];
  const arts = state.artifacts && typeof state.artifacts === 'object' ? state.artifacts : {};
  const out = [];
  for (const d of DOC_KINDS) {
    const done = stageChain.indexOf(d.produced);
    if (done < 0 || idx <= done) continue;
    if (declaredPath(arts, d)) continue;
    out.push({ key: d.key, label: d.label });
  }
  return out;
}

/** 三种文档的登记口径（供 CLI 展示与"该谁看"提示用，不暴露内部实现）。 */
export function docKinds() {
  return DOC_KINDS.map(({ key, label, produced, aliases, suffix }) => ({ key, label, produced, aliases, suffix }));
}

/**
 * 某份文档在 state.artifacts 里登记的路径（含别名与后缀回退）。
 * 导出它是为了让 CLI 不必自己再实现一遍"怎么找路径"——两套找法必然分叉，
 * 然后出现"review-packet 说有、ci-verify 说没有"。
 */
export function declaredPathOf(state, key) {
  const d = DOC_KINDS.find((x) => x.key === key || (x.aliases || []).includes(key));
  if (!d) return null;
  const arts = state && state.artifacts && typeof state.artifacts === 'object' ? state.artifacts : {};
  return declaredPath(arts, d);
}
