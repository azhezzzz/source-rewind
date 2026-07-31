# SourceRewind

浏览器资源采集与前端源码回溯工具。

使用真实 Chrome 捕获现代前端页面运行时加载的资源，再从 Source Map 或 Webpack eval bundle 中恢复可读源码。工具通过 `src/cli.ts` 提供两个行动：

- `download`：通过 Puppeteer 记录浏览器实际加载的前端资源。
- `recover`：扫描已下载资源，识别并恢复标准 Source Map 和 Webpack eval 源码。

下载和恢复可以分开运行；浏览器仍在采集时，也可以在另一个终端恢复已经落盘的文件。API 请求（XHR、Fetch 等）和普通 JSON 响应不会保存，Source Map 文件不受 JSON 过滤影响。

> 仅用于你拥有或已获授权访问的站点。

## 安装

```bash
nub install
```

不带行动运行时会显示帮助：

```bash
nub src/cli.ts
```

需要 Node.js 20.19 或更高版本以及 `nub`。项目使用 `puppeteer-core`，安装依赖时不会下载 Chrome。请准备本地 Chrome/Chromium，或者可访问的远程 Chrome DevTools endpoint。

## 一、下载浏览器资源

使用本地 Chrome：

```bash
PUPPETEER_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
nub src/cli.ts download
```

也可以使用命令行参数；命令行参数优先于环境变量：

```bash
nub src/cli.ts download --browser '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

浏览器打开后，在地址栏访问站点并正常操作。路由懒加载、动态 import、点击或跳转产生的前端资源会在收到响应时立即写入磁盘。采集会持续运行，关闭采集标签页或按 `Ctrl+C` 才会结束并生成 `download-report.json`。

也可以提供初始 URL：

```bash
PUPPETEER_BROWSER='/path/to/chrome' \
nub src/cli.ts download https://example.com/
```

连接远程调试浏览器时，HTTP 地址需要返回包含 `webSocketDebuggerUrl` 的 JSON：

```bash
PUPPETEER_BROWSER=http://127.0.0.1:9222/json/version nub src/cli.ts download
```

也支持完整的版本信息 URL 和 WebSocket endpoint：

```bash
nub src/cli.ts download --browser http://192.168.0.3:9223/json/version
nub src/cli.ts download --browser ws://192.168.0.3:9223/devtools/browser/xxx
```

远程模式结束采集时不会关闭远程浏览器。

下载器环境变量：

| 变量                | 必填 | 说明                                                      |
| ------------------- | ---- | --------------------------------------------------------- |
| `PUPPETEER_BROWSER` | 是   | Chrome 可执行文件路径、HTTP 调试地址或 WebSocket endpoint |
| `OUTPUT_DIR`        | 否   | 工作目录，默认 `./output`                                 |
| `HEADLESS`          | 否   | 本地启动时是否无界面，默认 `false`                        |

## 二、恢复源码

恢复命令必须指定一个站点的资源目录。即使下载器仍在运行也可以执行：

```bash
nub src/cli.ts recover ./output/resources/static1.kqiu.cn
```

参数必须指向 `resources` 下的具体站点目录，而不是整个 `resources` 或 `output` 目录。恢复结果默认写入 `./output/restored/`。

使用 `OUTPUT_DIR` 可以指定另一个输出工作目录：

```bash
OUTPUT_DIR=./recovered nub src/cli.ts recover ./output/resources/static1.kqiu.cn
```

恢复器目前识别：

1. 外部 `sourceMappingURL=app.js.map`
2. 内嵌 `sourceMappingURL=data:application/json;base64,...`
3. Webpack `eval("... //# sourceURL=webpack:///...")`

恢复内容会按 Source Map 或 Webpack bundle 中记录的原始内容写入，不会额外格式化。

外部 Source Map 会缓存到 `OUTPUT_DIR/resources/<host>/...`。再次执行时优先读取缓存，只有本地不存在才按 bundle URL 下载。需要特殊登录请求头的 `.map` 可能无法获取，失败原因会写入报告。

## 输出结构

```text
output/
├── resources/<host>/...          # 浏览器捕获的原始资源
├── restored/
│   ├── sourcemap/<host>/...      # 标准 Source Map 恢复结果
│   └── webpack-eval/<host>/...   # Webpack eval/sourceURL 提取结果
├── download-report.json
└── recovery-report.json
```

## 限制

- 只保存采集期间实际请求的资源；没有访问的路由和没有触发的懒加载模块不会出现。
- `xhr`、`fetch`、WebSocket、EventSource 和普通 JSON API 响应会被跳过。
- 外部 Source Map 如果需要登录 Cookie、Referer 或自定义请求头，恢复器的普通网络请求可能无法下载。
- Source Map 没有 `sourcesContent` 时，无法仅靠映射信息完整恢复原文件。
- Webpack eval 恢复的是 bundle 中嵌入的模块内容，可能仍包含 `__webpack_require__` 等编译产物。
- 恢复器会执行路径安全检查、内容去重和冲突记录，但恢复结果不保证能够直接重新构建。

## 构建 SEA 可执行文件

使用 Node 25.5 或更高版本为本机平台生成无需另行安装 Node 的可执行文件：

```bash
nub run build:sea
```

产物位于 `dist/source-rewind`，Windows 下为 `dist/source-rewind.exe`。构建脚本会先打包 CLI，再通过 Node 原生 `--build-sea` 生成可执行文件。不同操作系统和 CPU 架构需要分别构建；Chrome 不会包含在产物中，运行下载行动时仍需通过 `--browser` 或 `PUPPETEER_BROWSER` 指定。

## 发布

项目使用 [release-it](https://github.com/release-it/release-it/releases) 和 Conventional Commits 自动计算版本、生成 `CHANGELOG.md`、创建 Git 标签及 GitHub Release。

提交信息遵循 `type: subject` 格式，具体规则见 `AGENTS.md`。发布前可先进行演练：

```bash
nub run release:dry
```

确认无误后执行：

```bash
nub run release
```
