#!/usr/bin/env nub
import process from "node:process";
import { parseArgs } from "./args.ts";
import { download, downloadUsage } from "./download.ts";
import { recover, recoverUsage } from "./recover.ts";

function usage(): void {
  console.log(`SourceRewind：浏览器资源采集与前端源码回溯工具

用法:
  source-rewind <行动> [参数]

行动:
  download [初始URL]       下载浏览器运行时加载的资源
  recover <站点资源目录>  从已下载资源恢复源码

运行 \`source-rewind <行动> --help\` 查看行动帮助。`);
}

async function main(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.action === "help") return usage();

  if (parsed.action === "download") {
    if (parsed.help) return downloadUsage();
    return download(parsed.options);
  }

  if (parsed.help) return recoverUsage();
  return recover(parsed.options);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  const action = process.argv[2];
  if (action === "download") downloadUsage();
  else if (action === "recover") recoverUsage();
  else usage();
  process.exitCode = 1;
});
