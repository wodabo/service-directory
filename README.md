# nav-hub · 本机服务导航面板

把本机一堆记不住端口的服务收进一个页面：SQLite 存数据，卡片式浏览，图标自动检索生成，
端口扫描一键发现，Docker 容器管理，支持增删改与分组。

零依赖 —— 只用 Node 内置模块（`node:sqlite` + `node:http`），不需要 `npm install`。

```
http://127.0.0.1:7788
```

## 快速开始

要求 Node ≥ 22.5（内置 `node:sqlite`）。

```bash
git clone https://github.com/wodabo/service-directory.git nav-hub
cd nav-hub
node server.js
```

启动后终端会列出所有可用地址，直接挑一个：

```
  🧭  nav-hub 已启动
     本机访问   http://127.0.0.1:7788
     局域网     http://192.168.3.116:7788   en1
     局域网     http://192.168.192.110:7788   ZeroTier
```

换端口：`NAV_PORT=8899 node server.js`
只限本机访问：`NAV_HOST=127.0.0.1 node server.js`

### 从手机 / 别的电脑访问

默认监听所有网卡。启动日志会列出可用地址并标注类型。选哪个取决于对端在哪个网络：
同一 Wi‑Fi 用物理网卡地址，走 ZeroTier 就用 ZeroTier 地址。

### 让卡片显示 ZeroTier / 局域网地址

设置 →「外部访问地址」填上要用的 IP（点「检测」会自动列出 ZeroTier 网段和网卡地址，
并预检每个服务在该地址上是否真的连得通）。配好之后：

- 卡片显示和点击打开的地址都会换成这个 IP —— **只替换 IP 形态的 host（回环 / 内网段 / `.local`），
  路径、查询串原样保留**；公网域名服务（如 `https://rss.bz/zh`）不重写，换了外部 IP 反而打不开
- 健康检查同时探内外两侧，**只监听 `127.0.0.1` 的服务会标成「仅本机」**，
  一眼就能看出哪些服务换地址也连不上，需要去改那个服务自己的监听配置

之所以做成一个开关而不是把每条记录的地址改写成 IP：ZeroTier 地址会变，而且那些只绑回环的
服务改写了也连不上。清空这个字段就回到本机地址。

### 加访问密码

面板能扫端口、改数据，暴露到局域网后建议加个密码：

```bash
NAV_AUTH="你的用户名:你的密码" node server.js
```

设了之后浏览器会弹一次登录框，之后正常使用（浏览器会缓存凭证，实时更新也不受影响）。
不设则同网段设备可直接打开。

### 开机自启（macOS LaunchAgent）

项目里带了 `com.zhong.navhub.plist` 模板（内含 `YOUR_USER` 占位），改成自己的路径后：

```bash
cp com.zhong.navhub.plist ~/Library/LaunchAgents/com.yourname.navhub.plist
# 编辑替换 YOUR_USER 为你的用户名
launchctl load ~/Library/LaunchAgents/com.yourname.navhub.plist
```

## 命令行

```bash
node cli.js scan            # 扫描本机监听端口（不改数据）
node cli.js seed            # 扫描并导入服务，自动分组 + 抓图标
node cli.js seed --all      # 连系统/IDE 内部端口一起导入
node cli.js sync            # 重新扫描，同步已收录服务的启动命令（图标匹配依赖它）
node cli.js titles          # 重新抓页面标题，恢复被改乱的服务名
node cli.js icons           # 重新处理所有图标
node cli.js icons --mono    # 全部改用字母图
node cli.js list            # 列出已收录服务
node cli.js check           # 检测所有服务连通性
```

## 功能

**图标自动检索**（`lib/icons.js`）—— 给一个服务找图标，按优先级依次尝试，永不出现空白：

