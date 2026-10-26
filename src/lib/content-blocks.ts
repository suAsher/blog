/** Bounded data-only formats. These parsers never evaluate Markdown, HTML or JavaScript. */
export interface ChartSpec { title: string; type: 'line' | 'bar'; labels: string[]; series: { name: string; values: number[] }[] }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function shortText(value: unknown, limit: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= limit; }
export function parseChart(source: string): ChartSpec {
  if (source.length > 20_000) throw new Error('图表定义最多 20,000 个字符。');
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('图表需要有效的 JSON。'); }
  if (!record(value) || !shortText(value.title, 120) || !['line', 'bar', undefined].includes(value.type as string | undefined) ||
      !Array.isArray(value.labels) || value.labels.length < 1 || value.labels.length > 60 ||
      !value.labels.every(label => shortText(label, 80)) || !Array.isArray(value.series) || value.series.length < 1 || value.series.length > 6) {
    throw new Error('请提供标题、1–60 个横轴标签，以及 1–6 组数据；类型为 line 或 bar。');
  }
  const labels = [...value.labels] as string[];
  const series = value.series.map(item => {
    if (!record(item) || !shortText(item.name, 80) || !Array.isArray(item.values) || item.values.length !== labels.length ||
        !item.values.every(number => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1e12)) {
      throw new Error('每组数据需要名称，数值数量须与标签一致，且应为绝对值不超过 10¹² 的有限数字。');
    }
    return { name: item.name, values: [...item.values] as number[] };
  });
  return { title: value.title, type: value.type === 'bar' ? 'bar' : 'line', labels, series };
}
export function validateDiagram(source: string): string {
  const text = source.trim();
  if (!text || text.length > 20_000) throw new Error('流程图定义需要 1–20,000 个字符。');
  if (!/^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2|erDiagram|mindmap)\b/.test(text)) {
    throw new Error('支持流程图、时序图、类图、状态图、关系图与思维导图。');
  }
  if (/[<>]/.test(text.replace(/<\|(?:--|\.\.)|(?:--|\.\.)\|>|(?:<<?|[ox*])?[-=.]+(?:>{1,2}|[ox*])?/g, '')) ||
      /%%\s*\{|^\s*---|\b(?:click|href|image|img|icon|url)\s*[:(\s]/im.test(text) || /(?:https?:|javascript:|data:|@\{)/i.test(text)) {
    throw new Error('图中不允许配置指令、HTML、外部链接、点击脚本或外部图片。');
  }
  const statements = text.split(/[\n;]/).filter(line => line.trim() && !line.trim().startsWith('%%')).length;
  const nodes = (text.match(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|&/g) || []).length;
  if (statements > 200 || nodes > 250) throw new Error('单张图最多 200 条语句、250 个节点，请拆分复杂图。');
  if ((text.match(/-->|---|==>|-\.->|->>|-->>|\|\|--|\}\|--/g) || []).length > 250) throw new Error('单张图最多 250 条连接。');
  return text;
}
export function parseCallout(source: string): { kind: 'note' | 'tip' | 'warning'; label: string; body: string } | null {
  const match = /^\[!(NOTE|TIP|WARNING)\](?:[^\S\r\n]+([^\r\n]*))?(?:\r?\n|$)([\s\S]*)$/i.exec(source.trim());
  if (!match) return null;
  const kind = match[1].toLowerCase() as 'note' | 'tip' | 'warning';
  return { kind, label: match[2]?.trim() || { note: '笔记', tip: '提示', warning: '注意' }[kind], body: match[3] };
}
const templates: Record<string, string> = {
  mermaid: '```mermaid\nflowchart LR\n  A[提出问题] --> B[收集证据]\n  B --> C{验证理解}\n  C -->|新的观察| A\n  C -->|可以复现| D[沉淀为文档]\n```',
  chart: '```chart\n{\n  "title": "演示数据 · 学习记录",\n  "type": "line",\n  "labels": ["周一", "周二", "周三", "周四", "周五"],\n  "series": [\n    {"name": "阅读", "values": [2, 4, 3, 6, 5]},\n    {"name": "实践", "values": [1, 2, 4, 3, 6]}\n  ]\n}\n```',
  note: '> [!NOTE] 留给下次回访的线索\n> 先写背景，再记录证据。这里是可以继续生长的思考。',
};
export function blockTemplate(kind: string): string | null { return Object.hasOwn(templates, kind) ? templates[kind] : null; }
