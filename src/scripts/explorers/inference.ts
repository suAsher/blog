import { inferenceTimeline, type InferenceInput } from "../../lib/explorers";
import { button, node, slider } from "./dom";

export function inference(figure: HTMLElement, target: HTMLElement) {
  let input: InferenceInput = { tokens: 256, requests: 4, servers: 1 };
  const controls = node("div", "", "explore-controls");
  const chart = node("div", "", "explore-timeline");
  chart.setAttribute("role", "img");
  const explanation = node("p", "", "explore-result");
  explanation.setAttribute("role", "status");
  const table = node("table");
  const caption = node("caption", "完整教学数据（时间单位为构造工作单位）");
  const head = node("thead"),
    heading = node("tr");
  ["请求", "服务槽", "排队", "预填充", "后续生成", "首个输出", "结束"].forEach(
    (label) => {
      const cell = node("th", label);
      cell.scope = "col";
      heading.append(cell);
    },
  );
  head.append(heading);
  const body = node("tbody");
  table.append(caption, head, body);
  const scroll = node("div", "", "explore-table");
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "完整教学数据，可横向滚动");
  scroll.append(table);
  const render = () => {
    const rows = inferenceTimeline(input),
      total = Math.max(...rows.map((row) => row.end));
    chart.setAttribute(
      "aria-label",
      `${rows.length} 个请求，${input.servers} 个串行服务槽；最后结束于 ${total} 工作单位。下方提供完整数值表。`,
    );
    chart.replaceChildren(
      ...rows.map((row) => {
        const line = node("div", "", "explore-time-row");
        const label = node(
          "span",
          `R${row.request} / S${row.server}`,
          "explore-time-label",
        );
        const track = node("div", "", "explore-track");
        for (const [kind, value, label] of [
          ["queue", row.queue, "排队"],
          ["prefill", row.prefill, "预填充"],
          ["decode", row.decode, "后续生成"],
        ] as const) {
          const segment = node("span", "", `explore-segment segment-${kind}`);
          segment.style.width = `${(value / total) * 100}%`;
          segment.title = `${label}：${value} 工作单位`;
          track.append(segment);
        }
        line.append(label, track);
        return line;
      }),
    );
    body.replaceChildren(
      ...rows.map((row) => {
        const tr = node("tr");
        [
          row.request,
          row.server,
          row.queue,
          row.prefill,
          row.decode,
          row.first,
          row.end,
        ].forEach((value) => tr.append(node("td", String(value))));
        return tr;
      }),
    );
    explanation.textContent = `最后一个请求的首个输出等待 ${rows.at(-1)!.first} 工作单位，其中排队占 ${rows.at(-1)!.queue}。这是固定公式下的观察，不是 GPU 性能预测。`;
  };
  const inputs = [
    slider("输入长度（token）", 1, 8192, input.tokens, (value) => {
      input = { ...input, tokens: value };
      render();
    }),
    slider("同时到达的请求数", 1, 12, input.requests, (value) => {
      input = { ...input, requests: value };
      render();
    }),
    slider("串行服务槽数量", 1, 4, input.servers, (value) => {
      input = { ...input, servers: value };
      render();
    }),
  ];
  controls.append(
    ...inputs.map((value) => value.wrapper),
    button("还原参数", () => {
      input = { tokens: 256, requests: 4, servers: 1 };
      [256, 4, 1].forEach((value, index) => {
        inputs[index].input.value = String(value);
        inputs[index].output.value = String(value);
      });
      render();
    }),
  );
  const legend = node("p", "", "explore-legend");
  ["排队", "预填充", "后续生成"].forEach((label, index) =>
    legend.append(node("span", label, `legend-${index}`)),
  );
  const note = node(
    "p",
    "模型约定：所有请求在 0 时刻到达；同一槽串行处理，无动态批处理、取消或网络开销。预填充=输入 token÷64，后续生成固定为 8 工作单位。首个输出被计在预填充结束处，仅用于教学，不等同于真实 TTFT。",
    "explore-note",
  );
  target.append(controls, legend, chart, explanation, note, scroll);
  figure.dataset.exploreModel = "inference";
  render();
}