1. **页面声明的图标** —— 抓页面 HTML，解析 `<link rel="icon|apple-touch-icon">`，按尺寸和类型打分（矢量优先）
2. **站点常规路径** —— `/apple-touch-icon.png`、`/favicon.ico`、`/favicon.svg`、`/logo.png` 等
3. **图标库**（`lib/iconlib.js`）—— 按服务名和启动命令识别出这是什么软件，去图标库取品牌图标。
   内网服务、数据库、自研项目本来就没有 favicon，这一步是它们拿到像样图标的主要途径
4. **第三方 favicon 服务** —— Google s2 / DuckDuckGo / favicon.im；内网地址自动跳过
5. **字母图** —— 按名称生成渐变字母图 SVG（中文取首字，英文取词首字母）

下载的图标会做魔数校验（避免把 404 页面当图片存下来），SVG 会清掉 script 和外链，然后落盘到
`data/icons/` 缓存。编辑弹窗里点「自动抓取」会同时把页面标题和描述一起填好。

**图标库** —— 内置两个公开图标库，共 1 万多个彩色 SVG：

| 库 | 数量 | 特点 |
| --- | --- | --- |
| [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) | 3545 | 开发工具与常见自托管应用，覆盖最好 |
| [selfh.st/icons](https://github.com/selfhst/icons) | 7223 | 长尾自托管应用更全 |

两个入口：

- **自动匹配**：扫描/同步时会把进程的启动命令存下来，图标引擎据此识别软件
  （命令行里有 `vite`、`postgres`、`uvicorn` 这些不会认错），自动套上品牌图标。
  只匹配**具体软件**，不匹配通用运行时——你自己的项目跑在 Node 上，套一个 Node 官方 logo
  还不如用项目名首字母的字母图。
- **手动挑选**：编辑弹窗里点「图标库」，搜关键词（`postgres`、`grafana`、`code`、`server`…）
  从网格里点一个即可。自研项目想配个好看的通用图标就用这个。

索引（图标名清单）缓存在 `data/icon-index.json`，30 天自动更新一次，启动时后台预热，
也可以在图标库弹窗里点「↻ 刷新索引」手动更新。

**端口扫描**（`lib/scan.js`）—— 用 `lsof -F` 拿到本机所有 TCP 监听端口，再用 `ps` 取完整命令行，
逐个 HTTP 探测。会自动识别并归类：

- 从页面标题反推服务名（比进程名有意义得多）
- 从命令行路径推断项目名和角色（Vite 开发服务器 / Python 服务 / 构建产物服务…）
- 按可执行文件路径区分：`/System/` 是系统守护进程，`*.app/Contents/` 是桌面应用内部端口，
  OrbStack 转发的数据库端口则是有效服务
- 识别开发服务器的附属端口（`--port` 与监听端口不一致的，如 Vite 的 HMR 端口），默认不导入

扫描弹窗里可以勾选导入（导入成功弹窗自动关闭）、忽略某些端口，或只看 HTTP 服务。

**健康检查** —— 有 URL 的走 HTTP 探测（任何响应都算在线，4xx/5xx 也算，因为进程活着），
只有端口的数据库类服务走 TCP 探测。配了「外部访问地址」后会同时探内外两侧，状态区分：

| 状态 | 含义 | 卡片外观 |
| --- | --- | --- |
| 在线 | 外部地址可达（没配外部地址时=本机可达） | 常规边框 + 绿色状态点 |
| 仅本机 | 本机通，外部不通 —— 服务只监听了 `127.0.0.1` | **红框** + 琥珀状态点 + 「仅本机」标签 |
| 离线 / 超时 | 两边都不通，进程可能挂了 | **红框** + 红色状态点 |
| 未检测 | 刚加入，还没跑过检测 | 常规边框 + 灰色状态点 |

**红框表示「这个现在打不开」**，涵盖进程挂掉的和服务活着但从你配置的地址过不去的两种情况。
状态点的颜色仍然区分是哪种原因。侧边栏统计口径跟红框一致（总计 / 可用 / 不可用）。
可在设置里开启定时自动检测。

**Docker 模块**（`lib/docker.js`）—— 侧栏「Docker 容器」进入，走本机 `docker` CLI（OrbStack /
Docker Desktop 都行），不碰 docker.sock，`execFile` 不经过 shell：

- **容器页签**：运行中 / 已停止分块，状态徽章（运行中/已退出/已暂停 + 健康状态）、映射端口、
  网络、Compose 项目名、实时 CPU / 内存占用；操作按钮按状态给（运行中 → 停止/重启，停止 → 启动）
- **网络页签**：每个网络的子网、网关、driver、internal 标记和接入容器的 IP 表
- **详情弹窗**：inspect 全量 —— 端口映射、网络 IP/网关/DNS 别名、挂载（宿主机路径 + rw/ro）、
  环境变量、启动命令、重启策略
- **日志弹窗**：`docker logs --tail 200 --timestamps`，可刷新
- 任何一端操作了容器，SSE 广播，其他打开着 Docker 视图的页面自动刷新
- docker 命令不存在或守护进程没起时显示「Docker 不可用 + 原因 + 重试」，不影响其它功能
- **安全取舍**：提供 start / stop / restart / pause / unpause / kill，**故意不提供删除容器** ——
  面板是日常随手点的工具，误触 rm 的代价太高，删容器请去命令行

**站点品牌** —— 设置里可自定义面板自己的名称与图标：侧栏标志、浏览器标签页标题、favicon
一并生效。图标支持本地上传（PNG/JPG/WebP/SVG/ICO，≤3MB），可一键恢复默认。

**其他** —— 分组管理（新建 / 重命名 / 换色 / **拖拽排序**，内置「全部服务」「未分组」固定）、
搜索（名称/端口/标签/描述/启动命令）、服务拖拽排序、网格/列表视图、深色/浅色主题
（浅色纯白底 + 卡片阴影层次）、JSON 导入导出、SSE 实时推送（后台抓到图标后卡片自动刷新）。

### 主题与层次

浅色主题是**纯白底**（`--bg`、`--bg-soft`、`--panel` 全是 `#ffffff`），
卡片和侧栏靠 `--card-shadow` / `--sidebar-shadow` 分出层次，深色主题下这两个变量是 `none`
（深色里阴影看不见，反而会把卡片边缘压糊，层次改由边框和悬停变亮来体现）。

**加新组件时注意**：白底白卡片意味着任何嵌在面板内部的浅底块都不能用 `--bg` 或 `--panel`，
否则浅色主题下会彻底看不见。用这几个语义变量：

| 变量 | 用途 | 深色 | 浅色 |
|---|---|---|---|
| `--inset-bg` | 嵌在面板里的浅底块（输入框、代码块、标签、图标格子） | `--bg`（比面板更深） | `#f5f7fb`（比白底更灰） |
| `--hover-bg` | 列表行 / 幽灵按钮的悬停底色 | `--panel-2` | `#f2f5fa` |
| `--card-bg` / `--card-hover-bg` | 卡片底色。浅色下悬停**不变色**，只加深阴影 —— 白卡变灰会读成"按下"而不是"抬起" | `--panel` / `--panel-2` | `#ffffff` / `#ffffff` |

## 目录结构

```
nav-hub/
├── server.js          HTTP 服务 + REST API + SSE
├── cli.js             命令行工具（扫描/灌数据/图标/检测）
├── lib/
│   ├── db.js          SQLite 数据层（schema、迁移、CRUD、导入导出）
│   ├── icons.js       图标检索与生成引擎
│   ├── iconlib.js     图标库（索引、搜索、软件名匹配）
│   ├── docker.js      Docker 容器/网络（包装 docker CLI）
│   ├── scan.js        端口扫描、服务识别、健康检查
│   └── config.js      配置加载（env > nav.config.json > 默认值）
├── public/            前端（原生 HTML/CSS/JS，无构建步骤）
└── data/              运行时数据（不入库，自动生成）
    ├── icons/         图标缓存
    └── icon-index.json  图标库索引缓存
```

## REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 一次性拉取分组、服务、设置、统计 |
| GET/POST | `/api/services` | 列表 / 新建 |
| GET/PUT/DELETE | `/api/services/:id` | 详情 / 修改 / 删除 |
| POST | `/api/services/reorder` | 拖拽排序 |
| POST | `/api/services/:id/icon` | 重抓图标；传 `icon_url` 指定图片，传 `icon_file: null` 重置 |
| POST | `/api/services/:id/icon/generate` | 生成字母图 |
| POST | `/api/preview` | 只探测不落库（编辑弹窗用） |
| GET/POST/PUT/DELETE | `/api/groups[/:id]` | 分组管理 |
| POST | `/api/groups/reorder` | 分组拖拽排序 |
| GET | `/api/iconlib` | 图标库索引状态 |
| GET | `/api/iconlib/search?q=` | 搜索图标 |
| POST | `/api/iconlib/apply` | 取用图标（下载到本地，不改服务） |
| POST | `/api/iconlib/refresh` | 强制重建索引 |
| POST | `/api/scan` | 扫描端口 |
| POST | `/api/scan/import` | 批量导入扫描结果 |
| POST | `/api/scan/ignore` | 忽略某端口 |
| POST | `/api/health` | 健康检查（可传 `ids` 只查部分）；配了外部地址就内外双探 |
| GET | `/api/network` | 网卡列表与 ZeroTier 检测结果 |
| POST | `/api/network/probe` | 预检某地址上各服务是否可达 |
| GET | `/api/docker/containers` | 容器列表（状态、端口、compose 项目、CPU/内存） |
| GET | `/api/docker/containers/:id` | 容器详情（inspect 全量） |
| GET | `/api/docker/containers/:id/logs?tail=` | 容器日志 |
| POST | `/api/docker/containers/:id/:action` | start / stop / restart / pause / unpause / kill |
| GET | `/api/docker/networks` | 网络列表（子网、网关、接入的容器） |
| POST/DELETE | `/api/site-icon` | 上传 / 清除站点图标（data URL） |
| GET/PUT | `/api/settings` | 设置（含站点名、外部地址、主题等） |
| GET | `/api/export` · POST `/api/import` | 数据备份与恢复 |
| GET | `/api/db` | 数据库与图标缓存信息 |
| GET | `/api/events` | SSE 实时事件流 |

## 配置

优先 `nav.config.json`（项目根目录，启动时自动创建默认值），环境变量可覆盖：

```json
{
  "db": "./data/nav.db",
  "port": 7788,
  "host": "0.0.0.0",
  "auth": ""
}
```

为什么不用环境变量做主配置：启动方式可能有多种（手动 `node server.js`、`start.sh`、LaunchAgent），
env 写在各自的启动脚本里很容易出现「手动跑用这个库、开机自启用那个库」。
配置文件放一处，各种方式都读它。环境变量仍然可以覆盖，适合临时调试。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `NAV_DB` | 数据库路径 |
| `NAV_DATA_DIR` | 数据目录（图标缓存与索引的父目录） |
| `NAV_PORT` | 监听端口（也可用第一个命令行参数） |
| `NAV_HOST` | 监听地址，设 `127.0.0.1` 则只限本机 |
| `NAV_AUTH` | 访问密码，格式 `用户名:密码`；留空则不鉴权 |

优先级：环境变量 > `nav.config.json` > 默认值。相对路径按项目根目录解析。

## 备注

- 默认监听所有网卡且不鉴权，同网段设备可直接访问。不放心就设 `NAV_AUTH`，或改成
  `NAV_HOST=127.0.0.1` 只限本机。
- 数据库用 Node 内置的 `node:sqlite`，需要 Node ≥ 22.5；无需任何 `npm install`。
- 图标缓存和索引在 `data/` 下，可再生的，丢了会自动重建；**备份只需拷数据库一个文件**，
  或用设置里的「导出 JSON」。
- 启动时会清理没有任何服务引用的图标缓存文件（站点图标和面板 favicon 除外）。
- 端口扫描与 Docker 模块仅支持 macOS / Linux（`lsof` / `docker` CLI）。
