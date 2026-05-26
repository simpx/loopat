/**
 * /loop page e2e tests.
 *
 * The test server runs in an isolated temp LOOPAT_HOME. globalSetup
 * registers a user and creates test data; the session cookie is loaded
 * via storageState. No mocking — these test the real UI against a real
 * (isolated) backend.
 */
import { test, expect } from "@playwright/test";

test.describe("/loop page", () => {
  test.beforeEach(async ({ page }) => {
    // Bypass the "Setup Personal Repo" card for fresh accounts.
    await page.addInitScript(() => {
      localStorage.setItem("loopat:setupPersonalRepoDismissed", "1");
    });
  });

  test("redirects / to /loop", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/loop/);
  });

  test("shows loop list sidebar with active loops", async ({ page }) => {
    await page.goto("/loop");

    await expect(page.locator("aside")).toBeVisible({ timeout: 10_000 });

    const sidebar = page.locator("aside");

    await expect(sidebar.getByText("测试任务：修复登录页bug")).toBeVisible();
    await expect(sidebar.getByText("设计新的 Dashboard 页面")).toBeVisible();
    await expect(sidebar.getByText("接入第三方支付")).toBeVisible();

    // Archived loop hidden by default
    await expect(sidebar.getByText("优化数据库查询性能")).not.toBeVisible();
  });

  test("search filters loops by title", async ({ page }) => {
    await page.goto("/loop");
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder("search loops…").fill("Dashboard");

    await expect(sidebar.getByText("设计新的 Dashboard 页面")).toBeVisible();
    await expect(sidebar.getByText("测试任务：修复登录页bug")).not.toBeVisible();
  });

  test("search clears when no match", async ({ page }) => {
    await page.goto("/loop");
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder("search loops…").fill("nonexistent-xyz");

    await expect(sidebar.getByText("测试任务：修复登录页bug")).not.toBeVisible();
    await expect(sidebar.getByText("设计新的 Dashboard 页面")).not.toBeVisible();
  });

  test("archive toggle shows/hides archived loops", async ({ page }) => {
    await page.goto("/loop");
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    await page.locator('[title="show archived"]').click();
    await expect(sidebar.getByText("优化数据库查询性能")).toBeVisible();

    await page.locator('[title="hide archived"]').click();
    await expect(sidebar.getByText("优化数据库查询性能")).not.toBeVisible();
  });

  test("clicking a loop navigates to /loop/:id", async ({ page }) => {
    await page.goto("/loop");
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    await sidebar.getByText("设计新的 Dashboard 页面").click();

    await expect(page).toHaveURL(/\/loop\/[a-f0-9-]+/);
  });

  test("loop detail page shows title and mode buttons", async ({ page }) => {
    await page.goto("/loop");
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // Title appears in sidebar and as a click-to-rename span in the header.
    await expect(page.locator('[title="click to rename"]')).toBeVisible();
    await expect(page.getByText("info")).toBeVisible();
  });

  test("RFD badge shown for RFD-tagged loops", async ({ page }) => {
    await page.goto("/loop");
    await expect(page.locator("aside")).toBeVisible({ timeout: 10_000 });

    // RFD badge (the amber tag on loop row, not the filter tab)
    await expect(page.locator("aside span.text-amber-800")).toBeVisible();
  });

  test("creates a loop via NewLoopDialog hitting v1 API", async ({ page }) => {
    await page.goto("/loop");
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // Capture the create request (set up AFTER navigation so we don't time
    // out on unrelated traffic). The v1 endpoint is what we assert below.
    const createReq = page.waitForRequest(
      (req) => req.url().includes("/api/v1/loops") && req.method() === "POST",
      { timeout: 15_000 },
    );

    // Open NewLoopDialog (header button — App.tsx:168).
    await page.getByRole("button", { name: /^\+ New Loop$/i }).click();
    await expect(page.getByText("New loop", { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.getByPlaceholder("refactor-gateway").fill("v1-e2e-create");
    await page.getByRole("button", { name: "create", exact: true }).click();

    const req = await createReq;
    expect(req.url()).toContain("/api/v1/loops");
    const body = req.postDataJSON();
    expect(body.title).toBe("v1-e2e-create");

    // Navigation to the new loop's page (the create resolves async).
    await expect(page).toHaveURL(/\/loop\/[a-f0-9-]+/, { timeout: 10_000 });
  });

  test("chat send + receive uses v1 API end-to-end", async ({ page }) => {
    // Walks through the full chat chain on the v1 surface:
    //   - GET  /api/v1/loops/:id/events   (live SSE subscription)
    //   - POST /api/v1/loops/:id/messages (user input)
    // We assert both fire; the actual model response isn't asserted because
    // the test env has no provider configured (would error out).

    // Capture the SSE subscription that useLoopRuntime opens on entry.
    const eventsReq = page.waitForRequest(
      (req) => /\/api\/v1\/loops\/loop_[a-f0-9-]+\/events/.test(req.url()),
      { timeout: 15_000 },
    );
    const sendReq = page.waitForRequest(
      (req) =>
        /\/api\/v1\/loops\/loop_[a-f0-9-]+\/messages/.test(req.url()) &&
        req.method() === "POST",
      { timeout: 15_000 },
    );

    await page.goto("/loop");
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // Open one of the seeded loops.
    await sidebar.getByText("测试任务：修复登录页bug").click();
    await expect(page).toHaveURL(/\/loop\/[a-f0-9-]+/);

    // /events should fire once the loop page mounts.
    const eventsR = await eventsReq;
    expect(eventsR.url()).toContain("/api/v1/loops/loop_");
    expect(eventsR.url()).toContain("/events");

    // Type into the chat composer (aria-label="Message input", Composer.tsx).
    const composer = page.getByLabel("Message input");
    await composer.fill("hello v1");
    await page.getByLabel(/Send message|Enqueue message/).click();

    const sendR = await sendReq;
    const body = sendR.postDataJSON();
    expect(body.content).toBe("hello v1");
    // permission_mode is optional but we send the current selector value.
    expect(typeof body.permission_mode === "string" || body.permission_mode === undefined).toBe(true);
  });

  test("scope tabs filter loops", async ({ page }) => {
    await page.goto("/loop");
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // "mine" scope (default) — active loops owned by test user
    await expect(sidebar.getByText("测试任务：修复登录页bug")).toBeVisible();
    await expect(sidebar.getByText("接入第三方支付")).toBeVisible();

    // "RFD" scope — only the RFD-tagged loop
    await page.getByRole("button", { name: "RFD", exact: true }).click();
    await expect(sidebar.getByText("接入第三方支付")).toBeVisible();
    await expect(sidebar.getByText("测试任务：修复登录页bug")).not.toBeVisible();
    await expect(sidebar.getByText("设计新的 Dashboard 页面")).not.toBeVisible();
  });
});
