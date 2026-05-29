export type ApiError = {
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
};
export type SessionUser = {
    subject: string;
    email?: string;
    raw: Record<string, unknown>;
    rawToken: string;
};
