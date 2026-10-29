---
title: "演示 · 性能 06｜写一份不抢跑结论的排障记录"
description: "把现象、假设、证据和下一步分开保存。"
date: 2026-10-29
tags: ["生成演示", "性能与可观测性"]
series: "性能与可观测性 · 从数字到证据（演示）"
---

> **生成演示内容**：以下场景与数字均为教学构造，不代表作者经历、线上实测或生产实现。代码只使用 Python 标准库，可在独立练习目录运行。
## 接口慢了，先不要把 CPU 当作答案

看到延迟升高后，直接写“CPU 不够”很容易让排查停在第一个猜测。相同现象也可能来自队列增长、下游等待、锁竞争或输入变大。排障记录应把观察与解释分开：观察是某个窗口的具体信号，假设是可能产生它的机制，下一步则应能区分至少两种假设。

下面用构造的阶段计时练习核对一次请求。总时间二百毫秒，其中等待一百二十、执行五十、返回三十。程序只指出等待占比更高，并明确剩余问题未知；它没有根据一条样本自动诊断根因。计时阶段必须互斥且覆盖完整范围，否则简单相加可能重复计算嵌套阶段。

```python
sample = {'queue_ms': 120, 'execute_ms': 50, 'return_ms': 30}
total_ms = sum(sample.values())
assert total_ms == 200
assert sample['queue_ms'] / total_ms == 0.6
record = {
    'observation': 'queue accounts for 60% of this constructed sample',
    'hypotheses': ['arrival burst', 'reduced service capacity'],
    'next_check': 'compare arrival count, queue depth and completed count',
    'root_cause': None,
}
assert record['root_cause'] is None
assert len(record['hypotheses']) == 2
print('waiting dominates; cause not yet established')
```

预期输出 `waiting dominates; cause not yet established`。练习新增第二份执行时间占比更高的样本，比较下一步检查会如何变化。再写一条反证：如果到达数没有变化而完成数下降，哪种解释更值得调查；如果任务大小同时增加，又该补充什么信号。

## 给下一次复查留下入口

记录中应包含时间范围、影响范围、已确认事实、仍缺的证据和下一步负责人或动作，不要把敏感请求内容直接复制进文章。缓解措施与根因修复也要分开，临时限流可能改善等待，却不说明瓶颈已经消失。本节没有连接真实服务，没有定位任何真实故障，也不提供自动诊断规则。它希望培养的是能被同事或未来自己接着验证的笔记：该知道时有证据，不知道时明确保留未知。

## 接着读

[[演示 · 性能 01｜先写单位，再谈快慢]]

## 跨方向继续探索

如果想把这一节的概念放到另一种场景里，可以接着读 [[演示 · 推理 01｜先写清请求，再讨论模型快慢]]。这是一条可选的阅读连接，不是必须按顺序完成的课程。
