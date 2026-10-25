# 私有文档与会话服务

Astro 构建阅读、写作与登录页面外壳；本服务持久保存正式 Markdown 文档、配图、工作稿和发布快照，提供全文查询、上传、导出及会话。Caddy 保护页面，所有 `/api/*` 请求还在 Go 内再次验证会话，写操作验证精确 HTTPS Origin。整个空间保持私有。

服务没有数据库或付费 API。认证使用 Go 标准库；内容渲染使用 Goldmark 1.8.6，YAML 元数据使用 `go.yaml.in/yaml/v3` 3.0.5，WebP 校验使用 `golang.org/x/image` 0.47.0。依赖版本和校验值保存在 `go.mod`、`go.sum`。生产程序在开发电脑交叉编译，服务器复用已有精简镜像，在 Docker 私有网络内监听 `9090`，不发布宿主机端口。

日常使用见 [文档指南](../docs/content-guide.md)，通用部署与运维见 [部署指南](../docs/deployment.md)。

## 本地验证与构建

使用 Go 1.27.3；当前依赖使 `go.mod` 最低要求 Go 1.26。首次指定工具链或安装模块可能需要网络。

```bash
cd auth
GOTOOLCHAIN=go1.27.3 go test -race -cover ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=go1.27.3 go build -trimpath -ldflags='-s -w' -o auth-service .
```

ARM64 服务器将 `GOARCH` 改为 `arm64`。生成的 `auth-service` 不提交源码仓库。Astro 的 `npm run dev` / `npm run preview` 仅提供静态界面，没有 `/auth/*` 或 `/api/*`；完整认证、写作与真实内容阅读需要下面的容器堆栈。单元/集成测试会创建自己的临时数据，本地 mock 界面检查不能替代真实后端验收。

## 首次部署或从登录版升级

以下以 `/srv/asher-knowledge` 为示例部署目录。静态界面、Go 程序、Caddy 配置应来自同一代码版本；先准备持久目录与私有服务，验证健康后再切换网关。

1. 将新界面构建上传到新的 `releases/<版本>/`，使用 `compose.prebuilt.yaml` 更新静态博客容器。将交叉编译的程序上传到 `gateway/releases/<版本>/auth-service`，设置 `0755`，让 `gateway/auth-service` 符号链接指向它。不要覆盖运行中正在绑定挂载的二进制。
2. 将 `deploy/compose.session.yaml` 复制为 `/srv/asher-knowledge/gateway/compose.session.yaml`。网关的 root 私有 `runtime.env` 保留 `BLOG_IP`、固定摘要的 `BLOG_GATEWAY_IMAGE` 与 `BLOG_RUNTIME_IMAGE`。
3. 在服务器创建正式内容目录。以下命令只创建目录并设置其顶层所有者，不清空现有数据；已有目录升级时先确认路径，避免误改其他服务：

```bash
install -d -m 700 -o 101 -g 101 /srv/asher-knowledge/data/content
```

Compose 将 `../data/content` 可写挂载为 `/data/content`；其余根文件系统仍只读。这个目录独立于程序版本、`dist/` 和会话文件。容器缺少持久卷或无写权限时应修正部署，不能通过关闭只读根文件系统来掩盖问题。

4. 仅首次接入时，在服务器就地从既有凭据生成验证器；从旧登录版升级时保留现有验证器和密码：

```bash
python3 /srv/asher-knowledge/current/auth/provision.py \
  --credentials-file /srv/asher-knowledge/secrets/access.json \
  --output /srv/asher-knowledge/gateway/private/session.json
```

`access.json` 仅 root 可读，包含 `url`、`username`、`password`；`url` 必须是实际 HTTPS origin。工具不会打印密码或导出到本机，已有输出时拒绝覆盖。验证器使用随机 32 字节盐、600000 次 PBKDF2-SHA256；root 执行时文件为 root:101、`0440`，父目录为 root、`0700`。容器仅只读挂载该验证器为 `/run/auth/config.json`，不挂载明文凭据。

5. 备份当前 Caddyfile，将 `deploy/Caddyfile.session.example` 放进网关配置目录，先以待切换文件名验证，再替换 `config/Caddyfile`。保留已有证书 `gateway/data/` 和原 Nginx 的 HTTP-01 专用路由。始终同时加载三份 Compose：

