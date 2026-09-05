// 契约实验：短原文片段定位，不代表完整文书或 MCP 集成验证。
// 来源：https://cicc.court.gov.cn/html/1/218/180/316/12572.html
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const quote = '当事人行为时有效的《合同法》第四百条规定';
const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
function locate(text, excerpt) {
  const first = text.indexOf(excerpt);
  if (first < 0) throw new Error('not_found');
  if (text.indexOf(excerpt, first + 1) >= 0) throw new Error('ambiguous');
  const start = Buffer.byteLength(text.slice(0, first), 'utf8');
  return { start, end: start + Buffer.byteLength(excerpt, 'utf8'), bodyDigest: digest(text) };
}
function verify(text, excerpt, locator) {
  if (digest(text) !== locator.bodyDigest) throw new Error('stale_body');
  const bytes = Buffer.from(text, 'utf8');
  if (!Number.isSafeInteger(locator.start) || !Number.isSafeInteger(locator.end)
    || locator.start < 0 || locator.end <= locator.start || locator.end > bytes.length) {
    throw new Error('invalid_range');
  }
  // fatal rejects a range which cuts through a multi-byte code point.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  if (decoder.decode(bytes.subarray(locator.start, locator.end)) !== excerpt) {
    throw new Error('locator_mismatch');
  }
}

// Surrounding text is intentionally synthetic, not claimed to be court text.
const body = `测试前缀😀\n${quote}\n测试尾部`;
const locator = locate(body, quote);
verify(body, quote, locator);
assert.equal(locator.start, Buffer.byteLength('测试前缀😀\n'));
assert.notEqual(locator.start, body.indexOf(quote));
assert.throws(() => verify(body, quote, { ...locator, start: locator.start + 1 }));
assert.throws(() => verify(` ${body}`, quote, locator), /stale_body/);
assert.throws(() => locate(`${body}\n${quote}`, quote), /ambiguous/);
assert.throws(() => verify(body, quote, { ...locator, end: -1 }), /invalid_range/);
assert.equal(digest(body), digest(body));
assert.notEqual(digest(body), digest(body.replaceAll('\n', '\r\n')));
console.log(JSON.stringify({
  scope: 'excerpt-based-contract-experiment',
  casesPassed: 7,
  locator,
  utf16Start: body.indexOf(quote),
  note: 'Synthetic surrounding text; no full-document fetch, database write or MCP call.',
}, null, 2));
