/**
 * 把一条 shell 命令拆成「段 → stage → 词/重定向」，只为回答两个问题：
 *   它往哪些路径写？它从哪些路径读？
 *
 * 为什么需要它：门禁原先只认 Write/Edit 工具，Bash 是整条敞开的通道——
 * `echo '{...}' > .ai/tasks/x/state.json` 绕过了 guard_state 的全部校验，
 * `cat .env` 绕过了 sensitiveRead。规则再多，只要有一条不经过它的路，威慑力就打折。
 *
 * 这里**不**求完整解析 shell（那是个无底洞：`eval`、变量展开、函数、进程替换……）。
 * 目标是覆盖"正常人会写出来的写法"，并承认边界：
 *   · `bash -c '<脚本>'` 里的内容是按字面量传给子进程的，本模块不展开；
 *   · 变量拼出来的路径（`$D/state.json`）拿不到展开值。
 * 这两类靠"门禁守诚实不守正确"的边界说明兜，不假装能判。
 *
 * 已知取舍：宁可误判成"读/写"，也不漏判——但误判会让门禁变成挡路，
 * 所以只有**像路径**的词才参与敏感判定（见 looksLikePath），
 * 且 `grep "\.env"` 这种正则片段（含反斜杠）不算路径。
 */

const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>']);
const IN_OPS = new Set(['<']);
/** 重定向到这些目标不算"写文件"。 */
const NULL_SINK = /^&?\d*$|^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$|^-$/;

