export const environmentVariables = {
  PUPPETEER_BROWSER: {
    description: "cloak、Chrome 可执行文件路径、HTTP 调试地址或 WebSocket endpoint",
    defaultValue: null,
  },
  OUTPUT_DIR: {
    description: "下载、恢复及报告的输出工作目录",
    defaultValue: "output",
  },
  HEADLESS: {
    description: "本地启动浏览器时是否使用无界面模式",
    defaultValue: false,
  },
  CAPTURE_NEW_TABS: {
    description: "是否采集当前浏览器实例在连接后新建的其他标签页",
    defaultValue: false,
  },
} as const;

export type RuntimeConfig = {
  browser: string | null;
  captureNewTabs: boolean;
  headless: boolean;
  outputDir: string;
};

const booleanValue = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : /^(1|true|yes)$/i.test(value);

export function readConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  return {
    browser: environment.PUPPETEER_BROWSER || environmentVariables.PUPPETEER_BROWSER.defaultValue,
    captureNewTabs: booleanValue(
      environment.CAPTURE_NEW_TABS,
      environmentVariables.CAPTURE_NEW_TABS.defaultValue,
    ),
    headless: booleanValue(environment.HEADLESS, environmentVariables.HEADLESS.defaultValue),
    outputDir: environment.OUTPUT_DIR || environmentVariables.OUTPUT_DIR.defaultValue,
  };
}

export function environmentHelp(): string {
  return Object.entries(environmentVariables)
    .map(([name, item]) => {
      const fallback = item.defaultValue === null ? "" : `，默认 ${String(item.defaultValue)}`;
      return `  ${name.padEnd(18)}${item.description}${fallback}`;
    })
    .join("\n");
}
