import { describe, expect, it } from "vitest";
import {
  parseExplorer,
  inferenceTimeline,
  requestStages,
  networkStages,
} from "../../src/lib/explorers";

describe("bounded explanatory models", () => {
  it("accepts only data-only known presets", () => {
    expect(parseExplorer('{"kind":"inference"}')).toEqual({
      kind: "inference",
      title: "一次请求的时间账本",
    });
    expect(parseExplorer('{"kind":"network","title":"本机路径"}').title).toBe(
      "本机路径",
    );
    for (const source of [
      "null",
      "[]",
      "{}",
      '{"kind":"script"}',
      '{"kind":["inference"]}',
      '{"kind":"network","url":"https://x"}',
      '{"kind":"network","title":""}',
      JSON.stringify({ kind: "network", title: "a".repeat(121) }),
      "x".repeat(2049),
    ])
      expect(() => parseExplorer(source)).toThrow();
  });
  it("schedules deterministic queues without inventing GPU measurements", () => {
    const input = { tokens: 256, requests: 3, servers: 1 };
    const rows = inferenceTimeline(input);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      request: 1,
      server: 1,
      queue: 0,
      prefill: 4,
      decode: 8,
      first: 4,
      end: 12,
    });
    expect(rows[1].queue).toBe(12);
    expect(rows[2].end).toBe(36);
    expect(inferenceTimeline({ ...input, servers: 3 })[2].queue).toBe(0);
    expect(input).toEqual({ tokens: 256, requests: 3, servers: 1 });
  });
  it("rejects unbounded and noninteger model inputs", () => {
    for (const input of [
      { tokens: 0, requests: 1, servers: 1 },
      { tokens: 8193, requests: 1, servers: 1 },
      { tokens: 1, requests: 13, servers: 1 },
      { tokens: 1, requests: 1, servers: 5 },
      { tokens: 1.1, requests: 1, servers: 1 },
      { tokens: NaN, requests: 1, servers: 1 },
    ])
      expect(() => inferenceTimeline(input)).toThrow();
  });
  it("makes invalid inputs and deadline failures explicit", () => {
    expect(requestStages("invalid")[0].detail).toContain("name 为空");
    expect(requestStages("valid").at(-1)).toMatchObject({
      state: "ok",
      label: "200 响应",
    });
    expect(requestStages("invalid")[1]).toMatchObject({ state: "failed" });
    expect(requestStages("invalid")[2]).toMatchObject({ state: "skipped" });
    expect(requestStages("timeout")[3]).toMatchObject({ state: "failed" });
    expect(requestStages("timeout").at(-1)?.label).toBe("503 响应");
    expect(() => requestStages("other" as never)).toThrow();
  });
  it("diagnoses one failure layer without contacting a network", () => {
    expect(networkStages("dns")[0].state).toBe("failed");
    expect(networkStages("port")[1].state).toBe("failed");
    expect(networkStages("http")[2].state).toBe("failed");
    expect(networkStages("ok").every((item) => item.state === "ok")).toBe(true);
    expect(() => networkStages("other" as never)).toThrow();
  });
});
