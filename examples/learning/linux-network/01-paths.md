---
title: "演示 · 从终端路径开始，建立一个可丢弃的练习目录"
description: "区分当前目录、相对路径和绝对路径，避免命令作用在错误的位置。"
date: 2026-10-29
tags: ["生成演示", "Linux 与网络"]
series: "Linux 与网络 · 从终端到连接证据（演示）"
---

> **生成演示内容**：用于展示分章学习与技术写作，不代表作者真实经历。请在独立练习环境验证，示例数字不是真实系统测量。

## 先做一个可以放心修改的目录

下面的程序只在系统临时目录中创建自己的文件，退出上下文后自动清理。先运行，再观察打印的三行；不要先把真实工作目录拿来练习。终端中的命令通常有一个当前工作目录，相对路径由这个位置解释，而不是由你脑中正在看的编辑器文件决定。

```python
from pathlib import Path
from tempfile import TemporaryDirectory

with TemporaryDirectory(prefix="learning-path-") as directory:
    workspace = Path(directory)
    notes = workspace / "notes"
    notes.mkdir()
    document = notes / "first.txt"
    document.write_text("hello learning\n", encoding="utf-8")
    print(document.relative_to(workspace))
    print(document.is_absolute())
    print(document.read_text(encoding="utf-8").strip())
```

输出依次为 `notes/first.txt`、`True`、`hello learning`。临时目录本身每次不同，不应该写成固定路径用于后续脚本。文件名是名称，目录组织名称之间的关系；绝对路径从文件系统根开始，相对路径则需要一个参照点。第一次学习时，把参照点明确写在纸上，能避免许多看似神秘的“文件不存在”。

## 再把它对应到终端

在自己创建的练习目录中，`pwd` 表示当前的位置，`ls` 列出目录项，`cd notes` 改变当前目录。`cd` 是 shell 内建操作：一个普通子进程不能替父 shell 改掉当前位置。路径中包含空格时，应使用引号把整个路径作为一个参数；引号不是路径内容的一部分。不要把网上复制的命令直接粘到存有生产配置的目录中。

## 做一次有意的修改

把 `first.txt` 改为 `first note.txt`，检查相对路径仍然保留空格；再把 `notes` 换成两层目录，观察 `mkdir()` 为什么失败，随后用 `parents=True` 明确允许创建父目录。这里不需要删除命令，也不需要提升权限。理解错误的含义比通过提高权限“让它运行”更有价值。

## 路径并不等于权限

路径正确并不保证能够读写：用户身份、目录权限和挂载选项都会影响结果。`exists()` 也不能作为授权检查，它与后面的打开操作之间还可能发生变化。本节只建立路径心智模型，不涵盖符号链接、容器挂载与权限隔离；进入这些主题后，需要分别验证可见位置和实际访问边界。

## 沿着这条路线继续

[[演示 · 进程与文件描述符：名字背后还有一次打开]]

## 编程起点

还没有编程基础时，也可以从 [[演示 · Go 01｜把 Go 工具链准备好]] 开始，再回来理解程序怎样运行在系统之上。
