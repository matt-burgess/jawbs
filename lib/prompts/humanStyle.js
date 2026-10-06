// Writing rules shared by every prompt whose output the user sends to
// another person (cover letter, follow-up email).
// Condensed from the "humanizer" skill (github.com/blader/humanizer, MIT),
// itself based on Wikipedia's "Signs of AI writing". Applied in the same
// call as generation — a second rewrite pass would double the API cost.
export const HUMAN_STYLE = `WRITE LIKE THE PERSON, NOT LIKE A MODEL. These patterns read as machine-written; a reader who spots one discounts the whole message:
- No "not X but Y" / "it's not just X, it's Y" contrasts. State Y.
- No one-line closers or fragments that restate the point for effect. End on the last new fact or the ask.
- No run-up before the point ("I wanted to reach out because", "I hope this finds you well", "Here's the thing"). Start with the point.
- No lists of three for rhythm. Use as many items as there are real ones.
- No em-dashes or en-dashes. Use a comma, a period, or parentheses.
- No inflated or sales words: thrilled, passionate, excited to, leverage, delve, robust, seamless, pivotal, landscape, journey, testament, unique, innovative, synergy, at the intersection of.
- No vague praise of the reader or their company. Say the specific thing or say nothing.
- No trailing "-ing" clauses that add a gloss instead of a fact ("..., highlighting my ability to").
- Every sentence must tell the reader something they did not already know. Do not explain their own company or role back to them.
- Plain verbs: "is", "has", "ran", "built". Not "serves as", "boasts", "spearheaded".
- Vary sentence length. Contractions are fine.
- If writing samples are provided, their voice overrides these defaults, except: never add a fact, name, number, or shared history that is not in the provided context.`;
