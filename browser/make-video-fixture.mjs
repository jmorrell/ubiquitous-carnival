import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Synthetic six-second gradient, no recorded media or transcription source.
// The cached Playwright ffmpeg accepts JPEG image pipes, not rawvideo/lavfi.
const ffmpeg = process.env.FFMPEG ?? join(homedir(), "Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac");
const temp = mkdtempSync(join(tmpdir(), "magpie-video-"));
try {
  const width = 160, height = 90;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    rgb[offset] = 40; rgb[offset + 1] = x % 180 + 40; rgb[offset + 2] = y * 2 % 180 + 30;
  }
  const ppm = join(temp, "frame.ppm"), jpeg = join(temp, "frame.jpg");
  writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
  execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", ppm, "--out", jpeg], { stdio: "pipe" });
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "image2pipe", "-vcodec", "mjpeg", "-r", "10", "-i", "pipe:0", "-c:v", "libvpx", "-b:v", "100k", "-an", fileURLToPath(new URL("../fixtures/video.webm", import.meta.url))], {
    input: Buffer.concat(Array(60).fill(readFileSync(jpeg))), stdio: ["pipe", "pipe", "pipe"],
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
