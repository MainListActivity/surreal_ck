import { expect, open, test } from "nsh/test";
test("发布入口在缺少可信更新配置时保持锁定", async () => {
 const app = await open(".");
 await app.waitFor("尚未配置可信更新服务，暂不能打开应用。");
 expect(app.texts()).toContain("尚未配置可信更新服务，暂不能打开应用。");
 expect(app.texts()).not.toContain("创建邀请");
});
