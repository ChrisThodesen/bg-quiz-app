// scoring.js
// Scoring calculation for the Live Quiz feature: base points for a
// correct answer, a speed bonus for answering quickly, and a streak
// multiplier for consecutive correct answers.

import { db, ref, get, update } from "./firebase-config.js";

const BASE_POINTS = 100;
const MAX_SPEED_BONUS = 100; // awarded in full if answered instantly
const STREAK_BONUS_PER_STEP = 20; // extra points per consecutive correct answer, capped below
const MAX_STREAK_BONUS = 100;

/**
 * Calculates points for a single correct answer based on how quickly it
 * was submitted relative to the question's time limit, plus the
 * player's current streak (BEFORE this question is factored in).
 *
 * @param {number} answeredAtMs - timestamp the player submitted their answer
 * @param {number} questionStartedAtMs - timestamp the question went live
 * @param {number} durationSeconds - total time allowed for the question
 * @param {number} currentStreak - player's streak going into this question
 * @returns {number} total points earned for this question
 */
export function calculatePoints(answeredAtMs, questionStartedAtMs, durationSeconds, currentStreak) {
  const elapsedSeconds = Math.max(0, (answeredAtMs - questionStartedAtMs) / 1000);
  const fractionRemaining = Math.max(0, 1 - elapsedSeconds / durationSeconds);
  const speedBonus = Math.round(MAX_SPEED_BONUS * fractionRemaining);
  const streakBonus = Math.min(MAX_STREAK_BONUS, currentStreak * STREAK_BONUS_PER_STEP);
  return BASE_POINTS + speedBonus + streakBonus;
}

/**
 * Applies the scoring outcome for one player for the current question:
 * updates their score and streak in the database. Safe to call once per
 * player per question -- callers should guard against double-calling for
 * the same question (e.g. by tracking which question indices have
 * already been scored locally).
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @param {boolean} wasCorrect
 * @param {object} timing - { answeredAtMs, questionStartedAtMs, durationSeconds } or null if they didn't answer
 */
export async function applyScoring(roomCode, playerId, wasCorrect, timing) {
  const playerRef = ref(db, `rooms/${roomCode}/players/${playerId}`);
  const snapshot = await get(playerRef);
  const player = snapshot.val();
  if (!player) return;

  const currentScore = player.score || 0;
  const currentStreak = player.streak || 0;

  if (!wasCorrect || !timing) {
    // Wrong answer or no answer submitted: streak resets, no points.
    await update(playerRef, { streak: 0 });
    return;
  }

  const points = calculatePoints(
    timing.answeredAtMs,
    timing.questionStartedAtMs,
    timing.durationSeconds,
    currentStreak
  );

  await update(playerRef, {
    score: currentScore + points,
    streak: currentStreak + 1
  });
}