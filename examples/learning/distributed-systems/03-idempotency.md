---
title: "演示 · 分布式 03｜幂等键必须绑定请求内容"
description: "识别同一请求的重试，并拒绝同键不同参数。"
date: 2026-10-29
tags: ["生成演示", "分布式系统"]
series: "分布式系统 · 从状态到失败恢复（演示）"
---

> **生成演示内容**：以下场景与数字均为教学构造，不代表作者经历、线上实测或生产实现。代码只使用 Python 标准库，可在独立练习目录运行。
## 再点一次，究竟是不是同一件事

任务提交超时以后，客户端重发相同请求。一个稳定的幂等键可以让服务端识别它是同一件事，但键本身不是魔法。如果客户端误把同一个键用于不同任务，静默返回第一次结果会掩盖错误。必须同时检查操作内容，并明确键的作用域、保存时限及调用者身份。

这个小模型保存请求的规范化表示和结果。相同键、相同内容返回旧结果；相同键、不同内容报错。排序后的 JSON 只是这里的演示指纹，真实接口还要决定数值、空值、默认字段及版本变化如何参与比较。不要把任意字典直接转换为字符串后当作跨语言协议。

```python
import json

receipts = {}
created = []

def create(key, payload):
    fingerprint = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    if key in receipts:
        old_fingerprint, result = receipts[key]
        if old_fingerprint != fingerprint:
            raise ValueError('key reused for different content')
        return result
    result = f'task-{len(created) + 1}'
    created.append(dict(payload))
    receipts[key] = (fingerprint, result)
    return result

assert create('request-a', {'name': 'demo'}) == 'task-1'
assert create('request-a', {'name': 'demo'}) == 'task-1'
assert len(created) == 1
try:
    create('request-a', {'name': 'other'})
except ValueError:
    pass
else:
    raise AssertionError('content mismatch accepted')
print('one effect, two matching calls')
```

运行输出 `one effect, two matching calls`。练习给键增加用户维度，验证两个不同用户的相同字符串不会共享结果；再讨论收据过期以后重试是否还允许。回答这些问题，比直接给接口贴上“支持幂等”标签更有用。

## 提交与收据需要一起考虑

内存字典只适用于这段单线程练习，进程退出就会丢失收据。如果真实系统先写业务结果、后写收据，在两步之间崩溃仍可能重复执行；并发请求也可能同时通过检查。生产实现需要与实际持久化机制一起设计原子边界和恢复流程。本例没有提供跨进程锁或事务，也不宣称任何一次执行语义。它验证的是重试识别规则与同键内容冲突，不能替代端到端故障演练。

## 接着读

[[演示 · 分布式 04｜消息到达顺序与业务顺序]]
