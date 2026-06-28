// player.js
// Player-side join logic for the Live Quiz feature.

import { db, ref, set, update, get, push } from "./firebase-config.js";

const HEARTBEAT_INTERVAL_MS = 10000; // how often to signal "I'm still here"
const STALE_THRESHOLD_MS = 30000;    // how long without a heartbeat before
                                      // a player is excluded from the live
                                      // "has everyone answered" count

let heartbeatIntervalId = null;

/**
 * Joins a room as a NEW player. Generates a unique player id (via
 * Firebase's push() key generator) and writes the player's name under
 * rooms/{code}/players/{playerId}.
 *
 * Players are never auto-removed on disconnect: rooms are short-lived
 * and self-cleaning (deleted by the host or by the room's own TTL), so a
 * dropped connection just leaves a quiet, harmless entry rather than
 * losing the player's score/streak. See startHeartbeat() for how
 * genuinely-absent players are excluded from live counts without being
 * deleted.
 *
 * @param {string} code - the 4-digit room code
 * @param {string} name - the player's display name
 * @returns {Promise<string>} the generated playerId
 */
export async function joinRoom(code, name) {
  const playersRef = ref(db, `rooms/${code}/players`);
  const newPlayerRef = push(playersRef);
  const playerId = newPlayerRef.key;

  await set(newPlayerRef, {
    name: name,
    score: 0,
    streak: 0,
    joinedAt: Date.now(),
    lastSeenAt: Date.now()
  });

  saveLocalIdentity(code, playerId, name);
  startHeartbeat(code, playerId);

  return playerId;
}

/**
 * Attempts to rejoin a room as a PREVIOUSLY-JOINED player, reusing their
 * existing playerId (and therefore their existing score/streak) rather
 * than starting fresh. Used when player.html loads and finds a stored
 * identity for the room code currently being entered.
 *
 * @param {string} code
 * @param {string} playerId
 * @returns {Promise<boolean>} true if the player still exists in that
 *                              room and rejoin succeeded; false if the
 *                              stored identity is no longer valid (e.g.
 *                              the room or player no longer exists),
 *                              in which case the caller should fall back
 *                              to the normal joinRoom() flow.
 */
export async function rejoinRoom(code, playerId) {
  const playerRef = ref(db, `rooms/${code}/players/${playerId}`);
  const snapshot = await get(playerRef);
  if (!snapshot.exists()) {
    clearLocalIdentity();
    return false;
  }

  await update(playerRef, { lastSeenAt: Date.now() });
  startHeartbeat(code, playerId);
  return true;
}

/**
 * Starts a periodic heartbeat write so the room can distinguish "present
 * but just hasn't answered yet" from "actually gone". Call stopHeartbeat()
 * when leaving the page/room to avoid a stray interval lingering.
 */
function startHeartbeat(code, playerId) {
  stopHeartbeat();
  const playerRef = ref(db, `rooms/${code}/players/${playerId}/lastSeenAt`);
  heartbeatIntervalId = setInterval(() => {
    set(playerRef, Date.now()).catch(() => {
      /* a transient failure here isn't worth surfacing to the player */
    });
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat() {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
}

/**
 * Returns true if a player's last heartbeat is recent enough to be
 * considered "actively present" right now. Used by the host's
 * haveAllPlayersAnswered() check to exclude genuinely-absent players
 * from the live answered-count, so the session doesn't stall waiting
 * for someone who has actually left.
 */
export function isPlayerActive(player) {
  if (!player || typeof player.lastSeenAt !== "number") return false;
  return (Date.now() - player.lastSeenAt) < STALE_THRESHOLD_MS;
}

// ── Local identity persistence (for reload/rejoin) ──────────────────────

const STORAGE_KEY = "liveQuizIdentity";

function saveLocalIdentity(code, playerId, name) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ code, playerId, name }));
}

/**
 * Returns the stored identity ({code, playerId, name}) if one exists,
 * regardless of which room it was for -- callers should check the code
 * matches the room currently being joined before using it.
 */
export function getLocalIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearLocalIdentity() {
  localStorage.removeItem(STORAGE_KEY);
}