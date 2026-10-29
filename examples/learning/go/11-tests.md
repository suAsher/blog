---
title: "演示 · Go 11｜表驱动测试：留下可以重复的验证"
description: "把手工核对转成每次修改后都能执行的检查。"
date: 2026-10-29
tags: ["生成演示", "Go 入门"]
series: "Go · 从第一行到独立实践（演示）"
---

> **生成演示内容**：本篇用于展示分章学习与技术写作，不代表作者真实经历。代码为独立练习，请在专用目录执行。

## 本节目标

把手工核对转成每次修改后都能执行的检查。

## 测试要表达预期，而不是复述实现

前面通过终端观察了很多输出，但记忆容易遗漏边界。自动化测试可以保存一组输入和明确的期望结果，帮助下一次修改时发现行为变化。测试通过不代表没有错误，只表示已写出的这些约定仍然成立。

在学习模块中创建 `clamp.go`：

```go
package main

func clamp(value, minimum, maximum int) int {
    if value < minimum { return minimum }
    if value > maximum { return maximum }
    return value
}
```

再创建 `clamp_test.go`：

```go
package main

import "testing"

func TestClamp(t *testing.T) {
    cases := []struct { name string; value, want int }{
        {"below", -1, 0},
        {"inside", 4, 4},
        {"above", 12, 10},
    }
    for _, item := range cases {
        t.Run(item.name, func(t *testing.T) {
            if got := clamp(item.value, 0, 10); got != item.want {
                t.Fatalf("got %d, want %d", got, item.want)
            }
        })
    }
}
```

```bash
go fmt ./...
go test ./...
```

## 让测试证明它真的会失败

正常情况应得到通过结果。暂时把函数中的上边界返回值改成 minimum，重新执行测试，应看到 above 用例失败。修复后再运行直到恢复绿色。这个过程能帮助确认测试确实覆盖了你关心的行为，而不是只执行了没有断言的代码。

表里的 name 方便定位失败场景；每组数据给出一个具体的预期，不需要为每个例子复制整个测试函数。这里输入的上下界固定合法，若要开放为公共工具，应明确 minimum 大于 maximum 时的契约，而不是偷偷交换参数掩盖调用错误。

## 小练习

加入恰好等于上下界的两组数据，再添加一个仅有单一合法值的范围测试。优先补充能改变判断的边界，不追求机械增加用例数量。覆盖率可以显示执行到了哪里，但不能代替测试是否正确描述需求的判断。
