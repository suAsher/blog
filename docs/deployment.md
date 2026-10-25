# 腾讯云 / 华为云通用部署指南

此指南使用 `YOUR_SERVER`（自己的 SSH Host 别名）、`YOUR_PUBLIC_IP` 和 `/srv/asher-knowledge` 示例目录。替换为自己的配置，不要把实例地址、密码、证书私钥或正式文档写进公开仓库。整个空间默认私有：页面、文章、图片和写作都需登录。

## 运行结构

```text
/srv/asher-knowledge/
  releases/RELEASE/         程序源码、dist/ 与静态 Compose
  current -> releases/RELEASE
  runtime.env              固定的静态运行镜像引用
  data/content/            正式文档与图片，独立持久化
  secrets/access.json      root 私有的访问记录
  gateway/
    compose.yaml
    compose.http.yaml
    compose.session.yaml
    runtime.env
    config/Caddyfile
    data/                  Caddy 证书和 ACME 账户
    private/session.json   只读密码验证器
    releases/RELEASE/auth-service
    auth-service -> releases/RELEASE/auth-service
```

Nginx 只绑定服务器 `127.0.0.1:8080`，提供静态外壳。Caddy 在公网提供 HTTPS。Go 服务只在 Docker 私有网络监听 `9090`，处理会话、文档、图片、导入和导出。正式数据不在 `dist/` 或静态示例目录中；日常写作和发布无需重建程序。

## 1. 准备构建

服务器需安装维护中的 Docker Engine 与 Compose。开发电脑需 Node.js 24 LTS（最低 22.23.4）、npm 和 Go 1.27.3；当前模块最低 Go 1.26。以下为 Linux amd64 构建，ARM64 服务器改为 `GOARCH=arm64`：

```bash
npm ci
npm run check
npm run test:coverage
npm run build
cd auth
GOTOOLCHAIN=go1.27.3 go test -race -cover ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=go1.27.3 go build -trimpath -ldflags='-s -w' -o auth-service .
```

将源码和 `dist/` 上传到新的 `releases/RELEASE/`，把二进制上传到 `gateway/releases/RELEASE/auth-service`。不上传依赖、测试报告、本机配置和密钥。服务器无需安装 Node.js 或 Go；小磁盘使用 [预构建静态配置](../compose.prebuilt.yaml)，避免现场构建依赖。

在服务器启动静态容器，先建立网关所需的 `asher-knowledge_default` 网络：

```bash
cd /srv/asher-knowledge/releases/RELEASE
docker compose -f compose.prebuilt.yaml config --quiet
docker compose -f compose.prebuilt.yaml up -d --no-build --wait
docker compose -f compose.prebuilt.yaml exec blog nginx -t
curl -I http://127.0.0.1:8080/
```

正式部署可通过 `BLOG_RUNTIME_IMAGE` 固定审核过的镜像 digest。选择维护中的镜像并保存旧版本用于回滚，不要在运行目录直接覆盖程序。

## 2. 初始化私有配置

以下在服务器的 root 交互终端（例如先执行 `sudo -i`）中执行。已有实例升级时保留原凭据、验证器、证书和内容，跳过初始化。

```bash
install -d -m 700 /srv/asher-knowledge/secrets
install -d -m 700 -o 101 -g 101 /srv/asher-knowledge/data/content
install -d -m 750 -o 0 -g 1000 /srv/asher-knowledge/gateway/config
install -d -m 700 -o 1000 -g 1000 /srv/asher-knowledge/gateway/data
install -d -m 700 /srv/asher-knowledge/gateway/private
```

用交互式输入创建访问记录；密码不会出现在命令参数或输出中。`HTTPS origin` 填 `https://YOUR_PUBLIC_IP`，不附加路径。输出文件存在时脚本拒绝覆盖：

```bash
python3 -c '
import getpass, json, os
from pathlib import Path
path = Path("/srv/asher-knowledge/secrets/access.json")
record = {"url": input("HTTPS origin: ").strip().rstrip("/"), "username": input("Username: ").strip(), "password": getpass.getpass("Password: ")}
if not record["username"] or len(record["password"]) < 12:
    raise SystemExit("Use a username and a strong password of at least 12 characters.")
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as output:
    json.dump(record, output)
    output.write("\n")
print("Private access record created.")
'
python3 /srv/asher-knowledge/releases/RELEASE/auth/provision.py \
  --credentials-file /srv/asher-knowledge/secrets/access.json \
  --output /srv/asher-knowledge/gateway/private/session.json
```

验证器为 root:101、`0440`，使用随机盐和 600000 次 PBKDF2-SHA256。服务只挂载验证器，不挂载明文访问记录。配置缺失或 HTTPS origin 非法时，服务拒绝启动。

