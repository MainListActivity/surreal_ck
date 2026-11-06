import { isAuthenticated, login } from "./lib/auth";
import {
  isFramed,
  postAuthEmbedMessage,
  sanitizeReturnTo,
} from "./lib/auth-embed-protocol";

const returnTo = sanitizeReturnTo(
  new URLSearchParams(window.location.search).get("returnTo"),
);

async function main(): Promise<void> {
  if (!isFramed()) {
    window.location.replace(
      `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    );
    return;
  }

  if (isAuthenticated()) {
    postAuthEmbedMessage({ source: "maplayer-auth", type: "success", returnTo });
    return;
  }

  try {
    await login(returnTo);
  } catch (error) {
    postAuthEmbedMessage({
      source: "maplayer-auth",
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

void main();
