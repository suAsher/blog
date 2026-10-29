---
title: "演示 · 读写 JSON：把文件格式检查留在系统边界"
description: "在自己的临时目录完成一次写入、读取和结构校验。"
date: 2026-10-29
tags: ["生成演示", "Python"]
series: "Python · 从数据处理到可靠小工具（演示）"
---

> **生成演示内容**：用于展示分章学习与技术写作，不代表作者真实经历。请在独立练习环境验证，示例数字不是真实系统测量。

## JSON 能解析，不代表内容能使用

下面的程序只创建自己的临时文件。它将一个小配置序列化为 UTF-8，再解析回 Python 对象，最后检查业务需要的字段。JSON 描述数据结构，语法正确只是第一层；字段类型、允许范围和未知字段政策仍然需要应用自己决定。

```python
from pathlib import Path
from tempfile import TemporaryDirectory
import json

with TemporaryDirectory(prefix="learning-json-") as directory:
    path = Path(directory) / "config.json"
    path.write_text(json.dumps({"name": "demo", "limit": 4}, ensure_ascii=False), encoding="utf-8")
    if path.stat().st_size > 4096:
        raise ValueError("configuration too large")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or set(data) != {"name", "limit"}:
        raise ValueError("unexpected configuration fields")
    if type(data["limit"]) is not int or not 1 <= data["limit"] <= 32:
        raise ValueError("invalid limit")
    print(data["name"], data["limit"])
```

输出为 `demo 4`。这里使用 `type(value) is int`，是因为本练习希望拒绝布尔值；Python 的 `bool` 是 `int` 的子类，单靠 `isinstance(True, int)` 无法表达这个较窄的约定。校验写法应从接口约定出发，而不是看到“差不多是整数”就放行。

## 文件边界有两种失败

读取可能失败，例如路径不存在或权限不允许；解析也可能失败，例如内容被截断。它们与业务字段不合法不同，提示时应该保留可诊断的区别。生产服务还需要对读取字节数设置硬预算；本例先检查大小只适用于自己拥有的静态临时文件，不能当作面对并发修改或恶意文件的完整防护。也不要把路径、密码或原始内容直接塞进返回给用户的错误。

## 写成功之前，别急着宣布保存完成

这个教学程序没有并发写入者，简单写入足够看清流程。真正持久保存配置时，通常还需要在相同文件系统写入临时文件、同步、原子替换，并考虑目录同步与权限。多写入者还需要版本检查；原子替换不等于不会丢失更新。

练习把 JSON 中 `limit` 改成 `true`、字符串和超范围数字，观察每一种输入被哪一层拒绝。然后补一个缺字段样本，确认程序不会用不明确的默认值掩盖格式错误。

## 沿着这条路线继续

[[演示 · 生成器与资源：按需读取，也要按时关闭]]
