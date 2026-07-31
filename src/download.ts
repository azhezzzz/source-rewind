#!/usr/bin/env nub
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type HTTPResponse, type Page } from "puppeteer-core";
import { parseArgs, type DownloadOptions } from "./args.ts";
import { resourcePath } from "./paths.ts";

export function downloadUsage(): void {
  console.log(`用法:
  nub src/cli.ts download [初始URL] --browser <Chrome路径或远程URL>

选项:
  --browser <值>     Chrome 可执行文件路径、远程 HTTP 调试地址或 WebSocket endpoint

环境变量:
  PUPPETEER_BROWSER  --browser 未提供时使用
  OUTPUT_DIR         工作目录（默认 ./output）
  HEADLESS           本地启动是否无界面，默认 false
`);
}

async function openBrowser(
  value: string,
  headless: boolean,
): Promise<{ browser: Browser; launched: boolean }> {
  if (/^wss?:\/\//i.test(value))
    return { browser: await puppeteer.connect({ browserWSEndpoint: value }), launched: false };
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`无法读取远程浏览器信息：HTTP ${response.status}`);
    const info = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof info.webSocketDebuggerUrl !== "string")
      throw new Error("远程浏览器信息缺少 webSocketDebuggerUrl");
    return {
      browser: await puppeteer.connect({ browserWSEndpoint: info.webSocketDebuggerUrl }),
      launched: false,
    };
  }
  return {
    browser: await puppeteer.launch({
      executablePath: path.resolve(value),
      headless,
      defaultViewport: null,
    }),
    launched: true,
  };
}

export async function download(options: DownloadOptions): Promise<void> {
  const entryUrl = options.url ? new URL(options.url) : null;
  if (entryUrl && !/^https?:$/.test(entryUrl.protocol))
    throw new Error("初始 URL 只支持 http/https");
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });

  const report = {
    startedAt: new Date().toISOString(),
    entryUrl: entryUrl?.href || null,
    outputDir,
    downloaded: [] as object[],
    skippedJson: [] as string[],
    failures: [] as object[],
  };
  const saved = new Set<string>();
  const pending = new Set<Promise<void>>();
  const attached = new WeakSet<Page>();
  const { browser, launched } = await openBrowser(options.browser, options.headless);

  const track = (promise: Promise<void>): void => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };
  const save = async (response: HTTPResponse): Promise<void> => {
    const request = response.request();
    const resourceType = request.resourceType();
    if (
      ["xhr", "fetch", "eventsource", "websocket", "preflight", "ping"].includes(resourceType) ||
      !response.ok()
    )
      return;
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || saved.has(url.href)) return;
    const contentType = response.headers()["content-type"] || "application/octet-stream";
    const isMap = /\.map(?:$|[?#])/i.test(url.href);
    if (
      !isMap &&
      (/\b(?:application|text)\/(?:[^;]+\+)?json\b/i.test(contentType) ||
        /\.json(?:$|[?#])/i.test(url.href))
    ) {
      report.skippedJson.push(url.href);
      return;
    }
    saved.add(url.href);
    try {
      const body = await response.buffer();
      const relative = resourcePath(url, contentType);
      const target = path.join(outputDir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
      report.downloaded.push({
        url: url.href,
        path: relative,
        bytes: body.length,
        contentType,
        resourceType,
      });
      console.log(`[${report.downloaded.length}] ${resourceType.padEnd(10)} ${url.href}`);
    } catch (error) {
      report.failures.push({
        url: url.href,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const attach = (page: Page): void => {
    if (attached.has(page)) return;
    attached.add(page);
    page.on("response", (response) => track(save(response)));
    page.on("popup", (popup) => {
      if (popup) attach(popup);
    });
  };

  const page = await browser.newPage();
  attach(page);
  if (entryUrl) {
    console.log(`正在打开 ${entryUrl.href}`);
    await page.goto(entryUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else console.log("浏览器已打开，请在地址栏访问页面。");
  console.log("采集会持续运行；关闭采集标签页或按 Ctrl+C 结束。\n");

  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
    page.once("close", finish);
    browser.once("disconnected", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  await Promise.allSettled(pending);
  await writeFile(
    path.join(outputDir, "download-report.json"),
    JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2),
  );
  if (launched && browser.connected) await browser.close();
  else if (browser.connected) browser.disconnect();
  console.log(`已保存 ${report.downloaded.length} 个资源：${outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseArgs(["download", ...process.argv.slice(2)]);
    const task =
      parsed.action === "download" && !parsed.help ? download(parsed.options) : downloadUsage();
    Promise.resolve(task).catch((error) => {
      console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
      downloadUsage();
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    downloadUsage();
    process.exitCode = 1;
  }
}
