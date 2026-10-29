---
title: "演示 · 地址、名称与端口：先把连接目标说完整"
description: "分开理解名字解析、IP 地址和监听端口，不把所有连接失败都叫网络故障。"
date: 2026-10-29
tags: ["生成演示", "Linux 与网络"]
series: "Linux 与网络 · 从终端到连接证据（演示）"
---

> **生成演示内容**：用于展示分章学习与技术写作，不代表作者真实经历。请在独立练习环境验证，示例数字不是真实系统测量。

## 一个服务地址至少包含几件事

`http://127.0.0.1:8080/health` 中，协议约定如何交谈，地址标识网络目标，端口定位传输层端点，路径才交给应用路由。它们属于不同层次。能解析名称不代表能连接端口；能连接端口也不代表应用会给你预期的页面。

```python
from urllib.parse import urlsplit
import ipaddress
import socket

url = urlsplit("http://127.0.0.1:8080/health")
address = ipaddress.ip_address(url.hostname)
print(url.scheme, url.port, url.path)
print(address.is_loopback)
resolved = socket.getaddrinfo(
    "127.0.0.1", 8080,
    family=socket.AF_INET,
    type=socket.SOCK_STREAM,
    flags=socket.AI_NUMERICHOST,
)
print(resolved[0][4])
```

输出包含 `http 8080 /health`、`True` 和 `('127.0.0.1', 8080)`。本例显式使用数字地址和 `AI_NUMERICHOST`，不会查询外部 DNS，也不会尝试连接任何端口。它只验证地址表达与接口返回结构，不证明有服务在运行。

## 名称解析与连接要分别记录

DNS 将名称映射到记录，但应用实际使用的解析机制也可能包含本机 hosts 文件、缓存或其他配置。排查时先记下请求的原始名称，再记录解析得到的地址，最后记录连接目标。只保留最后一行“访问失败”，会把三类问题压成一个无法验证的猜测。IPv4 与 IPv6 也应分别看待：`127.0.0.1` 与 `::1` 都是回环地址，但只监听其中一种不意味着另一种必然可达。

## 一个不访问公网的小练习

把地址替换成 `::1`，用 `ipaddress` 验证它的版本与回环属性；再解析没有显式端口的 URL，观察 `urlsplit().port` 返回 `None`。解析器没有替你创建连接，也不会因此自动填好应用层的默认配置。要求读者把“输入是什么”和“客户端最终采用什么”分开写清楚。

## 连接成功仍然不是业务成功

端口属于地址、协议等条件共同确定的端点，不能孤立当成一台机器上唯一的服务编号。容器内的回环地址指向容器自身的网络命名空间，不能按宿主机的视角套用。本篇只建立术语和验证顺序；防火墙、路由、TLS 与代理属于后续层次，需要各自拿证据确认。

## 沿着这条路线继续

[[演示 · 让 HTTP 在本机走一趟：请求、状态与响应体]]
