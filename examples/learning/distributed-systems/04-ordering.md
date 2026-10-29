---
title: "演示 · 分布式 04｜消息到达顺序与业务顺序"
description: "用带序号的事件理解乱序、重复和缺口。"
date: 2026-10-29
tags: ["生成演示", "分布式系统"]
series: "分布式系统 · 从状态到失败恢复（演示）"
---

> **生成演示内容**：以下场景与数字均为教学构造，不代表作者经历、线上实测或生产实现。代码只使用 Python 标准库，可在独立练习目录运行。
## 第二条先到了，不要急着覆盖

假设任务状态依次经历等待、运行、完成。订阅方先收到序号二的运行事件，再收到序号一的等待事件，如果只按到达顺序更新页面，状态就会倒退。消息系统中的到达顺序、发送顺序和业务提交顺序可能不同，讨论“有序”之前要说明是哪个实体、哪个范围、哪一种顺序。

以下模型只处理一个任务，序号从一开始连续递增。乱序事件先放进缓冲区，只有补齐缺口才能向前应用；已经应用的重复事件被忽略。为了保持例子短小，事件内容只用状态文字表示。真实应用如果发现同序号不同内容，应报警并拒绝，而不能把它当作正常重复。

```python
pending = {}
applied = []
next_sequence = 1

def receive(sequence, value):
    global next_sequence
    if sequence < next_sequence:
        return
    if sequence in pending and pending[sequence] != value:
        raise ValueError('conflicting event')
    pending[sequence] = value
    while next_sequence in pending:
        applied.append(pending.pop(next_sequence))
        next_sequence += 1

receive(2, 'running')
assert applied == []
receive(1, 'waiting')
receive(2, 'running')
receive(3, 'finished')
assert applied == ['waiting', 'running', 'finished']
print(' -> '.join(applied))
```

预期输出 `waiting -> running -> finished`。练习让第一条事件永远不来，观察 pending 不能继续清空。此时需要的是缺口恢复策略，例如重新读取快照或从已确认位置补取，而不是无限占用内存等下去。还要限制缓冲事件数量、最大缺口和等待时间。

## 顺序范围越大，协调成本越高

为单个任务编号不意味着所有任务之间也有全局顺序。跨任务事务、多个写入者和序号持久化都不在模型内，已处理事件的历史冲突也没有长期存储。实际设计通常先识别业务实体，再决定哪些操作必须顺序执行、哪些可以并行。不要为了页面展示方便强行建立全局递增队列；也不要把同一分区内的约定扩展成整个系统的保证。

## 接着读

[[演示 · 分布式 05｜用版本号识别陈旧读取]]
