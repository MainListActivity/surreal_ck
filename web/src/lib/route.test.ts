import { describe, expect, test } from "bun:test";
import { editorPath, parseRoute, workspacePath } from "./route";

describe("parseRoute", () => {
  test("auth 路由", () => {
    expect(parseRoute("/auth/login")).toEqual({ kind: "login" });
    expect(parseRoute("/auth/callback")).toEqual({ kind: "callback" });
  });

  test("根路径与未知路径落 home", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/whatever")).toEqual({ kind: "home" });
  });

  test("workspace 首页与子页面", () => {
    expect(parseRoute("/w/acme")).toEqual({ kind: "workspace", slug: "acme", page: "home" });
    expect(parseRoute("/w/acme/docs")).toEqual({ kind: "workspace", slug: "acme", page: "docs" });
    expect(parseRoute("/w/acme/templates")).toEqual({
      kind: "workspace",
      slug: "acme",
      page: "templates",
    });
    expect(parseRoute("/w/acme/dashboard")).toEqual({
      kind: "workspace",
      slug: "acme",
      page: "dashboard",
    });
    expect(parseRoute("/w/acme/admin")).toEqual({ kind: "workspace", slug: "acme", page: "admin" });
    expect(parseRoute("/w/acme/admin-console")).toEqual({
      kind: "workspace",
      slug: "acme",
      page: "admin-console",
    });
    expect(parseRoute("/w/acme/settings")).toEqual({
      kind: "workspace",
      slug: "acme",
      page: "settings",
    });
    expect(parseRoute("/w/acme/trash")).toEqual({ kind: "workspace", slug: "acme", page: "trash" });
  });

  test("未知 workspace 子页面退回 home 页面（不丢 slug）", () => {
    expect(parseRoute("/w/acme/nope")).toEqual({ kind: "workspace", slug: "acme", page: "home" });
    // /w/:slug/wb 不完整时不当 editor，退回 workspace home
    expect(parseRoute("/w/acme/wb")).toEqual({ kind: "workspace", slug: "acme", page: "home" });
  });

  test("公开表单占位页", () => {
    expect(parseRoute("/form")).toEqual({ kind: "form" });
    expect(parseRoute("/form-success")).toEqual({ kind: "form-success" });
  });

  test("workbook 路由（默认 sheet）", () => {
    expect(parseRoute("/w/acme/wb/workbook:wb1")).toEqual({
      kind: "editor",
      slug: "acme",
      workbookId: "workbook:wb1",
      sheetId: null,
    });
  });

  test("workbook 路由（指定 sheet）", () => {
    expect(parseRoute("/w/acme/wb/workbook:wb1/sheet/sheet:s2")).toEqual({
      kind: "editor",
      slug: "acme",
      workbookId: "workbook:wb1",
      sheetId: "sheet:s2",
    });
  });

  test("解码 percent-encoded 段（RecordId 含冒号等）", () => {
    const route = parseRoute("/w/my%20space/wb/workbook%3Awb1/sheet/sheet%3As2");
    expect(route).toEqual({
      kind: "editor",
      slug: "my space",
      workbookId: "workbook:wb1",
      sheetId: "sheet:s2",
    });
  });

  test("sheet 段不完整时退回默认 sheet", () => {
    expect(parseRoute("/w/acme/wb/workbook:wb1/sheet")).toEqual({
      kind: "editor",
      slug: "acme",
      workbookId: "workbook:wb1",
      sheetId: null,
    });
  });
});

describe("editorPath", () => {
  test("无 sheet", () => {
    expect(editorPath("acme", "workbook:wb1")).toBe("/w/acme/wb/workbook%3Awb1");
  });

  test("带 sheet", () => {
    expect(editorPath("acme", "workbook:wb1", "sheet:s2")).toBe(
      "/w/acme/wb/workbook%3Awb1/sheet/sheet%3As2",
    );
  });

  test("parseRoute(editorPath(...)) 往返一致", () => {
    const p = editorPath("my space", "workbook:wb1", "sheet:s2");
    expect(parseRoute(p)).toEqual({
      kind: "editor",
      slug: "my space",
      workbookId: "workbook:wb1",
      sheetId: "sheet:s2",
    });
  });
});

describe("workspacePath", () => {
  test("首页省略 page", () => {
    expect(workspacePath("acme")).toBe("/w/acme");
    expect(workspacePath("acme", "home")).toBe("/w/acme");
  });

  test("子页面拼接", () => {
    expect(workspacePath("acme", "docs")).toBe("/w/acme/docs");
    expect(workspacePath("acme", "admin-console")).toBe("/w/acme/admin-console");
    expect(workspacePath("acme", "settings")).toBe("/w/acme/settings");
  });

  test("slug 做 percent-encode", () => {
    expect(workspacePath("my space", "admin")).toBe("/w/my%20space/admin");
  });

  test("parseRoute(workspacePath(...)) 往返一致", () => {
    expect(parseRoute(workspacePath("my space", "dashboard"))).toEqual({
      kind: "workspace",
      slug: "my space",
      page: "dashboard",
    });
  });
});
