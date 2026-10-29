---
title: "演示 · 性能 04｜让日志可以沿着一个请求读下去"
description: "用结构化事件串起阶段、结果与关联标识。"
date: 2026-10-29
tags: ["生成演示", "性能与可观测性"]
series: "性能与可观测性 · 从数字到证据（演示）"
---

> **生成演示内容**：以下场景与数字均为教学构造，不代表作者经历、线上实测或生产实现。代码只使用 Python 标准库，可在独立练习目录运行。
## 一行报错，需要能找到上下文

一次请求经历接收、读取和返回三个阶段。如果日志只有三句相似文字，在并发请求中很难确认哪些属于同一次操作。稳定的关联标识让事件可以被分组，阶段名和结果字段让程序能够统计。标识的作用是帮助连接证据，它不应包含密码、正文、访问令牌或用户的敏感输入。

以下事件列表由程序直接构造，不读取系统日志。它把两个请求混合排列，再选出一个请求的完整链条。时间使用相对于该请求起点的示例毫秒值；真实跨机器时间可能存在偏差，不能凭日志打印时间就断言全局先后。需要同时保存事件语义和时钟范围。

```python
events = [
    {'request_id': 'demo-a', 'stage': 'accepted', 'elapsed_ms': 0},
    {'request_id': 'demo-b', 'stage': 'accepted', 'elapsed_ms': 0},
    {'request_id': 'demo-a', 'stage': 'loaded', 'elapsed_ms': 8},
    {'request_id': 'demo-a', 'stage': 'returned', 'elapsed_ms': 12, 'status': 200},
]
selected = [event for event in events if event['request_id'] == 'demo-a']
assert [event['stage'] for event in selected] == ['accepted', 'loaded', 'returned']
assert selected[-1]['elapsed_ms'] == 12
assert all('password' not in event and 'body' not in event for event in events)
print('demo-a: accepted -> loaded -> returned')
```

练习给事件增加一个受控的失败原因分类，再按结果统计数量。不要把任意异常全文当作指标标签：大量不同文本会使标签组合快速膨胀，也容易泄漏私有信息。需要保留原始细节时，应使用受权限保护、有限大小和明确保留期限的日志。

## 三种信号各有职责

指标擅长描述整体变化，日志擅长保留离散事件，调用链可以表达一次请求跨组件的关系；只有 request_id 的列表还不是完整的分布式追踪实现。本例没有传播上下文、采样或跨线程关联，也没有接入任何遥测服务。排障时应先问现有信号能够回答什么，再补缺失的阶段，不必为了一个小练习安装整套平台。最有价值的字段通常是下一次复现时仍能稳定核对的字段。

## 接着读

[[演示 · 性能 05｜比较优化前后，先固定问题]]
