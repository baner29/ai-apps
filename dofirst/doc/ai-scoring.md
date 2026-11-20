# How the AI scoring works

The scoring engine is in `lib/scorer.js`.
The engine runs on your computer.
The engine makes no network calls.
The engine needs no API keys.

## Inputs

The engine uses five inputs:

1. The task title and description.
2. The due date.
3. The impact rating, from 1 to 5.
4. The importance rating, from 1 to 5.
5. The criticality rating, from 1 to 5.

## The score

The engine gives each task a score from 0 to 100.
A high score means: do the task early.

The score is a weighted total:

| Input | Weight |
| --- | --- |
| Urgency, from the due date | 35% |
| Importance | 25% |
| Impact | 20% |
| Criticality | 20% |

The engine adds a keyword adjustment of at most 6 points up or 8 points down.
The engine keeps the final score between 0 and 100.

## Urgency

The engine calculates urgency from the number of days to the due date:

| Due date | Urgency |
| --- | --- |
| Overdue | 100 |
| Today | 95 |
| Tomorrow | 85 |
| In 2 to 3 days | 70 |
| In 4 to 7 days | 55 |
| In 8 to 14 days | 40 |
| In 15 to 30 days | 25 |
| In more than 30 days | 12 |
| No due date | 20 |

## Keywords

The engine searches the title and the description for whole words.

Words for criticality include: outage, down, crash, broken, emergency, incident, production, blocked, deadline, urgent.
Words for importance include: client, customer, revenue, launch, release, interview, presentation, strategy, health, family.
Words that lower the score include: someday, maybe, optional, nice to have, read later.

The engine matches whole words only.
The word "down" does not match inside the word "downloads".

## Inferred ratings

You can leave a rating empty.
The engine then infers a rating from the description.
The starting value is 3.
A critical keyword raises the inferred criticality to 5.
An important keyword raises the inferred impact and importance to 4.
The reasoning text tells you when a rating is inferred.

## The quadrant

The engine sets two flags:

- **Urgent:** urgency is 50 or more, or the text contains a critical keyword.
- **Important:** the average of the impact and importance scores is 60 or more, and the text contains no low-value keyword.

The flags give the quadrant:

| Urgent | Important | Quadrant |
| --- | --- | --- |
| Yes | Yes | Do Now |
| No | Yes | Schedule |
| Yes | No | Delegate |
| No | No | Eliminate |

## The reasoning text

Each scored task gets a short reasoning text.
The text shows the urgency value, the three ratings, and any keyword effect.
The card on the board shows the score.
Hover on the card to see the reasoning text in a tooltip.

## Your control

Your placement replaces the engine placement at all times.
Drag a task to a different quadrant to replace the placement.
Edit a task and click **AI Place** to score the task again.
Click **AI Prioritize All** to score all active tasks again.
