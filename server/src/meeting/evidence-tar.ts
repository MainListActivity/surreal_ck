type TarEntry = { path: string; bytes: number; chunks: AsyncIterable<Uint8Array> };
const block = 512;
const maxOctalSize = 0o77777777777;

function header(path: string, bytes: number, type: string) {
  const result = Buffer.alloc(block);
  result.write(path, 0, 100, "ascii");
  result.write("0000600\0", 100, "ascii");
  result.write("0000000\0", 108, "ascii");
  result.write("0000000\0", 116, "ascii");
  result.write(bytes.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  result.write("00000000000\0", 136, "ascii");
  result.fill(0x20, 148, 156);
  result.write(type, 156, "ascii");
  result.write("ustar\0" + "00", 257, "ascii");
  result.write(result.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return result;
}

function pax(key: string, value: string) {
  const record = ` ${key}=${value}\n`;
  let length = record.length + 1;
  while (length !== record.length + String(length).length) length = record.length + String(length).length;
  return `${length}${record}`;
}

const padding = (bytes: number) => Buffer.alloc((block - (bytes % block)) % block);

async function* tar(entries: AsyncIterable<TarEntry>) {
  for await (const { path, bytes, chunks } of entries) {
    const extended = (path.length > 100 ? pax("path", path) : "") + (bytes > maxOctalSize ? pax("size", String(bytes)) : "");
    if (extended) {
      yield header("PaxHeader", extended.length, "x");
      yield Buffer.from(extended);
      if (extended.length % block) yield padding(extended.length);
    }
    yield header(path.slice(0, 100), bytes <= maxOctalSize ? bytes : 0, "0");
    yield* chunks;
    if (bytes % block) yield padding(bytes);
  }
  yield Buffer.alloc(2 * block);
}

export function streamEvidenceTar(entries: AsyncIterable<TarEntry>): ReadableStream<Uint8Array> {
  const iterator = tar(entries);
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() { await iterator.return(undefined); },
  });
}
