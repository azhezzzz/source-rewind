import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { terminateBrowserProcess } from "../src/browser-process.ts";
import { CdpClient } from "../src/cdp-client.ts";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const browserPath = process.argv[2] || process.env.PUPPETEER_BROWSER;
if (!browserPath || /^https?:|^wss?:/i.test(browserPath))
  throw new Error("请通过参数或 PUPPETEER_BROWSER 提供本地 Chrome 可执行文件路径");

const profileDir = await mkdtemp(path.join(tmpdir(), "source-rewind-cdp-"));
const browser = spawn(
  path.resolve(browserPath),
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const browserError = new Promise<never>((_, reject) => browser.once("error", reject));

try {
  const endpoint = await Promise.race([
    (async () => {
      const activePortPath = path.join(profileDir, "DevToolsActivePort");
      for (let attempt = 0; attempt < 200; attempt++) {
        if (browser.exitCode !== null || browser.signalCode !== null)
          throw new Error("Chrome 在调试端口就绪前退出");
        try {
          const [port, webSocketPath] = (await readFile(activePortPath, "utf8")).trim().split("\n");
          if (port && webSocketPath) return `ws://127.0.0.1:${port}${webSocketPath}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(50);
      }
      throw new Error("等待 Chrome 调试端口超时");
    })(),
    browserError,
  ]);

  const client = await CdpClient.connect(endpoint);
  const version = await client.send("Browser.getVersion");
  console.log(`CDP 连接成功：${version.product}，协议 ${version.protocolVersion}`);
  const startedAt = performance.now();
  await client.close();
  console.log(`WebSocket 已关闭：${Math.round(performance.now() - startedAt)} ms`);
} finally {
  await terminateBrowserProcess(browser);
  await rm(profileDir, { recursive: true, force: true });
}
