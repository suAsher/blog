---
title: "演示 · 推理 04｜只估算 KV 载荷，不冒充整机容量"
description: "明确层数、KV 头、头维度和精度，给显存计算写上假设。"
date: 2026-10-29
tags: ["生成演示", "AI 推理基础设施"]
series: "AI 推理基础设施 · 从请求到可验证的服务（演示）"
---

> **生成演示内容**：本篇为学习路线示例，不代表作者真实经历或真实模型测量。所有数字为构造值，代码仅使用 Python 标准库。

## 写公式之前，先声明假设

本例假设每层都保存相同长度的键和值，不使用滑动窗口，不考虑缓存量化、分片、分页对齐或前缀共享。构造一个只有四层、两个 KV 头、每头八个数值的小模型，保存十六个位置，每个数值按两个字节计。下面的运算只估算 KV 数据载荷，不会创建实际模型。

```python
def kv_payload_bytes(layers, kv_heads, head_dimension, positions, bytes_per_value):
    values = (layers, kv_heads, head_dimension, positions, bytes_per_value)
    if any(type(value) is not int or value <= 0 for value in values):
        raise ValueError("positive integer assumptions required")
    return 2 * layers * kv_heads * head_dimension * positions * bytes_per_value

payload = kv_payload_bytes(4, 2, 8, 16, 2)
assert payload == 4096
print(f"KV payload only: {payload} bytes")

```

运行应输出四千零九十六字节。开头的二代表 K 和 V 两部分，不代表两份模型。KV 头数量需要读取模型配置，不能总拿查询头数量代替；对不同注意力结构做估计前，先确认公式是否适用。

## 把缺失的账目列出来

权重、激活、中间工作区、运行时缓冲、分配器开销和保留空间都不在这个结果中。设备总显存减去纸面权重，再除以本例载荷，也不能直接得到安全并发数。实际缓存分配可能按块取整，序列长度不同，已释放空间也未必立刻表现为可用的连续空间。

[Transformers 缓存策略说明](https://huggingface.co/docs/transformers/v5.15.0/kv_cache)介绍了不同策略的内存取舍，并提醒滑动窗口等结构下缓存增长会受到限制。本例刻意使用更窄的统一长度假设；偏离该假设时，应替换模型，而不是把原公式当成所有架构的通用答案。

## 把预算写成范围与验证任务

先记录配置来源，再写位置数量是否包含已有输入与新生成的预算。多个请求的载荷可在各自假设成立时相加，但共享、分片与块管理必须另记。接着在真实引擎中逐步增加负载，核对分配与拒绝行为；这里只提出验证任务，不宣称已经执行设备实验。

练习把位置数量翻倍，验证结果也翻倍；随后把 KV 头数量减半，观察载荷变化。再用零和布尔值调用函数，确认错误输入会被拒绝。最后为公式写一段限制说明，让未来的自己知道哪些成本没有被算入。

这份小预算的价值在于让假设可审查。它不推荐硬件型号，不估算真实模型的最大吞吐，也没有把缓存载荷包装成生产容量结论。


## 接着读

[[演示 · 推理 05｜先定义事件，再计算首响与间隔]]