```bash
cd /srv/asher-knowledge/gateway
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml config --quiet
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml up -d --no-build --pull never --wait auth
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml exec gateway caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml restart gateway
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml ps
```

若替换了验证器绑定源、程序链接或 Compose 设置，使用 `up -d --force-recreate --wait auth` 重建服务，而不是仅 `restart`。首次接入前后检查匿名页面跳转登录、匿名 API 返回 401、登录后可创建草稿并重新读取；不要使用 `curl -k` 跳过证书验证。

## 运行边界

服务使用 UID/GID `101:101`、只读根文件系统、移除全部 capabilities、128 MB 内存、0.5 核 CPU、`GOMEMLIMIT=96MiB`、`GOMAXPROCS=1` 及大小受限日志。只允许内容持久卷写入。

| 设置 | 默认值与用途 |
| --- | --- |
| `AUTH_CONFIG` | `/run/auth/config.json`，受保护的密码验证器 |
| `AUTH_LISTEN` | `:9090`，仅 Docker 私有网络，不发布宿主机端口 |
| `AUTH_DATA_DIR` | `/data/content`，文档和图片持久卷 |
| HTTP 超时 | 请求头 5 秒；正文读写 180 秒；空闲连接 30 秒 |
| 内容 API 限速 | 每来源 IP 每分钟最多 600 次，保护搜索、预览及写入 |

慢网络上传仍受 32 MiB 请求、文件数与单文件限制，不因读写超时增加而取消大小边界。服务器必须有足够空闲空间；低容量返回 507，超限上传返回 413。写入保留至少 64 MiB，并对在途上传预留容量；临时导入目录成功或失败后清理，启动时清理本服务自己遗留的导入暂存。

## 文档与发布模型

`data/content/documents/` 中每篇独立 JSON 保存 Markdown 原文、元数据、版本号、工作稿和最近一次发布快照；采用原子替换与 fsync。`assets/` 按内容哈希去重保存图片，`tmp/` 仅用于受限上传暂存。

保存草稿不会改变正式阅读内容。发布将当前工作稿保存为发布快照，首页、列表和搜索读取快照；继续修改只改变工作稿，重新发布后才更新阅读。版本号用于乐观锁，冲突返回 409，不能用陈旧标签页静默覆盖新内容。垃圾箱是软删除，恢复为草稿；永久删除仅允许对垃圾箱文档操作。

Markdown 使用 Goldmark/GFM 渲染，不启用不安全原始 HTML，也不由服务器抓取外部图片。配图导入按所选根目录中的相对路径匹配，缺图会报告；目录上传不会以别的目录同名图片静默替代。只有完全平铺选择且文件名唯一时，系统可报告按文件名匹配的警告。SVG 不接受；支持 PNG、JPEG、GIF、WebP 并校验格式与尺寸。

上传默认草稿；标准 Markdown 导出包含 YAML 元数据，ZIP 可携带配图与可解析的目录结构。正式数据不放进普通源码归档；用户操作见 [使用与备份指南](../docs/content-guide.md)。

## 会话与权限

- 32 字节随机会话令牌只在 Cookie 和服务端内存间使用；服务端只保存其 SHA-256，最多 256 个会话。
- `__Host-asher_session` 使用 Secure、HttpOnly、SameSite=Lax、Path=/，不设置 Domain；令牌不写 localStorage、URL 或日志。
- 普通 Cookie 随浏览器会话结束，服务端最长 12 小时；保持登录最长 7 天。浏览器会话恢复功能可能恢复会话 Cookie，但服务端期限仍生效。
- 退出撤销令牌、清除 Cookie，并发送 `Clear-Site-Data: "cache"`；保留收藏、阅读进度和主题的 localStorage。
- 文档与 API 响应不缓存。页面匿名访问跳转 `/login/`，API 匿名访问返回 401 JSON；不发送 `WWW-Authenticate`。
- 服务重启、重建或升级后内存会话失效，需重新登录。正式文档与图片在独立持久卷内保留，不随会话失效。

