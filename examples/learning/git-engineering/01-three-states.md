---
title: "演示 · Git 01｜一次修改经过哪三个位置"
description: "用三个差异视图解释保存文件与提交快照的区别。"
date: 2026-10-29
tags: ["生成演示", "Git 与工程协作"]
series: "Git 与工程协作 · 从改动到可信交付（演示）"
---

> **生成演示内容**：本篇用于展示分章学习，不代表作者经历或生产实测。所有操作只针对你新建的练习目录；不要在真实业务仓库或服务器照抄。

## 先制造一个能解释的差异

在终端执行下面的独立练习。`mktemp` 创建专用目录；身份只写到这个新仓库的局部配置，不修改全局账号。第一次提交建立观察基线，随后把一行加入暂存区，再写入另一行。

```bash
sandbox=$(mktemp -d)
cd "$sandbox"
git init -q
git config user.name 'Learning Example'
git config user.email 'learning@example.invalid'
printf 'baseline\n' > note.txt
git add note.txt
git commit -qm 'add baseline'
printf 'staged\n' >> note.txt
git add note.txt
printf 'working\n' >> note.txt
git diff -- note.txt
git diff --cached -- note.txt
git diff HEAD -- note.txt
```

比较新增行时，第一个视图只有 `working`，第二个只有 `staged`，第三个同时包含两行；上下文仍会显示周围的原有文字。文件已经保存到磁盘，只说明工作区发生变化；`git add` 决定下一份快照要接收哪些内容。暂存区不是等待上传的网络队列，提交也不是把整个电脑自动备份。

## 把比较对象说完整

“这次没有差异”不是充分结论，必须补上比较的两端。默认差异比较工作区与暂存区，带暂存选项则比较暂存区与当前提交。对排查问题很有用的一句话是：文件正在磁盘上变动，但下一次提交准备收录什么？两个答案可以不同，恰恰是分批提交的基础。

一个常见误操作是在检查过文件后继续修改，却直接提交已经暂存的旧内容。练习里的第三行可以让这个问题变得可见。提交前再看一遍暂存差异，确认代码、测试和说明围绕同一个意图；没有必要为了凑一次提交把互不关联的实验塞进去。

## 自己核对

运行 `git status --short`，观察同一文件为何可能同时具有两种修改状态。接着执行一次普通提交，确认提交里包含 `staged`，而 `working` 仍留在工作区。为两个视图各写一句解释，比记住字母缩写更能帮助以后评审。

本节没有配置远端，也没有推送。请保留练习目录供后续使用；如果路径指向真实项目，应停止练习并重新创建沙箱。命令的完整比较语义见 [Git diff 官方说明](https://git-scm.com/docs/git-diff)。

## 沿着这条线继续

下一篇可读：[[演示 · Git 02｜让提交成为可以复查的单位]]。把本节留下的验证证据也记进自己的文档，再对照下一节的边界。
