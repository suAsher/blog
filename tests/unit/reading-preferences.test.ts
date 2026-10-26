import { describe, expect, it } from 'vitest';
import { DEFAULT_READING_PREFERENCES, parseReadingPreferences, readingVariables } from '../../src/lib/reading-preferences';

describe('reading preferences', () => {
  it('uses comfortable defaults for missing, malformed or non-object storage', () => {
    for (const value of [null, '', 'not-json', '[]', 'null', '42', 'x'.repeat(2049)]) {
      expect(parseReadingPreferences(value)).toEqual(DEFAULT_READING_PREFERENCES);
    }
  });
  it('restores only supported bounded values and ignores arbitrary styles', () => {
    expect(parseReadingPreferences('{"fontSize":21,"width":860,"lineHeight":2.2,"css":"bad"}')).toEqual({ fontSize:21,width:860,lineHeight:2.2 });
    expect(parseReadingPreferences('{"fontSize":10000,"width":"860","lineHeight":0}')).toEqual(DEFAULT_READING_PREFERENCES);
  });
  it('validates fields independently and returns fresh immutable preference objects', () => {
    const valid=parseReadingPreferences('{"fontSize":17,"width":680}');
    expect(valid).toEqual({fontSize:17,width:680,lineHeight:2});
    expect(parseReadingPreferences(null)).not.toBe(DEFAULT_READING_PREFERENCES);
    expect(readingVariables(valid)).toEqual({ '--reading-font-size':'17px','--reading-column':'680px','--reading-line-height':'2' });
  });
});