复制 [基础网关 Compose](../deploy/compose.ip-https.yaml) 为 `gateway/compose.yaml`、[会话配置](../deploy/compose.session.yaml) 为 `gateway/compose.session.yaml`、[会话 Caddyfile](../deploy/Caddyfile.session.example) 为 `gateway/config/Caddyfile`。程序权限为 `0755`，`gateway/auth-service` 指向相应版本二进制。Caddyfile 可为 `0644`，配置目录保持 root:1000、`0750`。

`gateway/runtime.env` 仅在服务器保存，设置实际 `BLOG_IP`、`BLOG_GATEWAY_IMAGE` 和 `BLOG_RUNTIME_IMAGE`，镜像建议固定为审核后的 digest。不要把此文件提交仓库。

## 3. 选择 HTTP-01 证书入口

当前会话 Caddyfile 通过 HTTP-01 申请短期公网 IP 证书，公网 TCP 80 必须能到达验证处理器。只有有效验证 token 会被公开响应；其他 HTTP 请求返回 404，文章仍只通过认证后的 HTTPS 访问。

**80 端口空闲的新服务器**：在 `gateway/compose.http.yaml` 中仅增加网关端口：

```yaml
services:
  gateway:
    ports:
      - "0.0.0.0:80:8081"
```

**80 端口已有其他 Nginx 网站**：使用 [私有网桥端口叠加配置](../deploy/compose.ip-http.yaml)，设置 `BLOG_CHALLENGE_BIND` 为该代理所在 Docker 网络的私有网桥地址；不能填公网地址或 `0.0.0.0`。备份现有代理配置，仅在原 80 端口 server 内加入 [ACME 专用路由](../deploy/nginx-acme-location.example)，替换其网桥占位地址，`nginx -t` 通过后平滑重载。不要覆盖已有网站或把整个 HTTP 站点跳转到本博客。

两种方式均只开放必要的 TCP 80/443；SSH 端口限制来源。8080、9090 和已有代理方案的 18080 不对公网开放。公网 IP 证书使用 `shortlived` profile，需持久保留 `gateway/data/` 并持续运行 Caddy 自动续期。首次签发和跨周期续期应分别验收。

## 4. 启动并验收

始终加载同一套三份 Compose。先启动并等待 Go 服务健康，再验证网关和启动：

```bash
cd /srv/asher-knowledge/gateway
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml config --quiet
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml up -d --no-build --wait auth
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml run --rm --no-deps gateway caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml up -d --no-build gateway
docker compose --env-file runtime.env -f compose.yaml -f compose.http.yaml -f compose.session.yaml ps
```

文档服务使用 UID/GID 101、只读根文件系统、仅内容卷可写、`128m` 内存限制、0.5 核 CPU、`GOMEMLIMIT=96MiB`，请求头超时 5 秒、正文读写超时 180 秒。写入至少预留 64 MiB 空间；低容量 507，超限 413，不应跳过容量检查。

检查以下实际行为，TLS 验证不能用 `curl -k` 绕过：

- 首页匿名请求 302 到 `/login/`，登录页 200，不含原生 `WWW-Authenticate` 挑战。
- 匿名 `/api/documents` 返回 401；正确账号密码登录后可新建、保存、发布并搜索。
- 上传自行选择的测试 Markdown 和配图，发布后显示正确；草稿不进入阅读索引。
- 退出后旧会话失效，后退不恢复私有正文；书架和主题记录保留。
- 验证程序重建后文档和图片仍在。重启会清除内存会话，重新登录属于预期。

可对自己授权的目标运行端到端测试。凭据仅通过 SSH 读入进程内存，测试不导出密码或网络追踪：

```bash
BLOG_TEST_BASE_URL=https://YOUR_PUBLIC_IP BLOG_TEST_SSH_TARGET=YOUR_SERVER npm run test:e2e
```

## 更新、回滚与备份

日常文档编辑、导入和发布无需部署。程序更新上传到新版本目录；切换二进制符号链接后，用 `up -d --force-recreate --wait auth` 重建绑定挂载，仅 `restart` 不会更换旧 inode。静态容器也应从新版本目录重建并验收，再切换 `current`。

回滚保留的程序及配置时，保持同一个 `data/content/`，不要用旧数据覆盖已经更新的文章。确认旧程序兼容当前数据格式。不要自动清理旧版本、共享图片或其他网站的数据。

源码、服务端内容、私有配置和浏览器状态分开备份：正式内容及配图位于 `data/content/`，验证器和证书位于 `gateway/`，登录记录位于 `secrets/`，应单独加密保存。备份需短暂停写并保持一致性；恢复属主和权限后再启动。具体命令见 [内容备份与恢复](content-guide.md#备份与恢复)。实例实际运维记录应保存在部署者私有位置，不进入公开仓库。
