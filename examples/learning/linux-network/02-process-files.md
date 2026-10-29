---
title: "演示 · 进程与文件描述符：名字背后还有一次打开"
description: "用一个临时文件观察打开、读取位置与关闭之间的关系。"
date: 2026-10-29
tags: ["生成演示", "Linux 与网络"]
series: "Linux 与网络 · 从终端到连接证据（演示）"
---

> **生成演示内容**：用于展示分章学习与技术写作，不代表作者真实经历。请在独立练习环境验证，示例数字不是真实系统测量。

## 同一个文件，两次打开

进程是正在执行的程序实例。它除了代码，还有自己的运行状态和打开资源。下面把同一个临时文件打开两次，观察两个读取位置怎样分别变化。练习只读取自己刚写入的内容，不访问系统配置或其他人的日志。

```python
from pathlib import Path
from tempfile import TemporaryDirectory
import os

with TemporaryDirectory(prefix="learning-fd-") as directory:
    path = Path(directory) / "events.txt"
    path.write_text("alpha\nbeta\n", encoding="utf-8")
    with path.open(encoding="utf-8") as first, path.open(encoding="utf-8") as second:
        print(first.readline().strip())
        print(first.readline().strip())
        print(second.readline().strip())
        print(first.fileno() != second.fileno())
        print(os.getpid() > 0)
```

输出为 `alpha`、`beta`、`alpha`、`True`、`True`。两次独立打开获得不同描述符；本例中的读取位置也独立。不要把这个结果扩展成“每个描述符都一定有独立偏移”：复制描述符等操作可能共享底层打开状态。区分名称、描述符与打开状态，是后面理解重定向的重要基础。

## 为什么关闭是程序行为的一部分

描述符是进程持有资源的句柄，不是文件名。即使你不再需要 Python 对象，资源也应在确定的位置释放；`with` 在正常退出和异常退出时都会关闭对应文件。长期运行的服务若不断打开文件却不关闭，最终可能耗尽描述符，新的连接或日志打开操作就会失败。此时反复重启能暂时清空现场，却不能解释资源为何增长。

Linux 中可以通过 `/proc/<pid>/fd` 观察某个进程的描述符链接，但它受权限、命名空间和进程生命周期影响。在容器里看见的 PID 也不一定等于宿主机 PID。本篇的可运行例子不依赖 `/proc`，因此可以先在本机练习；Linux 观察步骤应该只针对自己的练习进程，并避免输出真实敏感路径。

## 验证与下一步

将第二次打开改成在第一次读取结束后才进行，确认文件内容不会因此自动改变。再故意在 `with` 结束后读取，捕获 `ValueError`，给错误写一句解释：句柄已经关闭，而不是文件凭空消失。后续学习标准输入、输出与错误流时，把重定向理解为进程资源的连接，就不必死记符号。

## 沿着这条路线继续

[[演示 · 地址、名称与端口：先把连接目标说完整]]
