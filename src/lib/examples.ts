/** A production exclusion removes routes and data, rather than hiding links. */
export function exampleContentEnabled(value: unknown): boolean {
  if (value === undefined || value === '1') return true;
  if (value === '0') return false;
  throw new Error('BLOG_INCLUDE_EXAMPLES 必须为 0 或 1。');
}

export function shouldUseExamples(search: string, enabled: boolean): boolean {
  return enabled && new URLSearchParams(search).get('examples') === '1';
}
