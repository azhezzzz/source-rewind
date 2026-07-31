import process from "node:process";

export type DownloadOptions = {
  browser: string;
  headless: boolean;
  outputDir: string;
  url: string | null;
};

export type RecoverOptions = {
  outputDir: string;
  siteDir: string;
};

export type CliArgs =
  | { action: "help" }
  | { action: "download"; help: true }
  | { action: "download"; help: false; options: DownloadOptions }
  | { action: "recover"; help: true }
  | { action: "recover"; help: false; options: RecoverOptions };

function optionValue(parameters: string[], index: number, name: string): [string, number] {
  const parameter = parameters[index]!;
  const inline = parameter.startsWith(`${name}=`) ? parameter.slice(name.length + 1) : null;
  const value = inline ?? parameters[index + 1];
  if (!value || (!inline && value.startsWith("--"))) throw new Error(`${name} 必须提供值`);
  return [value, inline === null ? index + 1 : index];
}

export function parseArgs(args: string[], environment: NodeJS.ProcessEnv = process.env): CliArgs {
  const [action, ...parameters] = args;

  if (!action || action === "-h" || action === "--help" || action === "help") {
    if (parameters.length) throw new Error("帮助行动不接受其他参数");
    return { action: "help" };
  }

  if (action === "download") {
    let browser: string | null = null;
    let help = false;
    const positionals: string[] = [];
    for (let i = 0; i < parameters.length; i++) {
      const parameter = parameters[i]!;
      if (parameter === "-h" || parameter === "--help") help = true;
      else if (parameter === "--browser" || parameter.startsWith("--browser=")) {
        if (browser !== null) throw new Error("--browser 不能重复指定");
        [browser, i] = optionValue(parameters, i, "--browser");
      } else if (parameter.startsWith("-")) throw new Error(`download 不支持选项：${parameter}`);
      else positionals.push(parameter);
    }
    if (help && (positionals.length || browser)) throw new Error("帮助选项不接受其他参数");
    if (help) return { action, help: true };
    if (positionals.length > 1) throw new Error("download 只接受一个可选的初始 URL");
    const resolvedBrowser = browser ?? environment.PUPPETEER_BROWSER;
    if (!resolvedBrowser) throw new Error("请通过 --browser 或 PUPPETEER_BROWSER 指定浏览器");
    return {
      action,
      help: false,
      options: {
        browser: resolvedBrowser,
        headless: /^(1|true|yes)$/i.test(environment.HEADLESS || "false"),
        outputDir: environment.OUTPUT_DIR || "output",
        url: positionals[0] ?? null,
      },
    };
  }

  if (action === "recover") {
    const help = parameters[0] === "-h" || parameters[0] === "--help";
    if (help && parameters.length > 1) throw new Error("帮助选项不接受其他参数");
    if (help) return { action, help: true };
    if (parameters.length > 1) throw new Error("recover 只接受一个站点资源目录");
    if (!parameters[0]) throw new Error("recover 必须指定站点资源目录");
    return {
      action,
      help: false,
      options: { outputDir: environment.OUTPUT_DIR || "output", siteDir: parameters[0] },
    };
  }

  throw new Error(`未知行动：${action}`);
}
