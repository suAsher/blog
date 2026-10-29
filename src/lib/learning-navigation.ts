/** Reading order uses published availability, never a working draft fallback. */
export function lessonNeighbors(
  chapters: { title: string; documentIds: string[] }[],
  published: Set<string>,
  current: string,
) {
  const lessons = chapters.flatMap((chapter) =>
    chapter.documentIds
      .filter((id) => published.has(id))
      .map((id) => ({ id, chapter: chapter.title })),
  );
  const at = lessons.findIndex((lesson) => lesson.id === current);
  if (at < 0) return null;
  return {
    chapter: lessons[at].chapter,
    index: at + 1,
    total: lessons.length,
    previous: lessons[at - 1]?.id ?? null,
    next: lessons[at + 1]?.id ?? null,
  };
}
