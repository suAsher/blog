# 学习路线与写作工作流验收

2026-11-06（Asia/Shanghai）。本轮使用临时本机 HTTPS 服务、真实 Go 会话与文件存储、随机测试凭据和生成文档。生产账号、Cookie 及私有正文没有导出到本机。

## 功能范围

- 书本式路线入口、学习目标、先修要求、章节目标与实践任务；已读和实践完成分别统计，跨设备版本冲突不覆盖远端修改。
- 导入报告中的成功文档按原目录编排为路线，可调顺序与归属；创建标识支持断网重试，不重复创建，不改变文档发布状态。
- 五种可编辑写作骨架；教学模型配置、真实组件预览和按原光标位置插入，已有修改先保存。
- 正文批注转为问题卡草稿；受控 `recall` 内容、原文回链和既有文章回顾流程。
- 六篇原创生成 AI 基础设施长文，与已有推理导读组成七章主线；旧基础文章和人工内容继续保留。
- 代码高亮改为按需加载，正文先可读；可选增强超时或失败时保留原文和批注能力。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 197 个文件；0 错误、0 警告；3 条既有提示 |
| `npm run test:coverage` | 277 项、33 个文件通过；语句 87.13%、分支 85.72%、函数 92.51%、行 88.96% |
| `npm run test:e2e` | 最终单次 414/414 通过，6.6 分钟；无跳过、无重试 |
| `npm run build` | 通过，19 条静态路由 |
| `auth/` 中 `go test -race -cover ./...` | 两个包通过；认证包覆盖率 87.7%、内容包 89.0% |
| Python 发布工具测试 | 42 项通过，包含收据恢复、冲突和幂等边界 |
| 六篇长文代码验证 | 六份固定教学程序全部通过，核对精确输出、正文长度和 SHA256 |
| `npm audit --audit-level=low` | 0 个已知漏洞 |
| 截图与 Axe | 32 张截图、20 个 WCAG AA 页面状态，零违规；真实上传后编排保持 6 篇草稿未发布 |
| Lighthouse | 首页手机性能中位数 98、长文 97，桌面均 100；无障碍、最佳实践全部样本 100 |

Vitest 覆盖率仅针对 `vitest.config.ts` 中选定的库文件，不代表所有 DOM 脚本的覆盖率。浏览器用例以 Chrome/Chromium 运行桌面、iPhone 13 和 iPad Mini 视口；手机和平板是模拟尺寸，没有验证真实 iPhone、Safari 或物理低端设备。

全量回归之后只补充了路线标题的均衡换行，重新构建后六项路线用例及 20 个截图/Axe 状态再次通过。该排版调整没有改变已测量的首页和阅读页 HTML，已核对构建文件 SHA256 一致。

## 回归中修复的问题

1. **路线页桌面溢出。** 1280 像素视口的滚动宽度曾达到 1324 像素。旋转轨道伪元素扩大了滚动区域；现在仅裁剪装饰场景，保留全页无横向溢出的断言。修复前桌面失败，修复后六项路线用例在三个视口全部通过。
2. **教学模型的表单标签。** 模型选择器改为显式 `label for` 与控件 ID 关联，使键盘、辅助技术与按标签定位保持一致。
3. **高弹窗的视口边界。** 写作弹窗使用 `inset: 0`、`margin: auto` 和视口内最大高度，内容在弹窗内部滚动，避免原顶部边距把底部操作按钮推到视口外。
4. **高亮阻塞批注。** 可选高亮最多等待 1.5 秒。未及时完成时保留纯文本代码并初始化批注；迟到模块不再改写活动文本节点，避免批注锚点失效。正文与基础阅读控件不等待这段增强。

## 截图与性能

`scripts/showcase-learning-v2.mjs` 真实导入六篇长文与已有导读，创建七章临时路线，生成 [result.json](result.json)。路线和新长文分别覆盖三个尺寸、深浅主题；模板、教学实验、导入编排与问题卡覆盖桌面深色、手机浅色。截图均为生成资料。视觉检查后，路线标题增加均衡换行，避免长标题末行只剩少数字符。

- [桌面深色：路线入口](desktop-dark-route-hero.png) · [目标与章节](desktop-dark-route-detail.png)
- [手机浅色：新长文](mobile-light-lesson-hero.png) · [平板代码阅读](tablet-light-lesson-code.png)
- [教学实验配置](desktop-dark-experiment-authoring.png) · [手机写作模板](mobile-light-writing-templates.png)
- [手机导入编排](mobile-light-import-arrangement.png) · [问题卡阅读](desktop-dark-recall.png)

Lighthouse 13.5.0 / Chrome 156.0.8078.80，31 份生成文档，每页、每设备三个独立冷浏览器样本，完整数据见 [performance.json](performance.json)。

| 页面 | 设备 | 性能中位数 / 最低 | 无障碍 / 最佳实践（最低） | LCP 中位数 / 最慢 |
| --- | --- | --- | --- | --- |
| 首页 | 手机 | 98 / 95 | 100 / 100 | 2134 / 2141 ms |
| 推理长文 | 手机 | 97 / 96 | 100 / 100 | 2568 / 2579 ms |
| 首页 | 桌面 | 100 / 100 | 100 / 100 | 535 / 567 ms |
| 推理长文 | 桌面 | 100 / 100 | 100 / 100 | 639 / 646 ms |

首页满足 2.5 秒预算。手机长文 LCP 仍为约 2.57 秒，不能声称所有页面都低于 2.5 秒；长文全部样本 CLS 为 0。测量采用回环 HTTPS、真实鉴权与独立冷浏览器；这些分数不代表公网、真机或服务器负载下的保证。本轮不使用历史分数替代实际测量，也没有执行真实 GPU 基准。

## 复现

```bash
npm run check
npm run test:coverage
npm run build
npm run test:e2e
python3 -m unittest discover -s tests -p 'test_*.py'
python3 examples/ai-infrastructure/checks/verify.py
node scripts/showcase-learning-v2.mjs
BLOG_PERF_FIELD_GUIDE=1 \
  BLOG_PERF_OUTPUT=docs/qa/learning-v2/performance.json \
  BLOG_PERF_DEVICES=mobile,desktop BLOG_PERF_SAMPLES=3 \
  node scripts/audit-performance.mjs
```

在 `auth/` 目录单独运行 `go test -race -cover ./...`。浏览器验收、截图和 Lighthouse 顺序执行，避免共享端口或争用测量资源。临时服务结束时清理自己的数据和随机凭据；不要为本地 QA 设置生产 SSH 凭据读取模式。

数据兼容、实践标记、导入重试及后端升级顺序见 [学习工作流](../../learning-workflow.md)。
