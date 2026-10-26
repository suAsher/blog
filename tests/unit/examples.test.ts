import { describe, expect, it } from 'vitest';
import { exampleContentEnabled, shouldUseExamples } from '../../src/lib/examples';

describe('build-time example content policy', () => {
  it('retains labeled examples by default and disables them explicitly', () => {
    expect(exampleContentEnabled(undefined)).toBe(true);
    expect(exampleContentEnabled('1')).toBe(true);
    expect(exampleContentEnabled('0')).toBe(false);
  });

  it.each(['', 'false', 'true', 0, null])('rejects an ambiguous build flag: %j', value => {
    expect(() => exampleContentEnabled(value)).toThrow('BLOG_INCLUDE_EXAMPLES');
  });

  it('never lets a query string re-enable excluded content', () => {
    expect(shouldUseExamples('?examples=1', false)).toBe(false);
    expect(shouldUseExamples('?q=学习&examples=1', true)).toBe(true);
    expect(shouldUseExamples('?examples=0', true)).toBe(false);
    expect(shouldUseExamples('', true)).toBe(false);
  });
});
