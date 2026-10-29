# asher · 知识空间

一个可以部署到腾讯云或华为云个人服务器的单所有者私有技术知识博客。Astro 7 + TypeScript 提供阅读与写作界面，Go 服务持久保存 Markdown 文档、配图和发布快照，负责会话与全文查询。支持站内写作、草稿保存和批量导入，无需数据库、API 密钥、付费服务或在线字体。

首页、列表与搜索默认展示你正式发布的内容；没有已发布文档时显示写作和导入入口。原有示例仅在明确选择「查看示例」后出现，均标注为**演示内容**，不代表作者真实经历。项目只接收你在页面里主动选择的文件，不扫描电脑中的其他文档。

生产构建可用 `BLOG_INCLUDE_EXAMPLES=0 npm run build` 关闭演示：示例正文路由、索引、入口和浏览器回退一起排除。Docker 构建使用 `BLOG_INCLUDE_EXAMPLES=0 docker compose build`；正式 Go 文档不受影响。默认值为 `1`，修改后需要重新构建。

## 本地启动

建议使用 Node.js 24 LTS 与 npm（最低 Node.js 22.23.4）。开发脚本适用于 Linux/macOS；Windows 可在 WSL 中运行。首次安装依赖需要访问 npm registry；构建完成后的阅读、搜索和收藏不依赖第三方服务。

```bash
npm ci
npm run dev
```

打开终端显示的地址，默认是 `http://127.0.0.1:4321/`。开发和预览服务均仅绑定本机。

```bash
npm run check
npm run test:coverage
npm run build
npm run preview
```

关闭示例的真实构建与浏览器回归可运行 `npm run test:examples`。它使用独立私有测试环境，验证示例路由/索引确实移除、查询参数不能重新启用，以及正式文档仍可发布阅读；结束后恢复调用前的构建开关（未指定时为 `1`）。不要与其他构建同时运行。

快捷键：`Ctrl/Cmd + K` 打开搜索，`Ctrl/Cmd + Alt + N` 打开随手记，`Esc` 关闭弹层，文章页 `F` 切换专注，`Tab/Shift+Tab` 遍历控件。随手记快捷键可改为 `Ctrl/Cmd + Shift + U` 或关闭；浏览器保留的 `Ctrl/Cmd + Shift + N` 不作为网页快捷键。

`dist/` 包含静态页面外壳、登录资源和示例文章。正式文档阅读、搜索、写作和导入由私有 Go API 提供数据，生产环境同时运行下方 Nginx、Caddy 与文档服务。Astro preview 仅用于本地界面检查。

`/login/` 是独立登录页，`/manage/` 是写作空间。本地 Astro 开发或预览不提供 `/auth/*`、`/api/*`；只有显式查看示例或本机 API 不存在时会使用示例回退。完整功能需运行私有网络中的文档与会话服务，构建、持久卷及测试见 [服务说明](auth/README.md)。本地 mock 截图不能代替真实服务验收。

## 功能和数据

[技术知识路线](docs/learning-paths.md)按「方向 → 章节 → 文章」组织系统学习，支持任意方向、分章目录、已有文档编排、阅读进度与上下节导航。文章仍使用 Markdown 和发布快照，路线结构保存在服务器；Go 入门资料明确标注为生成演示。

[阅读研究与导入整理](docs/research-workflows.md)增加真实上传预检、默认跳过重复内容、逐文件更新决策、可重开的导入报告；文档历史可比较与恢复工作稿，重新发布前核对线上差异。正式文章支持带出处的段落批注及摘录成笔记。「专题」可保存阅读路径、问题清单、已发布文章对照与连接画布，草稿和线上快照继续隔离。

[生成的工程研究资料](examples/research/README.md)可直接通过文件夹上传：4 篇 Markdown、1 篇 TXT、2 张配图。全部显式标注为演示，未读取本机真实文档；本地真实上传/写作截图可通过 `node scripts/showcase-research.mjs` 复现。

首页新增[每日入口与随手记](docs/daily-workflow.md)：真实写作热力图、连续记录、旧文回顾、往年今日、最近编辑与待完成草稿。随手记复用文档存储和发布流程；全局 `Ctrl/Cmd + Alt + N` 打开，`Ctrl/Cmd + Enter` 保存。文章支持可选系列、成长状态和关联文档，发布生命周期保持独立。