登录/退出 POST 和内容写操作必须来自配置的精确 HTTPS Origin；登录只接收限长 JSON。账号或密码错误使用相同提示，同一来源 5 次错误尝试后限制 5 分钟，并限制 4 个并发密码派生。私有代理传递来源 IP，服务不直接暴露公网。

## API 与网关

| 路径 | 用途 |
| --- | --- |
| `POST /auth/login` | 登录并设置会话 Cookie |
| `GET /auth/session` | 查询当前会话；不缓存 |
| `GET /auth/verify` | 供网关检查；有效 204，否则 302 到登录 |
| `POST /auth/logout` | 撤销当前会话与缓存 |
| `GET /healthz` | 容器内部健康检查，不作为公网 API |
| `/api/documents`、`/api/documents/{id}` | 列表、全文查询、工作稿与发布快照、乐观锁更新 |
| `/api/documents/{id}/publish` 等 | 发布、撤回、垃圾箱、恢复与永久删除 |
| `POST /api/preview` | 与正式阅读一致的安全 Markdown 预览 |
| `POST /api/import`、`POST /api/assets` | 文档/目录导入与单独图片上传 |
| `GET /api/assets/{hash}.{ext}` | 登录后的私有图片读取 |
| `GET /api/documents/{id}/export` | Markdown；`?format=zip` 包含配图 |

内容 JSON 使用 `{ok:true,data:...}` 包装，失败为 `{ok:false,message,code?}`。创建文档返回 201，版本冲突 409，容量不足 507。内容发布与导入行为见 [文档指南](../docs/content-guide.md)，部署边界见 [部署指南](../docs/deployment.md)。

Caddy 只精确公开 `/login`、`/login/`、两个登录资源和 favicon；其他页面经 `forward_auth`。`/api/*` 送到本服务，由 Go 对每个请求再次鉴权。真实文章 `/articles/{32hex}/` 在鉴权后重写到阅读外壳 `/reader/`。不可公开整个登录资源目录或绕过 API 内部权限检查。

## 更新、轮换与回滚

日常编辑、上传和发布无需构建程序。只有界面或 Go 程序改变时，才构建新的静态版本和程序版本。切换 `gateway/auth-service` 符号链接后重建绑定挂载：

```bash
cd /srv/asher-knowledge/gateway
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml up -d --no-build --pull never --force-recreate --wait auth
```

仅改链接后 `restart` 不足以替换绑定文件。程序回滚可切回兼容旧版本并重建，但始终保留 `data/content/`；不要把旧备份覆盖到新文章上。发布格式变更前应备份，并确认旧程序能读取当前数据。回滚导致会话登出属于预期。

密码或 HTTPS origin 变更时，先在服务器维护 root 私有 `secrets/access.json`，用 `provision.py` 输出新验证器文件，确认权限后切换挂载并强制重建 `auth`。保留旧验证器便于回滚；明文不进入命令参数、源码或报告。旧 Basic Auth 示例仅作兼容和紧急回滚。

## 备份、恢复和验收

正式内容、部署私有配置与源码分开备份。必须另行加密保管 `data/content/`、`gateway/`（包括验证器、证书、程序与配置）及 `secrets/`。一致备份应在短暂停止写入的维护窗口进行，尽量从服务器流向自己的备份介质，避免挤占小磁盘；详细命令见 [备份与恢复](../docs/content-guide.md#备份与恢复)。

恢复后保持内容目录 UID/GID `101:101`、`0700`，验证器 root:101、`0440`，Caddy 数据 UID/GID `1000:1000`、`0700`；先恢复目录与配置，再启动服务。内存会话无需备份，重新登录即可。

在项目根目录运行真实公网验收：

```bash
BLOG_TEST_BASE_URL=https://YOUR_PUBLIC_IP BLOG_TEST_SSH_TARGET=YOUR_SERVER npm run test:e2e
```

仅显式指定 SSH 目标时，fixture 才将现有凭据读入进程内存，在校验 HTTPS origin 后建立 Cookie 会话；部署测试关闭 trace、视频和 HTML 报告。内容测试只创建并清理自身随机 QA 文档，不能清理用户已有数据。当前文档功能的最终测试数量、覆盖率和公网结果以 [验证记录](../docs/qa/verification.md)为准，不把本地 mock 当作真实服务验收。
