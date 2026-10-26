export interface ReadingPreferences { readonly fontSize: number; readonly width: number; readonly lineHeight: number }
export const DEFAULT_READING_PREFERENCES: ReadingPreferences = Object.freeze({ fontSize:19, width:760, lineHeight:2 });
export function parseReadingPreferences(raw: string | null): ReadingPreferences {
  if (!raw || raw.length > 2048) return { ...DEFAULT_READING_PREFERENCES };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_READING_PREFERENCES };
    const fields = value as Record<string, unknown>;
    return {
      fontSize: [17,19,21].includes(fields.fontSize as number) ? fields.fontSize as number : 19,
      width: [680,760,860].includes(fields.width as number) ? fields.width as number : 760,
      lineHeight: [1.8,2,2.2].includes(fields.lineHeight as number) ? fields.lineHeight as number : 2,
    };
  } catch { return { ...DEFAULT_READING_PREFERENCES }; }
}
export function readingVariables(value: ReadingPreferences): Record<string,string> {
  return { '--reading-font-size':`${value.fontSize}px`, '--reading-column':`${value.width}px`, '--reading-line-height':String(value.lineHeight) };
}
