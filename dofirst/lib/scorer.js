// DoFirst scoring engine.
//
// Scores a task from 0 to 100 and places it in one of the four Eisenhower
// quadrants. The score weighs five inputs:
//   1. the task description (keyword analysis)
//   2. urgency, from how close the due date is
//   3. impact (1 to 5)
//   4. importance (1 to 5)
//   5. criticality (1 to 5)
//
// The engine runs locally with no network calls and no API keys. If the
// caller does not provide a rating, the engine infers a starting rating
// from the words in the title and description, and says so in its reasoning.

export const QUADRANTS = ["do-now", "schedule", "delegate", "eliminate"];

export const QUADRANT_LABELS = {
  "do-now": "Do Now",
  "schedule": "Schedule",
  "delegate": "Delegate",
  "eliminate": "Eliminate",
};

const CRITICAL_WORDS = [
  "outage", "down", "crash", "broken", "emergency", "incident", "production",
  "security breach", "data loss", "blocked", "blocker", "failure", "failed",
  "urgent", "asap", "immediately", "deadline", "overdue", "expiring",
  "expires", "payment due", "tax filing", "visa", "passport expiry",
];

const IMPORTANT_WORDS = [
  "client", "customer", "revenue", "launch", "release", "interview",
  "presentation", "board", "strategy", "roadmap", "health", "doctor",
  "family", "contract", "proposal", "invoice", "budget", "promotion",
  "performance review", "goal",
];

const LOW_VALUE_WORDS = [
  "someday", "maybe", "idea", "browse", "watch later", "read later",
  "tidy", "reorganize", "reorganise", "optional", "nice to have",
  "if time", "when bored",
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function findWords(text, words) {
  // Match whole words (or whole phrases), so "down" does not fire on
  // "downloads" and "tax" does not fire on "syntax".
  return words.filter((w) => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(text);
  });
}

export function daysUntilDue(dueDate, now = new Date()) {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T23:59:59`);
  if (Number.isNaN(due.getTime())) return null;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDue = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.round((startOfDue - startOfToday) / 86400000);
}

export function urgencyFromDueDate(days) {
  if (days === null) return 20;
  if (days < 0) return 100;
  if (days === 0) return 95;
  if (days === 1) return 85;
  if (days <= 3) return 70;
  if (days <= 7) return 55;
  if (days <= 14) return 40;
  if (days <= 30) return 25;
  return 12;
}

function ratingOrInfer(value, boost) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return { rating: n, inferred: false };
  return { rating: clamp(3 + boost, 1, 5), inferred: true };
}

export function scoreTask(input, now = new Date()) {
  const text = `${input.title || ""} ${input.description || ""}`.toLowerCase();
  const criticalHits = findWords(text, CRITICAL_WORDS);
  const importantHits = findWords(text, IMPORTANT_WORDS);
  const lowHits = findWords(text, LOW_VALUE_WORDS);

  const impact = ratingOrInfer(input.impact, importantHits.length > 0 ? 1 : 0);
  const importance = ratingOrInfer(
    input.importance,
    importantHits.length > 0 || criticalHits.length > 0 ? 1 : 0,
  );
  const criticality = ratingOrInfer(input.criticality, criticalHits.length > 0 ? 2 : 0);

  const days = daysUntilDue(input.dueDate || input.due_date, now);
  const urgency = urgencyFromDueDate(days);

  let keywordBoost = 0;
  if (criticalHits.length) keywordBoost += 6;
  if (importantHits.length) keywordBoost += 3;
  if (lowHits.length) keywordBoost -= 8;

  const score = clamp(
    Math.round(
      urgency * 0.35 +
        importance.rating * 20 * 0.25 +
        impact.rating * 20 * 0.2 +
        criticality.rating * 20 * 0.2 +
        keywordBoost,
    ),
    0,
    100,
  );

  const isUrgent = urgency >= 50 || criticalHits.length > 0;
  const importanceScore = (importance.rating * 20 + impact.rating * 20) / 2;
  const isImportant = importanceScore >= 60 && lowHits.length === 0;

  let quadrant = "eliminate";
  if (isUrgent && isImportant) quadrant = "do-now";
  else if (!isUrgent && isImportant) quadrant = "schedule";
  else if (isUrgent && !isImportant) quadrant = "delegate";

  const reasons = [];
  if (days === null) reasons.push("No due date set, so urgency is low (20/100).");
  else if (days < 0) reasons.push(`Overdue by ${Math.abs(days)} day(s), so urgency is 100/100.`);
  else if (days === 0) reasons.push("Due today, so urgency is 95/100.");
  else reasons.push(`Due in ${days} day(s), so urgency is ${urgency}/100.`);
  reasons.push(
    `Impact ${impact.rating}/5, importance ${importance.rating}/5, criticality ${criticality.rating}/5.`,
  );
  if (criticalHits.length) {
    reasons.push(`Description mentions "${criticalHits[0]}", which raises criticality.`);
  } else if (importantHits.length) {
    reasons.push(`Description mentions "${importantHits[0]}", which raises importance.`);
  } else if (lowHits.length) {
    reasons.push(`Description mentions "${lowHits[0]}", which lowers the score.`);
  }
  if (impact.inferred || importance.inferred || criticality.inferred) {
    reasons.push("Some ratings were inferred from the description because they were not set.");
  }
  reasons.push(`Placed in ${QUADRANT_LABELS[quadrant]}.`);

  return {
    score,
    quadrant,
    reasoning: reasons.join(" "),
    impact: impact.rating,
    importance: importance.rating,
    criticality: criticality.rating,
    urgency,
  };
}