const DEFAULT_CFG = {
  // source / . 不在这里：source 的实参语义与 cat 不同（会执行），在 analyzeSegment 单独处理。
  directReaders: ['cat', 'head', 'tail', 'less', 'more', 'bat', 'xxd', 'od', 'hexdump', 'strings', 'base64', 'base32', 'openssl', 'gpg', 'zcat', 'source'],
  pathReaders: ['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'sed', 'sort', 'uniq', 'cut', 'tr', 'diff', 'jq', 'wc', 'file', 'stat', 'md5sum', 'shasum', 'sha256sum'],
  writers: ['cp', 'mv', 'install', 'ln', 'rsync', 'tee', 'dd', 'truncate', 'shred'],
};

/** 命令前面的修饰词：跳过它们才拿得到真正的命令名。busybox 是多路复用器（busybox cat = cat）。 */
const PREFIX_WORDS = new Set(['sudo', 'command', 'builtin', 'exec', 'time', 'nohup', 'nice', 'timeout', 'busybox']);

/** `bash -c '<脚本>'` 里的脚本按同一条判据再看一层——否则字符串里塞什么都能过。 */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const MAX_DEPTH = 3;

/**
 * 去掉 heredoc 正文。
 *
 * 不去掉的话，`cat > notes.md <<'EOF'` 里只要出现 “强推” 这行说明（scan-ok: 注释解释误拦，不是命令），
 * 整条命令就会被当成强推拦下——直接写在文档里的命令被自己的门禁误伤，
 * 这种误拦会让人干脆不用 heredoc，而不是更安全。
 */
export function stripHeredocs(text) {
  const s = String(text || '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(rest);
    if (!m) {
      out += rest;
      break;
    }
    const start = i + m.index;
    out += s.slice(i, start);
    let j = start + m[0].length;
    const nl = s.indexOf('\n', j);
    if (nl === -1) break; // 没有正文：命令本身就到这
    j = nl + 1;
    const end = new RegExp('^[ \\t]*' + m[2] + '[ \\t]*$', 'm').exec(s.slice(j));
    if (!end) {
      i = s.length; // 正文没结束：按"整段都是正文"处理，不猜
      break;
    }
    out += ' ';
    i = j + end.index + end[0].length;
  }
  return out;
}

/** 按 `;` `&&` `||` 换行切段（引号内的分隔符不算）。 */
export function splitSegments(text) {
  const s = stripHeredocs(text);
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (c === '\n' || c === ';') {
      out.push(cur);
      cur = '';
      continue;
    }
    if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * 词法切分。重定向符即使紧贴单词也单独成 token（`echo x>f` 同样能被看见）。
 */
export function tokenize(segment) {
  const out = [];
  let cur = '';
  let open = false;
  const flush = () => {
    if (open) out.push({ t: 'w', v: cur });
    cur = '';
    open = false;
  };
  const s = String(segment || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      open = true;
      continue;
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      cur += j === -1 ? s.slice(i + 1) : s.slice(i + 1, j);
      open = true;
      i = j === -1 ? s.length : j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        // 双引号里反斜杠只对 $ ` " \ 换行 生效，其余原样保留。
        // 早先一律吞掉反斜杠，`grep "\.env"` 的 token 变成 `.env`——
        // 于是"搜索一个正则"被当成了"读取一个凭据文件"。
        if (s[j] === '\\' && j + 1 < s.length && '$`"\\\n'.includes(s[j + 1])) {
          cur += s[j + 1];
          j += 2;
        } else cur += s[j++];
      }
      open = true;
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    if (c === '>' || c === '<' || c === '|' || (c === '&' && (s[i + 1] === '&' || s[i + 1] === '>'))) {
      const two = s.slice(i, i + 2);
      const three = s.slice(i, i + 3);
      flush();
      if (c === '&') {
        const op = three === '&>>' ? '&>>' : '&>';
        out.push({ t: 'op', v: op });
        i += op.length - 1;
        continue;
      }
      if (c === '|') {
        out.push({ t: 'op', v: two === '||' ? '||' : '|' });
        if (two === '||') i++;
        continue;
      }
      if (c === '>') {
        // 两字符运算符优先；`>&`（复制 fd）不在写文件集合里，但必须切出来，
        // 否则 `2>&1` 会把 `&1` 当成一个文件名传给后面的判定。
        const op = two === '>>' || two === '>|' || two === '>&' ? two : '>';
        out.push({ t: 'op', v: op });
        i += op.length - 1;
        continue;
      }
      // '<'
      if (two === '<<') {
        const op = three === '<<-' ? '<<-' : '<<';
        out.push({ t: 'op', v: op });
        i += op.length - 1;
        continue;
      }
      out.push({ t: 'op', v: two === '<>' ? '<>' : '<' });
      if (two === '<>') i++;
      continue;
    }
    cur += c;
    open = true;
  }
  flush();
  return out;
}

const baseName = (w) => String(w).split('/').pop();

/** 这个词看起来像路径吗？（裸名字如 `credentials` 不算——`grep credentials src/` 是找代码） */
export function looksLikePath(w) {
  const s = String(w || '');
  if (!s || s.startsWith('-')) return false;
  if (s.includes('\\')) return false; // 含转义 = 正则片段，不是路径
  return s.startsWith('/') || s.startsWith('.') || s.startsWith('~') || s.includes('/');
}

function isFlag(w) {
  return String(w).startsWith('-');
}

function isNullSink(w) {
  return NULL_SINK.test(String(w || ''));
}

/**
 * 子壳与进程替换的括号不是命令的一部分：`(cat .env)` 的第一个词是 `(cat`，
 * `cat <(cat .env)` 的实参是 `.env)`——都匹配不上任何词表。括号只在"词边界"上剥：
 * 前面是空白/管道/分号（子壳开头）或后面是词尾（子壳结尾）。`$(` 的 `(` 前是 `$`，不受影响。
 */
function stripSubshellParens(text) {
  return String(text)
    .replace(/(^|[\s|;&])\(+/g, '$1')
    .replace(/\)+(?=$|[\s|;&)])/g, '');
}

/**
 * 一段命令 → { cmd, writes: [{path, via}], reads: [{path, via}] }。
 * 一个段里可能有多个 stage（`a | b | tee c`），逐个 stage 判。
 */
