/**
 * Stable client identity for the current browser session.
 * Generated once on module load; lives for the duration of the page session.
 * Used for collab presence, snapshot coordinator election, and mutation attribution.
 */
export const clientId: string = crypto.randomUUID();
