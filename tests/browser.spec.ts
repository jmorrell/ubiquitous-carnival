import { expect, test, type Page } from "@playwright/test";
import type { ViewContext } from "../src/contract";

declare global {
  interface Window {
    magpie: {
      read(artifact: string): Promise<{ bytes: ArrayBuffer }>;
    };
  }
}

async function viewer(page: Page) {
  await page.goto("/");
  const frame = page.frameLocator('iframe[title="Isolated item viewer"]');
  await expect(frame.locator("#message")).toHaveText("Ready");
  return frame;
}

test("a custom viewer seeks and follows real playback; Parquet uses the readable host view", async ({ page }) => {
  const frame = await viewer(page);
  await expect(frame.locator("#cues button")).toHaveCount(2);
  await expect(frame.locator("#cues button").nth(1)).toContainText("1.0s · ");

  // The processor and its viewer interpret transcript cues; the host only reads artifacts.
  await expect(page.locator("#fallback")).not.toBeEmpty();
  await expect(page.locator("#fallback button, #fallback video")).toHaveCount(0);
  await frame.locator("#cues button").nth(1).click();
  const video = frame.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(1, 1);
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1.2);
  await expect(frame.locator("#time")).not.toHaveText("1.00 seconds");
  await video.evaluate((element: HTMLVideoElement) => element.pause());

  await page.goto("/?item=parquet");
  await expect(page.locator("#title")).toHaveText("Parquet public summary");
  await expect(page.locator("#fallback")).toHaveText("Harbor: 12\nForest: 34");
  await expect(page.locator("#viewer iframe")).toHaveCount(0);
});

test("the sandbox rejects parent access, foreign reads, unsupported requests and sibling handshakes", async ({ page, request }) => {
  const context: ViewContext = await (await request.get("/api/context")).json();
  const otherItem: ViewContext = await (await request.get("/api/context?item=parquet")).json();
  const component = context.publication.presentation.component!;
  // A hostile component can speak the wire protocol directly. The broker must still reject writes.
  const probeSource = `<script>
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "magpie:init" || event.ports.length !== 1) return;
      const port = event.ports[0];
      port.addEventListener("message", ({ data }) => {
        if (data.id === "unsupported-probe") document.body.dataset.unsupported = data.ok ? "allowed" : data.error;
      });
      port.start();
      port.postMessage({ id: "unsupported-probe", method: "write", body: "host mutation" });
    });
  </script>`;
  // Delay the legitimate fixture's handshake so a hostile sibling races it.
  await page.route("**/api/artifacts/" + component, async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace("<script>", probeSource + "<script>")
      .replace('parent.postMessage({ type: "magpie:ready" }, "*");', 'setTimeout(() => parent.postMessage({ type: "magpie:ready" }, "*"), 500);');
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await expect(page.locator('iframe[title="Isolated item viewer"]')).toBeAttached();
  await page.evaluate(() => {
    const spoof = document.createElement("iframe");
    spoof.id = "spoof";
    spoof.sandbox.add("allow-scripts");
    spoof.srcdoc = '<body><script>window.addEventListener("message",()=>document.body.dataset.received="yes");parent.postMessage({type:"magpie:ready"},"*");</script></body>';
    document.body.append(spoof);
  });
  const frame = page.frameLocator('iframe[title="Isolated item viewer"]');
  await expect(frame.locator("#message")).toHaveText("Ready");
  await expect(page.frameLocator("#spoof").locator("body")).not.toHaveAttribute("data-received", "yes");
  await expect(frame.locator("body")).toHaveAttribute("data-unsupported", "Unknown request");
  const probe = await frame.locator("body").evaluate(async (_, foreignId) => {
    let parentDenied = false;
    try { void parent.document.body; } catch { parentDenied = true; }
    const foreign = await window.magpie.read(foreignId).then(() => "allowed", (error: Error) => error.message);
    return { parentDenied, foreign, capabilities: Object.keys(window.magpie) };
  }, otherItem.item.originals[0].id);
  expect(probe).toEqual({ parentDenied: true, foreign: "Artifact not granted", capabilities: ["read"] });
  expect(await (await request.get("/api/context")).json()).toEqual(context);
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
