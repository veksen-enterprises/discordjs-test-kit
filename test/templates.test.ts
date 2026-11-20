import { once } from "node:events";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function botIn(botPermissions: bigint) {
  const record = mock.createGuild("Titan");
  mock.createTextChannel(record, "general");
  mock.grantBot(botPermissions);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return client.guilds.cache.get(record.id)!;
}

it("makes a template of the guild with Manage Server, and anyone can fetch it by code", async () => {
  // Arrange
  const guild = await botIn(Permission.ManageGuild);

  // Act
  const template = await guild.createTemplate("Starter", "Our layout");

  // Assert
  const fetched = await client.fetchGuildTemplate(template.code);
  expect({
    name: fetched.name,
    description: fetched.description,
    guildId: fetched.guildId,
    creatorId: fetched.creatorId,
    channels: fetched.serializedGuild.channels?.map((c) => c.name),
    unSynced: fetched.unSynced,
  }).toEqual({
    name: "Starter",
    description: "Our layout",
    guildId: guild.id,
    creatorId: client.user!.id,
    channels: ["general"],
    unSynced: false,
  });
});

it("refuses a template without Manage Server", async () => {
  // Arrange
  const guild = await botIn(0n);

  // Act
  const created = guild.createTemplate("Starter");

  // Assert
  await expect(created).rejects.toMatchObject({ code: 50013 });
});

it("refuses a second template for the same guild", async () => {
  // Arrange
  const guild = await botIn(Permission.ManageGuild);
  await guild.createTemplate("Starter");

  // Act
  const second = guild.createTemplate("Another");

  // Assert
  await expect(second).rejects.toMatchObject({ code: 30031 });
});

it("lists the guild's templates", async () => {
  // Arrange
  const guild = await botIn(Permission.ManageGuild);
  const template = await guild.createTemplate("Starter");

  // Act
  const templates = await guild.fetchTemplates();

  // Assert
  expect([...templates.keys()]).toEqual([template.code]);
});

it("marks a template out of sync once the guild changes, and in sync again after a sync", async () => {
  // Arrange
  const guild = await botIn(Permission.ManageGuild);
  const template = await guild.createTemplate("Starter");
  mock.createTextChannel(mock.state.requireGuild(guild.id), "rules");
  const stale = await client.fetchGuildTemplate(template.code);
  const wasUnsynced = stale.unSynced;

  // Act
  const synced = await stale.sync();

  // Assert
  expect([wasUnsynced, synced.unSynced]).toEqual([true, false]);
  expect(synced.serializedGuild.channels?.map((c) => c.name)).toEqual([
    "general",
    "rules",
  ]);
});

it("renames a template", async () => {
  // Arrange
  const guild = await botIn(Permission.ManageGuild);
  const template = await guild.createTemplate("Starter");

  // Act
  const renamed = await template.edit({
    name: "Community",
    description: "New",
  });

  // Assert
  expect([renamed.name, renamed.description]).toEqual(["Community", "New"]);
});

it("deletes a template, after which its code is unknown", async () => {
  // Arrange
  const guild = await botIn(Permission.ManageGuild);
  const template = await guild.createTemplate("Starter");

  // Act
  await template.delete();

  // Assert
  await expect(client.fetchGuildTemplate(template.code)).rejects.toMatchObject({
    code: 10057,
  });
});
