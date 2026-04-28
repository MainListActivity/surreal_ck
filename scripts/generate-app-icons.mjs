import { mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const assetsDir = join(rootDir, "assets");
const svgPath = join(assetsDir, "app-icon.svg");
const pngPath = join(assetsDir, "icon.png");
const iconsetDir = join(assetsDir, "icon.iconset");

const sizes = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

function renderPng(outputPath, size) {
  execFileSync("sips", ["-s", "format", "png", "-z", String(size), String(size), svgPath, "--out", outputPath], {
    stdio: "inherit",
  });
}

if (!existsSync(svgPath)) {
  throw new Error(`Missing source icon: ${svgPath}`);
}

rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });

renderPng(pngPath, 1024);

for (const item of sizes) {
  renderPng(join(iconsetDir, item.name), item.size);
}

console.log("Generated app icons in assets/");
