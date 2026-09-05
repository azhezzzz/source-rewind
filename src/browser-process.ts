import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

const isRunning = (browserProcess: ChildProcess): boolean =>
  browserProcess.exitCode === null && browserProcess.signalCode === null;

async function waitForExit(exited: Promise<void>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function terminateBrowserProcess(
  browserProcess: ChildProcess,
  requestClose: () => Promise<void> | void = () => {
    browserProcess.kill();
  },
): Promise<void> {
  if (!isRunning(browserProcess)) return;

  const exited = once(browserProcess, "exit").then(() => undefined);
  void Promise.resolve()
    .then(requestClose)
    .catch(() => {
      if (isRunning(browserProcess)) browserProcess.kill();
    });

  await waitForExit(exited, 2_000);
  if (isRunning(browserProcess)) {
    browserProcess.kill("SIGKILL");
    await waitForExit(exited, 2_000);
  }
  if (isRunning(browserProcess))
    throw new Error(`无法终止浏览器进程 ${browserProcess.pid ?? ""}`.trim());
}
