import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [nativeRole, port = '8765', seconds = '20'] = process.argv.slice(2);
if (!['offerer', 'answerer'].includes(nativeRole)) {
  throw new Error('用法：node meeting_interop_drive.mjs <原生角色 offerer|answerer> [端口] [秒数]');
}
const browserRole = nativeRole === 'offerer' ? 'answerer' : 'offerer';
const base = `http://127.0.0.1:${port}`;
const sources = ['microphone', 'camera', 'screen'];
const defaultPeer = fileURLToPath(new URL('../target/debug/examples/meeting_interop_peer', import.meta.url));
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import('playwright');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN,
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});
const peer = spawn(process.env.INTEROP_PEER || defaultPeer, [
  '--role', nativeRole, '--port', port, '--seconds', seconds, '--expect', sources.join(','),
], { stdio: ['ignore', 'pipe', 'inherit'] });
let peerResult;
const done = new Promise(resolve => {
  peer.once('error', error => { peerResult = { error }; resolve(); });
  peer.once('close', (code, signal) => { peerResult = { code, signal }; resolve(); });
});
let native;
const lines = createInterface({ input: peer.stdout });
await run();

async function run() {
  lines.on('line', line => {
    console.log(`原生报告：${line}`);
    native = line;
  });
  try {
    const url = `${base}/report`;
    const until = Date.now() + 15000;
    let initial;
    while (Date.now() < until && !peerResult) {
      initial = await fetch(url).catch(() => undefined);
      if (initial?.ok) break;
      await sleep(100);
    }
    assert(initial?.ok, `原生邮箱未启动：${JSON.stringify(peerResult)}`);
    assert.equal(initial.headers.get('access-control-allow-origin'), '*');
    assert.equal((await initial.json()).connected, false);
    if (nativeRole === 'answerer') assert.equal((await fetch(`${base}/answer`)).status, 404);
    const signal = `${base}/${browserRole === 'offerer' ? 'offer' : 'answer'}`;
    const preflight = await fetch(signal, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    const oversized = await fetch(signal, { method: 'POST', body: ' '.repeat(49153) });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get('access-control-allow-origin'), '*');
    assert.equal(typeof (await oversized.json()).error, 'string');

    console.log(`Chrome ${browser.version()}；原生 ${nativeRole} / 浏览器 ${browserRole}`);
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('浏览器：', error.message));
    await page.goto(`${base}/?role=${browserRole}`);
    await page.evaluate(() => window.interopReady);
    let report;
    while (!peerResult) {
      const snapshot = await page.evaluate(() => window.interopReport());
      if (!report?.connected || snapshot.connected) report = snapshot;
      await Promise.race([sleep(250), done]);
    }
    assert(report, '无浏览器报告');
    console.log(`浏览器报告：${JSON.stringify(report)}`);
    assert.equal(peerResult.code, 0, `原生退出异常：${JSON.stringify(peerResult)}`);
    const nativeReport = JSON.parse(native);
    assert.equal(nativeReport.connected, true);
    assert.equal(nativeReport.route, 'direct');
    assert.equal(report.connected, true);
    for (const source of sources) {
      assert(nativeReport.received[source] >= 10, `原生未收到足够的 ${source}`);
      assert(report.received[source] >= 10, `浏览器未收到足够的 ${source}`);
      assert.equal(report.codecs[source], source === 'microphone' ? 'audio/opus' : 'video/VP8');
    }
    console.log('通过：双向三个媒体源均至少收到 10 帧或音频包');
  } finally {
    if (!peerResult) peer.kill();
    await done;
    await browser.close();
  }
}
