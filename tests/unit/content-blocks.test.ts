import { describe, expect, it } from 'vitest';
import { parseChart, validateDiagram, parseCallout, blockTemplate } from '../../src/lib/content-blocks';
const chart = { title: '演示趋势', type: 'line', labels: ['一','二'], series: [{ name: '草稿', values: [1, 2] }] };
describe('interactive content boundaries', () => {
  it('parses immutable bounded chart series', () => { const value=parseChart(JSON.stringify(chart)); expect(value).toEqual(chart); expect(value.series[0].values).not.toBe(chart.series[0].values); });
  it('supports bar charts and a default line type', () => { expect(parseChart(JSON.stringify({...chart,type:'bar'})).type).toBe('bar'); const {type,...plain}=chart; expect(parseChart(JSON.stringify(plain)).type).toBe('line'); });
  it.each(['bad','null','[]','{}',JSON.stringify({...chart,type:'pie'}), JSON.stringify({...chart,labels:[]}), JSON.stringify({...chart,series:[]}), JSON.stringify({...chart,series:[{name:'bad',values:[1]}]}), JSON.stringify({...chart,series:[{name:'bad',values:[1,null]}]}), JSON.stringify({...chart,series:[{name:'bad',values:[1,'2']}]}), JSON.stringify({...chart,title:'x'.repeat(121)}), 'x'.repeat(20001)])('rejects malformed or unbounded charts %#', input => { expect(()=>parseChart(input)).toThrow(); });
  it('bounds labels, series and finite values', () => {
    for(const input of [ {...chart,labels:Array(61).fill('a')}, {...chart,series:Array(7).fill(chart.series[0])}, {...chart,labels:['x'.repeat(81),'b']}, {...chart,series:[{name:'x'.repeat(81),values:[1,2]}]}, {...chart,series:[{name:'x',values:[1,1e20]}]} ])expect(()=>parseChart(JSON.stringify(input))).toThrow();
  });
  it('accepts safe Mermaid and rejects directives, links, HTML, unsupported types and size', () => {
    expect(validateDiagram('flowchart LR\nA[问题] --> B[验证]')).toContain('flowchart');
    for(const text of ['', 'x'.repeat(20001), '%%{init: {}}%%\nflowchart LR\nA-->B', '---\nconfig: x\n---\nflowchart LR\nA-->B','flowchart LR\nclick A "https://x.invalid"','flowchart LR\nA[<img src=x>]','flowchart LR\nA --> B\n'+Array(251).fill('A-->B').join('\n'),'gantt\nx', 'flowchart LR\n'+Array(251).fill('A[节点]').join(' '), 'flowchart LR\n'+Array(201).fill('A').join(';')])expect(()=>validateDiagram(text)).toThrow();
  });
  it('accepts bounded sequence and class diagram arrows', () => {
    expect(validateDiagram('sequenceDiagram\nAlice->>Bob: 问题\nBob-->>Alice: 答案')).toContain('Alice');
    expect(validateDiagram('classDiagram\nAnimal <|-- Duck')).toContain('Duck');
  });
  it('recognizes a first-line callout and preserves body text', () => { expect(parseCallout('[!TIP]\n先保留上下文')).toEqual({kind:'tip',label:'提示',body:'先保留上下文'}); expect(parseCallout('[!NOTE] 标题\n正文')).toEqual({kind:'note',label:'标题',body:'正文'}); expect(parseCallout('[!WARNING]\n注意')).toMatchObject({kind:'warning'}); expect(parseCallout('普通引用')).toBeNull(); });
  it('offers only known safe templates', () => { expect(blockTemplate('mermaid')).toContain('```mermaid'); expect(blockTemplate('chart')).toContain('```chart'); expect(blockTemplate('note')).toContain('[!NOTE]'); expect(blockTemplate('missing')).toBeNull(); });
});
