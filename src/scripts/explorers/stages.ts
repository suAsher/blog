import {
  requestStages,
  networkStages,
  type RequestScenario,
  type NetworkScenario,
} from "../../lib/explorers";
import { node, player } from "./dom";
let scenarioNumber = 0;

export function stages(
  figure: HTMLElement,
  target: HTMLElement,
  kind: "go-request" | "network",
) {
  const label = node("label", kind === "go-request" ? "请求场景" : "诊断场景");
  const select = node("select");
  select.id = `explore-scenario-${++scenarioNumber}`;
  label.htmlFor = select.id;
  select.setAttribute("aria-label", label.textContent!);
  const choices =
    kind === "go-request"
      ? [
          ["valid", "正常输入"],
          ["invalid", "无效输入"],
          ["timeout", "截止时间耗尽"],
        ]
      : [
          ["ok", "正常响应"],
          ["dns", "名称解析失败"],
          ["port", "端口拒绝连接"],
          ["http", "HTTP 500"],
        ];
  for (const [value, text] of choices) {
    const option = node("option", text);
    option.value = value;
    select.append(option);
  }
  const diagram = node("ol", "", "explore-stages");
  const result = node("p", "", "explore-result");
  result.setAttribute("role", "status");
  const values = () =>
    kind === "go-request"
      ? requestStages(select.value as RequestScenario)
      : networkStages(select.value as NetworkScenario);
  const render = (at: number) => {
    const data = values();
    diagram.replaceChildren(
      ...data.map((stage, index) => {
        const item = node("li", "", "explore-stage");
        item.dataset.state = index <= at ? stage.state : "pending";
        item.setAttribute("aria-current", index === at ? "step" : "false");
        item.append(
          node(
            "span",
            String(index + 1).padStart(2, "0"),
            "explore-stage-number",
          ),
          node("strong", stage.label),
          node(
            "span",
            index > at
              ? "待展开"
              : { ok: "通过", failed: "失败 / 返回", skipped: "未执行" }[
                  stage.state
                ],
            "explore-stage-state",
          ),
        );
        return item;
      }),
    );
    result.textContent = `第 ${at + 1} 步 · ${data[at].label}：${data[at].detail}`;
  };
  const playback = player(figure, () => values().length, render);
  select.addEventListener("change", () => playback.reset());
  const all = node("details", "", "explore-text-equivalent");
  const summary = node("summary", "阅读完整步骤与文字解释");
  const text = node("ol");
  const updateText = () =>
    text.replaceChildren(
      ...values().map((stage) => node("li", `${stage.label}：${stage.detail}`)),
    );
  select.addEventListener("change", updateText);
  updateText();
  all.append(summary, text);
  const note = node(
    "p",
    kind === "go-request"
      ? "这是预设应用控制流，不运行 Go、不发送 HTTP。本篇程序将本地预算耗尽映射为 503；具体应用可采用不同响应约定。"
      : "这是预设诊断路径，不执行 DNS 查询、连接端口或扫描网络。收到 HTTP 500 只能说明应用返回错误，不能单凭该状态码确定具体根因。",
    "explore-note",
  );
  target.append(label, select, diagram, result, playback.controls, note, all);
}
