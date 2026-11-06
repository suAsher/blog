import { describe, expect, it } from "vitest";
import {
  proposeImportRoute, routeInput, assignImportLesson, moveImportItem,
  type RouteImportReport,
} from "../../src/lib/import-route";

const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
const doc = (id: string, title = id, status = "draft") => ({ id, title, status });
const report = (outcomes: RouteImportReport["outcomes"]): RouteImportReport => ({
  id: "f".repeat(32), imported: [doc(a), doc(b), doc(c)], updated: [],
  outcomes, unresolvedImages: [],
});
const outcome = (path: string, id: string, status = "create") => ({path, id, status});

describe("import route proposal", () => {
  it("uses directory hierarchy, natural order, and live titles without modifying report", () => {
    const input = report([outcome("Go/02 并发/10 worker.md", b), outcome("Go/01 入门/02 开始.md", a)]);
    const value = proposeImportRoute(input, [doc(a, "第一课"), doc(b, "工作池")]);
    expect(value.title).toBe("Go");
    expect(value.chapters.map(item => item.title)).toEqual(["01 入门", "02 并发"]);
    expect(value.lessons.map(item => item.title)).toEqual(["第一课", "工作池"]);
    expect(input.outcomes![0].path).toBe("Go/02 并发/10 worker.md");
  });
  it("does not include skipped, duplicate, unresolved, unknown, trash or unsafe outcomes", () => {
    const input = report([
      outcome("Root/a.md", a), outcome("Root/duplicate.md", a),
      outcome("Root/b.md", b), outcome("Root/c.md", c),
      outcome("Root/skipped.md", "d".repeat(32), "skipped"),
      outcome("../escape.md", "e".repeat(32)),
    ]);
    input.unresolvedImages = [{document: "Root/b.md", path: "missing.png"}];
    const value = proposeImportRoute(input, [doc(a), doc(b), doc(c, "trash", "trash")]);
    expect(value.lessons.map(item => item.id)).toEqual([a]);
    expect(proposeImportRoute({...input, outcomes: undefined}, [doc(a)]).lessons).toEqual([]);
  });
  it("supports flat uploads, editable assignment, skipping, and boundary-safe reordering", () => {
    const value = proposeImportRoute(report([outcome("a.md", a), outcome("b.txt", b)]), [doc(a), doc(b)]);
    expect(value.title).toBe("导入资料学习路线");
    expect(value.chapters[0].title).toBe("起步与资料");
    const withChapter = {...value, chapters: [...value.chapters, {id: "extra", title:"进阶"}]};
    const assigned = assignImportLesson(withChapter, a, "extra");
    expect(assigned.lessons[0].chapterId).toBe("extra");
    expect(value.lessons[0].chapterId).not.toBe("extra");
    expect(assignImportLesson(value, a, "unknown")).toEqual(value);
    const skipped = assignImportLesson(assigned, b, "");
    expect(routeInput(skipped).chapters).toEqual([{id:"extra",title:"进阶",description:"",documentIds:[a]}]);
    expect(moveImportItem([a,b], a, -1)).toEqual([a,b]);
    expect(moveImportItem([a,b], a, 1)).toEqual([b,a]);
    expect(moveImportItem([a,b], "unknown", 1)).toEqual([a,b]);
  });
  it("accepts verified updates but rejects an over-budget proposal before any truncation", () => {
    const value = report([outcome("Root/a.md", a, "update")]);
    value.imported = [];
    value.updated = [doc(a)];
    expect(proposeImportRoute(value, [doc(a)]).lessons).toHaveLength(1);
    const many = Array.from({length:301}, (_,index) => doc(index.toString(16).padStart(32,"0")));
    expect(() => proposeImportRoute({
      ...report(many.map(item => outcome(`${item.id}.md`, item.id))), imported: many,
    }, many)).toThrow("300");
  });
  it("rejects invalid report identities and bounded route inputs instead of silently truncating", () => {
    expect(() => proposeImportRoute({...report([]), id:"../x"}, [])).toThrow();
    const value = proposeImportRoute(report([outcome("a.md", a)]), [doc(a)]);
    expect(() => routeInput({...value, title:""})).toThrow();
    expect(() => routeInput({...value, lessons:[]})).toThrow();
    expect(() => routeInput({...value, chapters: [{id:"first",title:""}], lessons:[{...value.lessons[0],chapterId:"first"}]})).toThrow();
    expect(routeInput(value).creationKey).toBe(`import-${"f".repeat(32)}`);
    expect(() => routeInput({...value, chapters: Array.from({length:31},(_,i)=>({id:`c${i}`,title:`C${i}`})), lessons: Array.from({length:31},(_,i)=>({...value.lessons[0],id:i.toString(16).padStart(32,"0"),chapterId:`c${i}`}))})).toThrow();
  });
});
