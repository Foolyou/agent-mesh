// Image-upload e2e over the fake server. Run: bun run src/web/images.e2e.ts
import { type Page } from "playwright";
import { launchChromium, e2eEnv } from "./e2e-playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.E2E_PORT) || 7517;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let pass = 0;
const fails: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    fails.push(name);
    console.log(`  ✗ ${name} — ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/api/state`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("server never became ready");
}

const root = await mkdtemp(join(tmpdir(), "mesh-images-root-"));
const files = await mkdtemp(join(tmpdir(), "mesh-images-files-"));
const pngA = join(files, "a.png");
const pngB = join(files, "b.png");
const svg = join(files, "bad.svg");
const big = join(files, "big.png");
await writeFile(pngA, PNG);
await writeFile(pngB, PNG);
await writeFile(svg, "<svg></svg>");
await writeFile(big, Buffer.alloc(10 * 1024 * 1024 + 1));

const server = Bun.spawn(["bun", "run", "src/main.ts", "--fake", "--port", String(PORT), "--root", root], {
  stdout: "pipe",
  stderr: "pipe",
  env: e2eEnv(),
});
const browser = await launchChromium();
try {
  await waitReady();
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator('.detail-head .btn:has-text("start mesh")').click();
  await page.waitForSelector('.detail-head:has-text("running")', { timeout: 8000 });

  const router = page.locator(".conv-panel");
  const textarea = router.locator(".composer textarea");
  const input = router.locator('.composer input[type="file"]');

  await step("file picker adds thumbnail and remove discards it", async () => {
    await input.setInputFiles(pngA);
    await router.locator(".pending-img img").waitFor({ timeout: 4000 });
    await router.locator('.pending-img button[title="remove image"]').click();
    await router.locator(".pending-img").waitFor({ state: "detached", timeout: 4000 });
  });

  await step("paste adds image thumbnail", async () => {
    await textarea.focus();
    await page.evaluate(async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      const file = new File([bytes], "paste.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await router.locator(".pending-img img").waitFor({ timeout: 4000 });
    await router.locator('.pending-img button[title="remove image"]').click();
  });

  await step("drop adds image thumbnail", async () => {
    await router.locator(".composer").evaluate((el) => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      const file = new File([bytes], "drop.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await router.locator(".pending-img img").waitFor({ timeout: 4000 });
    await router.locator('.pending-img button[title="remove image"]').click();
  });

  await step("send uploads image, user bubble shows thumbnail, lightbox opens", async () => {
    await input.setInputFiles(pngA);
    await textarea.fill("see image");
    await textarea.press("Enter");
    const bubble = router.locator(".msg.user .bubble", { hasText: "see image" }).last();
    await bubble.locator(".sent-image img").waitFor({ timeout: 6000 });
    const src = await bubble.locator(".sent-image img").getAttribute("src");
    if (!src?.startsWith("/api/uploads/demo/")) throw new Error(`thumbnail src was ${src}`);
    await bubble.locator(".sent-image").click();
    await page.locator(".lightbox img").waitFor({ timeout: 4000 });
    await page.locator(".lightbox-close").click();
  });

  await step("non-image agent: attach is allowed but warns it won't send", async () => {
    await page.locator('.topo .node:has-text("opencode-1")').click();
    const panel = page.locator('.dchat .panel:has(.tabs)');
    await panel.locator('.tab:has-text("opencode-1")').click();
    const btn = panel.locator(".attach-btn");
    await btn.waitFor({ timeout: 4000 });
    // the button is now ENABLED (attach always works); capability only governs a warning + drop
    if (await btn.isDisabled()) throw new Error("attach button should be enabled even for a non-image agent");
    const title = await btn.getAttribute("title");
    if (!title?.includes("does not advertise")) throw new Error(`missing tooltip: ${title}`);
    // attaching adds a thumbnail and surfaces a warning that the image won't be delivered
    await panel.locator('.composer input[type="file"]').setInputFiles(pngA);
    await panel.locator(".pending-img img").waitFor({ timeout: 4000 });
    await panel.locator(".compose-warn").waitFor({ timeout: 4000 });
    await panel.locator('.pending-img button[title="remove image"]').click();
  });

  await step("client rejects SVG, oversize, and sixth image", async () => {
    await page.locator('.topo .node:has-text("router")').click();
    await input.setInputFiles(svg);
    await router.locator(".compose-error", { hasText: "SVG" }).waitFor({ timeout: 4000 });
    await input.setInputFiles(big);
    await router.locator(".compose-error", { hasText: "too large" }).waitFor({ timeout: 4000 });
    await input.setInputFiles([pngA, pngB, pngA, pngB, pngA]);
    await input.setInputFiles(pngB);
    await router.locator(".compose-error", { hasText: "at most 5" }).waitFor({ timeout: 4000 });
  });

  await step("no page errors", async () => {
    if (errors.length) throw new Error(errors.slice(0, 3).join(" || "));
  });

  console.log(`\n  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log("  FAILED:", fails.join(", "));
    process.exitCode = 1;
  } else {
    console.log("  IMAGES E2E OK");
  }
} finally {
  await browser.close();
  server.kill();
  await rm(root, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
}
