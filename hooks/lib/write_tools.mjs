/**
 * 写类工具的单一事实源：哪个工具能写文件、它写完会留下什么。
 *
 * 为什么必须抽出来：guard_write 认 6 个工具、guard_state 认 5 个（少了
 * str_replace_editor）。差异不显眼，后果很具体——用 str_replace_editor 改
 * state.json 时 guard_state 直接 `process.exit(0)` 放行，一份没有证据的完成态
 * 就这么落盘了。两个门禁对"哪些工具算写"各有一张表，等于给了一条只绕过其一的窄缝。
 *
 * 这里只管**载荷形状**（各 CLI 的参数名不同不是我们的选择），不管判定口径。
 */

/** 能落盘的工具名（Claude Code / ZCode / 通用 IDE 的写法都收）。 */
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'create_file', 'str_replace_editor']);

/** 从入参取目标路径：不同工具分别叫 file_path / path / notebook_path。 */
export function writeTarget(input) {
  const i = input || {};
  return String(i.file_path || i.path || i.notebook_path || '');
}

/**
 * 从入参推出"写完之后文件长什么样"。推不出来返回 null —— 由调用方按 fail-closed 处理。
 *
 * 只覆盖能确定语义的命令。`str_replace_editor` 的 insert / undo_edit 依赖行号与历史，
 * 在这里复现等于另写一个编辑器（复现错了比推不出来更糟）。
 */
export function prospectiveContent(tool, input, abs, readCurrent) {
  const i = input || {};
  const cmd = String(i.command || '');

  // 整篇覆盖型：Write / create_file / str_replace_editor create
  if (tool === 'Write' || tool === 'create_file' || (tool === 'str_replace_editor' && cmd === 'create')) {
    if (typeof i.content === 'string') return i.content;
    if (typeof i.file_text === 'string') return i.file_text;
    return null;
  }

  const current = readCurrent(abs);

  if (tool === 'Edit' || tool === 'str_replace_editor') {
    if (current === null) return null;
    // str_replace_editor 用 old_str / new_str，且没有 replace_all（要求唯一命中）。
    const oldStr = String(i.old_string ?? i.old_str ?? '');
    const newStr = String(i.new_string ?? i.new_str ?? '');
    // 只认显式的 str_replace（或缺省）；insert / undo_edit 依赖行号与历史，推不出来就交给调用方 fail-closed。
    if (tool === 'str_replace_editor' && cmd && cmd !== 'str_replace') return null;
    if (!oldStr || !current.includes(oldStr)) return null;
    if (i.replace_all) return current.split(oldStr).join(newStr);
    return current.replace(oldStr, newStr);
  }

  if (tool === 'MultiEdit') {
    if (current === null) return null;
    let text = current;
    for (const e of i.edits || []) {
      const oldStr = String((e && e.old_string) ?? '');
      if (!oldStr || !text.includes(oldStr)) return null;
      text = e.replace_all ? text.split(oldStr).join(String(e.new_string ?? '')) : text.replace(oldStr, String(e.new_string ?? ''));
    }
    return text;
  }

  return null;
}
