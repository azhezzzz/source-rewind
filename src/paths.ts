import { createHash } from "node:crypto";
import path from "node:path";

export function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+$/, "_") || "_";
}

export function resourcePath(url: URL, contentType = ""): string {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  const parts = pathname.split("/").filter(Boolean).map(safe);
  if (!parts.length || pathname.endsWith("/")) parts.push("index.html");
  if (!path.extname(parts.at(-1)!) && /text\/html|application\/xhtml/i.test(contentType))
    parts[parts.length - 1] += ".html";
  if (url.search) {
    const hash = createHash("sha1").update(url.search).digest("hex").slice(0, 10);
    const ext = path.extname(parts.at(-1)!);
    const stem = ext ? parts.at(-1)!.slice(0, -ext.length) : parts.at(-1)!;
    parts[parts.length - 1] = `${stem}.__q_${hash}${ext}`;
  }
  return path.join("resources", safe(url.host), ...parts);
}

export function restoredSourcePath(sourceRoot: unknown, source: unknown): string | null {
  if (typeof source !== "string") return null;
  let value =
    `${typeof sourceRoot === "string" ? sourceRoot : ""}${source}`
      .replace(/^(?:webpack|webpack-internal|file):\/\/+?/i, "")
      .replaceAll("\\", "/")
      .split(/[?#]/)[0] ?? "";
  value = path.posix.normalize(value).replace(/^\/+/, "");
  if (!value || value === "." || value === ".." || value.startsWith("../")) return null;
  return value.split("/").map(safe).join("/");
}
