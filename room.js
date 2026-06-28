// room.js
// Room creation, lookup, and lifecycle helpers for the Live Quiz feature.

import { db, ref, set, get, remove, onDisconnect, serverTimestamp } from "./firebase-config.js";

const ROOM_TTL_MS = 60 * 60 * 1000; // 1 hour safety-net auto cleanup

/**
 * Generates a random 4-digit room code as a zero-padded string, e.g. "0421".
 */
function generateRoomCode() {
  const n = Math.floor(Math.random() * 10000);
  return n.toString().padStart(4, "0");
}

/**
 * Creates a new room with a unique 4-digit code. Retries on the rare
 * collision with an already-active room code.
 * @param {string} quizId - matches an id in data/index.json
 * @returns {Promise<string>} the created room code
 */
export async function createRoom(quizId) {
  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const roomRef = ref(db, `rooms/${code}`);
    const snapshot = await get(roomRef);

    if (!snapshot.exists()) {
      await set(roomRef, {
        quizId,
        status: "lobby",
        currentQuestionIndex: 0,
        createdAt: serverTimestamp(),
        players: {}
      });

      // Safety net: if the host's tab disconnects unexpectedly (crash,
      // closed laptop lid, network drop) Firebase will run this removal
      // server-side even though the client never got to run its own
      // cleanup code.
      onDisconnect(roomRef).remove();

      // Belt-and-braces: also schedule a client-side cleanup in case the
      // host keeps the tab open well past the session (e.g. forgets to
      // close it). This only fires if the tab stays open that long.
      setTimeout(() => {
        remove(roomRef).catch(() => {
          /* room may already be gone -- not an error worth surfacing */
        });
      }, ROOM_TTL_MS);

      return code;
    }
    // Collision (rare with 10,000 possible codes and short-lived rooms) --
    // loop and try a new random code.
  }
  throw new Error("Could not generate a unique room code after several attempts. Please try again.");
}

/**
 * Checks whether a room code currently exists and is joinable (still in
 * the lobby state).
 * @param {string} code
 * @returns {Promise<{exists: boolean, joinable: boolean}>}
 */
export async function checkRoom(code) {
  const roomRef = ref(db, `rooms/${code}`);
  const snapshot = await get(roomRef);
  if (!snapshot.exists()) {
    return { exists: false, joinable: false };
  }
  const room = snapshot.val();
  return { exists: true, joinable: room.status === "lobby" };
}

/**
 * Permanently deletes a room. Called by the host when ending a session
 * normally (not via disconnect/timeout).
 * @param {string} code
 */
export async function deleteRoom(code) {
  await remove(ref(db, `rooms/${code}`));
}