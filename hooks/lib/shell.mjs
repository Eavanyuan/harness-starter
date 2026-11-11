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
  directReaders: ['cat', 'head', 'tail', 'less', 'more', 'bat', 'xxd', 'od', 'hexdump', 'strings', 'base64', 'base32', 'openssl', 'gpg', 'zcat'],
  pathReaders: ['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'sed', 'sort', 'uniq', 'cut', 'tr', 'diff', 'jq', 'wc', 'file', 'stat', 'md5sum', 'shasum', 'sha256sum'],
  writers: ['cp', 'mv', 'install', 'ln', 'rsync', 'tee', 'dd', 'truncate', 'shred'],
};

/** 命令前面的修饰词：跳过它们才拿得到真正的命令名。 */
const PREFIX_WORDS = new Set(['sudo', 'command', 'builtin', 'exec', 'time', 'nohup', 'nice', 'timeout']);

/** `bash -c '<脚本>'` 里的脚本按同一条判据再看一层——否则字符串里塞什么都能过。 */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const MAX_DEPTH = 3;

/**
 * 去掉 heredoc 正文。
 *
 * 不去掉的话，`cat > notes.md <<'EOF'` 里只要出现 "git push --force" 这行说明，
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
 * 一段命令 → { cmd, writes: [{path, via}], reads: [{path, via}] }。
 * 一个段里可能有多个 stage（`a | b | tee c`），逐个 stage 判。
 */
export function analyzeSegment(segment, cfg, depth = 0) {
  const c = { ...DEFAULT_CFG, ...(cfg || {}) };
  const tokens = tokenize(segment);

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

    const cmd = baseName(words[idx] || '');
    const rawArgs = words.slice(idx + 1);
    const args = rawArgs.filter((w) => !isFlag(w));
    if (!firstCmd) firstCmd = cmd;

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
  }

  return { cmd: firstCmd, writes, reads };
}

/** 整条命令 → 逐段的判定素材。段文本原样留着，供 allowlist 前缀匹配与规则正则使用。 */
export function analyzeCommand(command, cfg) {
  return splitSegments(command).map((text) => ({ text, ...analyzeSegment(text, cfg) }));
}
