#!/usr/bin/env node
/**
 * 从 agents/*.agent.md 单一源生成三个 CLI 的产物。
 *
 *   源：agents/<name>.agent.md（抽象 capabilities）
 *   产物：.claude/agents、.zcode/agents、prompts/agents、各自的 commands
 *
 * 用法：
 *   node scripts/build-agents.mjs              生成全部 enabled target
 *   node scripts/build-agents.mjs --target claude
 *   node scripts/build-agents.mjs --check      只比对不写入；有漂移 exit 1（CI 用）
 *   node scripts/build-agents.mjs --prune      清理目标目录中不属于本次生成的文件
 *
 * 零依赖，Node 18+。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'agents');
const GENERATED_MARK = '<!-- generated: do not edit, run npm run build:agents -->';

/** slash command 别名。改这里等于改入口，不需要动 11 个源文件。 */
const COMMANDS = {
  orchestrator: { cmd: 'task', use: '启动一个任务，驱动全流程' },
  'requirement-analyst': { cmd: 'rs', use: '产出需求规格与开放问题' },
  'feature-decomposer': { cmd: 'wbs', use: '把需求拆成带依赖的 TODO' },
  'tech-selector': { cmd: 'adr', use: '对多方案决策点出 ADR' },
  'spec-writer': { cmd: 'fs', use: '起草功能规格' },
  'interaction-prototyper': { cmd: 'proto', use: '生成线框与交互状态矩阵' },
  'spec-reviewer': { cmd: 'sr', use: '审核规格，输出分级意见' },
  coder: { cmd: 'impl', use: '按 TODO 编码' },
  'test-engineer': { cmd: 'test', use: '补测试与定向验证' },
  'code-reviewer': { cmd: 'cr', use: '审查 diff 或 MR' },
  'retro-ledger': { cmd: 'retro', use: '复盘并沉淀为 skill 修订' },
};

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const PRUNE = argv.includes('--prune');
const targetArg = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : null;

function die(msg) {
  console.error(`[build-agents] ${msg}`);
  process.exit(1);
}

