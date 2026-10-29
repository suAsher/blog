---
title: "演示 · 推理 06｜用预算准入和退出路径保护服务"
description: "在小型纯函数模拟中检查接收、拒绝与释放，不把队列当无限缓冲。"
date: 2026-10-29
tags: ["生成演示", "AI 推理基础设施"]
series: "AI 推理基础设施 · 从请求到可验证的服务（演示）"
---

> **生成演示内容**：本篇为学习路线示例，不代表作者真实经历或真实模型测量。所有数字为构造值，代码仅使用 Python 标准库。

## 先做一个不会透支预算的入口

给模拟服务设定一千个缓存预算单位。已有请求占用六百，新请求分别申请三百和五百。我们的目标不是让所有请求都排进去，而是在接受前确认预算，并在退出时把占用归还。单位是人为定义的练习量，不是实际 token 或 GPU 显存。

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class Budget:
    capacity: int
    used: int = 0

def admit(state, cost):
    if type(cost) is not int or cost <= 0:
        raise ValueError("positive cost required")
    if cost > state.capacity - state.used:
        return state, False
    return Budget(state.capacity, state.used + cost), True

state = Budget(1000, 600)
accepted, ok = admit(state, 300)
assert ok and accepted.used == 900 and state.used == 600
rejected, ok = admit(accepted, 500)
assert not ok and rejected == accepted
released = Budget(accepted.capacity, accepted.used - 300)
assert released.used == 600
print("accepted 300; rejected 500; released 300")

```

运行应输出接受、拒绝和释放的三步说明。函数返回新状态，原对象不变，因此容易写清每一步断言。但是这个程序只有单线程、内存内状态；它没有实现生产系统的原子预留，也没有防止重复释放，不能直接放到多实例入口承担并发准入。

## 一次请求的结尾比开头更容易遗漏

正常完成、输入错误、调用方取消和计算异常，都可能成为释放资源的路径。把释放动作集中在可检查的退出流程，并为每一条路径写测试。若资源已经交给另一层管理，应明确所有权如何转移，不能在两处各减一次占用。

队列也必须有边界：容量、等待期限、超时后是否移出、拒绝如何反馈。更长的队列不保证更多请求成功，它可能把原本可以及时拒绝的请求拖到全部过期。真实引擎的调度与缓存管理更复杂，本节只要求你写出可验证的入口约束。

## 把可观测性与容量实验接起来

保存接收数、拒绝数、等待时间、活跃请求与退出原因。在逐步增加构造负载时，先观察服务是否按预定规则拒绝和释放，再谈吞吐提升。预算模型来自上一节假设时，要注明它还缺少实际运行时的成本；准入只能和经过核对的资源估计共同使用。

练习补一个带请求标识的占用表，让重复取消不会二次释放；再用异常模拟失败路径，检查占用最后回到基线。最后将多个请求的到达顺序打乱，解释相同总成本为什么仍可能产生不同等待体验。

到这里你得到的是一套从请求契约、状态预算到测量口径的阅读路线。下一次做真实推理实验时，可以把观察与未知项写进自己的文章，而不用先把玩具模拟误当成系统结论。


## 接着读

[[演示 · 推理 01｜先写清请求，再讨论模型快慢]]

## 跨方向继续探索

如果想把这一节的概念放到另一种场景里，可以接着读 [[演示 · 从终端路径开始，建立一个可丢弃的练习目录]]。这是一条可选的阅读连接，不是必须按顺序完成的课程。
