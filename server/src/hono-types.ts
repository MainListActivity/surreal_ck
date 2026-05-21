import type { SessionUser } from "@surreal-ck/shared";

export type AppBindings = {
  Variables: {
    user: SessionUser;
  };
};
