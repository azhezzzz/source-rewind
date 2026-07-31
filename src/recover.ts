import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RecoverOptions } from "./args.ts";
import { resourcePath, restoredSourcePath, safe } from "./paths.ts";

type Report = {
  scanned: number;
  maps: {
    found: number;
    downloaded: number;
    reusedFromCache: number;
    restored: number;
    failures: object[];
    missingContent: number;
  };
  webpackEval: { found: number; restored: number; failures: object[] };
  conflicts: string[];
};

async function walk(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(target)));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

function mapReference(text: string): string | null {
  return [...text.matchAll(/[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/g)].at(-1)?.[1]?.trim() || null;
}

function decodeInlineMap(reference: string): string {
  const match = reference.match(/^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/is);
  if (!match) throw new Error("不支持的内嵌 Source Map");
  const payload = match[2] ?? "";
  return match[1] ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
}

function decodeEscape(
  text: string,
  start: number,
  quote: string,
): { value: string; end: number } | null {
  let value = "";
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (char === quote) return { value, end: i + 1 };
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = text[++i];
    if (next === undefined) return null;
    const simple: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      "0": "\0",
    };
    if (next in simple) value += simple[next];
    else if (next === "\n") continue;
    else if (next === "\r") {
      if (text[i + 1] === "\n") i++;
    } else if (next === "x" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      value += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (next === "u" && /^[0-9a-f]{4}$/i.test(text.slice(i + 1, i + 5))) {
      value += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
      i += 4;
    } else value += next;
  }
  return null;
}

function evalSources(text: string): { source: string; content: string }[] {
  const result: { source: string; content: string }[] = [];
  for (let offset = 0; ;) {
    const at = text.indexOf("eval(", offset);
    if (at < 0) break;
    let cursor = at + 5;
    while (/\s/.test(text[cursor] || "")) cursor++;
    const quote = text[cursor];
    if (quote !== '"' && quote !== "'") {
      offset = cursor + 1;
      continue;
    }
    const decoded = decodeEscape(text, cursor, quote);
    if (!decoded) break;
    const match = decoded.value.match(/\/\/[#@]\s*sourceURL=(webpack(?:-internal)?:\/\/\/[^\s]+)/);
    if (match?.[1])
      result.push({
        source: match[1],
        content: decoded.value.replace(/\n?\/\/[#@]\s*sourceURL=.*?(?:\n|$)/, ""),
      });
    offset = decoded.end;
  }
  return result;
}

export function recoverUsage(): void {
  console.log(
    "用法: source-rewind recover <站点资源目录>\n输出目录由 OUTPUT_DIR 控制，默认 ./output",
  );
}

export async function recover(options: RecoverOptions): Promise<void> {
  const siteDir = path.resolve(options.siteDir);
  const outputDir = path.resolve(options.outputDir);
  const host = path.basename(siteDir);
  const files = (await walk(siteDir)).filter((file) => /\.(?:js|mjs|cjs|css)$/i.test(file));
  const report: Report = {
    scanned: files.length,
    maps: {
      found: 0,
      downloaded: 0,
      reusedFromCache: 0,
      restored: 0,
      failures: [],
      missingContent: 0,
    },
    webpackEval: { found: 0, restored: 0, failures: [] },
    conflicts: [],
  };
  const written = new Map<string, string>();
  const writeSource = async (
    kind: string,
    host: string,
    relative: string,
    content: string,
  ): Promise<void> => {
    const targetRelative = path.join("restored", kind, safe(host), relative);
    const digest = createHash("sha1").update(content).digest("hex");
    if (written.has(targetRelative)) {
      if (written.get(targetRelative) !== digest) report.conflicts.push(targetRelative);
      return;
    }
    written.set(targetRelative, digest);
    const target = path.join(outputDir, targetRelative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };

  for (const [index, file] of files.entries()) {
    const text = await readFile(file, "utf8");
    const relative = path.relative(siteDir, file).replaceAll(path.sep, "/");
    const bundleUrl = new URL(relative, `https://${host}/`);
    const ref = mapReference(text);
    if (ref) {
      report.maps.found++;
      try {
        let mapText: string;
        let mapUrl = bundleUrl.href;
        if (/^data:/i.test(ref)) mapText = decodeInlineMap(ref);
        else {
          mapUrl = new URL(ref, bundleUrl).href;
          const target = path.join(
            outputDir,
            resourcePath(new URL(mapUrl), "application/json+sourcemap"),
          );
          try {
            mapText = await readFile(target, "utf8");
            report.maps.reusedFromCache++;
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
            const response = await fetch(mapUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            mapText = await response.text();
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, mapText);
            report.maps.downloaded++;
          }
        }
        const map = JSON.parse(mapText) as {
          sourceRoot?: string;
          sources?: unknown[];
          sourcesContent?: unknown[];
        };
        for (let i = 0; i < (map.sources?.length || 0); i++) {
          const content = map.sourcesContent?.[i];
          if (typeof content !== "string") {
            report.maps.missingContent++;
            continue;
          }
          const source = restoredSourcePath(map.sourceRoot, map.sources![i]);
          if (!source) continue;
          await writeSource("sourcemap", host, source, content);
          report.maps.restored++;
        }
      } catch (error) {
        report.maps.failures.push({
          file: relative,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      for (const item of evalSources(text)) {
        report.webpackEval.found++;
        const source = restoredSourcePath("", item.source);
        if (!source) continue;
        await writeSource("webpack-eval", host, source, item.content);
        report.webpackEval.restored++;
      }
    } catch (error) {
      report.webpackEval.failures.push({
        file: relative,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    console.log(`[${index + 1}/${files.length}] ${relative}`);
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "recovery-report.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), siteDir, outputDir, host, ...report },
      null,
      2,
    ),
  );
  if (report.maps.found === 0 && report.webpackEval.found === 0) {
    console.warn("\n未检测到可恢复的 Source Map 或 Webpack eval 源码。");
  }
  console.log(
    `完成：Source Map 源码 ${report.maps.restored} 个（下载 Map ${report.maps.downloaded}，复用缓存 ${report.maps.reusedFromCache}），Webpack eval ${report.webpackEval.restored} 个。`,
  );
  console.log(`输出：${path.join(outputDir, "restored")}`);
}
