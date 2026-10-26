import { describe, expect, it } from 'vitest';
import { commandMatches, highlightSegments, nextCommandIndex } from '../../src/lib/commands';

describe('command palette helpers', () => {
  it('matches command mode, Chinese names and case-insensitive aliases', () => {
    expect(commandMatches('新建文档', ['new', 'write'], '>')).toBe(true);
    expect(commandMatches('新建文档', ['new', 'write'], '> NEW')).toBe(true);
    expect(commandMatches('导入文档', ['import'], '导入')).toBe(true);
    expect(commandMatches('导入文档', ['import'], '不存在')).toBe(false);
  });
  it('preserves literal potentially unsafe text as data while highlighting tokens', () => {
    expect(highlightSegments('<script>中文 search</script>', '中文 search')).toEqual([
      { text: '<script>', match: false }, { text: '中文', match: true }, { text: ' ', match: false },
      { text: 'search', match: true }, { text: '</script>', match: false },
    ]);
    expect(highlightSegments('a+b a.b', 'a+b')).toEqual([{ text: 'a+b', match: true }, { text: ' a.b', match: false }]);
  });
  it('merges overlapping tokens and handles empty and repeated input', () => {
    expect(highlightSegments('ababa', 'aba bab')).toEqual([{ text: 'ababa', match: true }]);
    expect(highlightSegments('Text TEXT', 'text')).toEqual([{ text: 'Text', match: true }, { text: ' ', match: false }, { text: 'TEXT', match: true }]);
    expect(highlightSegments('', 'x')).toEqual([]);
    expect(highlightSegments('hello', '')).toEqual([{ text: 'hello', match: false }]);
    expect(highlightSegments('hello', 'not found')).toEqual([{ text: 'hello', match: false }]);
  });
  it('cycles the keyboard selection without an invalid index', () => {
    expect(nextCommandIndex(-1, 3, 1)).toBe(0);
    expect(nextCommandIndex(-1, 3, -1)).toBe(2);
    expect(nextCommandIndex(2, 3, 1)).toBe(0);
    expect(nextCommandIndex(0, 3, -1)).toBe(2);
    expect(nextCommandIndex(1, 3, 1)).toBe(2);
    expect(nextCommandIndex(1, 0, 1)).toBe(-1);
  });
});
