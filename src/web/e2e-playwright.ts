import { chromium, type Browser } from "playwright";

const CHROMIUM_ARGS = ["--disable-gpu", "--disable-software-rasterizer"];

export function launchChromium(): Promise<Browser> {
  return chromium.launch({ headless: true, args: CHROMIUM_ARGS });
}

export function e2eEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...process.env, NODE_ENV: "production", ...extra };
}
