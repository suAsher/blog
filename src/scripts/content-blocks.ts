import { parseCallout, parseChart, validateDiagram, type ChartSpec } from '../lib/content-blocks';
import '../styles/content-blocks.css';
import { scheduleExplorers } from './explorers/loader';

const NS = 'http://www.w3.org/2000/svg';
const darkColors = ['#8ce3c4', '#a9a0ef', '#e6b985', '#7ac8dd', '#e498ba', '#b1cc77'];
const lightColors = ['#23765c', '#6e55a6', '#99612c', '#257a94', '#9d4879', '#58752f'];
const palette = () => document.documentElement.dataset.theme === 'light' ? lightColors : darkColors;
let themeObserver: MutationObserver | undefined;
function watchTheme() {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => document.querySelectorAll('.chart-widget').forEach(chart => chart.dispatchEvent(new Event('content-theme'))));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
class DiagramLoaderError extends Error {}
let diagramNumber = 0;
let diagramQueue: Promise<unknown> = Promise.resolve();
let mermaidModule: Promise<typeof import('mermaid')> | undefined;
const pendingDiagrams = new Map<HTMLElement, () => void>();
let diagramObserver: IntersectionObserver | undefined;
function loadDiagramModule(): Promise<typeof import('mermaid')> {
  mermaidModule ||= import('mermaid').then(module => {
    if (typeof module.default?.initialize !== 'function' || typeof module.default?.render !== 'function') throw new DiagramLoaderError();
    return module;
  }).catch(() => {
    mermaidModule = undefined;
    throw new DiagramLoaderError('流程图组件暂时未能加载，原始定义仍可阅读。网络恢复后，请刷新页面并重试。');
  });
  return mermaidModule;
}
function isModuleFailure(error: unknown) {
  return error instanceof DiagramLoaderError || error instanceof Error && /fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|failed to load module script|failed to fetch|load failed/i.test(error.message);
}
function refreshControl(problem: HTMLElement) {
  const status = node('span', 'widget-reload-status');
  const control = button('刷新页面并重试', () => {
    if (control.disabled) return;
    control.disabled = true; control.textContent = '正在安全刷新…'; status.textContent = '';
    const gates: Promise<boolean>[] = [];
    const waitUntil = (task: Promise<boolean>) => { gates.push(Promise.resolve(task)); };
    document.dispatchEvent(new CustomEvent('content:before-reload', { detail: { waitUntil } }));
    void Promise.all(gates).then(results => {
      if (results.every(saved => saved === true)) location.reload();
      else status.textContent = '当前修改尚未安全保存，未刷新页面。请先处理保存提示后重试。 ';
    }).catch(() => {
      status.textContent = '保存检查未完成，未刷新页面。原文和当前编辑仍保留。 ';
    }).finally(() => { control.disabled = false; control.textContent = '刷新页面并重试'; });
  });
  control.setAttribute('aria-label', '刷新页面并重试流程图');
  problem.append(status, control);
}
function scheduleDiagram(figure: HTMLElement, render: () => void) {
  if (typeof IntersectionObserver === 'undefined') { render(); return; }
  diagramObserver ||= new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const target = entry.target as HTMLElement;
      const callback = pendingDiagrams.get(target); pendingDiagrams.delete(target); diagramObserver?.unobserve(target);
      if (target.isConnected) callback?.();
    });
  }, { rootMargin: '350px' });
  pendingDiagrams.set(figure, render); diagramObserver.observe(figure);
}
function clearDetachedDiagrams() {
  pendingDiagrams.forEach((_, figure) => { if (!figure.isConnected) { diagramObserver?.unobserve(figure); pendingDiagrams.delete(figure); } });
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
}
function button(label: string, action: () => void) {
  const control = node('button', 'widget-button', label); control.type = 'button'; control.addEventListener('click', action); return control;
}
function svgNode(tag: string, attributes: Record<string, string | number> = {}, text = '') {
  const element = document.createElementNS(NS, tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  element.textContent = text; return element;
}
function widget(pre: HTMLElement, title: string, kind: string) {
  const figure = node('figure', `content-widget ${kind}-widget`);
  const header = node('div', 'widget-header');
  const caption = node('figcaption', '', title);
  const badge = node('span', 'widget-badge', 'INTERACTIVE');
  const tools = node('div', 'widget-tools');
  const source = node('details', 'widget-source');
  source.append(node('summary', '', '查看原始定义'));
  tools.append(button('原文', () => { source.open = !source.open; }));
  header.append(badge, caption, tools); figure.append(header);
  pre.replaceWith(figure); source.append(pre); figure.append(source);
  return { figure, tools, source };
}
function failed(figure: HTMLElement, source: HTMLDetailsElement, error: unknown) {
  const message = node('p', 'widget-error', error instanceof Error ? error.message : '暂时无法渲染，原始内容仍可阅读。');
  message.setAttribute('role', 'status'); figure.insertBefore(message, source); source.open = true; return message;
}
function safeDiagramSVG(svg: string): SVGElement {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('流程图渲染结果无效，请查看原文。');
  parsed.querySelectorAll('script,foreignObject,image,iframe,object,embed').forEach(element => element.remove());
  parsed.querySelectorAll('*').forEach(element => {
    [...element.attributes].forEach(attribute => {
      if (/^on/i.test(attribute.name) || (/(?:^|:)href$/i.test(attribute.name) && !attribute.value.startsWith('#'))) element.removeAttribute(attribute.name);
    });
  });
  return document.importNode(parsed.documentElement, true) as unknown as SVGElement;
}
function diagram(pre: HTMLElement, source: string) {
  const { figure, tools, source: original } = widget(pre, '把关系画出来', 'diagram');
  let definition: string;
  try { definition = validateDiagram(source); } catch (error) { failed(figure, original, error); return; }
  const viewport = node('div', 'diagram-viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', '流程图，可缩放并横向滚动');
  const stage = node('div', 'diagram-stage'); stage.append(node('p', 'widget-loading', '正在本地绘制流程图…')); viewport.append(stage); figure.insertBefore(viewport, original);
  let scale = 1;
  const applyScale = () => { stage.style.width = `${scale * 100}%`; stage.style.minWidth = `${scale * 100}%`; };
  tools.prepend(button('−', () => { scale = Math.max(0.5, scale - 0.25); applyScale(); }), button('＋', () => { scale = Math.min(2.5, scale + 0.25); applyScale(); }), button('还原', () => { scale = 1; applyScale(); }));
  tools.querySelectorAll('button')[0]?.setAttribute('aria-label', '缩小流程图');
  tools.querySelectorAll('button')[1]?.setAttribute('aria-label', '放大流程图');
  let rendering = false;
  const render = () => {
    if (rendering) return; rendering = true;
    figure.querySelectorAll(':scope > .widget-error').forEach(error => error.remove());
    stage.replaceChildren(node('p', 'widget-loading', '正在本地绘制流程图…'));
    diagramQueue = diagramQueue.catch(() => undefined).then(async () => {
    if (!figure.isConnected) return;
    try {
      const mermaid = (await loadDiagramModule()).default;
      if (!figure.isConnected) return;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 20_000, maxEdges: 250, suppressErrorRendering: true,
        htmlLabels: false, theme: 'base', fontFamily: 'system-ui, sans-serif',
        flowchart: { htmlLabels: false, useMaxWidth: true, curve: 'basis' },
        themeVariables: { primaryColor: '#182c2b', primaryTextColor: '#dfeee9', primaryBorderColor: '#609b8a', lineColor: '#7bb9a4', secondaryColor: '#242b43', tertiaryColor: '#17222a' } });
      const rendered = await mermaid.render(`asher-diagram-${++diagramNumber}`, definition);
      if (!figure.isConnected) return;
      const svg = safeDiagramSVG(rendered.svg); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '文档中的交互流程图');
      svg.style.maxWidth = 'none'; svg.style.width = '100%'; svg.removeAttribute('height');
      stage.replaceChildren(svg); figure.dataset.ready = 'true'; window.dispatchEvent(new Event('resize'));
    } catch (error) {
      stage.replaceChildren();
      const moduleFailure = isModuleFailure(error);
      const message = moduleFailure ? '流程图组件或其依赖暂时未能加载，原始定义仍可阅读。网络恢复后，请刷新页面并重试。' : error instanceof Error && /maximum|limit|size/i.test(error.message) ? '流程图超过安全渲染限额，请拆分为更小的图。' : '流程图语法暂时无法解析，请展开原文检查后修改。';
      const problem = failed(figure, original, new Error(message));
      if (moduleFailure) refreshControl(problem);
    }
  }).finally(() => { rendering = false; }); };
  scheduleDiagram(figure, render);
}
function dataTable(spec: ChartSpec) {
  const details = node('details', 'chart-data'); details.append(node('summary', '', '查看完整数据表'));
  const table = node('table'); const head = node('thead'); const row = node('tr'); row.append(node('th', '', '项目'));
  spec.series.forEach(series => row.append(node('th', '', series.name))); head.append(row); table.append(head);
  const body = node('tbody');
  spec.labels.forEach((label, index) => { const tr = node('tr'); tr.append(node('th', '', label)); spec.series.forEach(series => tr.append(node('td', '', String(series.values[index])))); body.append(tr); });
  table.append(body); details.append(table); return details;
}
function chart(pre: HTMLElement, source: string) {
  const { figure, source: original } = widget(pre, '数据里的线索', 'chart');
  let spec: ChartSpec;
  try { spec = parseChart(source); } catch (error) { failed(figure, original, error); return; }
  figure.querySelector('figcaption')!.textContent = spec.title;
  const legend = node('div', 'chart-legend'); legend.setAttribute('role', 'group'); legend.setAttribute('aria-label', '切换图表数据系列');
  const plot = node('div', 'chart-plot'); const reading = node('p', 'chart-reading', '悬停或用 Tab 聚焦数据点，查看对应数值。'); reading.setAttribute('aria-live', 'polite');
  const shown = new Set(spec.series.map((_, index) => index));
  const draw = () => {
    const colors = palette();
    legend.querySelectorAll<HTMLElement>('button').forEach((button, index) => button.style.setProperty('--series-color', colors[index]));
    const visible = spec.series.map((series, index) => ({ ...series, index })).filter(series => shown.has(series.index));
    plot.replaceChildren();
    if (!visible.length) { plot.append(node('p', 'chart-empty', '所有系列已隐藏，点击上方名称重新显示。')); return; }
    const values = visible.flatMap(series => series.values);
    const low = Math.min(0, ...values); const high = Math.max(1, ...values); const range = high - low;
    const width = 720, height = 310, left = 58, right = 22, top = 25, bottom = 45;
    const innerWidth = width - left - right, innerHeight = height - top - bottom;
    const x = (index: number) => left + innerWidth * (index + 0.5) / spec.labels.length;
    const y = (value: number) => top + innerHeight * (high - value) / range;
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${spec.title}，${spec.type === 'bar' ? '柱状图' : '折线图'}` });
    for (let step = 0; step < 5; step++) {
      const value = low + range * step / 4; const lineY = y(value);
      svg.append(svgNode('line', { x1: left, y1: lineY, x2: width - right, y2: lineY, class: 'chart-gridline' }));
      svg.append(svgNode('text', { x: left - 10, y: lineY + 4, 'text-anchor': 'end', class: 'chart-axis' }, Number(value.toPrecision(4)).toLocaleString()));
    }
    const stride = Math.max(1, Math.ceil(spec.labels.length / 8));
    spec.labels.forEach((label, index) => { if (index % stride === 0 || index === spec.labels.length - 1) svg.append(svgNode('text', { x: x(index), y: height - 17, 'text-anchor': 'middle', class: 'chart-axis' }, label.length > 9 ? label.slice(0, 8) + '…' : label)); });
    visible.forEach((series, visibleIndex) => {
      const color = colors[series.index];
      if (spec.type === 'line') svg.append(svgNode('polyline', { points: series.values.map((value, index) => `${x(index)},${y(value)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      series.values.forEach((value, index) => {
        const barWidth = Math.min(32, innerWidth / spec.labels.length / (visible.length + 1));
        const point = spec.type === 'line' ? svgNode('circle', { cx: x(index), cy: y(value), r: 4.5, fill: color }) :
          svgNode('rect', { x: x(index) + (visibleIndex - visible.length / 2) * barWidth, y: Math.min(y(0), y(value)), width: Math.max(2, barWidth - 2), height: Math.max(1, Math.abs(y(0) - y(value))), rx: 3, fill: color });
        const detail = `${spec.labels[index]} · ${series.name}：${value}`;
        point.setAttribute('tabindex', '0'); point.setAttribute('role', 'img'); point.setAttribute('aria-label', detail); point.classList.add('chart-point'); point.append(svgNode('title', {}, detail));
        point.addEventListener('mouseenter', () => { reading.textContent = detail; }); point.addEventListener('focus', () => { reading.textContent = detail; }); svg.append(point);
      });
    });
    plot.append(svg);
  };
  spec.series.forEach((series, index) => {
    const control = button(series.name, () => { if (shown.has(index)) shown.delete(index); else shown.add(index); control.setAttribute('aria-pressed', String(shown.has(index))); draw(); });
    control.setAttribute('aria-pressed', 'true'); control.style.setProperty('--series-color', palette()[index]); legend.append(control);
  });
  watchTheme(); figure.addEventListener('content-theme', draw);
  figure.insertBefore(legend, original); figure.insertBefore(plot, original); figure.insertBefore(reading, original); figure.insertBefore(dataTable(spec), original); draw();
}
function callouts(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('blockquote:not([data-callout-ready])').forEach(quote => {
    const first = quote.querySelector('p'); if (!first) return;
    const text = first.cloneNode(true) as HTMLElement;
    text.querySelectorAll('br').forEach(lineBreak => lineBreak.replaceWith(document.createTextNode('\n')));
    const definition = parseCallout(text.textContent || ''); if (!definition) return;
    quote.dataset.calloutReady = 'true'; quote.classList.add('content-callout', `callout-${definition.kind}`);
    const heading = node('strong', 'callout-heading', definition.label);
    const firstText = first.firstChild;
    if (firstText?.nodeType === Node.TEXT_NODE) firstText.textContent = firstText.textContent?.replace(/^\[!(?:NOTE|TIP|WARNING)\][^\r\n]*(?:\r?\n)?/, '') || '';
    if (!first.textContent?.trim()) first.remove();
    quote.prepend(heading);
  });
}
/** Enhance server-sanitized content only. Ordinary code stays untouched; repeated calls are safe. */
export function enhanceContent(root: HTMLElement): void {
  clearDetachedDiagrams();
  callouts(root);
  scheduleExplorers(root);
  let diagrams = 0, charts = 0;
  root.querySelectorAll<HTMLElement>('pre > code').forEach(code => {
    if (code.closest('.content-widget')) return;
    const pre = code.parentElement!;
    const language = code.dataset.language || pre.dataset.language || /(?:^|\s)language-([^\s]+)/.exec(code.className)?.[1];
    if (language !== 'mermaid' && language !== 'chart') return;
    const source = code.textContent || '';
    if ((language === 'mermaid' ? ++diagrams > 6 : ++charts > 12)) {
      const result = widget(pre, '内容保留为原文', language); failed(result.figure, result.source, new Error('每篇最多增强 6 张流程图和 12 张图表，其余定义保留为原文。')); return;
    }
    if (language === 'mermaid') diagram(pre, source); else chart(pre, source);
  });
}
