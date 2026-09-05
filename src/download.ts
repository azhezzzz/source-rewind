import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { launch as launchCloakBrowser } from "cloakbrowser/puppeteer";
import puppeteer, { type Browser, type HTTPResponse, type Page, type Target } from "puppeteer-core";
import type { DownloadOptions } from "./args.ts";
import { environmentHelp } from "./config.ts";
import { resourcePath } from "./paths.ts";

const guidePage = (captureNewTabs: boolean): string => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Source Rewind 资源采集</title>
    <style>
      :root { width: 100%; height: 100%; color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { box-sizing: border-box; width: 100%; height: 100%; margin: 0; overflow: hidden; background: #f4f6f8; color: #17202a; }
      .layout { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; }
      main { box-sizing: border-box; width: min(640px, calc(100% - 32px)); padding: 40px; border: 1px solid #d9e0e7; border-radius: 16px; background: #fff; box-shadow: 0 12px 36px rgb(0 0 0 / 8%); }
      h1 { margin: 0 0 20px; font-size: 28px; }
      p { margin: 12px 0; font-size: 17px; line-height: 1.7; }
      strong { color: #175cd3; }
      kbd { padding: 2px 7px; border: 1px solid #b8c1cc; border-bottom-width: 2px; border-radius: 5px; background: #f7f8fa; font: inherit; font-size: 14px; }
      @media (prefers-color-scheme: dark) {
        body { background: #111820; color: #edf2f7; }
        main { border-color: #344251; background: #1b2530; }
        strong { color: #84adff; }
        kbd { border-color: #607080; background: #253240; }
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <main>
        <h1>Source Rewind 已准备好采集</h1>
        <p>请在<strong>当前标签页</strong>的地址栏输入要访问的网址，然后按回车。</p>
        <p>${
          captureNewTabs
            ? "采集期间<strong>新建的标签页也会自动采集</strong>。"
            : "仅采集<strong>当前标签页</strong>，其他新建标签页不会被采集。"
        }</p>
        <p>访问站点后正常操作即可。关闭此标签页或在终端按 <kbd>Ctrl</kbd> + <kbd>C</kbd> 将结束采集并生成报告。</p>
      </main>
    </div>
  </body>
</html>`;

export function downloadUsage(): void {
  console.log(`用法:
  source-rewind download [初始URL] --browser <cloak、Chrome路径或远程URL>

选项:
  --browser <值>     cloak、Chrome 可执行文件路径、远程 HTTP 调试地址或 WebSocket endpoint

环境变量:
${environmentHelp()}
`);
}

async function openBrowser(
  value: string,
  headless: boolean,
): Promise<{ browser: Browser; launched: boolean }> {
  if (value.toLowerCase() === "cloak")
    return {
      browser: await launchCloakBrowser({ headless, humanize: true }),
      launched: true,
    };
  if (/^wss?:\/\//i.test(value))
    return {
      browser: await puppeteer.connect({ browserWSEndpoint: value, defaultViewport: null }),
      launched: false,
    };
  if (/^https?:\/\//i.test(value)) {
    const versionUrl = new URL(value);
    if (!versionUrl.pathname.includes("/json/version")) {
      versionUrl.pathname = `${versionUrl.pathname.replace(/\/$/, "")}/json/version`;
    }
    const response = await fetch(versionUrl);
    if (!response.ok) throw new Error(`无法读取远程浏览器信息：HTTP ${response.status}`);
    const info = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof info.webSocketDebuggerUrl !== "string")
      throw new Error("远程浏览器信息缺少 webSocketDebuggerUrl");
    return {
      browser: await puppeteer.connect({
        browserWSEndpoint: info.webSocketDebuggerUrl,
        defaultViewport: null,
      }),
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
  const attached = new Map<Page, (response: HTTPResponse) => void>();
  let accepting = true;
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
    if (!accepting || attached.has(page)) return;
    const onResponse = (response: HTTPResponse): void => track(save(response));
    attached.set(page, onResponse);
    page.on("response", onResponse);
  };
  const onTargetCreated = (target: Target): void => {
    if (!accepting || target.type() !== "page") return;
    track(
      (async () => {
        const targetPage = await target.page();
        if (!accepting || !targetPage) return;
        attach(targetPage);
      })().catch((error) => {
        console.warn(`无法监听新标签页：${error instanceof Error ? error.message : String(error)}`);
      }),
    );
  };
  if (options.captureNewTabs) {
    browser.on("targetcreated", onTargetCreated);
  }

  const page = await browser.newPage();
  attach(page);
  if (entryUrl) {
    console.log(`正在打开 ${entryUrl.href}`);
    await page.goto(entryUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else {
    await page.setContent(guidePage(options.captureNewTabs));
    console.log(
      options.captureNewTabs
        ? "浏览器已打开，请在地址栏访问页面；采集期间新建的标签页也会自动采集。"
        : "浏览器已打开，请在当前标签页的地址栏访问页面；其他新建标签页不会被采集。",
    );
  }
  console.log("采集会持续运行；关闭采集标签页或按 Ctrl+C 结束。\n");

  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        accepting = false;
        if (options.captureNewTabs) browser.off("targetcreated", onTargetCreated);
        for (const [attachedPage, onResponse] of attached) {
          attachedPage.off("response", onResponse);
        }
        attached.clear();
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