[知识连接](docs/knowledge-links.md)支持 `[[标题]]`、`[[标题|别名]]`、稳定 ID 补全、关联文档和反向链接。`/graph/` 用本地 Canvas 与独立 Worker 展示已发布关系；仅该页面加载布局引擎，支持搜索、键盘、缩放拖动与静态布局。代码中的双括号保持原文，未发布的标题和关系不会提前进入正式阅读。

[离线阅读与跨设备同步](docs/offline-and-sync.md)把两类数据严格分开：收藏、已读、进度和回顾计划采用本地缓存、待同步队列及服务器字段版本；私有正文只有在用户明确选择后，才以独立口令加密保存已发布快照。Service Worker 只缓存无正文的离线外壳，不缓存登录、API、私有文章 HTML 或搜索索引。

本轮体验升级增加了[内容实验室与交互 Markdown](docs/interactive-content.md)：本地按需绘制的流程图、可切换系列的数据图表、提示块、图片放大和阅读排版设置。编辑器可快捷插入内容块、粘贴/拖入图片、专注写作；命令搜索支持快捷操作、键盘选择和安全命中高亮。首页与卡片使用克制的星轨、光晕和入场，遵循减少动画偏好。服务端增加16MiB预算的派生搜索缓存，保留既有存储格式和发布快照隔离。

视觉增强采用 OGL 绘制首页主视觉；设备能力、节省流量和减少动画偏好决定是否按需加载 GSAP/ScrollTrigger 与 Lenis，隐藏、离屏或失败时会暂停/降级，阅读和写作仍使用原生滚动。跨文档效果使用浏览器原生 View Transitions 渐进增强，而不接管导航为 ClientRouter，保持无脚本、失败降级、认证重定向与浏览器历史行为可预测。

- 站内 Markdown 编辑、自动保存草稿、对照预览、发布/撤回与发布快照隔离。
- 批量导入 Markdown、TXT 与配套图片，保留目录关系；Markdown 和含配图 ZIP 导出。
- 首页、文章列表、文章详情、服务端全文搜索、标签筛选与真实空状态。
- 文档垃圾箱、恢复、永久删除和并发编辑版本冲突提示。
- 文章目录、代码高亮与复制、阅读进度、继续阅读、专注模式。
- 收藏与已读状态、深浅主题、移动与平板布局、键盘操作及减少动画偏好。
- 标签和可选分类从 Markdown 元数据汇总；没有预置技术领域分类。
- 自定义登录页、密码显示切换、登录错误反馈、保持登录与退出；公网入口使用服务端会话保护内容。

浏览器记录按**协议 + 域名 + 端口**隔离；登录并联网后，收藏、已读、进度与回顾计划会同步到同一空间的服务器，离线变更在恢复连接后补传。冲突不会按设备时间静默覆盖，而是要求选择服务器值或重新应用本机值；不支持 Web Locks API 的浏览器安全降级为仅本机模式并显示警告。主题仍只保存在浏览器。

「我的书架」仍可导出或导入 v1 JSON 作为迁移与应急备份。结构为 `{ version: 1, exportedAt, entries }`，可选包含回顾计划，但不含文章/离线正文、图片、密码、会话或同步队列。正式文档使用稳定随机 ID 关联记录；修改标题不会改变文档地址。完整边界见[离线与同步说明](docs/offline-and-sync.md)。

## 写作、导入与发布

登录后打开导航中的「写作」，或访问 `/manage/`。选择「新建文档」，填写标题并编辑 Markdown；等待「所有修改已保存」后可切换预览。保存的是工作稿，点击「发布文档」才进入首页、列表、全文搜索和正式阅读页。已发布文档再次编辑时，原发布快照继续用于阅读，直到重新发布。**日常写作与导入不需要重新构建或部署 Astro。**

本机已有文档可通过「导入文档」选择文件或文件夹。配图建议与 Markdown 一起选择文件夹，保留 `docs/note.md` → `../images/chart.png` 这样的相对关系；导入结果会报告跳过项和未匹配图片，默认存为草稿，检查后再发布。

