---
title: "演示 · 用 unittest 固定边界：测试应解释哪种输入被接受"
description: "把正常值与错误值放进可重复执行的测试，不依赖人工盯输出。"
date: 2026-10-29
tags: ["生成演示", "Python"]
series: "Python · 从数据处理到可靠小工具（演示）"
---

> **生成演示内容**：用于展示分章学习与技术写作，不代表作者真实经历。请在独立练习环境验证，示例数字不是真实系统测量。

## 让一次手工核对变成长期约定

程序首次运行正确，只说明当时那组输入得到了满意结果。修改代码后，我们需要知道哪些约定仍成立。下面的测试只使用 Python 标准库，既检查成功结果，也检查拒绝无效输入的行为。把整段保存为独立文件运行，不需要安装测试框架。

```python
import unittest

def normalize_name(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("name must not be empty")
    return value.strip().lower()

class NameTests(unittest.TestCase):
    def test_normalization(self):
        for raw, expected in [(" Demo ", "demo"), ("QUEUE", "queue")]:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_name(raw), expected)

    def test_rejects_empty_or_wrong_type(self):
        for raw in ["", "   ", None]:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    normalize_name(raw)

if __name__ == "__main__":
    unittest.main()
```

运行应报告两个测试通过。`subTest` 为同一个行为下的多个输入保留独立失败上下文，不需要把每个数据点拆成一份几乎一样的函数。`assertEqual` 关注可观察结果，`assertRaises` 关注错误契约；它们比测试函数内部某一行到底执行了几次更稳定。

## 测试名称应回答一个具体问题

不要只写 `test_works`，也不要为了覆盖率把实现复制一遍当作预期值。这里预期字符串直接写在样本中，读者可以从需求独立判断它是否正确。若实际规则不应该转换大小写，就同时修改约定和相应测试，而不是为了让失败消失而随意改断言。

## 留下一次有意义的红灯

先将实现改成直接返回 `value`，确认规范化测试失败；再恢复实现。这个短暂红灯证明测试能够发现你关心的行为改变。不要把失败当作坏事，无法区分正确和错误实现的“绿灯”才没有提供证据。涉及文件和时钟的逻辑需要隔离自己的临时资源，避免测试之间依赖执行顺序。

本篇没有把通过率或行覆盖率等同于正确性。测试可以遗漏规则，也可以本身写错。练习增加一个含中文的名称样本，并用一句话解释为什么去空白与改大小写是两条不同的约定。

## 沿着这条路线继续

[[演示 · 做一个小命令：参数、计算与退出状态分开]]
