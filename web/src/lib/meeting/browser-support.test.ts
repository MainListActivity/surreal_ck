import { describe, expect, test } from "bun:test";
import { checkMeetingSupport, detectInAppBrowser, type MeetingSupportEnv } from "./browser-support";

const WECHAT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x18002831) NetType/WIFI Language/zh_CN";
const DINGTALK =
  "Mozilla/5.0 (Linux; Android 13; V2241A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/101.0.4951.61 Mobile Safari/537.36 AliApp(DingTalk/7.0.40) com.alibaba.android.rimet";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function env(userAgent: string, overrides: Partial<MeetingSupportEnv> = {}): MeetingSupportEnv {
  return {
    userAgent,
    isSecureContext: true,
    hasPeerConnection: true,
    hasGetUserMedia: true,
    hasGetDisplayMedia: true,
    ...overrides,
  };
}

describe("会议浏览器能力检测", () => {
  test("识别微信 / 钉钉内置浏览器并给出外部打开引导", () => {
    expect(detectInAppBrowser(WECHAT)).toBe("wechat");
    expect(detectInAppBrowser(DINGTALK)).toBe("dingtalk");
    expect(checkMeetingSupport(env(WECHAT))).toEqual({ kind: "in-app", app: "wechat" });
    // 即便内置浏览器缺 WebRTC 也先给引导，而不是报不支持。
    expect(checkMeetingSupport(env(DINGTALK, { hasPeerConnection: false }))).toEqual({ kind: "in-app", app: "dingtalk" });
  });

  test("系统浏览器：桌面可共享屏幕，手机不提供共享", () => {
    expect(detectInAppBrowser(SAFARI_IOS)).toBeNull();
    expect(checkMeetingSupport(env(CHROME_DESKTOP))).toEqual({ kind: "supported", canShareScreen: true, mobile: false });
    expect(checkMeetingSupport(env(SAFARI_IOS))).toEqual({ kind: "supported", canShareScreen: false, mobile: true });
  });

  test("非 HTTPS 或缺少 WebRTC 时明确说明原因", () => {
    expect(checkMeetingSupport(env(CHROME_DESKTOP, { isSecureContext: false })).kind).toBe("unsupported");
    expect(checkMeetingSupport(env(CHROME_DESKTOP, { hasGetUserMedia: false })).kind).toBe("unsupported");
  });
});
