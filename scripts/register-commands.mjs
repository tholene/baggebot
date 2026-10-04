#!/usr/bin/env node
/**
 * Registers this bot's slash commands with Discord.
 *
 * Registration is guild-scoped rather than global: guild commands appear
 * immediately, while global ones can take up to an hour to propagate. This bot
 * only ever serves one guild, so there is no reason to register globally.
 *
 * Run this once, and again whenever a command's name, description or options
 * change. Editing the DM template or the handler logic does not need it.
 *
 *   npm run register
 */

import "dotenv/config";

import { REST, Routes } from "discord.js";

import { SafeError, log, logErr } from "../src/lib/safe.mjs";
import { loadConfig } from "../src/lib/config.mjs";
import * as bonkCommand from "../src/commands/bonk.mjs";
import * as statsCommand from "../src/commands/stats.mjs";

const commands = [bonkCommand.data, statsCommand.data];

async function main() {
  // Registration only needs to know which application and guild to target.
  const config = loadConfig({ requireBonkConfig: false });
  const rest = new REST({ version: "10" }).setToken(config.token);

  log("");
  log("Registering slash commands");
  log("==========================");
  log(`Application: ${config.appId}`);
  log(`Guild:       ${config.guildId}`);
  log(`Commands:    ${commands.map((command) => `/${command.name}`).join(", ")}`);
  log("");

  let result;
  try {
    result = await rest.put(
      Routes.applicationGuildCommands(config.appId, config.guildId),
      { body: commands.map((command) => command.toJSON()) }
    );
  } catch (error) {
    if (error?.status === 401) {
      throw new SafeError("Discord rejected the token. Check DISCORD_BOT_TOKEN.");
    }
    if (error?.status === 403) {
      throw new SafeError(
        "Discord refused the registration. The bot needs the applications.commands " +
          "scope in this guild - re-invite it with that scope ticked."
      );
    }
    if (error?.status === 404) {
      throw new SafeError(
        `Discord could not find application ${config.appId} or guild ${config.guildId}. ` +
          `Check APP_ID and GUILD_ID.`
      );
    }
    throw new SafeError(`Could not register commands: ${error?.message ?? error}`);
  }

  const registered = Array.isArray(result) ? result : [];
  log(`Registered ${registered.length} command(s):`);
  for (const command of registered) log(`  /${command.name} (id ${command.id})`);
  log("");
  log("These are live in the guild immediately. Start the bot with: npm start");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    logErr("");
    logErr(
      error instanceof SafeError
        ? `ERROR: ${error.message}`
        : `UNEXPECTED ERROR: ${error?.message ?? error}`
    );
    logErr("");
    process.exitCode = 1;
  });
