/** Finish optional text decoration before anchors are created, or keep plain text.
 * A late module may load, but it must never rewrite an already active selection.
 */
export async function optionalEnhancement<T>(
  loaded: Promise<T>,
  apply: (value: T) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      loaded.then((value) => ({ value })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1500);
      }),
    ]);
    if (result) apply(result.value);
  } catch {
    // Optional decoration failed; the original text remains the reading source.
  } finally {
    clearTimeout(timer);
  }
}
