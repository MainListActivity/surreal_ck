const SURREALDB_TIMESTAMP_DBG_START =
  /^\[.*surrealdb-core-[^/\]]+\/src\/kvs\/timestamp\.rs:\d+:\d+\] self\.0\.to_be_bytes\(\) = \[$/;

export type NativeStderrFilter = {
  write(chunk: string | Uint8Array): void;
  flush(): void;
};

export function createNativeStderrFilter(writeFilteredChunk: (chunk: string) => void): NativeStderrFilter {
  const decoder = new TextDecoder();
  let pending = "";
  let filteringTimestampDbgBlock = false;

  function processLine(lineWithEnding: string): void {
    const line = lineWithEnding.replace(/\r?\n$/, "");

    if (filteringTimestampDbgBlock) {
      if (line === "]") {
        filteringTimestampDbgBlock = false;
      }
      return;
    }

    if (SURREALDB_TIMESTAMP_DBG_START.test(line)) {
      filteringTimestampDbgBlock = true;
      return;
    }

    writeFilteredChunk(lineWithEnding);
  }

  return {
    write(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

      while (true) {
        const newlineIndex = pending.indexOf("\n");
        if (newlineIndex < 0) return;

        const lineWithEnding = pending.slice(0, newlineIndex + 1);
        pending = pending.slice(newlineIndex + 1);
        processLine(lineWithEnding);
      }
    },
    flush() {
      pending += decoder.decode();
      if (pending.length > 0) {
        processLine(pending);
        pending = "";
      }
    },
  };
}

export function filterNativeStderrText(input: string): string {
  let output = "";
  const filter = createNativeStderrFilter((chunk) => {
    output += chunk;
  });
  filter.write(input);
  filter.flush();
  return output;
}
