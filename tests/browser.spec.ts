import { expect, test, type Page } from "@playwright/test";
import type { ViewContext } from "../src/contract";

declare global {
  interface Window {
    magpie: {
      read(artifact: string): Promise<{ bytes: ArrayBuffer }>;
      proposeAnnotation(target: string, body: string): Promise<unknown>;
    };
  }
}

async function viewer(page: Page) {
  await page.goto("/");
  const frame = page.frameLocator('iframe[title="Isolated item viewer"]');
  await expect(frame.locator("#message")).toHaveText("Ready");
  return frame;
}

test("a custom viewer seeks and follows real playback; saving a note requires host confirmation", async ({ page, request }) => {
  const frame = await viewer(page);
  const context: ViewContext = await (await request.get("/api/context")).json();
  const original = context.item.originals.find((artifact) => artifact.mediaType.startsWith("video/"))!;
  const cues = context.generation.targets!.filter((target) => target.artifact === original.id && target.selector.kind === "time");
  expect(cues).toHaveLength(2);
  const selector = cues[1].selector;
  if (selector.kind !== "time") throw new Error("Expected a time target");

  // The fixed view retains readable content but has no synchronization affordance.
  await expect(page.locator("#fallback")).not.toBeEmpty();
  await expect(page.locator("#fallback button, #fallback video")).toHaveCount(0);
  await frame.locator("#cues button").nth(1).click();
  const video = frame.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(selector.startMs / 1000, 1);
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(selector.startMs / 1000 + 0.2);
  await expect(frame.locator("#time")).not.toHaveText((selector.startMs / 1000).toFixed(2) + " seconds");
  await video.evaluate((element: HTMLVideoElement) => element.pause());

  const body = "Keep this moment " + crypto.randomUUID();
  await frame.getByLabel("Note", { exact: true }).fill(body);
  await frame.getByRole("button", { name: "Propose note at selected cue" }).click();
  await expect(page.locator("#proposal-body")).toHaveText(body);
  const replacement = await frame.locator("body").evaluate(async (_, target) =>
    window.magpie.proposeAnnotation(target, "replace the visible note").then(() => "allowed", (error: Error) => error.message), cues[1].id);
  expect(replacement).toBe("A note is already awaiting confirmation");
  await expect(page.locator("#proposal-body")).toHaveText(body);
  const before: ViewContext = await (await request.get("/api/context")).json();
  expect(before.annotations.some((note) => note.body === body)).toBe(false);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator("#annotations")).toContainText(body);
  const after: ViewContext = await (await request.get("/api/context")).json();
  expect(after.annotations.find((note) => note.body === body)?.target).toBe(cues[1].id);

  await page.goto("/?item=parquet");
  await expect(page.locator("#title")).toHaveText("Parquet public summary");
  await expect(page.locator("#fallback")).not.toBeEmpty();
  await expect(page.locator("#viewer iframe")).toHaveCount(0);
});

test("the sandbox cannot access parent state, foreign objects, forged targets or commit a note", async ({ page, request }) => {
  const context: ViewContext = await (await request.get("/api/context")).json();
  const otherItem: ViewContext = await (await request.get("/api/context?item=parquet")).json();
  const component = context.generation.publication!.presentation.component!;
  // Delay the legitimate fixture's handshake so a hostile sibling races it.
  await page.route("**/api/artifacts/" + component, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('parent.postMessage({ type: "magpie:ready" }, "*");', 'setTimeout(() => parent.postMessage({ type: "magpie:ready" }, "*"), 500);');
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await expect(page.locator('iframe[title="Isolated item viewer"]')).toBeAttached();
  await page.evaluate((target) => {
    const spoof = document.createElement("iframe");
    spoof.id = "spoof";
    spoof.sandbox.add("allow-scripts");
    spoof.srcdoc = '<body><script>window.addEventListener("message",()=>document.body.dataset.received="yes");parent.postMessage({type:"magpie:ready"},"*");parent.postMessage(' + JSON.stringify({ id: "spoof", method: "proposeAnnotation", target, body: "spoofed note" }) + ',"*");</script></body>';
    document.body.append(spoof);
  }, context.generation.targets![0].id);
  const frame = page.frameLocator('iframe[title="Isolated item viewer"]');
  await expect(frame.locator("#message")).toHaveText("Ready");
  await expect(page.frameLocator("#spoof").locator("body")).not.toHaveAttribute("data-received", "yes");
  const before = context.annotations.length;
  const probe = await frame.locator("body").evaluate(async (_, foreignId) => {
    let parentDenied = false;
    try { void parent.document.body; } catch { parentDenied = true; }
    const foreign = await window.magpie.read(foreignId).then(() => "allowed", (error: Error) => error.message);
    const target = await window.magpie.proposeAnnotation("forged-target", "forged note").then(() => "allowed", (error: Error) => error.message);
    return { parentDenied, foreign, target };
  }, otherItem.item.originals[0].id);
  expect(probe).toEqual({ parentDenied: true, foreign: "Artifact not granted", target: "Target not granted" });
  await expect(page.locator("#proposal")).toBeHidden();

  const direct = await request.post("/api/annotations", { data: { target: context.generation.targets![0].id, body: "unconfirmed note" } });
  expect(direct.status()).toBe(403);
  const after: ViewContext = await (await request.get("/api/context")).json();
  expect(after.annotations).toHaveLength(before);
});

test("CSP prevents component fetch and cross-origin frame navigation before network egress", async ({ page }) => {
  let intercepted = 0;
  await page.route("http://127.0.0.1:4174/**", async (route) => { intercepted++; await route.abort(); });
  const frame = await viewer(page);
  const fetchResult = await frame.locator("body").evaluate(async () => {
    return fetch("http://127.0.0.1:4174/forbidden-fetch").then(() => "allowed", () => "blocked");
  });
  expect(fetchResult).toBe("blocked");
  await frame.locator("body").evaluate(() => { location.href = "http://127.0.0.1:4174/forbidden-navigation"; });
  // Chromium replaces the blocked frame with an error document; host content survives.
  await expect.poll(() => page.frames().find((candidate) => candidate.parentFrame())?.url()).not.toBe("about:srcdoc");
  await expect(page.locator("#fallback")).not.toBeEmpty();
  expect(intercepted).toBe(0);
});
