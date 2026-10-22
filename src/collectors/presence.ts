import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { getStmts } from "../database/queries";
import { evaluateEvent } from "../alerts/engine";
import { pushSSEEvent } from "../api/routes/events";
import { closeOpenVoiceForTarget } from "./voice";

const log = createLogger("Presence");

interface PresenceState {
    status:       string;
    platform:     string | null;
    clientStatus: { desktop?: string; mobile?: string; web?: string } | null;
}

const currentPresence: Map<string, PresenceState> = new Map();

// ── Presence evidence tracking (offline-reconciliation watchdog) ─────────────
//
// Discord expires op-14 presence subscriptions for offline members within
// ~60 s, and re-subscribing produces NO event for offline members. A missed
// offline transition therefore can never self-heal from gateway events alone —
// the cached status would stay "locked" (e.g. online) until process restart.
//
// To break that lock we record the last time each target produced POSITIVE
// presence evidence:
//   - any PRESENCE_UPDATE (status OR activity change), or
//   - appearing in a GUILD_MEMBERS_CHUNK presences list (op-8 poll),
// and sweepStalePresence() force-offlines targets cached as active whose
// evidence is older than the threshold. Online targets always appear in chunk
// presences (op-8 requests them explicitly with presences: true), so
// "no evidence across two full poll rounds" is strong offline evidence —
// while a user who is genuinely online produces evidence every few seconds.
const lastPresenceEvidenceAt = new Map<string, number>();

/** Record positive presence evidence for a target. Cheap: one Map.set. */
export function markPresenceEvidence(targetId: string): void {
    lastPresenceEvidenceAt.set(targetId, Date.now());
}

/** Re-baseline every cached target's evidence clock (call on RESUMED —
 *  chunks re-arrive within seconds of a resume, and the sweep must not fire
 *  inside the reconnect gap where no evidence can arrive). */
export function touchAllPresenceEvidence(): void {
    const now = Date.now();
    for (const id of currentPresence.keys()) lastPresenceEvidenceAt.set(id, now);
}

/** Effective stale-offline threshold. 0 in config = derive from the status
 *  poll interval (2 full poll rounds + 60 s of stagger/reconnect slack).
 *  Read at sweep time so runtime config changes apply immediately. */
export function getStalePresenceThresholdMs(): number {
    if (config.presenceStaleOfflineMs > 0) return config.presenceStaleOfflineMs;
    return 2 * config.statusPollIntervalMs + 60_000;
}

export function getPlatform(clientStatus: any): string | null {
    if (!clientStatus) return null;
    if (clientStatus.desktop && clientStatus.desktop !== "offline") return "desktop";
    if (clientStatus.mobile  && clientStatus.mobile  !== "offline") return "mobile";
    if (clientStatus.web     && clientStatus.web     !== "offline") return "web";
    return null;
}

export function getCurrentPresence(targetId: string): PresenceState | undefined {
    return currentPresence.get(targetId);
}

export function isActiveStatus(status: string): boolean {
    return status === "online" || status === "idle" || status === "dnd";
}

