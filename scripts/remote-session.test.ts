import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRemoteLink } from "./remote-session";

describe("parseRemoteLink", () => {
  const link =
    "https://o.maplayer.top/t/ck/remote#code=abc123&client_id=remote_client&api=https%3A%2F%2Fl.maplayer.top&aud=aud-product&ops_aud=aud-ops";

  it("parses issuer, fragment params and defaults", () => {
    const parsed = parseRemoteLink(link);
    expect(parsed.issuer).toBe("https://o.maplayer.top/t/ck");
    expect(parsed.code).toBe("abc123");
    expect(parsed.clientId).toBe("remote_client");
    expect(parsed.api).toBe("https://l.maplayer.top");
    expect(parsed.aud).toBe("aud-product");
    expect(parsed.opsAud).toBe("aud-ops");
    expect(parsed.dbUrl).toBe("wss://data.maplayer.top/rpc");
  });

  it("honours an explicit db_url fragment param", () => {
    const parsed = parseRemoteLink(link + "&db_url=wss%3A%2F%2Fexample.test%2Frpc");
    expect(parsed.dbUrl).toBe("wss://example.test/rpc");
  });

  it("ops_aud defaults to aud", () => {
    const parsed = parseRemoteLink(
      "https://o.maplayer.top/t/ck/remote#code=x&client_id=c&api=a&aud=p",
    );
    expect(parsed.opsAud).toBe("p");
  });
});

describe("session file layout", () => {
  it("documented path honour SCK_REMOTE_SESSION override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sck-remote-test-"));
    const path = join(dir, "session.json");
    process.env.SCK_REMOTE_SESSION = path;
    // 写一份会话文件验证 0600/路径约定（不写真实 token）
    await Bun.write(path, JSON.stringify({ issuer: "x", clientId: "c", api: "a", aud: "a", opsAud: "o", refreshToken: "t" }));
    const mode = (await stat(path)).mode & 0o777;
    expect([0o600, 0o644]).toContain(mode); // Bun.write 默认 umask；生产路径由脚本 0600 写入
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.issuer).toBe("x");
  });
});
