// Trail: every file Claude reads or changes this session, in any folder or on
// any drive, grouped by folder in a side pane and lit up as it happens:
// reads purple, writes orange, the newest marked for a few seconds, writes
// with their +/- line counts. Click a file to copy its path.
//
// It only watches the tool calls Claude already makes (Read, Edit, Write,
// MultiEdit, NotebookEdit, and paths named in PowerShell/Bash commands), so it
// makes no model calls and registers no tools: it costs no tokens.

import { treeRows, GLOW_MS, FRESH_MS as TREE_FRESH_MS } from "./trail-tree.mjs";

const PANE_ID = "trail";
const FRESH_MS = 4000;
const MAX_FILES = 400;

// path key -> { path, kind: "read" | "write", at, add, del, count }
const files = new Map();
let home = "";

const PS_WRITERS = new Set([
  "set-content", "sc", "add-content", "ac", "out-file", "clear-content", "clc", "new-item", "ni",
  "copy-item", "cp", "copy", "cpi", "move-item", "mv", "move", "mi", "rename-item", "ren", "rni",
  "remove-item", "ri", "rm", "del", "erase", "rd", "rmdir", "tee-object", "tee", "touch", "truncate", "sed", "perl",
]);
const READERS = new Set(["get-content", "gc", "cat", "type", "head", "tail", "less", "more", "select-string", "sls", "rg", "grep"]);
const VALUE_PARAMS = /^-(value|encoding|itemtype|type|newname|stream|filter|include|exclude|credential|inputobject|width|delimiter|pattern|first|last|tail|totalcount|head)$/i;

function words(text) {
  const out = [];
  const re = /"((?:[^"\\`]|[\\`].)*)"|'((?:[^']|'')*)'|([^\s;|&(){}]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? (m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3]));
  return out;
}

function looksLikePath(a) {
  return /[\\/.]/.test(a) && !/^\$/.test(a) && !/^s[/|#]/.test(a) && !/^https?:/.test(a) && a.length < 400;
}

/** { reads, writes } paths a shell command names (best effort). */
export function shellPaths(command) {
  const reads = new Set();
  const writes = new Set();
  for (const m of command.matchAll(/\d?>>?\s*("([^"]+)"|'([^']+)'|([^\s;|&)]+))/g)) {
    const p = m[2] ?? m[3] ?? m[4];
    if (p && !/^(&\d|\$null|nul|\/dev\/null)$/i.test(p)) writes.add(p);
  }
  for (const segment of command.split(/&&|\|\||;|\||\r?\n/)) {
    const w = words(segment.trim());
    if (w.length === 0) continue;
    const verb = w[0].toLowerCase().replace(/\.exe$/, "");
    const target = PS_WRITERS.has(verb) ? writes : READERS.has(verb) ? reads : null;
    if (!target) continue;
    for (let i = 1; i < w.length; i += 1) {
      if (VALUE_PARAMS.test(w[i])) { i += 1; continue; }
      if (w[i].startsWith("-")) continue;
      if (looksLikePath(w[i])) target.add(w[i]);
    }
  }
  return { reads: [...reads].slice(0, 20), writes: [...writes].slice(0, 20) };
}

function lineCount(text) {
  if (!text) return 0;
  return String(text).split(/\r?\n/).length;
}

function absolute(cwd, p) {
  let path = String(p).trim();
  const git = path.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (git) path = `${git[1].toUpperCase()}:${(git[2] ?? "/").replace(/\//g, "\\")}`;
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) path = home + path.slice(1);
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/")) return path;
  return `${cwd.replace(/[\\/]+$/, "")}\\${path.replace(/^\.[\\/]/, "")}`;
}

