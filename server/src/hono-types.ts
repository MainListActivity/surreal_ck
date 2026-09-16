import type { SessionUser } from "@surreal-ck/shared";
import type { PlatformOperatorCapability } from "@surreal-ck/shared/native-quota";

export type AppBindings = {
  Variables: {
    user: SessionUser;
    platformOperator: {
      subject: string;
      capabilities: readonly PlatformOperatorCapability[];
    };
  };
};