支持 UTF-8 的 `.md`、`.markdown`、`.txt`，以及 PNG、JPEG、GIF、WebP；不接受 SVG、Word、PDF、压缩包或可执行文件。每批最多 32 MiB、500 个文件，单篇正文 2 MiB、单张图片 8 MiB；接近批量上限时应分批并留出上传封装余量。服务器还会保留至少 64 MiB 空闲容量，空间不足时返回明确提示，不应把小磁盘视为无限文档库。

正式内容保存在服务器 `/srv/asher-knowledge/data/content/`，独立于程序版本和 `dist/`。每篇记录包含 Markdown 原文、元数据、工作稿和最近发布快照，图片按内容哈希保存；服务端阅读状态位于同目录的 `state/reading.json`，无需数据库。浏览器本地缓存、待同步队列、主题、未保存备份和加密离线副本都不能代替服务端内容备份。

详细工作流、Markdown 元数据、相对配图、冲突处理、垃圾箱及私有备份见 [文档使用与备份指南](docs/content-guide.md)。`src/content/articles/` 现用于维护明确标注的静态示例；只有修改界面、程序或示例时才运行 `npm run build` 更新部署。

## 完整本地验收

完整端到端测试需要 Go 1.26、OpenSSL 和 Playwright/Chrome。先构建，再运行 `npm run test:e2e`：默认启动仅绑定回环地址的临时 HTTPS 环境，使用真实 Go 认证和内容服务、随机测试账号及独立临时数据。自签名证书的 SPKI 仅用于固定本次临时测试证书，不放宽普通网络请求的 TLS 校验；结束后清理进程、凭据和数据，不使用 SSH 或访问生产服务器。

仅检查静态页面时可显式设置 `BLOG_TEST_STATIC_ONLY=1`；此模式会跳过真实认证/内容用例，不能代替完整验收。明确设置 `BLOG_TEST_BASE_URL` 才会使用指定预览或部署地址。测试服务不会复用已有端口，避免误把 SSH 转发或旧预览当作当前代码。

## 腾讯云 / 华为云部署

支持腾讯云轻量应用服务器 Lighthouse、CVM，以及华为云 ECS 等可运行 Docker 的 Linux 主机。以下以 Ubuntu 24.04 LTS 为例；基础 `compose.yaml` 只启动回环绑定的静态 Nginx，不是一键完整私有服务。正式写作、同步和离线版本校验还需按[部署指南](docs/deployment.md)运行 Caddy 与 Go 服务。

