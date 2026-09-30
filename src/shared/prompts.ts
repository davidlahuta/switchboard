import type { QuickPrompt } from './types.ts';

/**
 * The prompts a session's terminal offers from its top bar, until the operator edits them.
 *
 * Seeded from how the operator actually drives a repository with many sessions in it, which is
 * two prompts, one after the other, dozens of times a day: find the next spec nothing else is
 * touching, then hand it to a new session the operator oversees directly. Typed by hand they
 * drifted — "not in conflict with open PRs", "based on fresh main", "not infra work", "deploy it
 * live and verify it on production" — and the second needed a follow-up more than once to make
 * sure the new session would not report back to the one that started it. These say all of it,
 * every time.
 */
export const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [
  {
    id: 'next-spec',
    label: 'Next spec to implement',
    text:
      'Fetch fresh origin/main and recommend the single most valuable spec to implement next that collides with nothing already in flight in this repository. ' +
      'Check every open PR (gh pr list, and the files each one changes) and every live Switchboard session here (sb_status: their intents, claims and lanes), ' +
      'and rule out any spec that one of them implements or whose files they change, any spec whose dependencies are not merged yet, and any spec that cannot be verified right now. ' +
      'A new numbered file is not a collision — a migration, an ADR, a spec, or any other file that takes the next number in a sequence: two pieces of work only collide there if they take the same number. ' +
      'For each numbered sequence the spec will add to, find the highest number taken on main, in every open PR, and in every live session\'s intents and claims, and reserve the next free one: ' +
      'claim that exact file path with sb_claim (reason "reserved for spec NNNN"), and tell the sessions adding to the same sequence which number you took with sb_send. ' +
      'If one of them is already using that number without a claim, agree the numbers with them before you answer me. ' +
      'Give me: the spec number and title, why it is the most valuable one now, what it will change, how you confirmed nothing else touches it, ' +
      'and each number you reserved (the sequence, the number, the file path, and who you told). ' +
      'If nothing qualifies, say so and why, rather than recommending one that collides.',
  },
  {
    id: 'start-session',
    label: 'Start a session for the recommended spec',
    text:
      'Start a new Switchboard session (sb_new_session) to implement the spec you just recommended. ' +
      'Brief it fully in its task: the spec number and what it covers, the open PRs and sessions it must stay clear of, ' +
      'the numbered files you reserved for it (exact paths), which it claims with sb_claim as soon as it joins — release your own reservation claims once it holds them — ' +
      'and that it drives the work to an honest done state — ' +
      'implemented, the full verification recipe green, a PR opened and merged by this repository\'s rules, and deployed and proven live whenever the spec calls for it. ' +
      'Tell it that I, the operator, oversee it directly: it must not report back to you, and it brings its questions and decisions to me. ' +
      'Once it has taken up the task, tell me its name, and do not follow up on it yourself.',
  },
];
