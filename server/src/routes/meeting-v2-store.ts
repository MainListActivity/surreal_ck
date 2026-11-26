import { createHmac } from "node:crypto";
import { DateTime, RecordId, Surreal } from "surrealdb";
import { env } from "../env";
import { getRootDatabaseSession } from "../db/root-connection";
import { isAtomicConflict } from "../db/atomic-conflict-retry";
import type { MeetingRoomState, MeetingStore } from "./meeting-v2-state";

const gatewayAccess = "meeting_v2_gateway";

export class SurrealMeetingStore implements MeetingStore {
  readonly #pool = new Map<string, { session: Promise<Surreal>; expires: number }>();

  constructor(
    private readonly key: string,
    private readonly config = { url: env.SURREAL_URL, namespace: env.SURREAL_NS, credentialSession: getRootDatabaseSession },
  ) {}

  async #connect(database: string, provision: boolean): Promise<Surreal> {
    const proof = createHmac("sha256", this.key).update(`meeting-v2-gateway:${database}`).digest("hex");
    if (provision) {
      const root = await this.config.credentialSession(database, this.config.namespace);
      await root.query("UPSERT meeting_v2_gateway:origin SET proof = $proof", { proof });
    }
    const db = new Surreal();
    try {
      await db.connect(this.config.url);
      await db.signin({ namespace: this.config.namespace, database, access: gatewayAccess, variables: { proof } });
      await db.use({ namespace: this.config.namespace, database });
      return db;
    } catch (error) {
      await db.close().catch(() => undefined);
      throw error;
    }
  }

  async #get(database: string, provision = false): Promise<Surreal> {
    const now = Date.now();
    const current = this.#pool.get(database);
    if (current && now < current.expires) {
      if (!provision) return current.session;
      const established = await current.session.catch(() => null);
      if (established) return established;
    }
    for (const [key, value] of this.#pool) {
      if (now < value.expires && this.#pool.size < 64) continue;
      this.#pool.delete(key);
      void value.session.then((db) => db.close()).catch(() => undefined);
    }
    const session = this.#connect(database, provision);
    this.#pool.set(database, { session, expires: now + 50 * 60_000 });
    void session.catch(() => {
      if (this.#pool.get(database)?.session === session) this.#pool.delete(database);
    });
    return session;
  }

  async read(database: string, id: string) {
    const db = await this.#get(database);
    const [row] = await db.query<[null | { revision: number; state: MeetingRoomState }]>(
      "SELECT revision, state FROM ONLY $id", { id: new RecordId("meeting_v2_room", id) },
    ).collect();
    return row ?? null;
  }

  async write(database: string, id: string, revision: number | null, state: MeetingRoomState): Promise<boolean> {
    const db = await this.#get(database, revision === null);
    const params = {
      id: new RecordId("meeting_v2_room", id),
      state,
      expires: new DateTime(new Date(state.expires + 60 * 60_000)),
      revision,
    };
    try {
      if (revision === null) {
        const [rows] = await db.query<[unknown[]]>(
          "CREATE $id SET revision = 0, state = $state, expires_at = $expires", params,
        ).collect();
        await db.query("DELETE meeting_v2_room WHERE expires_at <= time::now() RETURN NONE").collect();
        return rows.length === 1;
      }
      const [rows] = await db.query<[unknown[]]>(
        "UPDATE $id SET revision += 1, state = $state WHERE revision = $revision RETURN VALUE id", params,
      ).collect();
      return rows.length === 1;
    } catch (error) {
      if (isAtomicConflict(error)) return false;
      throw error;
    }
  }
}
