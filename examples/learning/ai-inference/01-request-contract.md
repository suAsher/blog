---
title: "演示 · 推理 01｜先写清请求，再讨论模型快慢"
description: "区分文本、token、输出约束与请求标识，建立可验证的输入契约。"
date: 2026-10-29
tags: ["生成演示", "AI 推理基础设施"]
series: "AI 推理基础设施 · 从请求到可验证的服务（演示）"
---

> **生成演示内容**：本篇为学习路线示例，不代表作者真实经历或真实模型测量。所有数字为构造值，代码仅使用 Python 标准库。

## 先把请求写成能检查的数据

下面这条请求不需要模型，也不会发送到网络。它先回答四个问题：输入是什么、允许生成多少内容、如何追踪这次调用、失败时由谁负责处理。基础设施的第一份文档可以从这里开始，而不是直接堆一组启动参数。把代码保存到独立的练习目录，用 Python 运行。

```python
request = {
    "request_id": "demo-request-001",
    "prompt": "解释什么是排队",
    "max_new_tokens": 32,
    "timeout_ms": 2000,
}
def validate(value):
    if not isinstance(value["prompt"], str) or not value["prompt"].strip():
        raise ValueError("prompt must be non-empty text")
    if type(value["max_new_tokens"]) is not int or not 1 <= value["max_new_tokens"] <= 128:
        raise ValueError("output budget out of range")
    if type(value["timeout_ms"]) is not int or value["timeout_ms"] <= 0:
        raise ValueError("timeout must be positive")
    return value
assert validate(request)["max_new_tokens"] == 32
print("contract accepted")

```

应输出 `contract accepted`。这里限制的是输出预算，不是实际生成长度；模型可能更早停止。请求标识用于串联日志，不应承载密码、完整输入或用户隐私。示例只检查选定字段，真实接口还需要检查整体字节数、未知字段、身份与配额。

## token 不是字数

模型通常先将输入转换为 token 标识，再进行数值计算。一个汉字不保证对应一个 token；同一句话在不同分词器、聊天模板和特殊标记下，长度也可能不同。不能用字符串长度冒充生产计费或显存依据。离线练习可以先记录字符数，但字段应诚实命名，避免把它写成真实 token 数。

## 从用户限制推到服务限制

超时预算是调用方愿意等待的时间，不代表服务器一定会在到期瞬间停止计算。断开连接、取消任务与释放资源是三个需要验证的动作。接口边界要说明取消是否传播、是否排除已完成结果、是否允许重试。没有这些约定，重试可能增加负载，却没有提高用户得到正确结果的机会。

把输出预算改为零，观察异常；再把布尔值放进输出预算，确认它不会被误当作整数接受。最后补一个输入字节数上限，并为中文文本写断言，理解字符数和 UTF-8 字节数为什么不是同一个单位。

本节不连接任何模型，也没有测量推理性能。读完应留下自己的请求样例与校验规则；下一节再把输入契约和数值计算的形状连接起来。


## 接着读

[[演示 · 推理 02｜用形状和单位读懂张量预算]]
