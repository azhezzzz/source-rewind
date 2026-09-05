import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";
import type { DownloadOptions } from "./args.ts";
import { environmentHelp } from "./config.ts";
import { resourcePath } from "./paths.ts";

type ResponseInfo = {
  contentType: string;
  requestId: Protocol.Network.RequestId;
  resourceType: Protocol.Network.ResourceType;
  sessionId: string;
  status: number;
  url: string;
};

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
        <p>${captureNewTabs ? "采集期间<strong>新建的标签页也会自动采集</strong>。" : "仅采集<strong>当前标签页</strong>，其他新建标签页不会被采集。"}</p>
        <p>访问站点后正常操作即可。关闭此标签页或在终端按 <kbd>Ctrl</kbd> + <kbd>C</kbd> 将结束采集并生成报告。</p>
      </main>
    </div>
  </body>
</html>`;

export function downloadUsage(): void {
  console.log(`用法:
  source-rewind download [初始URL] --browser <Chrome路径或远程URL>

选项:
  --browser <值>     Chrome 可执行文件路径、远程 HTTP 调试地址或 WebSocket endpoint

环境变量:
${environmentHelp()}
`);
}

type LaunchedBrowser = { process: ChildProcess; profileDir: string };

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function launchBrowser(
  executablePath: string,
  headless: boolean,
  profileRoot: string,
): Promise<{
  endpoint: string;
  launchedBrowser: LaunchedBrowser;
}> {
  await mkdir(profileRoot, { recursive: true });
  const profileDir = await mkdtemp(path.join(profileRoot, "session-"));
  const activePortPath = path.join(profileDir, "DevToolsActivePort");
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (headless) args.push("--headless=new");
  args.push("about:blank");
  const browserProcess = spawn(path.resolve(executablePath), args, { stdio: "ignore" });
  const browserError = new Promise<never>((_, reject) => browserProcess.once("error", reject));
  try {
    return await Promise.race([
      (async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (browserProcess.exitCode !== null || browserProcess.signalCode !== null)
            throw new Error(
              `浏览器启动失败：${browserProcess.exitCode === null ? `信号 ${browserProcess.signalCode}` : `退出码 ${browserProcess.exitCode}`}`,
            );
          try {
            const [port, webSocketPath] = (await readFile(activePortPath, "utf8"))
              .trim()
              .split("\n");
            if (port && webSocketPath)
              return {
                endpoint: `ws://127.0.0.1:${port}${webSocketPath}`,
                launchedBrowser: { process: browserProcess, profileDir },
              };
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw error;
          }
          await delay(50);
        }
        throw new Error("等待浏览器调试端口超时");
      })(),
      browserError,
    ]);
  } catch (error) {
    if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
      browserProcess.kill();
      await Promise.race([once(browserProcess, "exit"), delay(2_000)]);
    }
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}

async function closeLaunchedBrowser(
  browser: LaunchedBrowser,
  cdp: CDP.Client | null,
): Promise<void> {
  if (browser.process.exitCode === null && browser.process.signalCode === null) {
    const exited = once(browser.process, "exit").then(() => undefined);
    if (cdp) await cdp.send("Browser.close").catch(() => undefined);
    await Promise.race([exited, delay(2_000)]);
    if (browser.process.exitCode === null && browser.process.signalCode === null) {
      browser.process.kill();
      await Promise.race([exited, delay(2_000)]);
    }
  }
  await rm(browser.profileDir, { recursive: true, force: true });
}

async function browserEndpoint(
  value: string,
  headless: boolean,
  profileRoot: string,
): Promise<{
  endpoint: string;
  launchedBrowser: LaunchedBrowser | null;
}> {
  if (/^wss?:\/\//i.test(value)) return { endpoint: value, launchedBrowser: null };
  if (/^https?:\/\//i.test(value)) {
    const versionUrl = new URL(value);
    if (!versionUrl.pathname.includes("/json/version"))
      versionUrl.pathname = `${versionUrl.pathname.replace(/\/$/, "")}/json/version`;
    const response = await fetch(versionUrl);
    if (!response.ok) throw new Error(`无法读取远程浏览器信息：HTTP ${response.status}`);
    const info = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof info.webSocketDebuggerUrl !== "string")
      throw new Error("远程浏览器信息缺少 webSocketDebuggerUrl");
    return { endpoint: info.webSocketDebuggerUrl, launchedBrowser: null };
  }
  return launchBrowser(value, headless, profileRoot);
}

