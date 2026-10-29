---
title: "演示 · 做一个小命令：参数、计算与退出状态分开"
description: "用标准库 argparse 把纯函数接到命令行边界。"
date: 2026-10-29
tags: ["生成演示", "Python"]
series: "Python · 从数据处理到可靠小工具（演示）"
---

> **生成演示内容**：用于展示分章学习与技术写作，不代表作者真实经历。请在独立练习环境验证，示例数字不是真实系统测量。

## 让程序有明确的输入方式

这段命令只计算一个由参数决定的整数，不访问网络、不执行 shell、不加载真实配置。把它保存为 `budget.py`，运行 `python3 budget.py --workers 3 --per-worker 4`，预期输出十二。我们借它练习命令接口，而不是估算真实机器的吞吐能力。

```python
import argparse

def capacity(workers, per_worker):
    if workers <= 0 or per_worker <= 0:
        raise ValueError("both counts must be positive")
    return workers * per_worker

def main():
    parser = argparse.ArgumentParser(description="A generated arithmetic exercise")
    parser.add_argument("--workers", type=int, required=True)
    parser.add_argument("--per-worker", type=int, required=True)
    args = parser.parse_args()
    try:
        result = capacity(args.workers, args.per_worker)
    except ValueError as error:
        parser.error(str(error))
    print(result)

if __name__ == "__main__":
    main()
```

再运行 `python3 budget.py --workers 0 --per-worker 4`，程序应给出参数错误并以非零状态退出，而不是打印零冒充正常结果。`argparse` 负责参数存在性与整数转换，纯函数负责正数这条业务约定，两层有不同职责。命令的帮助信息也属于接口，`--help` 应让第一次使用者理解参数，而不是要求先读源代码。

## 输出要能被人和脚本共同理解

普通结果写到标准输出，参数错误由解析器写到错误流。这样调用方可以区分成功数据与失败提示。不要把调试日志与 JSON 或数值结果混在同一个输出通道，再要求下游猜哪一行可用。以后加入复杂任务时，退出状态仍应表达整个命令是否完成，而不是只表示最后一句日志是否写出。

## 小工具的边界也需要写下来

乘法假设每个工作者的可用额度可以简单相加，它没有考虑共享资源、排队或请求成本，所以只是一项算术练习。把这个数字叫作真实吞吐量会误导读者。真实容量验证应固定输入，记录时间窗口，并观察延迟与错误率。本例也没有把任意用户输入拼入 shell，避免为一次普通计算引入不必要的命令执行边界。

练习先为 `capacity` 补单元测试，再用 `subprocess.run` 在独立目录中调用自己的脚本，断言有效输入返回零状态、无效输入返回非零状态。保持函数测试与接口测试分开，失败时才能迅速知道约定在哪一层被破坏。

## 沿着这条路线继续

[[演示 · 从值和分支开始，写一个能解释结果的小程序]]

## 跨方向继续探索

如果想把这一节的概念放到另一种场景里，可以接着读 [[演示 · Git 01｜一次修改经过哪三个位置]]。这是一条可选的阅读连接，不是必须按顺序完成的课程。
