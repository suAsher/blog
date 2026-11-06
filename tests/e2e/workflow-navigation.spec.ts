import { test, expect } from "./fixtures";

test("organizing and precise search are reachable through writing and keyboard commands", async ({
  page,
}) => {
  await page.goto("/manage/");
  await page.getByRole("link", { name: "资料收件箱", exact: true }).click();
  await page.waitForLoadState("load");
  await expect(page).toHaveURL(/\/inbox\/(?:\?.*)?$/);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "在知识里，找一点灵感" });
  await dialog.getByRole("searchbox", { name: "全文搜索" }).fill("> 段落");
  const search = dialog.getByRole("link", { name: /段落检索/ });
  await expect(search).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(search).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\/$/);
  await page.goBack();
  await page.waitForLoadState("load");
  await expect(page).toHaveURL(/\/inbox\/(?:\?.*)?$/);
  await page.keyboard.press("ControlOrMeta+k");
  await dialog.getByRole("searchbox", { name: "全文搜索" }).fill("> 收件箱");
  await expect(dialog.getByRole("link", { name: /资料收件箱/ })).toBeVisible();
});

test("article discovery retains full article search and offers passage search", async ({
  page,
}) => {
  await page.goto("/articles/");
  await expect(
    page.getByRole("link", { name: "按段落检索", exact: true }),
  ).toHaveAttribute("href", "/search/");
  await page.getByRole("button", { name: "搜索文章", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "在知识里，找一点灵感" });
  await dialog
    .getByRole("searchbox", { name: "全文搜索" })
    .fill("暂不存在的 QA 关键词");
  const link = dialog.getByRole("link", {
    name: "定位正文与代码中的段落 →",
    exact: true,
  });
  await expect(link).toHaveAttribute(
    "href",
    "/search/?q=" + encodeURIComponent("暂不存在的 QA 关键词"),
  );
  await expect(
    dialog.getByRole("link", { name: "查看全部搜索结果 →", exact: true }),
  ).toBeVisible();
});
