// session.js
// Host-side session controller: loads quiz questions, advances through
// them, manages the timer, and handles the "strip correct answer until
// reveal" logic for the Live Quiz feature.

import { db, ref, set, update, get, onValue } from "./firebase-config.js";

/**
 * Fisher-Yates shuffle (mirrors the same approach used in quiz.js).
 */
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Fetches a quiz's question bank by its index.json file path and returns
 * a shuffled, capped-length list of full question objects (including the
 * correct answer -- this is for HOST-SIDE use only; never broadcast this
 * full object while a question is live).
 *
 * @param {string} fileUrl - the "file" path from data/index.json
 * @param {number} questionCount - how many questions this session should use
 */
export async function loadQuizQuestions(fileUrl, questionCount) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Could not load quiz file: ${fileUrl}`);
  }
  const allQuestions = await response.json();
  const shuffled = shuffle(allQuestions);
  return shuffled.slice(0, Math.min(questionCount, shuffled.length));
}

/**
 * Strips the correct-answer index out of a question object, returning
 * only what's safe to broadcast while players are still answering.
 */
function stripAnswer(question) {
  return {
    question: question.question,
    answers: question.answers
  };
}

/**
 * Starts a session: writes session metadata and moves the room into the
 * first question.
 *
 * @param {string} roomCode
 * @param {object[]} questions - full question list (with correct answers),
 *                               kept in the host's own memory for the
 *                               duration of the session
 * @param {number} durationSeconds - time allowed per question
 */
export class LiveSession {
  constructor(roomCode, questions, durationSeconds = 20) {
    this.roomCode = roomCode;
    this.questions = questions;
    this.durationSeconds = durationSeconds;
    this.currentIndex = -1;
    this.roomRef = ref(db, `rooms/${roomCode}`);
    this.timerId = null;
  }

  /**
   * Pushes the next question (stripped of its answer) to the room and
   * starts the countdown. If there are no more questions, marks the
   * session finished instead.
   */
  async nextQuestion() {
    this._clearTimer();
    this.currentIndex++;

    if (this.currentIndex >= this.questions.length) {
      await update(this.roomRef, { status: "finished" });
      return;
    }

    const fullQuestion = this.questions[this.currentIndex];

    await update(this.roomRef, {
      status: "question",
      currentQuestionIndex: this.currentIndex,
      currentQuestion: stripAnswer(fullQuestion),
      questionStartedAt: Date.now(),
      questionDurationSeconds: this.durationSeconds
    });

    // Auto-advance to reveal once the timer runs out. The host can also
    // call revealAnswer() early via the "skip ahead" button.
    this.timerId = setTimeout(() => {
      this.revealAnswer();
    }, this.durationSeconds * 1000);
  }

  /**
   * Moves the room into "reveal" state, now safely including the correct
   * answer, explanation, and source since the answering window is over.
   * Also computes a per-answer tally (how many players picked each
   * option) for the host's bar-chart display.
   */
  async revealAnswer() {
    this._clearTimer();
    const fullQuestion = this.questions[this.currentIndex];
    if (!fullQuestion) return;

    const playersSnapshot = await get(ref(db, `rooms/${this.roomCode}/players`));
    const players = playersSnapshot.val() || {};

    const tally = [0, 0, 0, 0];
    Object.values(players).forEach(player => {
      const answer = player.answers && player.answers[this.currentIndex];
      if (answer && answer.selectedIndex >= 0 && answer.selectedIndex <= 3) {
        tally[answer.selectedIndex]++;
      }
    });

    await update(this.roomRef, {
      status: "reveal",
      currentQuestion: {
        question: fullQuestion.question,
        answers: fullQuestion.answers,
        correct: fullQuestion.correct,
        explanation: fullQuestion.explanation || "",
        source: fullQuestion.source || ""
      },
      answerTally: tally
    });
  }

  /**
   * Moves the room into "leaderboard" state: ranks players by score,
   * computes this round's accolades (fastest answer this question,
   * longest streak reached so far, most-improved rank vs the previous
   * leaderboard), and stores the current ranking so the NEXT leaderboard
   * can compute "most improved" against it.
   */
  async showLeaderboard() {
    const roomSnapshot = await get(this.roomRef);
    const roomData = roomSnapshot.val() || {};
    const players = roomData.players || {};
    const previousRanking = roomData.previousRanking || {};

    const playerList = Object.entries(players).map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score || 0,
      streak: p.streak || 0,
      answers: p.answers || {}
    }));

    const ranked = [...playerList].sort((a, b) => b.score - a.score);
    const top5 = ranked.slice(0, 5).map(p => ({ name: p.name, score: p.score }));

    // Fastest answer THIS question (lower elapsed time wins). Only
    // considers players who actually answered this round.
    let fastest = null;
    playerList.forEach(p => {
      const answer = p.answers[this.currentIndex];
      if (!answer) return;
      const elapsed = answer.answeredAt - (roomData.questionStartedAt || answer.answeredAt);
      if (fastest === null || elapsed < fastest.elapsed) {
        fastest = { name: p.name, elapsed };
      }
    });

    // Longest streak reached by anyone, at any point so far this session.
    let longestStreak = null;
    playerList.forEach(p => {
      if (longestStreak === null || p.streak > longestStreak.streak) {
        longestStreak = { name: p.name, streak: p.streak };
      }
    });

    // Most improved: biggest positive jump in rank position since the
    // last leaderboard. Skipped entirely on the very first leaderboard
    // of the session, since there's nothing to compare against yet.
    let mostImproved = null;
    if (Object.keys(previousRanking).length > 0) {
      let biggestJump = 0;
      ranked.forEach((p, newRankIndex) => {
        const oldRank = previousRanking[p.id];
        if (oldRank === undefined) return; // joined after the last leaderboard
        const improvement = oldRank - newRankIndex; // positive = moved up
        if (improvement > biggestJump) {
          biggestJump = improvement;
          mostImproved = { name: p.name, places: improvement };
        }
      });
    }

    // Store this round's ranking (by playerId -> rank index) for next time.
    const newRanking = {};
    ranked.forEach((p, i) => { newRanking[p.id] = i; });

    await update(this.roomRef, {
      status: "leaderboard",
      top5,
      accolades: {
        fastest: fastest ? { name: fastest.name, seconds: Math.round(fastest.elapsed / 100) / 10 } : null,
        longestStreak: longestStreak && longestStreak.streak > 0 ? longestStreak : null,
        mostImproved: mostImproved
      },
      previousRanking: newRanking
    });
  }

  /**
   * Host-triggered manual skip: jump straight to reveal even if the
   * timer hasn't run out yet (e.g. everyone's already answered, or the
   * class needs to move on).
   */
  skipToReveal() {
    this.revealAnswer();
  }

  /**
   * Returns true if every ACTIVELY PRESENT player has submitted an
   * answer for the current question. "Actively present" excludes
   * players whose heartbeat (lastSeenAt) has gone stale -- someone who
   * has genuinely left no longer blocks auto-reveal for everyone else,
   * but they're not removed from the room, so their score/streak is
   * preserved if they reconnect later.
   *
   * The staleness threshold equals ONE FULL QUESTION DURATION. The
   * reasoning: a player is only treated as genuinely gone once they've
   * been silent for at least as long as a full round -- i.e. they've
   * had an entire question's worth of opportunity to engage and shown
   * no sign of it. This is a simple, defensible rule that scales
   * correctly for any duration without needing a separate floor or
   * fraction to tune: a 20s quiz-show round gives a 20s grace period, a
   * 2-minute ACS-realistic round gives a full 2 minutes, matching how
   * long someone might reasonably be heads-down in the reference guide.
   *
   * Returns false for a room with no actively-present players, so an
   * empty or fully-stale room never "auto-reveals" instantly.
   */
  haveAllPlayersAnswered(players) {
    const staleThresholdMs = this.durationSeconds * 1000;
    const now = Date.now();

    const activePlayers = Object.values(players || {}).filter(p =>
      typeof p.lastSeenAt === "number" && (now - p.lastSeenAt) < staleThresholdMs
    );

    if (activePlayers.length === 0) return false;
    return activePlayers.every(p => p.answers && p.answers[this.currentIndex] !== undefined);
  }

  _clearTimer() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Cleans up any pending timer. Call this if the host ends the session
   * early, to avoid a stray setTimeout firing after the room is gone.
   */
  destroy() {
    this._clearTimer();
  }
}