1. 根据 [Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)安装 Docker Engine 与 Compose 插件，并确认 `docker version`、`docker compose version` 可用。使用维护中的 Docker 版本；本机端口绑定在 Docker 28 以前存在同二层网络访问的历史限制，详见 [Docker 端口发布文档](https://docs.docker.com/engine/network/port-publishing/)。
2. 把本项目源文件上传到服务器，例如 `/srv/asher-knowledge`。保留 `package-lock.json`，不上传 `node_modules/`、本机密钥或环境文件。
3. 进入项目目录并启动：

```bash
cd /srv/asher-knowledge
docker compose config
docker compose up -d --build
docker compose ps
curl -I http://127.0.0.1:8080/
```

容器应显示 `healthy`，首页应返回 HTTP 200。默认端口映射为 `127.0.0.1:8080:8080`，外部无法通过普通公网端口映射直接访问。应用容器以非 root 身份运行，根文件系统只读，仅 `/tmp` 使用临时内存文件系统；日志限制大小并自动轮转。

```bash
docker compose logs --tail=100 blog
docker compose exec blog nginx -t
curl -I http://127.0.0.1:8080/this-page-does-not-exist/
```

最后一个请求应返回 HTTP 404，并可在浏览器看到友好的不存在页面。

### 小磁盘服务器：本地构建后上传

当服务器磁盘或内存紧张时，使用独立的 `compose.prebuilt.yaml`，无需在服务器安装 Node.js 或构建依赖：

```bash
# 在开发电脑上
npm ci
npm run check
npm run build
# 上传 dist/、deploy/nginx.conf 和 compose.prebuilt.yaml 到同一服务器目录

# 在服务器的该目录中
docker compose -f compose.prebuilt.yaml config
docker compose -f compose.prebuilt.yaml pull
docker compose -f compose.prebuilt.yaml up -d --no-build --wait
```

此配置使用官方 Nginx 精简镜像，以 UID 101 读取只读挂载的静态文件；限制内存 96 MB、CPU 0.5 核、进程 64 个，日志最多约 6 MB。内容目录需允许容器用户读取（目录 `0755`、文件 `0644`）。可以通过 `BLOG_RUNTIME_IMAGE` 指定审核过的镜像摘要，实现精确回滚；`--env-file` 也可加载仅包含镜像摘要的配置文件。

更新时先上传到新的版本目录，再从该目录使用相同 Compose 项目名 `-p asher-knowledge` 启动，并检查健康状态。保留前一个版本目录，回滚时从前一个目录执行相同命令并加 `--force-recreate`。不要同时启动两套 Compose 配置；它们使用相同项目名和本机端口。若用 `current` 符号链接切换版本，也需重建容器以重新绑定内容目录。

### 静态页面诊断：SSH 隧道

隧道直连 Nginx 可检查页面外壳和静态示例，不提供完整的登录、写作或内容 API。完整私有博客仍需下方 HTTPS 网关。在自己的电脑运行，替换示例中的服务器登录名和地址：

```bash
ssh -N -L 127.0.0.1:8080:127.0.0.1:8080 your-user@your-server
```

保持 SSH 连接，打开 `http://127.0.0.1:8080/` 检查静态资源。传输经过 SSH 加密；正式文档功能通过 Caddy 路由访问。

### 公网 IP 访问：HTTPS + 认证

不配置域名也可使用 `https://服务器公网IP/`。默认方案为正式 IP 证书、自定义登录页和服务端 Cookie 会话；未登录访问文章会跳转至 `/login/`，登录成功后回到原路径。通用目录、初始化和运维步骤见 [部署指南](docs/deployment.md)。首次部署时由空间所有者设置账号和密码；升级已有实例时保留原凭据。访问记录由服务器上的 root 私有文件保存，可在自己的终端查看：

```bash
ssh YOUR_SERVER 'cat /srv/asher-knowledge/secrets/access.json'
```

不要把该文件放入代码仓库或普通源码归档。若 HTTP 80 端口已有其他网站，保留其服务，只增加证书验证专用路由。访问博客请明确使用 **HTTPS**。

独立 IP 网关使用 [基础 Compose](deploy/compose.ip-https.yaml)、[会话服务叠加配置](deploy/compose.session.yaml)和 [会话版 Caddy 配置](deploy/Caddyfile.session.example)，加入博客的 `asher-knowledge_default` 网络，只公开 TCP `443:8443`。会话服务的 `9090` 端口仅供 Docker 网络内的网关访问，不发布到宿主机。显式配置 Let's Encrypt `shortlived` profile，为公网 IP 申请约 160 小时的证书；Caddy 持续运行并持久化 `/data` 以自动续期。首次签发、外部信任校验和跨周期续期需在目标环境验证。相关机制见 [Let's Encrypt IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)与 [Caddy TLS 配置](https://caddyserver.com/docs/caddyfile/directives/tls#issuers)。

准备网关时，将基础 Compose 复制为 `/srv/asher-knowledge/gateway/compose.yaml`，会话配置复制为 `compose.session.yaml`，会话版 Caddy 配置复制为 `config/Caddyfile`。`runtime.env` 设置 `BLOG_IP`、固定摘要的 `BLOG_GATEWAY_IMAGE` 与 `BLOG_RUNTIME_IMAGE`。Go 程序在开发电脑编译，服务器复用现有精简运行镜像；在服务器就地运行 `auth/provision.py`，将既有密码转换为 `gateway/private/session.json` 中的 PBKDF2-SHA256 验证器，文件为 root:101、`0440`。程序只挂载验证器，不读取明文凭据文件；还需创建 UID/GID `101:101`、`0700` 的 `/srv/asher-knowledge/data/content/`，以可写持久卷挂载到 `/data/content`。具体步骤见 [文档与会话服务部署](auth/README.md)。Caddy 配置目录使用 root:1000、`0750`；`data/` 归 UID/GID `1000:1000`、权限 `0700`，普通 Caddyfile 可用 `0644`。

会话 Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax` 和 `__Host-` 前缀。普通会话在浏览器关闭后结束，服务端最长 12 小时；选择保持登录时最长 7 天。退出会先锁定并清理本机加密离线库和同步协议元数据，再确认服务端令牌撤销；书架 v1 记录和主题保留。认证服务重启或更新后需重新登录；会话令牌不写入 localStorage，也不持久化到数据库。

会话版 Caddy 配置使用 HTTP-01。已有 80 端口反向代理时，搭配 [HTTP 端口叠加配置](deploy/compose.ip-http.yaml)和 [Nginx 验证路径片段](deploy/nginx-acme-location.example)。先备份现有 Nginx 配置，只在 80 端口站点中增加 `/.well-known/acme-challenge/` 路由，并在 `nginx -t` 成功后平滑重载。`BLOG_CHALLENGE_BIND` 必须填写该 Nginx 容器所在 Docker 网络的私有网桥地址，**不得使用 `0.0.0.0` 或公网地址**。网关 HTTP 端口只处理证书验证，其他路径返回 404。

实际 HTTP-01 网关运行命令：

```bash
cd /srv/asher-knowledge/gateway
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml config --quiet
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml up -d --no-build --wait auth
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml exec gateway caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml restart gateway
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml logs --tail=100 gateway auth
```

HTTP-01 续期依赖现有 Nginx 的验证路由、Docker 私有网桥地址与 Caddy 持续可用。旧网站升级或网络重建时需保留并复查该路由；不要把整个旧网站改成博客的 HTTP 跳转。公网不开放 `8080` 或 `18080`。独立网关配置与域名宿主机 Caddy 方案不可同时争用 443。

### 兼容方案：域名 + HTTPS + Basic Auth

以下保留原生 Basic Auth 方案供兼容和回滚，会出现浏览器认证弹窗。自定义登录页使用上方会话方案；迁移为域名时还需同步修改会话验证器中的 HTTPS origin。

项目提供 `deploy/Caddyfile.example`、`deploy/caddy.env.example` 和 systemd 配置示例。**Caddy 安装在宿主机**，将 HTTPS 请求转发到本机 `127.0.0.1:8080`。基本认证覆盖整站，包括文章、搜索索引和静态资源；仅在前端隐藏内容无法保护私有文章。

1. 准备自己控制的域名，将 A 记录指向服务器公网地址；只在服务器实际配置 IPv6 时添加 AAAA 记录。按照 [Caddy 官方安装文档](https://caddyserver.com/docs/install)安装带 systemd 服务的 Caddy。
2. 生成密码哈希。下列命令会交互式询问密码，不把明文写入命令行：

```bash
caddy hash-password
```

3. 在服务器项目目录复制示例，并编辑 `/etc/caddy/blog.env`：将 `BLOG_DOMAIN` 改为真实域名、`BLOG_USER` 改为登录名、`BLOG_PASSWORD_HASH` 改为上一步的完整哈希。保留哈希外层单引号。示例值无法直接用于登录。

```bash
sudo install -m 600 deploy/caddy.env.example /etc/caddy/blog.env
sudoedit /etc/caddy/blog.env
```

4. 若服务器尚无其他 Caddy 网站，将示例复制为主配置；已有网站时，将示例中的站点块合并到现有文件，避免覆盖其他站点。

```bash
sudo install -m 644 deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo mkdir -p /etc/systemd/system/caddy.service.d
sudo install -m 644 deploy/caddy.service.override.conf /etc/systemd/system/caddy.service.d/blog.conf
```

5. 加载同一份环境变量验证配置，再启动服务。以下验证命令只加载你刚填写的服务端环境文件：

```bash
sudo bash -c 'set -a; source /etc/caddy/blog.env; set +a; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl restart caddy
sudo systemctl status caddy --no-pager
```

Caddy 使用域名自动申请、更新 TLS 证书，并将 HTTP 重定向到 HTTPS；常规配置需要外部能访问 TCP 80/443，以及服务器能访问证书签发服务。详见 [自动 HTTPS](https://caddyserver.com/docs/automatic-https)。认证只应通过 HTTPS 使用，配置里放密码哈希而非明文，详见 [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)。

验证真实域名时，未认证请求必须得到 401，包含搜索索引在内：

```bash
curl -I https://knowledge.example.com/
curl -I https://knowledge.example.com/search-index.json
curl -u asher -I https://knowledge.example.com/
```

把 `knowledge.example.com` 和 `asher` 替换为配置值。最后一条会提示输入密码，成功后返回 200。更新普通 Caddyfile 配置后运行 `sudo systemctl reload caddy`；修改环境文件后运行 `sudo systemctl restart caddy`，让服务读取新变量。排查证书或认证问题可用 `sudo journalctl -u caddy --no-pager -n 100`。

### 云控制台入站规则

| 端口 | SSH 隧道访问 | 域名 HTTPS 访问 | 公网 IP HTTPS 访问 |
| --- | --- | --- | --- |
| TCP 22（或实际 SSH 端口） | 仅允许自己的来源 IP | 仅允许自己的来源 IP | 仅允许自己的来源 IP |
| TCP 80 | 不需要开放 | 给宿主机 Caddy 开放 | HTTP-01 需要现有代理可达；TLS-ALPN 不需要 |
| TCP 443 | 不需要开放 | 给宿主机 Caddy 开放 | 给独立 Caddy 网关开放 |
| TCP 8080 / 9090 / 18080 | 不开放 | 不开放 | 不开放 |

腾讯云 Lighthouse 在实例「防火墙」管理入站规则；CVM 使用安全组。华为云 ECS 在关联安全组中配置入方向。已有默认规则也要检查，不能只添加新规则而保留“全部放通”。具体入口参考 [腾讯云轻量防火墙](https://cloud.tencent.com/document/product/1207/44577)、[腾讯云 CVM 安全组](https://cloud.tencent.com/document/product/213/112614/)、[华为云 ECS 安全组](https://support.huaweicloud.com/usermanual-ecs/zh-cn_topic_0030878383.html)。操作系统防火墙同样需要匹配；Docker 的端口发布行为不能只依赖 UFW 规则约束。

如果选择中国大陆地域并通过域名对外提供网站访问，应在启用域名访问前确认云厂商的 ICP 备案 / 接入要求，不能把登录认证视为备案替代。地域和接入细节以 [腾讯云备案说明](https://cloud.tencent.com/document/product/243/73180)及 [华为云备案说明](https://support.huaweicloud.com/icp_faq/icp_05_0145.html)为准。

## 程序更新、回滚与备份

上传修改后的源文件，然后在服务器项目目录运行：

```bash
docker image tag asher-knowledge:local asher-knowledge:previous
docker compose build --pull
docker compose up -d --no-build
docker compose ps
```

第一次部署无需执行旧镜像标记命令；有旧镜像时先打标签，便于更新失败后回滚。构建使用锁文件确定 npm 依赖版本；基础镜像使用维护中的版本标签，正式运维可固定审核过的镜像 digest，再定期升级验证。

回滚到保留的镜像：

```bash
docker image tag asher-knowledge:previous asher-knowledge:local
docker compose up -d --no-build --force-recreate
```

备份分四部分：

1. **程序源代码**：备份项目源码、`public/`、部署配置、`package-lock.json`、`auth/go.mod` 与 `auth/go.sum`。`src/content/articles/` 是静态示例，正式内容不在这里；依赖、`dist/`、缓存和报告可重建。普通源码归档排除 `data/`、网关私有配置和凭据。
2. **服务端正式内容与状态**：单独加密备份整个 `/srv/asher-knowledge/data/content/`，包含文档 JSON、Markdown 原文/发布快照、配图、活动和 `state/reading.json`。程序回滚时保持此目录，不要用旧数据覆盖新文章。应在短暂停止唯一写入进程的维护窗口创建一致备份，方法见 [内容备份指南](docs/content-guide.md#备份与恢复)。
3. **浏览器记录**：定期在「我的书架」导出 JSON，保留尚未同步或仅本机的记录。服务器备份不包含主题、未保存编辑和加密离线副本；恢复时可通过「导入记录」合并。
4. **部署私有配置**：单独加密备份，不放入代码仓库或普通源码归档。此次 IP 网关需备份 `/srv/asher-knowledge/gateway/`（含配置、`private/session.json` 验证器、认证程序版本、`data/` 内的证书与 ACME 账户）以及 `/srv/asher-knowledge/secrets/`；恢复后保持原有所有者和权限，并复查现有 Nginx 的 ACME 路由。内存会话无需备份，恢复后重新登录。域名宿主机兼容方案备份 `/etc/caddy/` 与证书数据目录；官方 systemd 服务通常使用 `/var/lib/caddy/.local/share/caddy`，详见 [Caddy 服务运行说明](https://caddyserver.com/docs/running)。

例如在项目目录外创建源码归档：

```bash
tar --exclude=node_modules --exclude=dist --exclude=.astro --exclude=coverage --exclude=playwright-report --exclude=test-results --exclude=.playwright-cli --exclude=.git --exclude=.aws --exclude=.agents --exclude=.codex --exclude=.codegraph --exclude=docs/deployments --exclude=docs/plans --exclude=auth/auth-service --exclude='.env*' --exclude=runtime.env --exclude=gateway --exclude=secrets --exclude=data -czf asher-knowledge-source.tar.gz -C /srv asher-knowledge
```

归档目标不要放进正在归档的项目目录。恢复程序时按部署记录恢复 Nginx、文档服务和网关，再挂载单独恢复的正式内容；`docker compose up -d --build` 只恢复静态容器，不等于恢复完整博客。服务端没有会话数据库，但 `data/content/` 必须保留。

## 验证与项目结构

检查命令、真实运行范围和环境限制见 [验证记录](docs/qa/verification.md)。正式文档版包含持久化、导入、快照与写作流程；本地 mock 界面检查不代表真实后端通过。部署与恢复步骤见 [部署指南](docs/deployment.md)。

```bash
npm run check
npm run test:coverage
npm run build
npx playwright install chromium
npm run test:e2e
```

验收已部署的 HTTPS 实例时，可显式指定目标和 SSH 别名：

```bash
BLOG_TEST_BASE_URL=https://YOUR_PUBLIC_IP BLOG_TEST_SSH_TARGET=YOUR_SERVER npm run test:e2e
```

该部署模式必须显式同时提供 HTTPS origin 与 SSH 目标；它不启动本地服务器，只通过 SSH 将 `/srv/asher-knowledge/secrets/access.json` 读入测试进程内存，校验 origin 后建立 Cookie 会话。不会导出密码文件，并关闭 trace、视频与 HTML 报告。默认 `npm run test:e2e` 不使用此模式。内容测试只创建和清理自身随机 QA 文档，不操作用户已有文档。

macOS 已安装 Google Chrome 时测试会自动复用；其他环境默认使用 Playwright Chromium，也可通过 `PLAYWRIGHT_CHANNEL` 指定浏览器通道。首次安装 Playwright 浏览器需要网络；Linux 上可能还需 `npx playwright install --with-deps chromium`。端到端测试是 Chromium 的桌面、手机和平板三种视口，不等同于三种浏览器，更不等同于真实 Safari/iOS 设备认证。覆盖率门槛覆盖核心逻辑，不声称代表全部 UI 代码。

此前记录的 162 项公网浏览器验收属于旧版本历史基线，不能代表本轮 PWA、同步与回流改动已经通过。最新本地门禁、覆盖率、截图、Lighthouse/LCP 数据、跳过项和环境限制以[验证记录](docs/qa/verification.md)及[性能记录](docs/qa/performance.md)为准；目标值在重新测量并写入记录前不算成绩。公开仓库只保留通用配置，不记录实例地址、真实凭据、内容数据或私有运维信息。

```text
src/content/articles/    明确标注的静态示例
src/content.config.ts   内容元数据校验
src/pages/              阅读、写作、登录页面外壳与示例路由
src/components/         页面组件
src/lib/                搜索、存储与内容辅助逻辑
public/images/          本地原创示例封面
public/login-assets/    公开登录页的独立样式和交互
auth/                   Go 文档/会话服务、Markdown 渲染与验证器工具
auth/content/           持久化、快照、搜索、上传与导出
docs/content-guide.md   日常写作、导入和私有内容备份
docs/offline-and-sync.md 加密离线、阅读同步与设备清理边界
tests/                  单元与浏览器测试
deploy/                 Nginx、Caddy 与服务配置
Dockerfile              静态构建及非 root 运行镜像
compose.yaml            仅绑定本机的容器服务
```
