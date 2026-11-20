import { once } from "node:events";
import { Client, Events, GatewayIntentBits, Routes } from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  deleteExpression,
  renameExpression,
  uploadExpression,
} from "../src/internal/expressions.js";
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

async function login(intents: GatewayIntentBits[]) {
  client = new Client({ intents, ...mock.clientOptions });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

// A 1x1 PNG, as discord.js sends an image: a data URI.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

it("tells the bot when a member adds, renames and deletes an emoji and a sticker", async () => {
  const guild = mock.createGuild("g");
  const mod = mock.createUser("mod");
  mock.addMember(guild, mod);
  mock.createRole(guild, "mods", Permission.CreateGuildExpressions, [mod]);
  await login([GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions]);
  const heard: string[] = [];
  client.on(Events.GuildEmojiCreate, (e) => heard.push(`emoji+ ${e.name}`));
  client.on(Events.GuildEmojiUpdate, (a, b) =>
    heard.push(`emoji ${a.name}>${b.name}`),
  );
  client.on(Events.GuildEmojiDelete, (e) => heard.push(`emoji- ${e.name}`));
  client.on(Events.GuildStickerCreate, (s) => heard.push(`sticker+ ${s.name}`));
  client.on(Events.GuildStickerDelete, (s) => heard.push(`sticker- ${s.name}`));

  const pog = uploadExpression(mock, guild, mod, "emoji", "pog");
  renameExpression(mock, guild, mod, "emoji", pog, "poggers");
  deleteExpression(mock, guild, mod, "emoji", pog);
  const wave = uploadExpression(mock, guild, mod, "sticker", "wave");
  const deleted = once(client, Events.GuildStickerDelete);
  deleteExpression(mock, guild, mod, "sticker", wave);
  await deleted;

  expect(heard).toEqual([
    "emoji+ pog",
    "emoji pog>poggers",
    "emoji- poggers",
    "sticker+ wave",
    "sticker- wave",
  ]);
});

it("refuses an upload without Create Expressions, and someone else's emoji without Manage Expressions", () => {
  const guild = mock.createGuild("g");
  const alice = mock.createUser("alice");
  const bob = mock.createUser("bob");
  mock.addMember(guild, alice);
  mock.addMember(guild, bob);

  expect(() => uploadExpression(mock, guild, alice, "emoji", "pog")).toThrow(
    "without Create Expressions",
  );
  mock.createRole(guild, "makers", Permission.CreateGuildExpressions, [
    alice,
    bob,
  ]);
  const pog = uploadExpression(mock, guild, alice, "emoji", "pog");
  expect(() => deleteExpression(mock, guild, bob, "emoji", pog)).toThrow(
    "without Manage Expressions",
  );
});

it("lets the bot create, list, restrict and delete emojis with Create Expressions", async () => {
  const guild = mock.createGuild("g");
  const owner = mock.state.requireUser(guild.ownerId);
  const theirs = uploadExpression(mock, guild, owner, "emoji", "theirs");
  const mods = mock.createRole(guild, "mods", 0n);
  await login([GatewayIntentBits.Guilds]);
  const emojis = client.guilds.cache.get(guild.id)!.emojis;

  await expect(
    emojis.create({ attachment: PNG, name: "x1" }),
  ).rejects.toMatchObject({ code: 50013 });
  mock.grantBot(Permission.CreateGuildExpressions);
  const created = await emojis.create({ attachment: PNG, name: "mine" });
  await created.edit({ roles: [mods.id] });
  const fetched = await emojis.fetch(undefined, { force: true });
  // discord.js's fetchAuthor checks its cached permissions first; ask the Route directly.
  const raw = (await client.rest.get(
    Routes.guildEmoji(guild.id, created.id),
  )) as { user?: { id: string } };

  expect(fetched.map((e) => e.name).sort()).toEqual(["mine", "theirs"]);
  expect([...created.roles.cache.keys()]).toEqual([mods.id]);
  expect(raw.user?.id).toBe(client.user!.id);
  await expect(emojis.cache.get(theirs)!.delete()).rejects.toMatchObject({
    code: 50013,
  });
  await created.delete();
  await expect(emojis.fetch(created.id, { force: true })).rejects.toMatchObject(
    { code: 10014 },
  );
  mock.assertNoUnhandledRequests();
});

it("fetches one guild sticker by id", async () => {
  // Arrange
  const guild = mock.createGuild("g");
  const mod = mock.createUser("mod");
  mock.addMember(guild, mod);
  mock.createRole(guild, "mods", Permission.CreateGuildExpressions, [mod]);
  const wave = uploadExpression(mock, guild, mod, "sticker", "wave");
  await login([GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions]);

  // Act
  const sticker = await client.guilds.cache
    .get(guild.id)!
    .stickers.fetch(wave, { force: true });

  // Assert
  expect(sticker.name).toBe("wave");
});

it("fetches a sticker by id alone, without its uploader", async () => {
  // Arrange
  const guild = mock.createGuild("g");
  const mod = mock.createUser("mod");
  mock.addMember(guild, mod);
  mock.createRole(guild, "mods", Permission.CreateGuildExpressions, [mod]);
  const wave = uploadExpression(mock, guild, mod, "sticker", "wave");
  await login([GatewayIntentBits.Guilds]);

  // Act
  const sticker = await client.fetchSticker(wave);

  // Assert
  expect([sticker.name, sticker.guildId, sticker.user]).toEqual([
    "wave",
    guild.id,
    null,
  ]);
});

it("answers Unknown Sticker for an id that is no sticker", async () => {
  // Arrange
  await login([GatewayIntentBits.Guilds]);

  // Act
  const fetched = client.fetchSticker("1");

  // Assert
  await expect(fetched).rejects.toMatchObject({ code: 10060 });
});

const PNG_FILE = Buffer.from(PNG.split(",")[1]!, "base64");

async function botWithStickers(botPermissions: bigint) {
  const record = mock.createGuild("g");
  mock.grantBot(botPermissions);
  await login([GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions]);
  return client.guilds.cache.get(record.id)!;
}

it("lets the bot upload a sticker with Create Expressions, and hears it", async () => {
  // Arrange
  const guild = await botWithStickers(Permission.CreateGuildExpressions);
  const created = once(client, Events.GuildStickerCreate);

  // Act
  const sticker = await guild.stickers.create({
    file: PNG_FILE,
    name: "wave",
    tags: "wave",
    description: "Hello!",
  });

  // Assert
  expect([sticker.name, sticker.description]).toEqual(["wave", "Hello!"]);
  expect((await created)[0].id).toBe(sticker.id);
});

it("refuses a sticker upload without Create Expressions", async () => {
  // Arrange
  const guild = await botWithStickers(0n);

  // Act
  const created = guild.stickers.create({
    file: PNG_FILE,
    name: "wave",
    tags: "wave",
  });

  // Assert
  await expect(created).rejects.toMatchObject({ code: 50013 });
});

it("refuses a sixth sticker", async () => {
  // Arrange
  const guild = await botWithStickers(Permission.CreateGuildExpressions);
  for (const name of ["s1", "s2", "s3", "s4", "s5"])
    await guild.stickers.create({ file: PNG_FILE, name, tags: name });

  // Act
  const created = guild.stickers.create({
    file: PNG_FILE,
    name: "s6",
    tags: "s6",
  });

  // Assert
  await expect(created).rejects.toMatchObject({ code: 30039 });
});

it("renames the bot's sticker", async () => {
  // Arrange
  const guild = await botWithStickers(Permission.CreateGuildExpressions);
  const sticker = await guild.stickers.create({
    file: PNG_FILE,
    name: "wave",
    tags: "wave",
  });

  // Act
  const renamed = await sticker.edit({ name: "hello" });

  // Assert
  expect(renamed.name).toBe("hello");
});

it("deletes the bot's sticker, and hears it", async () => {
  // Arrange
  const guild = await botWithStickers(Permission.CreateGuildExpressions);
  const sticker = await guild.stickers.create({
    file: PNG_FILE,
    name: "wave",
    tags: "wave",
  });
  const deleted = once(client, Events.GuildStickerDelete);

  // Act
  await sticker.delete();

  // Assert
  expect((await deleted)[0].id).toBe(sticker.id);
});

it("uploads an emoji to the bot's application", async () => {
  // Arrange
  await login([GatewayIntentBits.Guilds]);

  // Act
  const emoji = await client.application!.emojis.create({
    attachment: PNG,
    name: "check",
  });

  // Assert
  expect([emoji.name, emoji.author?.id]).toEqual(["check", client.user!.id]);
});

it("lists the application's emojis", async () => {
  // Arrange
  await login([GatewayIntentBits.Guilds]);
  await client.application!.emojis.create({ attachment: PNG, name: "check" });

  // Act
  const emojis = await client.application!.emojis.fetch();

  // Assert
  expect(emojis.map((e) => e.name)).toEqual(["check"]);
});

it("fetches one application emoji by id", async () => {
  // Arrange
  await login([GatewayIntentBits.Guilds]);
  const { id } = await client.application!.emojis.create({
    attachment: PNG,
    name: "check",
  });

  // Act
  const emoji = await client.application!.emojis.fetch(id, { force: true });

  // Assert
  expect(emoji.name).toBe("check");
});

it("renames an application emoji", async () => {
  // Arrange
  await login([GatewayIntentBits.Guilds]);
  const emoji = await client.application!.emojis.create({
    attachment: PNG,
    name: "check",
  });

  // Act
  const renamed = await emoji.edit({ name: "tick" });

  // Assert
  expect(renamed.name).toBe("tick");
});

it("deletes an application emoji", async () => {
  // Arrange
  await login([GatewayIntentBits.Guilds]);
  const emoji = await client.application!.emojis.create({
    attachment: PNG,
    name: "check",
  });

  // Act
  await emoji.delete();

  // Assert
  expect((await client.application!.emojis.fetch()).size).toBe(0);
});
