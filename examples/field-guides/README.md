# 交互长文 · 生成演示

这三篇是原创生成的教学资料，不代表 asher 的真实经历或生产测量。不扫描或读取用户文档，也不覆盖现有文章。以完整问题链、可复现代码与图解展示长文阅读效果。

| 文档 | 正文汉字数¹ | 核心体验 |
| --- | ---: | --- |
| [一次推理请求的旅程](inference.md) | 3,998 | 排队/预填充/生成时间轴、负载滑块、完整 FIFO 模型与指标边界 |
| [一条请求如何穿过 Go 程序](go-request.md) | 3,452 | 输入校验、上下文、503 超时映射、完整程序与 13 个测试分支 |
| [输入一个地址之后](linux-network.md) | 3,893 | DNS/端口/HTTP 分层诊断、回环实验、错误观察与排查地图 |

¹ 去除 frontmatter 与围栏代码后统计汉字，不把代码和元数据计为正文篇幅。文章另含 Mermaid、表格、提示、练习和一手来源。交互只使用本站受控模型，不运行文章中的任意脚本。

## 在站内查看

登录后使用「写作 → 导入文档 → 文件夹」，选择本目录。保留三个正文 `.md` 和 `images/` 的目录关系，在上传预检中将本说明 `README.md` 标为跳过；代码验证脚本等其他格式会被过滤。确认三篇导入、配图匹配后预览并发布，再在「路线」中添加为方向的导读章。日常更新无需重新部署。

图片是本站原创工程图，三张均为 1200×400 PNG。`cover` 使用 `images/*.png` 相对路径，真实导入后由服务端转换为私有图片地址。不要只选择 Markdown 而漏掉配图。生成器 `node scripts/generate-field-guide-covers.mjs` 会同时更新本目录及 `public/images/field-guides/`；依赖现有工具链中的 sharp，没有新增运行时依赖。

## 验证文章中的代码

从项目根目录运行，需 Python 3、Go 1.26：

```bash
python3 examples/field-guides/checks/verify-inference.py
python3 examples/field-guides/checks/verify-go.py
python3 examples/field-guides/checks/verify-network.py
python3 -m unittest discover -s tests -p 'test_field_guides*.py' -v
```

推理验证不监听端口；Go 示例通过 `httptest` 测试成功、错误输入及超时/取消，无外部网络。网络实验仅监听 127.0.0.1 临时端口，验证 200、404、连接失败和响应头超时。非监听端口在不同系统/策略下可能表现为拒绝或连接超时，验证接受这两种明确区分的观察。Linux 的 `ss`、`/proc` 命令应在 Linux 环境操作；macOS 上的回环实验不能当作这些命令已经执行的证据。

## 部署端追加导读

`deploy/seed-field-guides.py` 是已有私有实例的运维工具，不是后台自动扫描器。先备份，上传这批明确生成的资料后，在服务器运行：

```bash
python3 deploy/seed-field-guides.py --examples examples/field-guides --dry-run
python3 deploy/seed-field-guides.py \
  --examples examples/field-guides --server-root /srv/asher-knowledge
```

工具要求服务器已有 Go、Linux、AI 路线的私有种子收据及访问配置。凭据只在服务器进程内使用。它通过现有鉴权导入/发布接口创建三篇新文档，再以版本检查追加导读章，保留其他字段；导入请求有稳定收据，重试不重复创建。检测到人工修改、版本冲突或预算不足时停止，不覆盖。完成收据位于服务器 `showcases/field-guides-v1.json`，再次运行直接返回；不提交该目录或凭据。

移除演示时在写作空间撤回/移入垃圾箱，并从路线移除对应引用。`BLOG_INCLUDE_EXAMPLES=0` 只关闭构建内示例，不会删除通过 Go 导入的正式文档。

截图和无障碍检查：构建后运行 `node scripts/showcase-field-guides.mjs`。它只使用临时本机服务与生成数据，输出到 `docs/qa/field-guides/`，不连接生产。
