/**
 * Turns Discord's terser login failures into something you can act on.
 *
 * These are the errors a first run actually hits - a forgotten portal toggle or
 * a stale token - and Discord's own wording ("Used disallowed intents") does not
 * tell you where to go or what to click.
 */

import { SafeError } from "./safe.mjs";

const LOGIN_FAILURES = [
  {
    match: /disallowed intents/i,
    message:
      "Discord refused the connection because a privileged intent is not enabled.\n" +
      "  Open the Developer Portal -> your application -> Bot -> Privileged Gateway\n" +
      "  Intents, and turn ON \"Server Members Intent\". /bonk needs it to see who\n" +
      "  holds the raider role. Leave \"Message Content Intent\" off.",
  },
  {
    match: /invalid token|TokenInvalid|401/i,
    message:
      "Discord rejected the bot token.\n" +
      "  Check DISCORD_BOT_TOKEN in .env. It comes from the Developer Portal ->\n" +
      "  your application -> Bot -> Reset Token, and is not APP_ID or PUBLIC_KEY.",
  },
  {
    match: /disallowed shard|sharding/i,
    message:
      "Discord asked this bot to shard, which this project does not support.\n" +
      "  That only happens above ~2500 guilds, so it almost certainly means the\n" +
      "  token belongs to a different, much larger application than you expect.",
  },
];

/**
 * @returns a SafeError with instructions when the failure is one we recognise,
 *          otherwise the original error untouched.
 */
export function explainLoginError(error) {
  const text = String(error?.message ?? error ?? "");
  for (const failure of LOGIN_FAILURES) {
    if (failure.match.test(text)) return new SafeError(failure.message);
  }
  return error;
}
