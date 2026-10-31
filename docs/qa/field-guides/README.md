# 交互长文验收

2026-10-31（Asia/Shanghai）。以真实 Go 会话、Markdown 导入/发布和临时本机 HTTPS 服务验收；只使用生成数据。生产账号、Cookie 和私有正文没有导出到本机。

## 功能范围

- 三篇独立长文：推理 3,998、Go 3,452、网络 3,893 个正文汉字；剔除 frontmatter 和围栏代码计数。原创 PNG 随 Markdown 一起真实上传，三篇发布后追加到临时路线导读章。
- 阅读首屏、本篇线索、路线侧栏与窄屏折叠、可键盘滚动的代码、文件名/行号/重点行、原文复制、输出折叠。
- 三种数据驱动教学组件，输入/大小/数量预算，未知字段和脚本拒绝，减少动画下的手动步骤、隐藏/离屏暂停。
- 折叠不改变批注文本上下文；定位到已折叠输出中的批注时自动展开，并同步按钮状态。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 175 个文件；0 错误、0 警告；3 条既有提示 |
| `npm run test:coverage` | 231 项、28 个文件；语句 85.84%、分支 84.60%、函数 91.38%、行 87.91%（选定库范围） |
| `npm run test:e2e` | 最终单次 378/378，5.1 分钟，无跳过/重试；桌面、手机、平板 Chromium |
| `npm run build` | 19 条静态路由 |
| `auth/` 中 `go test ./...` | 两个包通过；本轮后端未改动 |
| Python 发布工具测试 | 长文 13 项、既有目录 14 项，共 27 项通过；包含真实 helper 锁互斥、丢失响应、幂等恢复、人工编辑与路线版本冲突 |
| 文中代码验证 | 推理模型断言、Go 13 个测试分支及 race、网络回环 200/404/连接失败/响应头超时通过 |
| `npm audit --audit-level=high` | 0 个已知漏洞 |

真实长文截图覆盖桌面三篇×深浅主题、平板/手机推理长文×深浅主题，共十个 Axe WCAG 状态，均为零违规；Go 超时 503、网络应用错误 500 场景均验证通过，见 [result.json](result.json)。

最终 Lighthouse 13.5.0 / Chrome 156.0.8078.76，每项三个冷浏览器样本，见 [performance.json](performance.json)：

| 页面 | 设备 | 性能中位数 / 最低 | 无障碍 / 最佳实践（最低） | LCP 中位数 / 最慢 |
| --- | --- | --- | --- | --- |
| 首页 | 手机 | 98 / 98 | 100 / 100 | 2113 / 2114 ms |
| 推理长文 | 手机 | 95 / 94 | 100 / 100 | 2863 / 2878 ms |
| 首页 | 桌面 | 100 / 99 | 100 / 100 | 553 / 574 ms |
| 推理长文 | 桌面 | 100 / 100 | 100 / 100 | 654 / 658 ms |

最终长文全部样本 CLS 为 0。首页满足本轮 2.5 秒预算；手机长文 LCP 仍约 2.86 秒，如需整站每页都小于 2.5 秒，还需单独优化私有文章加载链路。

完整回归曾暴露既有跨标签退出用例的时序竞争：共享会话已撤销时，另一标签未完成的真实文章请求收到 401 并正常跳登录，打断测试安排的本地修改。可控延迟已复现该过程。用例现在等待两边正文就绪，暂缓真实退出请求直至目标 `read=true` journal 排队，再放行并检查真实 200、清理完成的登录地址、epoch 与私有缓存/journal 清空；未改产品认证或同步逻辑，也没有放宽超时或开启重试。

生产发布工具首次执行在登录和写入前停止：长文锁名称未纳入共享 helper 的允许列表。新增两个调用真实 helper 的用例先复现失败，再仅允许精确的 `field-guides-v1` 锁范围；目录名称白名单、权限检查、符号链接保护和非阻塞互斥仍保留。回归同时验证完成收据可以直接退出，无需读取凭据或再次登录。

初测长文移动端性能 87，CLS 为 0.168；通过 PerformanceObserver 定位到加载提示下方的页脚先进入首屏、再被正文推走。现在加载态预留首屏高度；原版在三个尺寸下均失败的延迟 API 回归用于验证修复。初测报告保留为 [performance-before-fix.json](performance-before-fix.json)，不能当作最终成绩。

## 截图

- [桌面深色：首屏](desktop-dark-inference-hero.png) · [正文与实验](desktop-dark-inference-experiment.png)
- [桌面浅色：Go 请求](desktop-light-go-request-experiment.png)
- [平板深色](tablet-dark-inference-experiment.png)
- [手机浅色](mobile-light-inference-experiment.png) · [手机深色](mobile-dark-inference-hero.png)

所有截图只含生成资料。三个尺寸是 Chromium 模拟，不能替代真实 Safari/iOS 或物理低端手机。性能采用回环 HTTPS、真实鉴权、31 份生成文档、首页及推理长文，每设备每页三个独立冷浏览器样本；不代表公网网络或服务器负载下的保证。网络文中的 Linux 专用 `ss`/`/proc` 操作未在本机 macOS 执行；回环连接在本机观察为连接超时，正文区分该情况与连接拒绝。

## 复现

```bash
npm run build
npm run test:e2e
node scripts/showcase-field-guides.mjs
BLOG_PERF_FIELD_GUIDE=1 \
  BLOG_PERF_OUTPUT=docs/qa/field-guides/performance.json \
  BLOG_PERF_DEVICES=mobile,desktop BLOG_PERF_SAMPLES=3 \
  node scripts/audit-performance.mjs
```

浏览器任务顺序运行，避免与其他构建或性能测量争用资源。临时测试服务退出后清理自身数据和随机凭据。
