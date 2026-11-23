/**
 * Before a member clicks or picks, the kit waits for the bot to go quiet for `quietTimeMs`, so a
 * collector the bot starts after a little work of its own hears the click. Lowering it speeds up a
 * test that clicks many times, and fails a bot whose work doesn't fit in it.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";
import { expect, it } from "vitest";
import { createDiscord, type DiscordOptions } from "../src/index.js";
import { commands as panelCommands, createBot } from "./fixtures/bot.js";

const commands = [
  new SlashCommandBuilder()
    .setName("dashboard")
    .setDescription("Settings")
    .toJSON(),
];

/** Replies, works `workMs` away from Discord (a database query, say), then starts its collector. */
function createSlowCollectorBot(options: object, workMs = 50) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...options,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    let enabled = false;
    const view = () => ({
      content: `Welcome messages: ${enabled ? "on" : "off"}`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("toggle")
            .setLabel("Toggle")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    await interaction.reply(view());
    await sleep(workMs);
    const dashboard = await interaction.fetchReply();
    const collector = dashboard.createMessageComponentCollector();
    collector.on("collect", async (click) => {
      await click.deferUpdate();
      enabled = !enabled;
      await interaction.editReply(view());
    });
  });
  return client;
}

async function openDashboard(options?: DiscordOptions, workMs?: number) {
  const discord = await createDiscord(options);
  const server = discord.guild("Titan");
  const general = discord.textChannel(server, "general");
  const owner = discord.owner(server);
  await discord.start(createSlowCollectorBot(discord.clientOptions, workMs), {
    commands,
  });
  const dashboard = await owner.runCommand(general, "dashboard");
  return { owner, dashboard };
}

it("clicks once the bot has started its collector after a little work of its own", async () => {
  // Arrange
  const { owner, dashboard } = await openDashboard();

  // Act
  const after = await owner.click(dashboard, "Toggle");

  // Assert
  expect(after.content).toBe("Welcome messages: on");
});

it("clicks before the collector is up when quietTimeMs is shorter than the bot's work", async () => {
  // Arrange: a second of work, so a loaded machine can't delay the click past it.
  const { owner, dashboard } = await openDashboard({ quietTimeMs: 0 }, 1_000);

  // Act
  const click = owner.click(dashboard, "Toggle");

  // Assert
  await expect(click).rejects.toThrow("The application did not respond");
});

it("clicks without waiting out the default 100ms when quietTimeMs is 0", async () => {
  // Arrange
  const discord = await createDiscord({ quietTimeMs: 0 });
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "alice");
  await discord.start(createBot(discord.clientOptions).client, {
    commands: panelCommands,
  });
  const panel = await alice.runCommand(general, "panel");

  // Act
  const started = performance.now();
  for (let i = 0; i < 10; i++) await alice.click(panel, "+1");
  const elapsed = performance.now() - started;

  // Assert
  expect(panel.content).toBe("count 10");
  expect(elapsed).toBeLessThan(10 * 100);
});

it("refuses a quietTimeMs that isn't a number of milliseconds, 0 or more", async () => {
  await expect(createDiscord({ quietTimeMs: -1 })).rejects.toThrow(
    "quietTimeMs must be a number of milliseconds, 0 or more, not -1",
  );
  await expect(createDiscord({ quietTimeMs: Number.NaN })).rejects.toThrow(
    "not NaN",
  );
  await expect(
    createDiscord({ quietTimeMs: Number.POSITIVE_INFINITY }),
  ).rejects.toThrow("not Infinity");
});
