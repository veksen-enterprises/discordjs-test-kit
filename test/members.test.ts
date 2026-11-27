import { once } from "node:events";
import { Client, Events, GatewayIntentBits, Routes } from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

async function start(intents: GatewayIntentBits[]) {
  const guild = mock.createGuild("ladder");
  for (const name of ["alice", "albert", "bob"])
    mock.addMember(guild, mock.createUser(name));
  client = new Client({ intents, ...mock.clientOptions });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return client.guilds.cache.get(guild.id)!;
}

it("fetches every member over the gateway with GUILD_MEMBERS", async () => {
  const guild = await start([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]);

  const members = await guild.members.fetch();

  expect(members.map((m) => m.user.username).sort()).toEqual([
    "albert",
    "alice",
    "bob",
    "bot",
    "ladder-owner",
  ]);
  mock.assertNoUnhandledRequests();
});

it("fetches members by username prefix", async () => {
  const guild = await start([GatewayIntentBits.Guilds]);

  const members = await guild.members.fetch({ query: "al", limit: 10 });

  expect(members.map((m) => m.user.username).sort()).toEqual([
    "albert",
    "alice",
  ]);
  mock.assertNoUnhandledRequests();
});

it("records a Gap when the whole list is asked for without GUILD_MEMBERS", async () => {
  const guild = await start([GatewayIntentBits.Guilds]);

  await expect(guild.members.fetch({ time: 200 })).rejects.toThrow();

  expect(() => mock.assertNoUnhandledRequests()).toThrow(
    /without GUILD_MEMBERS/,
  );
});

it("announces a member leaving to a bot with GUILD_MEMBERS", async () => {
  const guild = await start([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]);
  const record = mock.state.requireGuild(guild.id);
  const carol = mock.createUser("carol");
  mock.addMember(record, carol);
  // GUILD_MEMBER_ADD caches her; discord.js drops a removal for an uncached member.
  await vi.waitFor(() => expect(guild.members.cache.has(carol.id)).toBe(true));
  const removed = once(client, Events.GuildMemberRemove);

  mock.removeMember(record, carol);

  const [member] = await removed;
  expect(member.id).toBe(carol.id);
  expect(member.guild.id).toBe(guild.id);
});

it("announces a nickname change to a bot with GUILD_MEMBERS", async () => {
  const guild = await start([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]);
  const record = mock.state.requireGuild(guild.id);
  const carol = mock.createUser("carol");
  mock.addMember(record, carol);
  await vi.waitFor(() => expect(guild.members.cache.has(carol.id)).toBe(true));
  const updated = once(client, Events.GuildMemberUpdate);

  mock.setNickname(record, carol, "Caz");

  const [before, after] = await updated;
  expect(before.displayName).toBe("carol");
  expect(after.displayName).toBe("Caz");
});

it("emits userUpdate in discord.js when a member changes their display name", async () => {
  const guild = await start([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ]);
  const record = mock.state.requireGuild(guild.id);
  const carol = mock.createUser("carol");
  mock.addMember(record, carol);
  await vi.waitFor(() => expect(guild.members.cache.has(carol.id)).toBe(true));
  const updated = once(client, Events.UserUpdate);

  mock.setDisplayName(carol, "Caroline");

  const [before, after] = await updated;
  expect(before.displayName).toBe("carol");
  expect(after.displayName).toBe("Caroline");
  expect(guild.members.cache.get(carol.id)!.displayName).toBe("Caroline");
});

it("leaves a guild: guildDelete, then nothing more from it", async () => {
  const guild = await start([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ]);
  const record = mock.state.requireGuild(guild.id);
  const channel = mock.createTextChannel(record, "general");
  const deleted = once(client, Events.GuildDelete);
  const heard = vi.fn();
  client.on(Events.MessageCreate, heard);

  await guild.leave();

  const [gone] = await deleted;
  expect(gone.id).toBe(guild.id);
  expect(client.guilds.cache.has(guild.id)).toBe(false);
  mock.as(mock.state.requireUser(record.ownerId)).sendMessage(channel, {
    content: "still there?",
  });
  await mock.waitForIdle();
  expect(heard).not.toHaveBeenCalled();
  await expect(
    client.rest.get(`/guilds/${guild.id}/members/${record.ownerId}`),
  ).rejects.toThrow("Missing Access");
  mock.assertNoUnhandledRequests();
});

it("tells a bot it was kicked, and leaves the guild out when it reconnects", async () => {
  const guild = await start([GatewayIntentBits.Guilds]);
  const record = mock.state.requireGuild(guild.id);
  const deleted = once(client, Events.GuildDelete);

  mock.removeBot(record);

  await deleted;
  await client.destroy();
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  expect(client.guilds.cache.has(guild.id)).toBe(false);
});

it("lists members in id order, a page at a time", async () => {
  // Arrange
  const guild = await start([GatewayIntentBits.Guilds]);
  const ids = [...mock.state.guilds.get(guild.id)!.members.keys()].sort(
    (a, b) => (BigInt(a) < BigInt(b) ? -1 : 1),
  );

  // Act
  const page = await guild.members.list({ limit: 2, after: ids[0] });

  // Assert
  expect([...page.keys()]).toEqual(ids.slice(1, 3));
});

it("searches members by the start of their name", async () => {
  // Arrange
  const guild = await start([GatewayIntentBits.Guilds]);

  // Act
  const found = await guild.members.search({ query: "AL", limit: 10 });

  // Assert
  expect(found.map((m) => m.user.username).sort()).toEqual(["albert", "alice"]);
});

it("finds a member by nickname", async () => {
  // Arrange
  const record = mock.createGuild("ladder");
  mock.addMember(record, mock.createUser("bob"), { nick: "Champion" });
  const guild = await login(record.id);

  // Act
  const found = await guild.members.search({ query: "champ" });

  // Assert
  expect(found.map((m) => m.user.username)).toEqual(["bob"]);
});

async function login(guildId: string) {
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return client.guilds.cache.get(guildId)!;
}

it("sets the bot's nickname through the old nickname route", async () => {
  // Arrange
  const record = mock.createGuild("g");
  mock.grantBot(Permission.ChangeNickname);
  const guild = await login(record.id);

  // Act
  await client.rest.patch(Routes.guildCurrentMemberNickname(guild.id), {
    body: { nick: "Ref" },
  });

  // Assert
  expect(record.members.get(client.user!.id)!.nick).toBe("Ref");
});

it("refuses to add a member with an OAuth2 token, since the test world issues none", async () => {
  // Arrange
  const record = mock.createGuild("g");
  const alice = mock.createUser("alice");
  mock.grantBot(Permission.CreateInstantInvite);
  const guild = await login(record.id);

  // Act
  const added = guild.members.add(alice.id, { accessToken: "token" });

  // Assert
  await expect(added).rejects.toMatchObject({ code: 50025 });
});