export function handlePresenceUpdate(targetId: string, data: any): void {
    // Any PRESENCE_UPDATE is positive evidence the gateway path for this
    // target is alive — stamp BEFORE the no-change early-return below so
    // activity-only / duplicate updates still count as evidence.
    markPresenceEvidence(targetId);

    const stmts     = getStmts();
    const newStatus = data.status || "offline";
    const clientStatus = data.client_status || null;
    const platform  = getPlatform(clientStatus);
    const now       = Date.now();

    const current   = currentPresence.get(targetId);
    const oldStatus = current?.status   ?? "unknown";
    const oldPlatform = current?.platform ?? null;

    // No change — skip
    if (oldStatus === newStatus && oldPlatform === platform) return;

    // Close ALL open presence sessions for this target (not just the most
    // recent one). Using the close-all statement prevents orphaned open rows
    // if duplicates were ever created by a previous bug or process restart.
    if (oldStatus !== "unknown") {
        stmts.closeAllOpenPresenceSessions.run(now, now, targetId);
    }

    // Open a new session for the new status — but skip if this is the very
    // first observation (unknown) and the user is already offline. In that
    // case there is no meaningful "start" to record; the next real transition
    // (offline → online) will open a proper session.
    if (!(oldStatus === "unknown" && newStatus === "offline")) {
        stmts.insertPresenceSession.run(targetId, newStatus, platform, now);
    }

    // Only emit a PRESENCE_UPDATE event when the status itself changed.
    // A platform-only change (e.g. desktop → mobile while staying DND) produces
    // "dnd → dnd" in the timeline which is noise — emit PLATFORM_SWITCH only.
    if (oldStatus !== newStatus) {
        const eventData = JSON.stringify({
            oldStatus,
            newStatus,
            platform,
            oldPlatform,
            clientStatus,
        });
        stmts.insertEvent.run(targetId, "PRESENCE_UPDATE", now, eventData, null, null);
        evaluateEvent("PRESENCE_UPDATE", targetId, eventData, now);
        pushSSEEvent({
            target_id:  targetId,
            event_type: "PRESENCE_UPDATE",
            timestamp:  now,
            data: { oldStatus, newStatus, platform, oldPlatform, clientStatus },
        });
        log.debug(`${targetId}: ${oldStatus} -> ${newStatus} (${platform || "unknown"})`);
    }

    // Track platform switch (independent of status change — can fire alone or together)
    if (oldPlatform !== platform && (oldPlatform || platform)) {
        const switchData = JSON.stringify({ from: oldPlatform, to: platform });
        stmts.insertEvent.run(targetId, "PLATFORM_SWITCH", now, switchData, null, null);
        pushSSEEvent({
            target_id:  targetId,
            event_type: "PLATFORM_SWITCH",
            timestamp:  now,
            data: { from: oldPlatform, to: platform },
        });
        log.debug(`${targetId}: platform ${oldPlatform ?? "none"} -> ${platform ?? "none"} (${newStatus})`);
    }

    currentPresence.set(targetId, { status: newStatus, platform, clientStatus });

    // Discord force-disconnects offline users from voice, but a VOICE_STATE_UPDATE
    // with null channel_id isn't always delivered during a gateway disconnect.
    // Whenever a target transitions to offline, defensively close any open voice
    // session for them. No-op when there's nothing open. Without this, voice
    // sessions could appear to last for days across reconnects.
    if (newStatus === "offline" && oldStatus !== "offline") {
        try { closeOpenVoiceForTarget(targetId, "presence→offline"); }
        catch (err: any) { log.warn(`voice close on offline failed for ${targetId}: ${err.message}`); }
    }
}

/** Drop the in-memory presence state for a target. Called when a target is deleted. */
export function removeTargetState(targetId: string): void {
    currentPresence.delete(targetId);
    lastPresenceEvidenceAt.delete(targetId);
}

/**
 * Offline-reconciliation sweep. Force-offlines every target whose cached
 * status is active (online/idle/dnd) but which has produced no presence
 * evidence for longer than getStalePresenceThresholdMs().
 *
 * Goes through handlePresenceUpdate so the correction is indistinguishable
 * from a real transition: open presence sessions close, a PRESENCE_UPDATE
 * event persists, alerts evaluate, and the dashboard/SSE receives the exact
 * same event shape it always has. Returns the number of targets corrected.
 *
 * Callers should skip the sweep while the gateway is disconnected (no
 * evidence can arrive during an outage; forcing offline then would be a
 * guess, and chunk evidence after reconnect corrects state anyway).
 */
export function sweepStalePresence(): number {
    const threshold = getStalePresenceThresholdMs();
    const now       = Date.now();
    let corrected   = 0;

    for (const [targetId, state] of currentPresence) {
        if (!isActiveStatus(state.status)) continue;

        const lastSeen = lastPresenceEvidenceAt.get(targetId) ?? 0;
        if (now - lastSeen < threshold) continue;

        log.info(
            `No presence evidence for ${targetId} in ${Math.round((now - lastSeen) / 1000)} s ` +
            `while cached as "${state.status}" — forcing offline ` +
            `(op-14 subscription expiry recovery)`
        );
        handlePresenceUpdate(targetId, { status: "offline", client_status: null });
        corrected++;
    }

    return corrected;
}

export function initPresence(targetId: string, data: any): void {
    const status       = data.status || "offline";
    const clientStatus = data.client_status || null;
    const platform     = getPlatform(clientStatus);
    const now          = Date.now();

    currentPresence.set(targetId, { status, platform, clientStatus });
    markPresenceEvidence(targetId);

    // Only open a session for non-offline states
    if (status !== "offline") {
        const stmts = getStmts();
        stmts.insertPresenceSession.run(targetId, status, platform, now);
        const eventData = JSON.stringify({ status, platform, clientStatus, midSession: true });
        stmts.insertEvent.run(targetId, "INITIAL_PRESENCE", now, eventData, null, null);
        // Do NOT push INITIAL_PRESENCE to SSE — it fires during reconnect/chunk processing
        // and would spam the live feed with stale state. Only real changes get SSE events.
        log.debug(`${targetId}: initial presence ${status} (${platform || "unknown"})`);
    } else {
        log.debug(`${targetId}: initial presence offline (no session opened)`);
    }
}