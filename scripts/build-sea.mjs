import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const bundlePath = path.join(distDir, "source-rewind.cjs");
const executableName = process.platform === "win32" ? "source-rewind.exe" : "source-rewind";
const executablePath = path.join(distDir, executableName);
const generatedConfigPath = path.join(distDir, "sea-config.json");

await mkdir(distDir, { recursive: true });
await build({
  entryPoints: [path.join(rootDir, "src/cli.ts")],
  bundle: true,
  format: "cjs",
  outfile: bundlePath,
  platform: "node",
  target: "node20",
});

const seaConfig = JSON.parse(await readFile(path.join(rootDir, "sea-config.json"), "utf8"));
seaConfig.main = bundlePath;
seaConfig.output = executablePath;
await writeFile(generatedConfigPath, JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ["--build-sea", generatedConfigPath], {
  cwd: rootDir,
  stdio: "inherit",
});
if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", executablePath], { stdio: "inherit" });
}

const size = (await stat(executablePath)).size / 1024 / 1024;
console.log(`SEA 构建完成：${executablePath} (${size.toFixed(1)} MB)`);
