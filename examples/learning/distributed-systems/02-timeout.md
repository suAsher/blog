---
title: "演示 · 分布式 02｜超时为什么不等于失败"
description: "用三种结果区分未提交、已提交和暂时不知道。"
date: 2026-10-29
tags: ["生成演示", "分布式系统"]
series: "分布式系统 · 从状态到失败恢复（演示）"
---

> **生成演示内容**：以下场景与数字均为教学构造，不代表作者经历、线上实测或生产实现。代码只使用 Python 标准库，可在独立练习目录运行。
## 请求完成了，响应却没有回来

你提交一次创建任务的请求，页面转了几秒后报超时。此时至少有三种可能：请求根本没有到达服务端；服务端正在处理；服务端已经保存任务，只是响应丢了。客户端观察到的是等待结束，并没有观察到服务端的提交记录。把超时直接翻译成“没有创建成功”，会让下一次点击变成重复任务。

下面不使用网络和真实等待，而把服务端提交与客户端收到响应拆成两个开关。这样可以稳定复现最容易被忽略的情况。三态结果里的 unknown 不是程序偷懒，而是承认当前证据不足；遇到这种结果，应查询原请求标识对应的状态，或者执行有明确去重约定的重试。

```python
def observe(committed, response_received):
    if not response_received:
        return 'unknown'
    return 'accepted' if committed else 'rejected'

assert observe(True, False) == 'unknown'
assert observe(False, False) == 'unknown'
assert observe(True, True) == 'accepted'
assert observe(False, True) == 'rejected'
print('unknown means insufficient evidence')
```

预期输出 `unknown means insufficient evidence`。把四组输入画成一个小表，单独写出“客户端知道什么”和“服务端发生什么”。你会发现，响应缺失时，即使练习程序的作者知道 committed 的值，客户端仍然没有获得这个事实。观察视角与真实状态必须分开描述。

## 给恢复留一个入口

练习设计一个任务创建接口：请求携带稳定标识，查询接口能返回该标识的处理状态；按钮超时后保留标识，而不是每次刷新生成新的。另一个有用约定是设置总等待预算，并区分排队超时、执行超时和响应超时。取消等待也不必然撤销已提交动作，真正的撤销通常是另一条有权限、可审计的业务命令。本例只说明信息边界，没有模拟网络栈、事务隔离或取消协议。

## 接着读

[[演示 · 分布式 03｜幂等键必须绑定请求内容]]
