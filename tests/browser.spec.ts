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
  }, otherItem.item.artifacts[0].id);
  expect(probe).toEqual({ parentDenied: true, foreign: "Artifact not granted", capabilities: ["read"] });
  expect(await (await request.get("/api/context")).json()).toEqual(context);
});

test("outputs from one input expose only their selected artifacts while allowing explicit sharing", async ({ page, request }) => {
  const first: ViewContext = await (await request.get("/api/context?item=photo-1")).json();
  const second: ViewContext = await (await request.get("/api/context?item=photo-2")).json();
  expect(first.item.itemId).not.toBe(second.item.itemId);
  expect(first.item.artifacts.map(artifact => artifact.id)).toEqual(first.publication.artifacts);
  expect(second.item.artifacts.map(artifact => artifact.id)).toEqual(second.publication.artifacts);
  const original = first.item.artifacts.find(artifact => artifact.mediaType === "image/svg+xml")!;
  const siblingOriginal = second.item.artifacts.find(artifact => artifact.mediaType === "image/svg+xml")!;
  const shared = first.item.artifacts.find(artifact => artifact.role === "photo-index")!;
  expect(second.item.artifacts.find(artifact => artifact.id === shared.id)).toEqual(shared);
  const siblingOnly = second.item.artifacts.filter(artifact => !first.publication.artifacts.includes(artifact.id));
  expect(siblingOnly.map(artifact => artifact.id)).toContain(siblingOriginal.id);
  expect(Object.keys(first.item).sort()).toEqual(["artifacts", "itemId"]);
  for (const artifact of siblingOnly) {
    expect(JSON.stringify(first)).not.toContain(artifact.id);
    expect((await request.get(`/api/artifacts/${artifact.id}?item=photo-1`)).status()).toBe(403);
  }
  for (const item of ["photo-1", "photo-2"]) {
    expect(await (await request.get(`/api/artifacts/${shared.id}?item=${item}`)).json()).toEqual({ title: "Imported images", count: 2 });
  }

  // Supply a hostile wire-protocol probe in place of an already selected artifact.
  // The fixture has no custom viewer; this exercises the actual host broker without adding one.
  const component = first.publication.presentation.fallback;
  const probeSource = `<body><script>
    window.addEventListener("message", (event) => {
      if (event.source !== parent || event.data?.type !== "magpie:init" || event.ports.length !== 1) return;
      const port = event.ports[0];
      const pending = new Map();
      let serial = 0;
      port.onmessage = ({ data }) => {
        const waiting = pending.get(data.id);
        if (!waiting) return;
        pending.delete(data.id);
        data.ok ? waiting.resolve(data) : waiting.reject(new Error(data.error));
      };
      window.magpie = { read(artifact) {
        return new Promise((resolve, reject) => {
          const id = String(++serial);
          pending.set(id, { resolve, reject });
          port.postMessage({ id, method: "read", artifact });
        });
      }};
      document.body.dataset.context = JSON.stringify(event.data.context);
      document.body.dataset.ready = "yes";
    });
    parent.postMessage({ type: "magpie:ready" }, "*");
  </script></body>`;
  await page.route("**/api/context?item=photo-1", async route => {
    const response = await route.fetch();
    const context: ViewContext = await response.json();
    context.publication.presentation.component = component;
    await route.fulfill({ response, json: context });
  });
  await page.route(`**/api/artifacts/${component}?item=photo-1`, route => route.fulfill({ contentType: "text/html", body: probeSource }));
  const browserReads: string[] = [];
  page.on("request", request => { browserReads.push(new URL(request.url()).pathname); });
  await page.goto("/?item=photo-1");
  const frame = page.frameLocator('iframe[title="Isolated item viewer"]');
  await expect(frame.locator("body")).toHaveAttribute("data-ready", "yes");
  const received: ViewContext = JSON.parse((await frame.locator("body").getAttribute("data-context"))!);
  expect(received.item).toEqual(first.item);
  const probe = await frame.locator("body").evaluate(async (_, ids) => {
    const own = await window.magpie.read(ids.own).then(result => new TextDecoder().decode(result.bytes));
    const shared = await window.magpie.read(ids.shared).then(result => JSON.parse(new TextDecoder().decode(result.bytes)));
    const foreign = await window.magpie.read(ids.foreign).then(() => "allowed", (error: Error) => error.message);
    return { own, shared, foreign };
  }, { own: original.id, shared: shared.id, foreign: siblingOriginal.id });
  expect(probe.own).toContain("<svg");
  expect(probe.shared).toEqual({ title: "Imported images", count: 2 });
  expect(probe.foreign).toBe("Artifact not granted");
  expect(browserReads).not.toContain(`/api/artifacts/${siblingOriginal.id}`);
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
