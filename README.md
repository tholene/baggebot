# BaggeBot

Discord tooling for one WoW guild. Two halves that share a bot token and little
else:

1. **`/bonk`** — a persistent gateway bot that DMs everyone on the raid roster
   who hasn't signed up for the next raid. This is the part that runs
   continuously.
2. **One-shot cleanup scripts** — `scripts/cleanup.mjs`, `scripts/purge-channel.mjs`
   and `scripts/react.mjs`, run by hand when needed. Documented in
   [Part 2](#part-2--one-shot-cleanup-scripts).

Everything talks to the Discord REST API v10 and, for `/bonk`, the Raid-Helper
v4 API. Node 18+ (developed on 24). Dependencies: `discord.js` and `dotenv`.

```bash
npm install
npm test           # 17 tests, no network or Discord needed
npm run check      # every file parses
```

## Layout

```
src/                the always-on half
  bot.mjs             gateway client and interaction router
  commands/bonk.mjs   the /bonk command
  lib/                config, Raid-Helper client, roster diff, DM loop, state
scripts/            one-shot tools, run by hand
  register-commands.mjs   register /bonk with Discord
  inspect-event.mjs       dump a Raid-Helper event payload
  cleanup.mjs             delete historical Raid-Helper posts
  purge-channel.mjs       delete every message in one channel
  activity-export.mjs     export a channel's history as JSONL (read-only)
  react.mjs               add or remove one reaction
test/               runs without network or Discord
logs/               record of DMs actually sent (gitignored)
```

---

# Part 1 — `/bonk`

## What it does

Ebri chases people who haven't signed up for the raid. `/bonk` does the tedious
half: work out who they are, and DM them.

```
/bonk  →  ephemeral preview: event, time, who is unsigned, who was already reminded
          [ Send 7 bonks ]  [ Cancel ]
                 ↓ only the officer who ran it can click
          progress, then a report with anyone who couldn't be reached
```

Nothing is sent until that button is clicked. It is the same idea as the
`CONFIRM_DELETE` phrase the cleanup scripts demand, in a form Discord can render.

## Why it doesn't just read `/unsigned`

Raid-Helper's `/unsigned` answers **ephemerally**. Ephemeral replies never enter
channel history, so no bot can fetch one — not over REST, not over the gateway.
Reading a normal bot message would additionally need the privileged Message
Content intent, which this project deliberately does not use.

So `/bonk` recomputes the same set instead:

```
unsigned = raider role − excluded roles − bots − anyone with any signup
```

That is what `/unsigned` does internally, and it has the advantage of yielding
real user IDs rather than display names — which is what sending a DM requires.

**Any signup counts as answered**, including Absence, Tentative and Bench. Those
people responded; chasing them would be the bug.

## Setup

### 1. Discord Developer Portal

* **Bot → Privileged Gateway Intents → Server Members Intent: ON.**
  Without it the raider role reads as empty. The bot refuses to run in that case
  rather than concluding nobody signed up.
* Leave **Message Content Intent OFF**. Nothing here needs it.
* **Application → General Information → name and icon**: this is what members
  see in their DMs, so it should look like a guild fixture.

### 2. Raid-Helper API key

A server admin runs `/apikey` in Discord; Raid-Helper DMs the key back. Put it in
`RAID_HELPER_TOKEN`. Without it `/bonk` can't read the raid calendar at all, and
every invocation fails — this key is required, not optional.

### 3. Role IDs

Discord → Settings → Advanced → **Developer Mode on**, then Server Settings →
Roles → right-click a role → **Copy Role ID**.

| Variable | Meaning |
| --- | --- |
| `RAIDER_ROLE_ID` | The roster. Everyone with this role is expected to sign up. |
| `OFFICER_ROLE_ID` | Who may run `/bonk`. Checked server-side, every invocation. |
| `EXCLUDE_ROLE_IDS` | Optional, comma-separated. Trials, socials, alt-only members. |
| `RAID_CHANNEL_IDS` | Comma-separated channels raids are posted in. Events elsewhere are ignored. |
| `RAID_HELPER_TOKEN` | From `/apikey`. Needed for auto-picking the next raid. |
| `DM_DELAY_MS` | Milliseconds between DMs. Default 2500, minimum 1000. |
| `EBRI_USER_ID` | Optional, cosmetic. When nobody needs a bonk, Ebri gets an encouraging line instead of the flat "nothing to do". Falls back to matching her name. |

### 4. Register the command and start

```bash
npm run register     # guild-scoped, so it appears immediately
npm start
```

Re-run `npm run register` only when a command's name, description or options
change. Editing the DM wording or the handler logic doesn't need it.

## Usage

```
/bonk        that's the whole command — it takes no arguments
```

The preview that comes back carries a **dropdown of the upcoming raids**, with
the soonest one already selected. Switching to a later raid is one tap and
re-runs the preview against it; the Send button always sends for whatever the
dropdown currently shows. Nothing to type, nothing to copy — which is the point,
because officers do this on their phones.

The list is the **events that have not started yet** in the channels named by
`RAID_CHANNEL_IDS`, soonest first, capped at 25 (Discord's limit on a menu). A
raid already underway is never offered, so you cannot bonk people for a raid they
are currently in. The dropdown itself is hidden when there is only one candidate,
since there would be nothing to choose.

That channel filter matters: guilds post other Raid-Helper events — roster
sign-ups, alt lists, other teams' raids — and without it a non-raid event would
show up in the picker and its non-signers could be DMed.

`/bonk` keeps **no memory between runs**. Every invocation DMs everyone currently
unsigned. That makes a second reminder closer to raid time trivial — just run it
again — but it also means running it twice in quick succession reminds the same
people twice. The preview and the confirm button are what stand between you and
that.

## The DM

`bonk-message.txt`, **re-read on every invocation** — edit the wording and the
next `/bonk` uses it, no restart needed.

| Placeholder | Becomes |
| --- | --- |
| `{user}` | A mention that pings them |
| `{name}` | Their display name, no ping |
| `{event}` | The event title |
| `{time_absolute}` | `<t:…:F>` — the raid time in *their* timezone |
| `{time_relative}` | `<t:…:R>` — "in 2 days" |
| `{link}` | Jump link to the event post |

Custom emoji work as plain shortcodes — write `:BONK:` and it is resolved against
the guild's emoji list when the DM is sent. Only names that actually exist are
substituted, so Discord's own `<t:…:R>` timestamp markup is left alone.

## Running it

The bot exists only while its process runs. If it is down when someone types
`/bonk`, Discord reports "The application did not respond" and there is no retry.
So it wants to be somewhere that stays up.

The gateway connection is **outbound**, so wherever it runs there is no port
forwarding, public IP, domain or TLS certificate involved.

### Docker (recommended)

```bash
docker compose up -d --build     # start, and come back automatically on boot
npm run logs                     # watch what the bot is doing
npm run status                   # is it up?
npm run bonks                    # what it has actually sent
docker compose restart           # after editing .env
docker compose down              # stop it
```

`restart: unless-stopped` brings the bot back after a crash and after a reboot,
provided the Docker daemon itself starts on boot:

```bash
sudo systemctl enable --now docker
```

`bonk-message.txt` is mounted rather than baked into the image, so editing the
wording takes effect on the next `/bonk` without rebuilding or restarting.

One-shot scripts use the same image:

```bash
docker compose run --rm bot npm run register
docker compose run --rm bot npm run inspect -- <eventId>
docker compose run --rm bot npm run scan
```

### Without Docker

`baggebot.service` is a systemd **user** unit for running against a local Node
install instead. You do not need it if you are using Docker.

```bash
mkdir -p ~/.config/systemd/user
cp baggebot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now baggebot
loginctl enable-linger $USER      # or it dies when you log out
journalctl --user -u baggebot -f
```

### Hosting it somewhere other than your own machine

The image is not host-specific, so moving is a matter of pointing a different
machine at this repo. Roughly, as of August 2026:

| Where | Cost | Notes |
| --- | --- | --- |
| This machine, via Docker | Free | Works today. Tied to your desktop being on. |
| [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) | Free | Generous ARM instance, free indefinitely. Signup approval is unreliable. |
| [Fly.io](https://fly.io) | ~$2/mo | `fly deploy` from this Dockerfile. No OS to maintain. No free tier. |
| Hetzner CX22 / Vultr | ~€3–4/mo | Plain VPS. `docker compose up -d` and you are done. |
| Render background worker | ~$7/mo | Fine, pricier. Its *free* tier sleeps, which kills a gateway bot. |

Anything that sleeps or scales to zero is unusable here: a sleeping gateway bot
is an offline bot.

A note on the serverless route, since it looks tempting: rewriting `/bonk` as an
HTTP interactions endpoint on Cloudflare Workers would need no always-on process
at all, but the free plan caps you at **50 external subrequests per invocation**
and each DM costs two Discord calls. That caps a single run at roughly 24
recipients, under a 40-person roster. The paid plan costs more than Fly and needs
a real rewrite. Not worth it at this scale.

## What was actually sent

Every DM attempt appends one JSON line to `logs/bonks.jsonl` — timestamp, who
invoked it, the event, the recipient, whether it succeeded, and the full message
body that went out.

```bash
npm run bonks              # the last 20 DMs
npm run bonks -- --full    # include each message body
npm run bonks -- --runs    # one line per /bonk invocation
npm run bonks -- --all     # everything
```

Two different things are called "logs" in this project, so the scripts keep them
apart: `npm run bonks` is the record of what was **sent to people**, while
`npm run logs` tails what the **bot itself** is doing in the container.

Nothing reads this file back to decide who gets a DM — `/bonk` deliberately has
no memory between runs. It is there so you can answer "what did we send, to
whom, when" after the fact rather than reconstructing it from Discord. A failure
to write it is reported and swallowed: losing the record is survivable, aborting
a half-finished DM run is not.

It is gitignored, since it contains member names and message bodies, and it is a
mounted volume in the container so it survives a rebuild.

## Safety model

Mass-DMing is precisely what Discord's spam rules target, so:

* **Preview and an explicit button click.** Never sends on invocation alone.
* **Officer-gated**, checked server-side on every use. `default_member_permissions`
  hides it in the UI, but that can be overridden by admins, so it is not the gate.
* **One guild.** The event's server ID is verified against `GUILD_ID`.
* **Paced**, sequential, never parallel. Bulk-opening DM channels fast is the
  flagged pattern. The bot refuses to start with `DM_DELAY_MS` under 1000.
* **Final per-recipient gate.** Immediately before each DM: still on the roster,
  still unsigned, not excluded. The preview may be minutes old by then, and
  someone may have signed up in between.
* **Fails closed on a missing signup list.** If Raid-Helper's response shape
  changes and the signups can't be found, it throws — treating that as "nobody
  signed up" would DM the entire roster.
* **Closed DMs are expected, not fatal.** They surface as `50007`, get collected,
  and are reported as a copy-pasteable list to chase by hand.
* **Never sent to anyone without the raider role.**
* **Every attempt is recorded** to `logs/bonks.jsonl`, including the message body.

## When Raid-Helper's API shape changes

The v4 response format isn't publicly documented, so `src/lib/raidhelper.mjs` reads
every field through a list of candidate spellings. To see what the API actually
returns:

```bash
npm run inspect -- <eventId>
```

It prints the raw payload and how `src/lib/raidhelper.mjs` parsed it. Read-only.

---

# Part 2 — one-shot cleanup scripts

Deliberately small, local, one-shot utilities. They share the bot token and
`src/lib/safe.mjs` with the bot above, but hold their own hand-rolled REST clients
and run standalone.

## RaidCleanup — deleting historical signup posts

Scan one configured channel's full message history, list every message authored
by Raid-Helper, and delete the old ones after you have reviewed them. There is no
Gateway connection and no use of the Raid-Helper API — the Raid-Helper events are
already gone; only the leftover Discord messages remain.

Identity is decided **only** by the immutable Discord author user ID
(`message.author.id === RAID_HELPER_USER_ID`). Message text, embed contents,
usernames and bot flags are never used to decide deletion, so the
**Message Content intent is not required**.

## Known target

```text
Guild:       240837008212230144
Channel:     1279867299066675321
Raid-Helper: 579155972115660803
```

Identity is decided **only** by the immutable Discord author user ID
(`message.author.id === RAID_HELPER_USER_ID`). Message text, embed contents,
usernames and bot flags are never used to decide deletion, so the
**Message Content intent is not required**.

## Required permissions

In the raid signup channel, the cleanup scripts need:

* **View Channel**
* **Read Message History**
* **Manage Messages** (only for actual deletion — dry-run scanning works without it)

**Administrator is not required** and should not be granted.

## Bot token

`DISCORD_BOT_TOKEN` comes from the Discord Developer Portal → your application
→ **Bot** → *Reset Token*. The same token drives `/bonk`, so rotating it means
restarting the bot too.

* The application **ID** and **public key** (`APP_ID`, `PUBLIC_KEY`) are for
  verifying incoming interaction webhooks. They **cannot** authenticate REST
  requests that read or delete messages, so they are not substitutes for
  `DISCORD_BOT_TOKEN` and this script does not use them.
* Never use a personal Discord user token. That violates Discord's ToS and the
  script refuses a non-bot token outright.
* `.env` is gitignored. Never commit the real token.

## Configuration

Copy `.env.example` to `.env` and fill in the token:

```env
DISCORD_BOT_TOKEN=

GUILD_ID=240837008212230144
CHANNEL_ID=1279867299066675321
RAID_HELPER_USER_ID=579155972115660803

DRY_RUN=true
DELETE_ALL_MATCHES=false
KEEP_FROM_MESSAGE_ID=
CONFIRM_DELETE=
MAX_DELETE=
```

| Variable | Meaning |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot token for the temporary cleanup application. |
| `GUILD_ID` | Server the channel must belong to. Verified against Discord. |
| `CHANNEL_ID` | The one channel that will be touched. |
| `RAID_HELPER_USER_ID` | The only author whose messages may ever be deleted. |
| `DRY_RUN` | `true` (default) lists only; `false` permits deletion. |
| `DELETE_ALL_MATCHES` | `true` makes every Raid-Helper message eligible. Dangerous. |
| `KEEP_FROM_MESSAGE_ID` | Oldest Raid-Helper message to **preserve**. It and everything newer is kept. |
| `CONFIRM_DELETE` | Must be exactly `DELETE_RAID_HELPER_MESSAGES` for a real run. |
| `MAX_DELETE` | Optional cap. Empty = built-in default of **500**. |

`DRY_RUN` and `DELETE_ALL_MATCHES` accept only the literal strings `true` or
`false`; a typo is an error rather than a silent fallback.

## First run (safe)

Ensure:

```env
DRY_RUN=true
DELETE_ALL_MATCHES=false
KEEP_FROM_MESSAGE_ID=
```

Then:

```bash
npm run scan
```

This authenticates, verifies the channel belongs to the configured guild, pages
through the entire channel history, and prints every Raid-Helper message
oldest-first with its timestamp, ID, Discord jump URL, the planned action, and
(when available) the embed title as a non-authoritative diagnostic label.
Nothing is deleted.

## Review

Open several of the printed jump URLs:

```text
https://discord.com/channels/<GUILD_ID>/<CHANNEL_ID>/<MESSAGE_ID>
```

Confirm manually that they really are the old Raid-Helper signup posts before
enabling deletion.

## Recommended real cleanup (keep recent signups)

1. Decide the **oldest Raid-Helper post that should remain**.
2. In Discord, enable Developer Mode (User Settings → Advanced) if needed.
3. Right-click that message → **Copy Message ID**.
4. Put it in `.env`:

   ```env
   KEEP_FROM_MESSAGE_ID=<that message ID>
   ```
5. Run another dry run:

   ```bash
   npm run scan
   ```
6. Confirm the `[DELETE]` / `[KEEP]` boundary is exactly where you expect.
7. Only then set:

   ```env
   DRY_RUN=false
   CONFIRM_DELETE=DELETE_RAID_HELPER_MESSAGES
   ```
8. Run it for real:

   ```bash
   npm run cleanup
   ```

The boundary is not trusted blindly: the script requires that
`KEEP_FROM_MESSAGE_ID` exists in the fetched history of the configured channel
**and** is authored by `RAID_HELPER_USER_ID`. Otherwise it stops without
deleting anything.

## Delete-all mode (more dangerous alternative)

```env
DRY_RUN=false
DELETE_ALL_MATCHES=true
KEEP_FROM_MESSAGE_ID=
CONFIRM_DELETE=DELETE_RAID_HELPER_MESSAGES
```

⚠️ **This deletes every Raid-Helper-authored message in the configured
channel**, including current and future signups. Use it only when there is
nothing left worth keeping.

Setting `DELETE_ALL_MATCHES=true` **and** `KEEP_FROM_MESSAGE_ID` together is
treated as ambiguous configuration and refused.

## Safety model

* **Dry run is the default.** Real deletion needs `DRY_RUN=false`, an exact
  `CONFIRM_DELETE` phrase, and exactly one deletion strategy.
* **Author-ID only.** No content, embed, username or bot-flag matching.
* **Single channel.** The channel must resolve via Discord and its `guild_id`
  must equal `GUILD_ID`, otherwise the run stops.
* **Final per-message gate.** Immediately before each `DELETE`, the message is
  re-checked for author ID, channel ID and a valid snowflake.
* **Validated boundary.** See above.
* **Ambiguity fails closed.** Conflicting or malformed settings abort.
* **Zero-match protection.** If no Raid-Helper messages exist, it says so and
  exits successfully without acting.
* **Volume cap.** More than `MAX_DELETE` (default 500) eligible messages is a
  warning in dry run and a refusal in a real run. Raise it deliberately in
  `.env` — the error message tells you the exact number needed.
* **Individual deletes.** `DELETE /channels/{id}/messages/{id}` one at a time,
  sequentially, with an audit-log reason. Bulk delete is **not** used because it
  rejects messages older than 14 days.
* **Rate limits.** HTTP 429 is handled by honouring `retry_after` and retrying;
  5xx and network errors get bounded exponential-backoff retries.
* **Permission failure aborts early.** A 401/403 on the first delete stops the
  run instead of hammering Discord with doomed requests.
* **No secret leakage.** The token is never printed; all output is passed
  through a scrubber, and error handling prints messages only — never headers,
  request objects or `process.env`.
* **Honest exit codes.** Any per-message failure means a non-zero exit and an
  explicit "Completed WITH FAILURES" line.

## Final counts

Every real run ends with:

```text
Messages scanned:
Raid-Helper matches:
Eligible:
Deleted:
Failed:
Kept:
```

## Afterward

* Verify the signup channel manually in Discord.
* Reset `.env` back to `DRY_RUN=true`, `CONFIRM_DELETE=` so a stray re-run is
  harmless.
* Leave future clutter to Raid-Helper's own event deletion/cleanup settings
  rather than re-running this tool.

> **Do not kick the bot or reset its token.** Earlier versions of this file said
> to decommission the cleanup bot once it had done its job. That no longer
> applies: the same application now runs `/bonk`, so removing it or rotating its
> token takes the reminder bot offline.
>
> The bot does still hold **Manage Messages** in the signup channel, which
> `/bonk` has no use for. That is deliberate — the cleanup scripts need it. Narrow
> it if you retire them.


---

# Part 3 — `activity-export.mjs`

Dumps one channel's message history to `logs/activity-<channel-id>.jsonl`, one
JSON object per message, oldest first. Read-only: it has no delete path and no
confirmation phrase, but it does copy chat onto disk, so it writes into the
gitignored `logs/` directory next to `bonks.jsonl`.

```bash
npm run activity -- <channel-id>
npm run activity -- <channel-id> --include-provisional --since=2026-08-01
```

Each record:

```json
{"id":"…","at":"2026-09-07T13:39:53.559000+00:00","author_id":"…","author":"fink5821",
 "display_name":"Fink","character":"Finklebear","account":"linked","bot":false,
 "content":"","edited":false,"reply_to":null,"attachments":0,"type":0}
```

## Linked vs provisional accounts

The guild chat channel is bridged from in-game chat, so authors come in two
kinds:

* **Linked** — a real Discord account. Normal username, normal snowflake.
* **Provisional** — the placeholder Discord mints for someone posting from the
  game without a linked Discord account. Auto-generated username
  (`jovial_kitten_04911`), display name set to the character name, and user flag
  `1 << 23` set. One human can hold several of these, so counting them as people
  overcounts.

Provisional accounts are excluded by default; `--include-provisional` keeps them.
`character` carries the in-game name a bridged message was sent from, which is
what links a provisional account back to a person.

## Message Content intent

**This script needs the Message Content privileged intent, which the rest of the
project deliberately does without.** Discord returns `content: ""` to every
application that lacks it — over REST as well as over the gateway — so the export
is timestamps-only until it is enabled. The script exits non-zero and says so
rather than writing a file that quietly means nothing.

Enabling it is retroactive: history already in the channel becomes readable, so
there is no need to "start collecting" before analysis is possible. Turn it on at
Developer Portal → Bot → Privileged Gateway Intents → Message Content Intent.
`/bonk` neither needs nor reads it; `src/bot.mjs` does not request the intent, so
turning it on in the portal changes nothing about how the bot runs.
