---
title: "演示 · 让 HTTP 在本机走一趟：请求、状态与响应体"
description: "用仅绑定回环的临时服务观察一次真实 HTTP 请求。"
date: 2026-10-29
tags: ["生成演示", "Linux 与网络"]
series: "Linux 与网络 · 从终端到连接证据（演示）"
---

> **生成演示内容**：用于展示分章学习与技术写作，不代表作者真实经历。请在独立练习环境验证，示例数字不是真实系统测量。

## 先看到一次完整往返

这段独立 Python 程序创建一个只监听 `127.0.0.1` 的临时服务，操作系统分配空闲端口。客户端访问它后，服务立即在确定的位置关闭。它不需要公网、不开放所有网卡，也不读取电脑里的文档；服务端只返回写在代码里的固定 JSON。

```python
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from urllib.request import urlopen
import json

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"ready":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

with HTTPServer(("127.0.0.1", 0), Handler) as server:
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        with urlopen(f"http://127.0.0.1:{server.server_port}/health", timeout=2) as response:
            print(response.status)
            print(json.load(response)["ready"])
    finally:
        server.shutdown()
        thread.join()
```

输出为 `200` 与 `True`。这说明本次连接、HTTP 解析和 JSON 读取都完成了；它不能证明服务在高负载时也满足延迟目标。`Content-Type` 描述正文如何解释，`Content-Length` 描述正文的字节数，状态码则表达服务器对请求的处理结果，三者不能互相替代。

## 状态码是一份约定

把状态改成 `503` 再运行，观察 `urlopen` 抛出 `HTTPError`，并用显式异常分支处理它。这里的连接并没有“断网”，而是客户端已经收到应用返回的错误状态。不要把所有异常简单转换成空字典，那会让错误状态看起来像一个内容为空的成功响应。

## 把边界留在练习记录里

示例没有鉴权、TLS、请求体上限或并发治理，只适合回环演示。`BaseHTTPRequestHandler` 不应被包装成可直接公开部署的生产网关。两秒超时也只是本次客户端的设置，不是整个服务的可靠性承诺。后续为真正的博客接口写验收时，应分别断言状态、媒体类型、字段与权限；本例刻意只演示一条最小往返链路。

## 把服务地址留在程序里

端口填零让操作系统为这次练习分配可用端点，实际地址从 `server.server_port` 读取。不要先挑一个看似空闲的固定端口，再假设它在真正监听时仍然空闲；检查与使用之间存在时间差。这里也显式等待线程结束，避免主程序退出后留下不确定的后台工作。若客户端读取抛出异常，`finally` 仍会关闭服务，这正是把资源清理与业务成功分开的原因。

## 沿着这条路线继续

[[演示 · 超时与重试：先限制总预算，再决定是否再试]]