const headerValue = (headers: Record<string, unknown>, name: string): string => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry ? String(entry[1]) : "";
};

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
  const responses = new Map<string, ResponseInfo>();
  const sessions = new Map<string, Promise<string>>();
  let accepting = true;
  const { endpoint, launchedBrowser } = await browserEndpoint(
    options.browser,
    options.headless,
    path.join(outputDir, "profile"),
  );
  let client: CDP.Client | null = null;
  try {
    const cdp = await CDP({ target: endpoint, local: true });
    client = cdp;
    const initialTargets = await cdp.send("Target.getTargets");
    const preexistingTargetIds = new Set(
      initialTargets.targetInfos.map((target) => target.targetId),
    );

    const track = (promise: Promise<void>): void => {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    };
    const responseKey = (sessionId: string, requestId: string): string =>
      `${sessionId}:${requestId}`;
    const save = async (info: ResponseInfo): Promise<void> => {
      const resourceType = info.resourceType.toLowerCase();
      if (
        ["xhr", "fetch", "eventsource", "websocket", "preflight", "ping"].includes(resourceType) ||
        info.status < 200 ||
        info.status >= 300
      )
        return;
      let url: URL;
      try {
        url = new URL(info.url);
      } catch {
        return;
      }
      if (!/^https?:$/.test(url.protocol) || saved.has(url.href)) return;
      const contentType = info.contentType || "application/octet-stream";
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
        const result = await cdp.send(
          "Network.getResponseBody",
          { requestId: info.requestId },
          info.sessionId,
        );
        const body = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
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
    const attachTarget = (targetId: string): Promise<string> => {
      const existing = sessions.get(targetId);
      if (existing) return existing;
      const attaching = (async () => {
        const { sessionId } = await cdp.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        await cdp.send("Network.enable", {}, sessionId);
        return sessionId;
      })();
      sessions.set(targetId, attaching);
      return attaching;
    };

    let mainTargetId = "";
    let finish: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    cdp.on("disconnect", () => finish?.());
    cdp.on("event", (event) => {
      if (event.method === "Target.targetDestroyed") {
        const params = event.params as Protocol.Target.TargetDestroyedEvent;
        if (params.targetId === mainTargetId) finish?.();
        return;
      }
      if (event.method === "Target.targetCreated" && options.captureNewTabs && accepting) {
        const { targetInfo } = event.params as Protocol.Target.TargetCreatedEvent;
        if (targetInfo.type === "page" && !preexistingTargetIds.has(targetInfo.targetId)) {
          track(
            attachTarget(targetInfo.targetId).then(
              () => undefined,
              (error) =>
                console.warn(
                  `无法监听新标签页：${error instanceof Error ? error.message : String(error)}`,
                ),
            ),
          );
        }
        return;
      }
      if (!accepting || !event.sessionId) return;
      if (event.method === "Network.responseReceived") {
        const params = event.params as Protocol.Network.ResponseReceivedEvent;
        const headers = params.response.headers;
        responses.set(responseKey(event.sessionId, params.requestId), {
          contentType: headerValue(headers, "content-type") || params.response.mimeType,
          requestId: params.requestId,
          resourceType: params.type,
          sessionId: event.sessionId,
          status: params.response.status,
          url: params.response.url,
        });
        return;
      }
      const { requestId } = event.params as
        | Protocol.Network.LoadingFailedEvent
        | Protocol.Network.LoadingFinishedEvent;
      const key = responseKey(event.sessionId, requestId);
      if (event.method === "Network.loadingFailed") responses.delete(key);
      else if (event.method === "Network.loadingFinished") {
        const info = responses.get(key);
        responses.delete(key);
        if (info) track(save(info));
      }
    });

    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const created = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    mainTargetId = created.targetId;
    const mainSessionId = await attachTarget(mainTargetId);
    if (entryUrl) {
      console.log(`正在打开 ${entryUrl.href}`);
      await cdp.send("Page.navigate", { url: entryUrl.href }, mainSessionId);
    } else {
      const frameTree = await cdp.send("Page.getFrameTree", undefined, mainSessionId);
      await cdp.send(
        "Page.setDocumentContent",
        { frameId: frameTree.frameTree.frame.id, html: guidePage(options.captureNewTabs) },
        mainSessionId,
      );
      console.log(
        options.captureNewTabs
          ? "浏览器已打开，请在地址栏访问页面；采集期间新建的标签页也会自动采集。"
          : "浏览器已打开，请在当前标签页的地址栏访问页面；其他新建标签页不会被采集。",
      );
    }
    console.log("采集会持续运行；关闭采集标签页或按 Ctrl+C 结束。\n");

    const stop = (): void => finish?.();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await finished;
    accepting = false;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await Promise.allSettled(pending);
    await writeFile(
      path.join(outputDir, "download-report.json"),
      JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2),
    );
  } finally {
    if (launchedBrowser) await closeLaunchedBrowser(launchedBrowser, client);
    if (client) await client.close().catch(() => undefined);
  }
  console.log(`已保存 ${report.downloaded.length} 个资源：${outputDir}`);
}
