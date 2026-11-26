/** 浏览器会议能力检测：受限内置浏览器给出外部打开引导，而不是白屏或反复弹权限。 */
export type InAppBrowser = "wechat" | "dingtalk" | "feishu" | "qq" | "weibo" | "alipay" | "webview";

const IN_APP_PATTERNS: ReadonlyArray<readonly [InAppBrowser, RegExp]> = [
  ["wechat", /MicroMessenger|WeChat|wxwork/i],
  ["dingtalk", /DingTalk/i],
  ["feishu", /Lark|Feishu/i],
  ["qq", /\bQQ\//i],
  ["weibo", /Weibo/i],
  ["alipay", /AlipayClient/i],
  ["webview", /; wv\)|FBAN|FBAV|Instagram|Line\//i],
];

export const IN_APP_LABELS: Record<InAppBrowser, string> = {
  wechat: "微信",
  dingtalk: "钉钉",
  feishu: "飞书",
  qq: "QQ",
  weibo: "微博",
  alipay: "支付宝",
  webview: "应用内置浏览器",
};

export const OPEN_IN_SYSTEM_BROWSER = "点击右上角在系统浏览器打开";

export function detectInAppBrowser(userAgent: string): InAppBrowser | null {
  for (const [kind, pattern] of IN_APP_PATTERNS) {
    if (pattern.test(userAgent)) return kind;
  }
  return null;
}

export type MeetingSupportEnv = {
  userAgent: string;
  isSecureContext: boolean;
  hasPeerConnection: boolean;
  hasGetUserMedia: boolean;
  hasGetDisplayMedia: boolean;
};

export type MeetingSupport =
  | { kind: "supported"; canShareScreen: boolean; mobile: boolean }
  | { kind: "in-app"; app: InAppBrowser }
  | { kind: "unsupported"; reason: string };

export function isMobileUserAgent(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

export function checkMeetingSupport(env: MeetingSupportEnv): MeetingSupport {
  const app = detectInAppBrowser(env.userAgent);
  if (app) return { kind: "in-app", app };
  if (!env.isSecureContext) return { kind: "unsupported", reason: "会议需要 HTTPS 安全连接" };
  if (!env.hasPeerConnection) return { kind: "unsupported", reason: "当前浏览器不支持 WebRTC 音视频" };
  if (!env.hasGetUserMedia) return { kind: "unsupported", reason: "当前浏览器无法访问摄像头和麦克风" };
  const mobile = isMobileUserAgent(env.userAgent);
  return { kind: "supported", canShareScreen: env.hasGetDisplayMedia && !mobile, mobile };
}

export function readMeetingSupportEnv(): MeetingSupportEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const devices = nav?.mediaDevices;
  return {
    userAgent: nav?.userAgent ?? "",
    isSecureContext: typeof window !== "undefined" && window.isSecureContext === true,
    hasPeerConnection: typeof RTCPeerConnection !== "undefined",
    hasGetUserMedia: typeof devices?.getUserMedia === "function",
    hasGetDisplayMedia: typeof devices?.getDisplayMedia === "function",
  };
}
