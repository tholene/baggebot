#!/usr/bin/env node
/**
 * BaggeBot - the persistent half of this repo.
 *
 * Unlike cleanup.mjs / purge-channel.mjs / react.mjs, which are one-shot scripts
 * you run and walk away from, this process stays connected to the Discord
 * gateway so that officers can invoke /bonk on demand.
 *
 * The gateway connection is outbound, so this needs no public address, no open
 * port and no TLS certificate. It does need to actually be running: if the
 * process is down when someone types /bonk, Discord reports "The application did
 * not respond" and there is no retry.
 *
 *   npm start                   run it
 *   npm run register            (re)register the slash commands
 */

import "dotenv/config";

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";

import { SafeError, log, logErr } from "./lib/safe.mjs";
import { loadConfig } from "./lib/config.mjs";
import { makeRaidHelper } from "./lib/raidhelper.mjs";
import { explainLoginError } from "./lib/discord-errors.mjs";
import * as bonkCommand from "./commands/bonk.mjs";

const commands = new Map([[bonkCommand.data.name, bonkCommand]]);

/**
 * Report a failure back to whoever ran the command, without ever leaking
 * internals. SafeError messages are written for humans; anything else gets a
 * generic message and goes to the log instead.
 */
async function replyWithError(interaction, error) {
  const message =
    error instanceof SafeError
      ? error.message
      : "Something went wrong. Check the bot's logs (`journalctl --user -u baggebot`).";

  if (!(error instanceof SafeError)) {
    logErr(`UNEXPECTED ERROR in /${interaction.commandName}: ${error?.message ?? error}`);
    if (error?.stack) logErr(error.stack);
  } else {
    logErr(`/${interaction.commandName} refused: ${error.message}`);
  }

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message, embeds: [], components: [] });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  } catch (replyError) {
    logErr(`Could not deliver the error to the user: ${replyError?.message ?? replyError}`);
  }
}

async function main() {
  const config = loadConfig();

  if (config.raidChannelIds.length === 0) {
    log(
      "NOTE: RAID_CHANNEL_IDS is not set, so /bonk will consider Raid-Helper events " +
        "from every channel - including non-raid ones. Set it to your signup channel."
    );
  }

  if (!config.raidHelperApiKey) {
    log(
      "WARNING: RAID_HELPER_TOKEN is not set, so /bonk cannot read the raid calendar " +
        "and every invocation will fail. Ask a server admin to run /apikey in Discord."
    );
  }

  const raidHelper = makeRaidHelper(config.raidHelperApiKey);
  const context = { config, raidHelper };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Privileged. Without it the raider role looks empty and /bonk refuses to
      // run rather than concluding that nobody signed up.
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.once(Events.ClientReady, (ready) => {
    log(`Logged in as ${ready.user.tag} (id ${ready.user.id})`);
    log(`Serving guild ${config.guildId}; raider role ${config.raiderRoleId}`);
    log(`Officer role ${config.officerRoleId}; ${config.dmDelayMs}ms between DMs`);
    log(
      `Raid channels: ${
        config.raidChannelIds.length ? config.raidChannelIds.join(", ") : "(all - unfiltered)"
      }`
    );
    log("Ready. Waiting for /bonk.");
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) {
      logErr(`Ignoring unknown command /${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction, context);
    } catch (error) {
      await replyWithError(interaction, error);
    }
  });

  client.on(Events.Error, (error) => logErr(`Gateway error: ${error?.message ?? error}`));
  client.on(Events.Warn, (warning) => logErr(`Gateway warning: ${warning}`));

  // systemd sends SIGTERM on stop/restart; close the socket cleanly so Discord
  // does not have to time the session out.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log(`Received ${signal}, shutting down.`);
      client.destroy().finally(() => process.exit(0));
    });
  }

  try {
    await client.login(config.token);
  } catch (error) {
    // A forgotten portal toggle is the most likely first-run failure, and
    // Discord's own wording does not say which switch to flip.
    throw explainLoginError(error);
  }
}

main().catch((error) => {
  logErr("");
  if (error instanceof SafeError) {
    logErr(`ERROR: ${error.message}`);
  } else {
    // Message only - never dump objects that could carry the token.
    logErr(`UNEXPECTED ERROR: ${error?.message ?? error}`);
  }
  logErr("");
  process.exitCode = 1;
});
