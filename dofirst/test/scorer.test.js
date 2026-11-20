import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTask, daysUntilDue, urgencyFromDueDate } from "../lib/scorer.js";

const NOW = new Date("2026-11-19T12:00:00");

function iso(daysFromNow) {
  const d = new Date(NOW);
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

test("critical task due today with top ratings lands in Do Now at a high score", () => {
  const r = scoreTask(
    {
      title: "Fix production database outage",
      description: "Customers cannot sign in.",
      dueDate: iso(0),
      impact: 5,
      importance: 5,
      criticality: 5,
    },
    NOW,
  );
  assert.equal(r.quadrant, "do-now");
  assert.ok(r.score >= 95, `expected score >= 95, got ${r.score}`);
  assert.match(r.reasoning, /Due today/);
});

test("important task due in 30 days lands in Schedule", () => {
  const r = scoreTask(
    {
      title: "Plan the client roadmap presentation",
      dueDate: iso(30),
      impact: 5,
      importance: 5,
      criticality: 3,
    },
    NOW,
  );
  assert.equal(r.quadrant, "schedule");
});

test("low value someday task lands in Eliminate", () => {
  const r = scoreTask(
    { title: "Someday maybe reorganize the downloads folder", dueDate: null },
    NOW,
  );
  assert.equal(r.quadrant, "eliminate");
  assert.ok(r.score < 50);
});

test("urgency scale: overdue beats today beats next month", () => {
  assert.equal(urgencyFromDueDate(-2), 100);
  assert.equal(urgencyFromDueDate(0), 95);
  assert.ok(urgencyFromDueDate(30) < urgencyFromDueDate(1));
  assert.equal(daysUntilDue(null, NOW), null);
});

test("ratings are inferred when not provided", () => {
  const r = scoreTask(
    { title: "Urgent: production outage", dueDate: iso(0) },
    NOW,
  );
  assert.equal(r.criticality, 5);
  assert.match(r.reasoning, /inferred/);
});
