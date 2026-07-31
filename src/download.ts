#!/usr/bin/env nub
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer, { type Browser, type HTTPResponse, type Page } from "puppeteer-core";
import { resourcePath } from "./paths.ts";

function usage(): void {
  console.log(`用法:
  PUPPETEER_BROWSER=/path/to/chrome nub src/download.ts [初始URL]
  PUPPETEER_BROWSER=http://127.0.0.1:9222 nub src/download.ts [初始URL]

环境变量:
  PUPPETEER_BROWSER  Chrome 路径、远程 HTTP 调试地址或 WebSocket endpoint（必填）
  OUTPUT_DIR         工作目录（默认 ./output）
  HEADLESS           本地启动是否无界面，默认 false
`);
}

async function openBrowser(value: string): Promise<{ browser: Browser; launched: boolean }> {
  if (/^wss?:\/\//i.test(value))
    return { browser: await puppeteer.connect({ browserWSEndpoint: value }), launched: false };
  if (/^https?:\/\//i.test(value))
    return { browser: await puppeteer.connect({ browserURL: value }), launched: false };
  return {
    browser: await puppeteer.launch({
      executablePath: path.resolve(value),
      headless: /^(1|true|yes)$/i.test(process.env.HEADLESS || "false"),
      defaultViewport: null,
    }),
    launched: true,
  };
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (input === "-h" || input === "--help") return usage();
  if (process.argv.length > 3) throw new Error("只接受一个可选的初始 URL");
  const entryUrl = input ? new URL(input) : null;
  if (entryUrl && !/^https?:$/.test(entryUrl.protocol))
    throw new Error("初始 URL 只支持 http/https");
  const endpoint = process.env.PUPPETEER_BROWSER;
  if (!endpoint) throw new Error("请设置 PUPPETEER_BROWSER");
  const outputDir = path.resolve(process.env.OUTPUT_DIR || "output");
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
  const { browser, launched } = await openBrowser(endpoint);

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

main().catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  usage();
  process.exitCode = 1;
});
