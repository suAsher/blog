import { blockTemplate } from './content-blocks';

export const writingCommands = [
  { id: 'heading', label: '小节标题', hint: 'heading title' },
  { id: 'code', label: '代码块', hint: 'code' },
  { id: 'table', label: '表格', hint: 'table' },
  { id: 'mermaid', label: '交互流程图', hint: 'mermaid diagram' },
  { id: 'chart', label: '交互图表', hint: 'chart' },
  { id: 'note', label: '提示块', hint: 'note callout' },
] as const;

export type DraftTemplate = 'mermaid' | 'chart' | 'note';
export type SelectionRange = { start: number; end: number };
export function commandSnippet(kind: string, selected = ''): string {
  if (kind === 'heading') return `\n## ${selected || '小节标题'}\n`;
  if (kind === 'bold') return `**${selected || '重点内容'}**`;
  if (kind === 'code') return `\n\`\`\`text\n${selected || '在这里写代码'}\n\`\`\`\n`;
  if (kind === 'link') return `[${selected || '链接说明'}](https://example.com)`;
  if (kind === 'table') return '\n| 项目 | 说明 |\n| --- | --- |\n| 第一项 | 在这里记录 |\n';
  const block = blockTemplate(kind);
  return block ? `\n${block}\n` : '';
}
export function slashCommand(source: string, start: number, end: number): (SelectionRange & { query: string }) | null {
  if (start !== end || start < 0 || start > source.length) return null;
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const line = source.slice(lineStart, start);
  const match = /^\s*\/([^\s/]{0,30})$/.exec(line);
  if (!match) return null;
  let fence = '';
  for (const previous of source.slice(0, lineStart).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(previous)?.[1];
    if (!marker) continue;
    if (!fence) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length && previous.trim() === marker) fence = '';
  }
  return fence ? null : { start: lineStart + line.indexOf('/'), end: start, query: match[1].toLocaleLowerCase() };
}
export function manageIntent(params: URLSearchParams): { kind: 'new' } | { kind: 'template'; template: DraftTemplate } | { kind: 'document'; id: string } | { kind: 'import' } | null {
  const id = params.get('id');
  if (id && /^[a-f0-9]{32}$/.test(id)) return { kind: 'document', id };
  const template = params.get('template');
  if (template === 'mermaid' || template === 'chart' || template === 'note') return { kind: 'template', template };
  if (params.get('new') === '1') return { kind: 'new' };
  return params.get('import') === '1' ? { kind: 'import' } : null;
}
export function draftTemplate(name: DraftTemplate) {
  const label = name === 'mermaid' ? '流程图' : name === 'chart' ? '数据图表' : '提示块';
  return {
    title: `${label} · 演示草稿`, description: `${label}模板，替换为自己的内容后即可发布。`,
    source: `> **演示模板** · 以下内容只用于展示写法，请替换为自己的记录。\n\n## ${label}\n\n${blockTemplate(name) || ''}\n`,
  };
}
export function imageValidationMessage(file: Pick<File, 'type' | 'size'>): string {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) return '只支持 PNG、JPEG、GIF 和 WebP 图片。';
  if (!file.size) return '图片文件为空，请选择另一张图片。';
  return file.size > 8 * 1024 * 1024 ? '单张图片不能超过 8 MB。' : '';
}
export function mapSelection(before: string, after: string, selection: SelectionRange): SelectionRange {
  if (before === after) return { ...selection };
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) ++prefix;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) ++suffix;
  const oldEnd = before.length - suffix, newEnd = after.length - suffix;
  const map = (at: number) => at <= prefix ? at : at >= oldEnd ? at + after.length - before.length : newEnd;
  if (selection.start !== selection.end && selection.start < oldEnd && selection.end > prefix) return { start: newEnd, end: newEnd };
  return { start: map(selection.start), end: map(selection.end) };
}
