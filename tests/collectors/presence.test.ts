// Presence watchdog tests need an in-memory DB so handlePresenceUpdate can
// write sessions/events, and a short PRESENCE_STALE_OFFLINE_MS so the
// stale-offline sweep can be exercised without real waiting.
//
// NOTE: tsx hoists static imports, so env vars set in the module body are NOT
// visible to config.ts at eval time (config is imported transitively below).
// The threshold is therefore overridden on the config object directly — the
// same mutation pattern runtime-config.ts uses for PATCH /api/config.
process.env.DB_PATH        = ":memory:";
process.env.API_AUTH_TOKEN = "test-token";
process.env.DISCORD_TOKEN  = "test-token";
process.env.LOG_LEVEL      = "error";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupTestDb, teardownTestDb, insertTestTarget } from "../helpers";
import { getDb } from "../../src/database/connection";
import { config } from "../../src/utils/config";
import {
    handlePresenceUpdate,
    initPresence,
    getCurrentPresence,
    sweepStalePresence,
    markPresenceEvidence,
    removeTargetState,
} from "../../src/collectors/presence";

// 50 ms threshold — long enough that a same-tick sweep is a no-op, short
// enough that a 80 ms sleep reliably crosses it.
config.presenceStaleOfflineMs = 50;

const TARGET_A = "111111111111111111";
const TARGET_B = "222222222222222222";

function countEvents(targetId: string, eventType: string): number {
    const row = getDb()
        .prepare("SELECT COUNT(*) AS c FROM events WHERE target_id = ? AND event_type = ?")
        .get(targetId, eventType) as { c: number };
    return row.c;
}

function openPresenceSessions(targetId: string): number {
    const row = getDb()
        .prepare("SELECT COUNT(*) AS c FROM presence_sessions WHERE target_id = ? AND end_time IS NULL")
        .get(targetId) as { c: number };
    return row.c;
}

function openActivePresenceSessions(targetId: string): number {
    const row = getDb()
        .prepare("SELECT COUNT(*) AS c FROM presence_sessions WHERE target_id = ? AND end_time IS NULL AND status != 'offline'")
        .get(targetId) as { c: number };
    return row.c;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("sweepStalePresence — offline-reconciliation watchdog", () => {
    beforeEach(() => {
        setupTestDb();
        insertTestTarget(TARGET_A);
        insertTestTarget(TARGET_B);
        removeTargetState(TARGET_A);
        removeTargetState(TARGET_B);
    });
    afterEach(teardownTestDb);

    it("does not correct freshly-seen active targets", () => {
        handlePresenceUpdate(TARGET_A, { status: "online", client_status: { desktop: "online" } });
        assert.equal(sweepStalePresence(), 0);
        assert.equal(getCurrentPresence(TARGET_A)?.status, "online");
    });

    it("forces stale active targets offline through the normal PRESENCE_UPDATE path", async () => {
        handlePresenceUpdate(TARGET_A, { status: "dnd", client_status: { desktop: "dnd" } });

        // Before the threshold elapses the target must survive the sweep.
        assert.equal(sweepStalePresence(), 0);

        await sleep(80); // threshold is 50 ms in this test process

        assert.equal(sweepStalePresence(), 1);
        assert.equal(getCurrentPresence(TARGET_A)?.status, "offline");

        // The correction must be indistinguishable from a real transition:
        // the open active session is closed and a PRESENCE_UPDATE event is
        // persisted for SSE/alerts. Going offline also opens an "offline"
        // interval row by design (the next transition closes it) — what must
        // be gone is any open ACTIVE session.
        assert.equal(openActivePresenceSessions(TARGET_A), 0);
        assert.equal(openPresenceSessions(TARGET_A), 1); // the offline interval row
        assert.equal(countEvents(TARGET_A, "PRESENCE_UPDATE"), 2); // dnd + forced-offline
    });

    it("leaves offline-cached targets alone", async () => {
        handlePresenceUpdate(TARGET_A, { status: "offline", client_status: null });
        await sleep(80);
        assert.equal(sweepStalePresence(), 0);
    });

    it("new evidence resets the staleness clock", async () => {
        handlePresenceUpdate(TARGET_A, { status: "online", client_status: { desktop: "online" } });
        await sleep(70);
        // Evidence refresh mid-window restarts the clock.
        markPresenceEvidence(TARGET_A);
        assert.equal(sweepStalePresence(), 0);
        assert.equal(getCurrentPresence(TARGET_A)?.status, "online");
    });

    it("initPresence counts as evidence (reconnect chunk re-baseline)", async () => {
        initPresence(TARGET_A, { status: "idle", client_status: { mobile: "idle" } });
        assert.equal(sweepStalePresence(), 0);
        assert.equal(getCurrentPresence(TARGET_A)?.status, "idle");
    });

    it("removing target state drops the evidence clock too", async () => {
        handlePresenceUpdate(TARGET_A, { status: "online", client_status: { desktop: "online" } });
        removeTargetState(TARGET_A);
        assert.equal(getCurrentPresence(TARGET_A), undefined);
        // Sweep must not resurrect or alert on removed targets.
        assert.equal(sweepStalePresence(), 0);
    });

    it("sweeps each stale target exactly once (idempotent until re-seen)", async () => {
        handlePresenceUpdate(TARGET_A, { status: "online", client_status: { desktop: "online" } });
        await sleep(80);
        assert.equal(sweepStalePresence(), 1);
        // Second sweep: target is offline-cached now, nothing to correct.
        assert.equal(sweepStalePresence(), 0);
    });
});