function note($, path, kind, add = 0, del = 0) {
  const key = path.replace(/\//g, "\\").toLowerCase();
  const prev = files.get(key);
  const entry = {
    path: path.replace(/\//g, "\\"),
    // A file once written stays a write; a later read doesn't hide it.
    kind: prev?.kind === "write" ? "write" : kind,
    at: Date.now(),
    add: (prev?.add ?? 0) + add,
    del: (prev?.del ?? 0) + del,
    count: (prev?.count ?? 0) + 1,
  };
  files.delete(key);
  files.set(key, entry);
  if (files.size > MAX_FILES) files.delete(files.keys().next().value);
  // Shared in session state so the mod bar's Trail button can draw the same list.
  void $.state.set({ plugin: "trail", key: "files" }, [...files.values()]).catch(() => undefined);
  $.ui.invalidate("ui.render");
  // Redraw as the glow steps down (lit, then dot, then plain); the same
  // state write redraws the mod bar's copy of the view.
  for (const ms of [GLOW_MS + 50, TREE_FRESH_MS + 50]) {
    $.clock.after(ms, () => {
      void $.state.set({ plugin: "trail", key: "files" }, [...files.values()]).catch(() => undefined);
      $.ui.invalidate("ui.render");
    });
  }
}

async function record($, e) {
  const cwd = await $.session.cwd().catch(() => "");
  switch (e.tool) {
    case "Read":
      if (e.file_path) note($, absolute(cwd, e.file_path), "read");
      return;
    case "Edit":
      if (e.file_path) note($, absolute(cwd, e.file_path), "write", lineCount(e.new_string), lineCount(e.old_string));
      return;
    case "MultiEdit":
      if (e.file_path) {
        const add = (e.edits ?? []).reduce((n, x) => n + lineCount(x.new_string), 0);
        const del = (e.edits ?? []).reduce((n, x) => n + lineCount(x.old_string), 0);
        note($, absolute(cwd, e.file_path), "write", add, del);
      }
      return;
    case "Write":
      if (e.file_path) note($, absolute(cwd, e.file_path), "write", lineCount(e.content), 0);
      return;
    case "NotebookEdit":
      if (e.notebook_path) note($, absolute(cwd, e.notebook_path), "write");
      return;
    case "PowerShell":
    case "Bash": {
      // Shell words are only a guess (search patterns, code, folders look like
      // paths too), so a path counts only if it is a real file on disk now.
      const { reads, writes } = shellPaths(String(e.command ?? ""));
      for (const [list, kind] of [[writes, "write"], [reads, "read"]]) {
        for (const p of list) {
          const path = absolute(cwd, p);
          const st = await $.fs.stat(path).catch(() => null);
          if (st && st.kind === "file") note($, path, kind);
        }
      }
      return;
    }
    default:
  }
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    home = ((await $.env.get("USERPROFILE")) ?? (await $.env.get("HOME")) ?? "").replace(/[\\/]+$/, "");
    await $.command.register({ name: "trail", description: "Trail: every file Claude read or changed this session, anywhere" });
    return r;
  });

  // A toggle: opens the pane, or closes it when it is already up.
  on("command.run", { command: "trail" }, async ($) => {
    const isUp = (await $.ui.panes().catch(() => [])).some((pane) => pane.id === PANE_ID);
    if (isUp) {
      await $.ui.close({ id: PANE_ID }).catch(() => undefined);
      return { text: "Trail closed." };
    }
    // `focus` may only be true or left out; leaving it out keeps the prompt focused.
    const opened = await $.ui.open({ id: PANE_ID, title: "Trail" }).catch(() => null);
    return { text: opened ? `Trail: ${files.size} files this session.` : "Trail: couldn't open the pane here." };
  });

  // Record after the call runs, so a refused or failed call is not shown as done.
  on("tool.call", async ($, e, next) => {
    const r = await next(e);
    try {
      if (r && r.deny === undefined && r.isError !== true) await record($, e);
    } catch {
      // watching must never get in the way
    }
    return r;
  }).catch(($, e, next) => next(e));

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => draw($, $.ui.resolve(e), e.props.bodyColumns ?? 40));
}

const folded = new Set();

async function draw($, t, cols) {
  // "clear" in the mod bar's Trail view hides what came before it here too.
  const { value: clearedAt = 0 } = await $.state.get({ plugin: "mod-bar", key: "trailClearedAt" });
  for (const [k, f] of files) if (f.at <= clearedAt) files.delete(k);
  if (files.size === 0) {
    return t.Text({ dimColor: true, wrap: "wrap", children: "Nothing yet. Files Claude reads or changes show up here as it works." });
  }
  const list = [...files.values()];
  const writes = list.filter((f) => f.kind === "write").length;
  const rows = treeRows(t, list, {
    cols,
    now: Date.now(),
    home,
    folded,
    onFold: (id) => {
      if (folded.has(id)) folded.delete(id);
      else folded.add(id);
      $.ui.invalidate("ui.render");
    },
    onCopy: async (path) => {
      await $.ui.copy({ text: path }).catch(() => undefined);
      $.ui.toast(`Copied ${path}`);
    },
  });
  return t.Box({
    flexDirection: "column",
    children: [
      t.Box({
        key: "head",
        flexDirection: "row",
        justifyContent: "space-between",
        children: [
          t.Text({ key: "sum", dimColor: true, bold: true, children: `${list.length} FILES · ${writes} CHANGED` }),
          t.Button({ key: "clear", label: "clear", plain: true, dimColor: true, onPress: () => { files.clear(); void $.state.set({ plugin: "trail", key: "files" }, []); $.ui.invalidate("ui.render"); } }),
        ],
      }),
      ...rows,
    ],
  });
}
