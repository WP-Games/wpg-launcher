// Shared by publish.mjs and its tests.
/**
 * Which platform a file belongs to, from Ren'Py's layout:
 *   Game.exe, lib/py3-windows-*, lib/windows-*            → windows
 *   Game.sh,  lib/py3-linux-*,   lib/linux-*              → linux
 *   Game.app/**, lib/py3-mac-*, lib/darwin-*, lib/mac-*   → mac
 *   everything else (game/, renpy/, lib/python3.x/ …)     → all
 */
export function platformOf(rel) {
  const top = !rel.includes("/");
  if (top && /\.exe$/i.test(rel)) return "windows";
  if (top && /\.sh$/i.test(rel)) return "linux";
  if (/^[^/]+\.app\//i.test(rel)) return "mac";
  const m = rel.match(/^lib\/(?:py\d-)?(windows|linux|mac|darwin)/i);
  if (m) return m[1].toLowerCase() === "darwin" ? "mac" : m[1].toLowerCase();
  return "all";
}