export function analyzeSegment(segment, cfg, depth = 0) {
  const c = { ...DEFAULT_CFG, ...(cfg || {}) };
  // \\⏎ 续行在 tokenize 里会变成词内换行（旗标识别失效），先归一成空白；
  // 子壳/进程替换括号先剥（见 stripSubshellParens）。
  const tokens = tokenize(stripSubshellParens(String(segment || '').replace(/\\\n/g, ' ')));

  const stages = [];
  let cur = [];
  for (const tk of tokens) {
    if (tk.t === 'op' && tk.v === '|') {
      stages.push(cur);
      cur = [];
    } else {
      cur.push(tk);
    }
  }
  stages.push(cur);

  const writes = [];
  const reads = [];
  let firstCmd = '';
  let prevWords = [];

  for (const stage of stages) {
    const words = [];
    for (let i = 0; i < stage.length; i++) {
      const tk = stage[i];
      if (tk.t === 'op' && WRITE_OPS.has(tk.v)) {
        // `2>file` 里的 `2` 是 fd 号，不是参数
        if (words.length && /^\d+$/.test(words[words.length - 1])) words.pop();
        const next = stage[i + 1];
        if (next && next.t === 'w') {
          i++;
          if (!isNullSink(next.v)) writes.push({ path: next.v, via: tk.v });
        }
        continue;
      }
      if (tk.t === 'op' && IN_OPS.has(tk.v)) {
        const next = stage[i + 1];
        if (next && next.t === 'w') {
          i++;
          reads.push({ path: next.v, via: '<' });
        }
        continue;
      }
      if (tk.t === 'op') continue;
      words.push(tk.v);
    }

    let idx = 0;
    while (idx < words.length) {
      const w = words[idx];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        idx++;
        continue;
      }
      if (PREFIX_WORDS.has(baseName(w))) {
        idx++;
        // `timeout 10 mvn ...` 的时长参数
        while (idx < words.length && (/^\d+[smhd]?$/.test(words[idx]) || isFlag(words[idx]))) idx++;
        continue;
      }
      if (baseName(w) === 'env') {
        idx++;
        while (idx < words.length && (isFlag(words[idx]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[idx]))) idx++;
        continue;
      }
      break;
    }

    const cmd = baseName(words[idx] || '').replace(/^\(+/, '');
    const rawArgs = words.slice(idx + 1);
    const args = rawArgs.filter((w) => !isFlag(w));
    if (!firstCmd) firstCmd = cmd;

    // `.` 内建（`. .env` 等价 source，且会执行内容）：单独处理，不能进 directReaders
    // （那里的词表语义是"读"，而 `.` 的实参同时也是执行目标——从严判读已足够拦凭据）。
    if (cmd === '.' && args[0]) reads.push({ path: args[0], via: '.' });

    // xargs：它自己的参数是被执行的命令；管道上游的路径词是它的实参来源
    // （`echo .env | xargs cat`：`.env` 在上游，`cat` 在 xargs 参数里）。
    if (cmd === 'xargs' && depth < MAX_DEPTH) {
      const rest = rawArgs.filter((w) => !isFlag(w));
      if (rest.length) {
        const r = analyzeSegment(rest.join(' '), cfg, depth + 1);
        writes.push(...r.writes);
        reads.push(...r.reads);
      }
      for (const w of prevWords) if (looksLikePath(w) && !isFlag(w)) reads.push({ path: w, via: 'xargs' });
    }

    // find -exec / -execdir 到 `;` / `+` 之间是被执行的命令；
    // find 自己的路径实参也是读源（`find . -name .env -exec cat {} ;` 的 .env 在 find 参数里）。
    if (cmd === 'find' && depth < MAX_DEPTH) {
      const at = words.findIndex((w) => w === '-exec' || w === '-execdir');
      if (at !== -1) {
        const end = words.findIndex((w2, i2) => i2 > at && (w2 === ';' || w2 === '+' || w2 === '\\;'));
        const inner = words.slice(at + 1, end === -1 ? undefined : end).join(' ');
        if (inner) {
          const r = analyzeSegment(inner, cfg, depth + 1);
          writes.push(...r.writes);
          reads.push(...r.reads);
        }
      }
      for (const a of args) if (looksLikePath(a)) reads.push({ path: a, via: 'find' });
    }

    // tar 打包：归档成员是读源（`.env` 被整体外带与被 cat 读走，后果同级）。
    // 旗标簇可带可不带横线（`tar czf x.tgz .env` 的 c 与 f 在同一簇里），
    // `-f`/簇内 f 的下一个词是归档文件，不算成员。只判含 c/r/u（创建/追加）的簇。
    if (cmd === 'tar') {
      const flagArgs = rawArgs.filter((w) => /^-?[A-Za-z]{1,5}$/.test(w) && /[cru]/.test(w));
      const withF = flagArgs.find((w) => /f/.test(w));
      const fAt = words.findIndex((w) => w === '-f' || w === '--file');
      const archive = withF
        ? words[words.indexOf(withF) + 1]
        : fAt !== -1
          ? words[fAt + 1]
          : null;
      for (const a of args) if (a !== archive && looksLikePath(a)) reads.push({ path: a, via: 'tar' });
    }

    // 未展开的 $(...) / 反引号：内容按同一条判据再走一遍（`echo $(cat .env)` 不应因为
    // 包了一层替换就绕过读判定）。嵌套括号不展开——构造出来的自指命令不值得逃代。
    if (depth < MAX_DEPTH) {
      const subs = String(segment).match(/\$\([^()]*\)|`[^`]*`/g) || [];
      for (const sub of subs) {
        const inner = sub.startsWith('$(') ? sub.slice(2, -1) : sub.slice(1, -1);
        for (const s2 of splitSegments(inner)) {
          const r = analyzeSegment(s2, cfg, depth + 1);
          writes.push(...r.writes);
          reads.push(...r.reads);
        }
      }
    }

    // `bash -c '<脚本>'` / `eval <脚本>`：内层按同一条判据再走一遍。
    // 不做这一层的话，`bash -c 'echo x > .ai/tasks/a/state.json'` 就是一个现成的绕过口，
    // 而它不比直接写更难想到。深度封顶，避免构造出来的自指命令把 hook 拖死。
    if (depth < MAX_DEPTH && (SHELLS.has(cmd) || cmd === 'eval')) {
      const at = rawArgs.indexOf('-c');
      const inner = cmd === 'eval' ? rawArgs.join(' ') : at !== -1 ? rawArgs[at + 1] : '';
      if (inner) {
        for (const sub of splitSegments(inner)) {
          const r = analyzeSegment(sub, cfg, depth + 1);
          writes.push(...r.writes);
          reads.push(...r.reads);
        }
      }
    }

    if (c.writers.includes(cmd)) {
      if (cmd === 'tee') {
        for (const a of args) if (!isNullSink(a)) writes.push({ path: a, via: 'tee' });
      } else if (cmd === 'dd') {
        for (const w of words) if (w.startsWith('of=')) writes.push({ path: w.slice(3), via: 'dd' });
      } else if (cmd === 'truncate' || cmd === 'shred') {
        for (const a of args) writes.push({ path: a, via: cmd });
      } else {
        // cp / mv / install / ln / rsync：最后一个非 flag 词是目的地，其余是源
        const dest = args[args.length - 1];
        if (dest && args.length >= 1) {
          writes.push({ path: dest, via: cmd });
          for (const src of args.slice(0, -1)) reads.push({ path: src, via: cmd });
        }
      }
    }

    if (cmd === 'sed') {
      const inPlace = words.some((w) => w === '--in-place' || /^-[a-zA-Z]*i/.test(w));
      if (inPlace) {
        for (const a of args.slice(1)) writes.push({ path: a, via: 'sed -i' });
      } else {
        for (const a of args) if (looksLikePath(a)) reads.push({ path: a, via: 'sed' });
      }
    } else if (c.directReaders.includes(cmd)) {
      for (const a of args) if (!isNullSink(a)) reads.push({ path: a, via: cmd });
    } else if (c.pathReaders.includes(cmd)) {
      for (const a of args) if (looksLikePath(a)) reads.push({ path: a, via: cmd });
    }

    prevWords = words;
  }

  return { cmd: firstCmd, writes, reads };
}

/**
 * 规则视角的归一化文本 + 词表：给 guard_command 的高危规则用。
 *
 * 为什么不能用原始 seg.text：
 *   · 续行 `git push \\$⏎--force` —— 规则正则失配，但 bash 执行的是强推；
 *   · 词内转义 `git pu\\sh --force` —— tokenize 已归一成 push，可规则跑在原文上；
 *   · 引号里的说明文字 `git commit -m "never run rm -rf /"` —— 文档被自己的门禁误拦。
 * 做法：剥续行 → 遮蔽引号内容（路径判定不受影响，它走 analyzeSegment 的原始 token）→
 * tokenize 重建。遮蔽后的文本只用于关键词/旗标匹配，宁可漏一条夸张的文档，不拦一次真的提交。
 */
export function ruleView(segment) {
  let s = String(segment || '').replace(/\\\n/g, ' ');
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "'…'").replace(/"(?:[^"\\]|\\.)*"/g, '"…"');
  const tokens = tokenize(s);
  // 管道符保留在重建文本里：高危规则里有一整族靠 `\|` 锚定（curl|sh 等），
  // 只拼词会把管道压掉，那族规则全部失配（A08/B37 回归的教训）。
  const words = tokens.filter((t) => t.t === 'w').map((t) => t.v).filter(Boolean);
  return { text: tokens.map((t) => t.v).join(' '), tokens: words, hasUnquotedSub: /\$\(|`/.test(s) };
}

/**
 * rm / git push 的 token 级判定（补正则的字形漏洞）：
 *   · 旗标按集合判，不按拼写字形：`-Rf`、`--recursive --force` 与 `-rf` 同罪；
 *   · `--force` 出现在 push 后任何位置都算（含尾置、含与 --force-with-lease 并存）。
 * 依据 config 的 blockedCommands 语义（harness.config.json 的 hint 是权威文案），
 * 这里只把同样的意图落到 token 层。
 */
export function hardTokenRule(tokens) {
  const w = tokens;
  for (let i = 0; i < w.length; i++) {
    if (w[i] === 'rm') {
      const letters = new Set();
      const long = new Set();
      let j = i + 1;
      while (j < w.length && w[j].startsWith('-') && w[j] !== '-') {
        const f = w[j].slice(1);
        if (f.startsWith('-')) long.add(f.slice(1).toLowerCase());
        else for (const ch of f.toLowerCase()) letters.add(ch);
        j++;
      }
      const rec = letters.has('r') || long.has('recursive');
      const frc = letters.has('f') || long.has('force');
      if (rec && frc) {
        const targets = w.slice(j).filter((t) => t === '/' || t === '~' || t === '$HOME' || t.startsWith('..'));
        if (targets.length) {
          return {
            rule: 'rm-recursive-force',
            reason: `递归强删根目录/家目录/上跳目录：${targets.join(' ')}`,
            hint: '删根/家/父目录没有等价的安全写法。要清理就写明确的相对路径，或让人手工执行',
          };
        }
      }
    }
    if (w[i] === 'push' && i > 0 && w[i - 1] === 'git') {
      for (let j = i + 1; j < w.length; j++) {
        if (w[j] === '--force' || w[j] === '-f') {
          return {
            rule: 'git-force-push',
            reason: '强推改写远端历史',
            hint: '改用 --force-with-lease：别人推过新提交时会被拒绝，不至于覆盖他人的工作',
          };
        }
        if (w[j].startsWith('+') && w[j].length > 1) {
          return {
            rule: 'git-push-refspec',
            reason: `+refspec 强推：${w[j]}`,
            hint: '用 +refspec 等于改写远端历史。改用 --force-with-lease，或推新分支',
          };
        }
      }
    }
  }
  return null;
}

/**
 * 整条命令 → 逐段的判定素材。段文本原样留着，供 allowlist 前缀匹配与规则正则使用。
 *
 * heredoc 喂给解释器（`bash <<'EOF' … EOF`）时，正文是会被执行的脚本：
 * 只把正文的读/写判定并进来，不做关键词扫描——否则往文档里写一段命令示例
 * （`cat > guide.md <<EOF` 内含 `git push --force` 文字）会被自己的门禁误拦，
 * 那正是 stripHeredocs 存在的理由。读/写判定只看路径，正文文字不命中路径词表。
 */
export function analyzeCommand(command, cfg) {
  const segments = splitSegments(command).map((text) => ({ text, ...analyzeSegment(text, cfg) }));
  const c = { ...DEFAULT_CFG, ...(cfg || {}) };
  const FEEDS_SHELL = /(?:^|[;&|\s])(?:sudo\s+|env\s+)?(?:ba|z|da|k|a)?sh(?:ell)?\b|\beval\b/;
  const bodyRe = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm;
  for (const m of String(command || '').matchAll(bodyRe)) {
    const feeder = String(command).slice(0, m.index);
    if (!FEEDS_SHELL.test(feeder)) continue;
    for (const text of splitSegments(m[3])) {
      const r = analyzeSegment(text, c);
      segments.push({ text: '(heredoc) ' + text, writes: r.writes, reads: r.reads, cmd: r.cmd });
    }
  }
  return segments;
}