function parseList(value) {
  if (!value.startsWith('[')) return value.replace(/^["']|["']$/g, '');
  return value
    .slice(1, -1)
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function parseAgent(file) {
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) die(`${file} 缺少 frontmatter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    meta[line.slice(0, idx).trim()] = parseList(line.slice(idx + 1).trim());
  }
  for (const k of ['name', 'description', 'capabilities']) {
    if (!meta[k]) die(`${file} 缺少必填字段 ${k}`);
  }
  if (!Array.isArray(meta.capabilities)) die(`${file} 的 capabilities 必须是数组`);
  return { meta, body: m[2].trim(), file };
}

function toolsFor(meta, config, target) {
  const out = [];
  for (const cap of meta.capabilities) {
    const mapped = config.capabilityMap[cap];
    if (!mapped) die(`capability "${cap}" 未在 capabilityMap 中定义`);
    for (const t of mapped[target] ?? []) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 只读裁剪的硬约束：文档类 agent 只能写文档，不许碰源码与 shell。
 * 这是把"自觉"变成"机制"的一处——裁剪发生在生成前，而不是运行时靠模型记住。
 */
const DOC_ONLY_AGENTS = new Set([
  'requirement-analyst',
  'feature-decomposer',
  'tech-selector',
  'spec-writer',
  'interaction-prototyper',
  'spec-reviewer',
  'retro-ledger',
]);

function assertReadOnlyTrim(meta) {
  if (!DOC_ONLY_AGENTS.has(meta.name)) return;
  if (meta.capabilities.includes('fs.edit')) die(`${meta.name} 只写文档，不得声明 fs.edit`);
  if (meta.capabilities.includes('shell.exec')) die(`${meta.name} 只写文档，不得声明 shell.exec`);
}

/**
 * 把源文件里的通用占位符换成当前项目的实际值。
 * 源保持技术栈无关，产物才是具体的——这样同一份源可以复制到不同栈的项目。
 */
function resolveTokens(text, config) {
  const stacks = config.stacks || {};
  const backend = stacks.backend || {};
  const frontend = stacks.frontend || {};
  const map = {
    '<backend-dir>': backend.dir || 'backend',
    '<frontend-dir>': frontend.dir || 'frontend',
    '<test-cmd>': backend.test || 'mvn test',
    '<fe-test-cmd>': frontend.test || 'pnpm test',
    '<lint-cmd>': backend.lint || 'lint',
  };
  let out = text;
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out;
}

function renderSubagent(meta, body, config, target) {
  const tools = toolsFor(meta, config, target);
  if (tools.length === 0) die(`${meta.name} 在 target=${target} 下没有任何工具`);
  return [
    '---',
    `name: ${meta.name}`,
    `description: ${meta.description}`,
    `tools: ${tools.join(', ')}`,
    '---',
    '',
    writesLine(meta, config),
    stopsLine(meta),
    '',
    resolveTokens(body, config),
    '',
  ].join('\n');
}

/** `writes` 是 agent 之间的交接契约，必须出现在模型真正读得到的位置。 */
function writesOf(meta, config) {
  return [].concat(meta.writes || []).map((w) => resolveTokens(w, config));
}

function writesLine(meta, config) {
  const w = writesOf(meta, config);
  return `> 写入范围：${w.length ? w.join('、') : '不落盘（只读 agent）'}`;
}

function stopsLine(meta) {
  const s = [].concat(meta.stops || []).filter(Boolean);
  return `> 人工停点：${s.length ? s.join('、') : '无'}`;
}

function renderPrompt(meta, body, config) {
  return [
    `# ${meta.title || meta.name}（${meta.name}）`,
    '',
    `> ${meta.description}`,
    '',
    writesLine(meta, config),
    stopsLine(meta),
    '',
    resolveTokens(body, config),
    '',
  ].join('\n');
}

/**
 * writes 的投影。生成物里的 `> 写入范围` 只对模型可见，人评审时看不到全局，
 * 所以把所有 agent 的写入域导出成一份可 diff 的 JSON——CI 和 code review 都读它。
 */
function renderWritesMatrix(agents, config) {
  const matrix = {};
  for (const { meta } of agents) {
    matrix[meta.name] = {
      title: meta.title || meta.name,
      writes: writesOf(meta, config),
      stops: [].concat(meta.stops || []).filter(Boolean),
      capabilities: meta.capabilities,
    };
  }
  return (
    JSON.stringify(
      {
        note: '由 scripts/build-agents.mjs 从 agents/*.agent.md 的 writes 字段生成，勿手改。写 agents/ 后跑 npm run build:agents。',
        agents: matrix,
      },
      null,
      2
    ) + '\n'
  );
}

function renderCommand(meta, target) {
  const c = COMMANDS[meta.name];
  if (!c) return null;
  const body =
    target === 'deepseek'
      ? `按 prompts/agents/${meta.name}.md 的角色定义执行本次任务，逐步走完其中的流程。\n\n任务：<在此粘贴需求 / TODO id / 文件路径>`
      : `使用 \`${meta.name}\` subagent 处理本次任务。\n\n任务：$ARGUMENTS`;
  return ['---', `description: ${c.use}`, '---', '', body, ''].join('\n');
}

function renderIndex(agents, config, target) {
  const lines = [
    '<!-- generated: do not edit -->',
    '# Agent 索引（prompt-only 形态）',
    '',
    '> 无 subagent 能力的 CLI，按此表取对应 prompt 文件，粘贴或经脚本注入上下文。',
    '> 表格顺序 = 建议启用顺序，不是字母序。',
    '',
    '| 别名 | 入口 | agent | 何时使用 | 写什么 |',
    '|---|---|---|---|---|',
  ];
  const order = Object.keys(COMMANDS);
  const sorted = [...agents].sort((a, b) => order.indexOf(a.meta.name) - order.indexOf(b.meta.name));
  for (const { meta } of sorted) {
    const c = COMMANDS[meta.name] || { cmd: '-' };
    const writes = [].concat(meta.writes || '-').map((w) => resolveTokens(w, config)).join('<br>');
    lines.push(
      `| /${c.cmd} | \`prompts/agents/${meta.name}.md\` | ${meta.title || meta.name} | ${meta.description} | ${writes} |`
    );
  }
  lines.push('', '## 建议启用顺序', '', '1. `orchestrator` + 三个只读（requirement-analyst / tech-selector / spec-reviewer）');
  lines.push('2. 加写文档类（feature-decomposer / spec-writer / interaction-prototyper / retro-ledger）');
  lines.push('3. 最后加写码类（coder / test-engineer / code-reviewer），且只在 L2 信任级别启用');
  lines.push('', '跳过顺序直接上 coder，是这套体系最常见的失败方式：门禁还没有，代码已经在改。', '');
  return lines.join('\n');
}

function main() {
  const config = JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8'));
  const targets = Object.entries(config.targets).filter(
    ([name, t]) => t.enabled && (!targetArg || name === targetArg)
  );
  if (targets.length === 0) die(`没有匹配的 target：${targetArg || '(all)'}`);

  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.agent.md')).sort();
  if (files.length === 0) die('agents/ 下没有 *.agent.md');
  const agents = files.map((f) => parseAgent(join(SRC_DIR, f)));

  const names = agents.map((a) => a.meta.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) die(`agent name 重复：${dup.join(', ')}`);
  for (const a of agents) assertReadOnlyTrim(a.meta);

  const outputs = new Map();
  for (const [target, t] of targets) {
    for (const a of agents) {
      const content =
        t.mode === 'prompt-only'
          ? renderPrompt(a.meta, a.body, config)
          : renderSubagent(a.meta, a.body, config, target);
      outputs.set(join(t.agentsDir, `${a.meta.name}.md`), content);
      const cmd = renderCommand(a.meta, target);
      if (cmd && COMMANDS[a.meta.name]) {
        outputs.set(join(t.commandsDir, `${COMMANDS[a.meta.name].cmd}.md`), cmd);
      }
    }
    if (t.mode === 'prompt-only') {
      outputs.set(join(dirname(t.agentsDir), 'INDEX.md'), renderIndex(agents, config, target));
    }
  }

  // writes 是全 CLI 共享的契约，与 target 无关，只产一份。
  outputs.set('.ai/writes.json', renderWritesMatrix(agents, config));

  if (CHECK) {
    const drift = [];
    for (const [rel, content] of outputs) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) drift.push(`缺失  ${rel}`);
      else if (readFileSync(abs, 'utf8') !== content) drift.push(`漂移  ${rel}`);
    }
    if (drift.length) {
      console.error('[build-agents] 生成物与源不一致：');
      for (const d of drift) console.error('  ' + d);
      console.error('\n修复：node scripts/build-agents.mjs');
      process.exit(1);
    }
    console.log(`[build-agents] check ok，${outputs.size} 个文件与源一致`);
    return;
  }

  for (const [rel, content] of outputs) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  if (PRUNE) {
    const keep = new Set([...outputs.keys()].map((p) => join(ROOT, p)));
    for (const [, t] of targets) {
      for (const dir of [t.agentsDir, t.commandsDir]) {
        const abs = join(ROOT, dir);
        if (!existsSync(abs)) continue;
        for (const f of readdirSync(abs)) {
          const p = join(abs, f);
          if (f.endsWith('.md') && !keep.has(p)) {
            rmSync(p);
            console.log(`[prune] ${dir}/${f}`);
          }
        }
      }
    }
  }

  console.log(`[build-agents] 生成 ${outputs.size} 个文件 · targets=${targets.map(([n]) => n).join(',')}`);
  for (const [target, t] of targets) {
    console.log(`  ${target.padEnd(9)} → ${t.agentsDir} (${agents.length}) + ${t.commandsDir}`);
  }
}

main();
