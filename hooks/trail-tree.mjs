// Draws Trail's file list as a folder tree, the way Filetree does for one
// project, but across every folder and drive Claude touched. Pure drawing: no
// `$` here; the hooks module passes the element table and the callbacks.
//
// Folders fold with ▾/▸, and single-child folder chains are merged into one
// row (VS Code's "compact folders"). The file being worked on lights up with a
// coloured background (orange changed, purple read) and so do the folders
// above it; the glow steps down to a coloured dot and then to plain.
//
// The same file is copied into the trail and mod-bar plugins; keep them equal.

export const GLOW_MS = 1500;
export const FRESH_MS = 4000;

const COLORS = {
  write: { ink: "#f6a96b", glow: "#5a3519" },
  read: { ink: "#c5a3ff", glow: "#3b2a5c" },
};

function display(path, home) {
  if (home && path.toLowerCase().startsWith(home.toLowerCase())) return `~${path.slice(home.length)}`;
  return path;
}

/** A tree of { name, dirs: Map, files: [], latest } from the flat list. */
export function buildTree(list, home) {
  const root = { name: "", dirs: new Map(), files: [], latest: 0 };
  for (const f of list) {
    const parts = display(f.path, home).split(/[\\/]+/).filter(Boolean);
    const fileName = parts.pop();
    let node = root;
    node.latest = Math.max(node.latest, f.at);
    for (const part of parts) {
      const key = part.toLowerCase();
      if (!node.dirs.has(key)) node.dirs.set(key, { name: part, dirs: new Map(), files: [], latest: 0 });
      node = node.dirs.get(key);
      node.latest = Math.max(node.latest, f.at);
    }
    node.files.push({ ...f, name: fileName });
  }
  return root;
}

/** Merges a folder with its only subfolder while it holds no files of its own. */
function compact(dir) {
  let name = dir.name;
  let node = dir;
  while (node.files.length === 0 && node.dirs.size === 1) {
    const [only] = node.dirs.values();
    name = `${name}\\${only.name}`;
    node = only;
  }
  return { name, node };
}

/**
 * Elements for the tree.
 * opts: { cols, now, home, folded: Set<string>, onFold(id), onCopy(path) }
 */
export function treeRows(t, list, opts) {
  const { cols, now, home, folded, onFold, onCopy } = opts;
  const rows = [];
  const root = buildTree(list, home);
  const walk = (node, depth, idBase) => {
    const dirs = [...node.dirs.values()].sort((a, b) => b.latest - a.latest);
    for (const dir of dirs) {
      const { name, node: inner } = compact(dir);
      const id = `${idBase}/${name.toLowerCase()}`;
      const isFolded = folded.has(id);
      const hot = now - inner.latest < FRESH_MS;
      const indent = "  ".repeat(depth);
      const label = `${indent}${isFolded ? "▸" : "▾"} ${name}`;
      rows.push(t.Button({
        key: `dir:${id}`,
        label: label.length > cols - 1 ? `${label.slice(0, Math.max(10, cols - 2))}…` : label,
        plain: true,
        dimColor: !hot,
        onPress: () => onFold(id),
      }));
      if (!isFolded) walk(inner, depth + 1, id);
    }
    const files = [...node.files].sort((a, b) => b.at - a.at);
    for (const f of files) {
      const age = now - f.at;
      const c = COLORS[f.kind] ?? COLORS.read;
      const indent = "  ".repeat(depth);
      const counts = f.kind === "write" && (f.add || f.del) ? ` +${f.add} −${f.del}` : f.count > 1 ? ` ×${f.count}` : "";
      const room = Math.max(8, cols - indent.length - 4 - counts.length);
      const name = f.name.length > room ? `${f.name.slice(0, room - 1)}…` : f.name;
      const key = `file:${idBase}/${f.name.toLowerCase()}`;
      if (age < GLOW_MS) {
        // Lit up: the file being worked on right now.
        rows.push(t.Box({
          key,
          flexDirection: "row",
          children: [
            t.Text({ key: `${key}:i`, children: indent }),
            t.Text({ key: `${key}:n`, bold: true, color: c.ink, backgroundColor: c.glow, children: ` ● ${name} ` }),
            ...(counts ? [t.Text({ key: `${key}:c`, color: c.ink, children: counts })] : []),
          ],
        }));
        continue;
      }
      const fresh = age < FRESH_MS;
      rows.push(t.Box({
        key,
        flexDirection: "row",
        children: [
          t.Text({ key: `${key}:i`, children: indent }),
          t.Text({ key: `${key}:d`, color: c.ink, dimColor: !fresh, children: fresh ? " ● " : " • " }),
          t.Button({ key: `${key}:b`, label: name, plain: true, dimColor: f.kind === "read", onPress: () => onCopy(f.path) }),
          ...(counts ? [t.Text({ key: `${key}:c`, color: f.kind === "write" ? c.ink : undefined, dimColor: true, children: counts })] : []),
        ],
      }));
    }
  };
  walk(root, 0, "");
  return rows;
}
