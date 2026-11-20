import { once } from "node:events";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

const adminConfig = new SlashCommandBuilder()
  .setName("admin-config")
  .setDescription("Configure the ladder")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set the channels")
      .addChannelOption((option) =>
        option
          .setName("updates")
          .setDescription("Where results go")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText),
      ),
  );

async function start() {
  const guild = mock.createGuild("ladder");
  const general = mock.createTextChannel(guild, "general");
  const category = mock.createCategory(guild, "ladders");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  const owner = mock.state.requireUser(guild.ownerId);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const updates = interaction.options.getChannel("updates", true);
    await interaction.reply(
      `${interaction.options.getSubcommand()} ${updates.name} ${updates.type}`,
    );
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client.application!.commands.set([adminConfig.toJSON()]);
  return { guild, general, category, alice, owner };
}

it("runs a subcommand with a channel option, resolved for the bot", async () => {
  const { general, owner } = await start();

  const reply = await mock
    .as(owner)
    .slashCommand(general, "admin-config set", { updates: general.id })
    .reply();

  expect(reply.content).toBe(`set general ${ChannelType.GuildText}`);
  mock.assertNoUnhandledRequests();
});

it("refuses a channel the option doesn't offer, and a missing subcommand", async () => {
  const { general, category, owner } = await start();

  expect(() =>
    mock
      .as(owner)
      .slashCommand(general, "admin-config set", { updates: category.id }),
  ).toThrow(/only offers channel types/);
  expect(() =>
    mock.as(owner).slashCommand(general, "admin-config", {}),
  ).toThrow(/needs a subcommand: set/);
});

it("records commands for a guild the bot isn't in as unmodelled, and names that request when a command isn't registered", async () => {
  // Arrange
  const guild = mock.createGuild("ladder");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  await client
    .application!.commands.set([{ name: "ping", description: "Pings" }], "1")
    .catch(() => {});

  // Act
  const run = () => mock.as(alice).slashCommand(general, "ping");

  // Assert
  expect(run).toThrow(
    `its PUT /applications/${client.application!.id}/guilds/1/commands was answered 404`,
  );
  expect(mock.rest.unhandled).toEqual([
    "guild commands for a guild the bot isn't in",
  ]);
  mock.rest.unhandled.length = 0;
});

it("hides a command from members without its default permissions", async () => {
  const { general, alice } = await start();

  expect(() =>
    mock
      .as(alice)
      .slashCommand(general, "admin-config set", { updates: general.id }),
  ).toThrow(/can't use \/admin-config/);
});

it("creates one command as an upsert, edits it, and deletes it so users can't run it", async () => {
  const { guild, general, alice } = await start();
  const commands = client.application!.commands;
  const ping = { name: "ping", description: "Pings" };

  const created = await commands.create(ping, guild.id);
  const again = await commands.create(
    { ...ping, description: "Pings again" },
    guild.id,
  );
  const edited = await commands.edit(
    created.id,
    { description: "Pings, edited" },
    guild.id,
  );

  expect(again.id).toBe(created.id);
  expect(edited.description).toBe("Pings, edited");
  expect((await commands.fetch({ guildId: guild.id })).size).toBe(1);
  await commands.delete(created.id, guild.id);
  expect(() => mock.as(alice).slashCommand(general, "ping")).toThrow(
    "/ping isn't registered",
  );
  expect(
    await commands.delete(created.id, guild.id).catch((e) => e),
  ).toMatchObject({ code: 10063 });
});

it("answers 201 for a new command and 200 for an existing name, as Discord's docs say", async () => {
  await start();
  const path = `/applications/${client.application!.id}/commands`;
  const post = () =>
    fetch(`${mock.apiUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bot ${mock.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "ping", description: "Pings" }),
    });

  expect((await post()).status).toBe(201);
  expect((await post()).status).toBe(200);
});

it("lists the global commands the bot registered", async () => {
  // Arrange
  await start();

  // Act
  const commands = await client.application!.commands.fetch();

  // Assert
  expect(commands.map((c) => c.name)).toEqual(["admin-config"]);
});

it("fetches one global command by id", async () => {
  // Arrange
  await start();
  const [id] = client.application!.commands.cache.keys();

  // Act
  const command = await client.application!.commands.fetch(id!, {
    force: true,
  });

  // Assert
  expect(command.name).toBe("admin-config");
});

it("edits a global command's description and keeps its name", async () => {
  // Arrange
  await start();
  const [id] = client.application!.commands.cache.keys();

  // Act
  const edited = await client.application!.commands.edit(id!, {
    description: "Configure the season",
  });

  // Assert
  expect([edited.name, edited.description]).toEqual([
    "admin-config",
    "Configure the season",
  ]);
});

it("deletes a global command, so the list no longer has it", async () => {
  // Arrange
  await start();
  const [id] = client.application!.commands.cache.keys();

  // Act
  await client.application!.commands.delete(id!);

  // Assert
  expect((await client.application!.commands.fetch()).size).toBe(0);
});

it("fetches one guild command by id", async () => {
  // Arrange
  const { guild } = await start();
  const commands = client.guilds.cache.get(guild.id)!.commands;
  const [created] = (await commands.set([adminConfig.toJSON()])).values();

  // Act
  const command = await commands.fetch(created!.id, { force: true });

  // Assert
  expect(command.guildId).toBe(guild.id);
});
