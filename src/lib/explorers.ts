export type ExplorerKind = "inference" | "go-request" | "network";
export interface ExplorerSpec {
  kind: ExplorerKind;
  title: string;
}
export interface Stage {
  label: string;
  detail: string;
  state: "ok" | "failed" | "skipped";
}
export type RequestScenario = "valid" | "invalid" | "timeout";
export type NetworkScenario = "ok" | "dns" | "port" | "http";
const titles = {
  inference: "一次请求的时间账本",
  "go-request": "沿着一条请求，逐步看见控制流",
  network: "先找到失败的那一层",
};
export function parseExplorer(source: string): ExplorerSpec {
  if (source.length > 2048) throw new Error("教学定义最多 2048 字符。");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("教学定义需要有效 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("教学定义需要一个对象。");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !["kind", "title"].includes(key)) ||
    typeof object.kind !== "string" ||
    !Object.hasOwn(titles, object.kind)
  )
    throw new Error(
      "只支持 inference、go-request、network 教学模型，不允许脚本或额外字段。",
    );
  if (
    object.title !== undefined &&
    (typeof object.title !== "string" ||
      !object.title.trim() ||
      object.title.length > 120)
  )
    throw new Error("标题需要 1–120 字符。");
  const kind = object.kind as ExplorerKind;
  return {
    kind,
    title: object.title === undefined ? titles[kind] : String(object.title),
  };
}
export interface InferenceInput {
  tokens: number;
  requests: number;
  servers: number;
}
export function inferenceTimeline(input: InferenceInput) {
  if (
    !Number.isInteger(input.tokens) ||
    input.tokens < 1 ||
    input.tokens > 8192 ||
    !Number.isInteger(input.requests) ||
    input.requests < 1 ||
    input.requests > 12 ||
    !Number.isInteger(input.servers) ||
    input.servers < 1 ||
    input.servers > 4
  )
    throw new Error("模型输入超出范围。");
  // Constructed work units: one server serially serves one request, no batching.
  const prefill = input.tokens / 64,
    decode = 8;
  return Array.from({ length: input.requests }, (_, index) => {
    const queue = Math.floor(index / input.servers) * (prefill + decode);
    return {
      request: index + 1,
      server: (index % input.servers) + 1,
      queue,
      prefill,
      decode,
      first: queue + prefill,
      end: queue + prefill + decode,
    };
  });
}
export function requestStages(scenario: RequestScenario): Stage[] {
  if (!["valid", "invalid", "timeout"].includes(scenario))
    throw new Error("未知请求场景。");
  const invalid = scenario === "invalid",
    timeout = scenario === "timeout";
  return [
    {
      label: "解析请求",
      detail: invalid
        ? "读取输入：name 为空；结构可以解析，但业务输入尚未通过校验。"
        : "读取输入：name=asher；请求结构与业务校验分别处理。",
      state: "ok",
    },
    {
      label: "校验输入",
      detail: invalid
        ? "name 为空，立即返回 400；不进入业务逻辑。"
        : "输入通过，交给 handler。",
      state: invalid ? "failed" : "ok",
    },
    {
      label: "业务处理",
      detail: invalid
        ? "校验失败，跳过 handler。"
        : "执行示例处理任务，使用请求上下文。",
      state: invalid ? "skipped" : "ok",
    },
    {
      label: "检查截止时间",
      detail: timeout
        ? "上下文超时，停止等待并返回超时响应。"
        : invalid
          ? "没有启动业务任务，无需等待。"
          : "任务在截止时间前完成。",
      state: invalid ? "skipped" : timeout ? "failed" : "ok",
    },
    {
      label: invalid ? "400 响应" : timeout ? "503 响应" : "200 响应",
      detail: "这里只演示应用控制流，不发送请求或执行 Go 代码。",
      state: invalid || timeout ? "failed" : "ok",
    },
  ];
}
export function networkStages(scenario: NetworkScenario): Stage[] {
  if (!["ok", "dns", "port", "http"].includes(scenario))
    throw new Error("未知网络场景。");
  const failure = { ok: -1, dns: 0, port: 1, http: 2 }[scenario];
  const labels = ["名称解析", "连接目标端口", "HTTP 响应"];
  const success = [
    "得到地址，继续检查目标端口。",
    "目标端口接受连接，继续读取 HTTP。",
    "得到 200，连接与应用协议均通过本例检查。",
  ];
  const errors = [
    "名字没有解析到地址；先核对名称和解析结果。",
    "地址已知，但连接被拒绝；核对进程监听和目标端口。",
    "已经收到 HTTP 500；请求到达应用，转向应用日志与请求标识。",
  ];
  return labels.map((label, index) => ({
    label,
    detail:
      index === failure
        ? errors[index]
        : failure >= 0 && index > failure
          ? "上游步骤失败，本层尚未得到验证。"
          : success[index],
    state:
      index === failure
        ? "failed"
        : failure >= 0 && index > failure
          ? "skipped"
          : "ok",
  }));
}
