---
title: "演示 · Go 12｜做一个能检查参数的小命令"
description: "把输入、业务逻辑和退出状态连成一个完整的可运行程序。"
date: 2026-10-29
tags: ["生成演示", "Go 入门"]
series: "Go · 从第一行到独立实践（演示）"
---

> **生成演示内容**：本篇用于展示分章学习与技术写作，不代表作者真实经历。代码为独立练习，请在专用目录执行。

## 本节目标

把输入、业务逻辑和退出状态连成一个完整的可运行程序。

## 给第一件小工具划清范围

这一节做一个计算两整数之和的命令，不访问网络、不读私人文件。它看起来简单，却能串起入口、参数校验、错误处理和结果输出。先规定接口：必须恰好提供两个整数，成功输出总和，失败写入标准错误并以非零状态退出。

```go
package main

import (
    "fmt"
    "os"
    "strconv"
)

func run(args []string) error {
    if len(args) != 2 {
        return fmt.Errorf("用法：sum 整数 整数")
    }
    left, err := strconv.ParseInt(args[0], 10, 32)
    if err != nil { return fmt.Errorf("第一个参数不是有效的32位整数") }
    right, err := strconv.ParseInt(args[1], 10, 32)
    if err != nil { return fmt.Errorf("第二个参数不是有效的32位整数") }
    fmt.Println(left + right)
    return nil
}

func main() {
    if err := run(os.Args[1:]); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}
```

## 用正常和错误输入验收

在新的学习模块目录里保存为 main.go，执行下面的命令。不要和上一节其他含 main 的示例放进同一个包，否则会出现入口重复。

```bash
go run . 12 30
go run . 12 invalid
go build -o sum .
```

第一条应输出四十二，第二条应提示第二个参数无效。`go run` 的工具层可能额外输出退出状态信息；直接执行构建产物可以观察程序本身的标准错误和退出码。Windows 下可构建为 sum.exe。

## 为什么限制输入为32位

`ParseInt` 返回 int64，但本例限制两个输入各为32位有符号整数，两者相加仍在 int64 范围内，因此避免演示里留下加法溢出的漏洞。若允许任意64位输入，就必须再增加加法溢出检查，不能只把解析位数改大。

## 继续独立实践

为 run 拆出一个不负责打印的求和函数，补充合法输入、缺少参数和解析失败的测试，再用 `go test ./...` 验证。下一篇自己的笔记可以记录“我为什么这样划分职责”，而不只是贴最终代码。路线到此是起点：并发、网络和部署值得各自独立成章，不必一次塞进第一个小工具。
