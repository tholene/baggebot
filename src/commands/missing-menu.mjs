/**
 * "Who hasn't reacted?" - /missing from the message right-click menu
 * (long-press on mobile, then Apps).
 *
 * Discord hands over the message itself, so there is no link to copy. Context
 * menu commands cannot take options, so this always checks the raider role;
 * /missing is there for any other role.
 */

import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";

import { allowed, runMissing } from "./missing.mjs";

export const data = new ContextMenuCommandBuilder()
  .setName("Who hasn't reacted?")
  .setType(ApplicationCommandType.Message)
  // UI-level hiding only, as for /bonk. The real gate is the officer role check.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction, context) {
  const { config } = context;
  if (!(await allowed(interaction, config, "this"))) return;

  // Fetched again rather than trusting the copy in the interaction, so the
  // reactions are current and the bot's read access is checked the same way.
  const ref = {
    guildId: interaction.guildId,
    channelId: interaction.targetMessage.channelId,
    messageId: interaction.targetId,
  };
  await runMissing(interaction, config, { ref, roleId: config.raiderRoleId });
}
