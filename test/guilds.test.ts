import { once } from "node:events";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";
import { setPresence } from "../src/internal/presence.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function login(intents = [GatewayIntentBits.Guilds]) {
  client = new Client({ intents, ...mock.clientOptions });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

it("lists the guild's channels the bot can view, with a hidden category whose child it can view", async () => {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const staff = mock.createCategory(guild, "staff");
  const mods = mock.createTextChannel(guild, "mods", { parent: staff });
  const secret = mock.createTextChannel(guild, "secret", { parent: staff });
  const hidden = mock.createCategory(guild, "hidden");
  const everyone = { id: guild.id, type: 0 } as const;
  for (const channel of [staff, secret, hidden])
    mock.setOverwrite(channel, everyone, { deny: Permission.ViewChannel });
  mock.setOverwrite(mods, everyone, { allow: Permission.ViewChannel });
  await login();

  const channels = await client.guilds.cache.get(guild.id)!.channels.fetch();

  expect([...channels.keys()].sort()).toEqual(
    [general.id, staff.id, mods.id].sort(),
  );
  mock.assertNoUnhandledRequests();
});

it("lists the bot's guilds, leaving out one it was kicked from, and refetches one with counts", async () => {
  const kept = mock.createGuild("kept");
  mock.addMember(kept, mock.createUser("alice"));
  mock.removeBot(mock.createGuild("kicked"));
  await login();

  const guilds = await client.guilds.fetch();
  const guild = await client.guilds.fetch({ guild: kept.id, force: true });

  expect(guilds.map((g) => g.name)).toEqual(["kept"]);
  expect(guilds.first()!.owner).toBe(false);
  expect(guild.approximateMemberCount).toBe(3);
  mock.assertNoUnhandledRequests();
});

it("renames a guild with Manage Server and hears guildUpdate, and is refused without it", async () => {
  const guild = mock.createGuild("old");
  await login();
  const cached = client.guilds.cache.get(guild.id)!;

  await expect(cached.setName("x")).rejects.toMatchObject({ code: 50013 });
  mock.grantBot(Permission.ManageGuild);
  const updated = once(client, Events.GuildUpdate);
  await cached.setName("new");

  const [before, after] = await updated;
  expect([before.name, after.name]).toEqual(["old", "new"]);
  mock.assertNoUnhandledRequests();
});

it("tells the bot when someone else renames the guild", async () => {
  const guild = mock.createGuild("old");
  await login();
  const updated = once(client, Events.GuildUpdate);

  mock.renameGuild(guild, "new");

  expect((await updated)[1].name).toBe("new");
});

it("turns the widget on with an invite channel, with Manage Server", async () => {
  // Arrange
  const record = mock.createGuild("g");
  const welcome = mock.createTextChannel(record, "welcome");
  mock.grantBot(Permission.ManageGuild);
  await login();
  const guild = client.guilds.cache.get(record.id)!;

  // Act
  await guild.setWidgetSettings({ enabled: true, channel: welcome.id });

  // Assert
  const settings = await guild.fetchWidgetSettings();
  expect([settings.enabled, settings.channel?.id]).toEqual([true, welcome.id]);
});

it("refuses to read the widget settings without Manage Server", async () => {
  // Arrange
  const record = mock.createGuild("g");
  await login();

  // Act
  const settings = client.guilds.cache.get(record.id)!.fetchWidgetSettings();

  // Assert
  await expect(settings).rejects.toMatchObject({ code: 50013 });
});

it("shows the public widget: voice channels @everyone can join, and members who are online", async () => {
  // Arrange
  const record = mock.createGuild("g");
  record.widget.enabled = true;
  mock.createTextChannel(record, "general");
  const lounge = mock.createVoiceChannel(record, "Lounge");
  const staff = mock.createVoiceChannel(record, "Staff");
  mock.setOverwrite(
    staff,
    { id: record.id, type: 0 },
    { deny: Permission.ViewChannel },
  );
  const alice = mock.createUser("alice");
  const bob = mock.createUser("bob");
  mock.addMember(record, alice);
  mock.addMember(record, bob);
  setPresence(mock, alice, {
    status: "dnd",
    activity: { name: "Chess", type: 0 },
  });
  mock.joinVoice(record, alice, lounge);
  await login();

  // Act
  const widget = await client.fetchGuildWidget(record.id);

  // Assert
  expect([...widget.channels.values()].map((c) => c.name)).toEqual(["Lounge"]);
  const [member, ...others] = widget.members.values();
  expect(others).toEqual([]);
  expect({
    id: member!.id,
    username: member!.username,
    status: member!.status,
    activity: member!.activity,
    channelId: member!.channelId,
  }).toEqual({
    id: "0",
    username: "alice",
    status: "dnd",
    activity: { name: "Chess" },
    channelId: lounge.id,
  });
  expect(widget.presenceCount).toBe(1);
});

it("answers Widget Disabled for a guild whose widget is off", async () => {
  // Arrange
  const record = mock.createGuild("g");
  await login();

  // Act
  const widget = client.fetchGuildWidget(record.id);

  // Assert
  await expect(widget).rejects.toMatchObject({ code: 50004 });
});

it("records a widget with an invite channel as unmodelled, since its invite isn't documented", async () => {
  // Arrange
  const record = mock.createGuild("g");
  const welcome = mock.createTextChannel(record, "welcome");
  record.widget = { enabled: true, channel_id: welcome.id };
  await login();

  // Act
  const widget = client.fetchGuildWidget(record.id);

  // Assert
  await expect(widget).rejects.toMatchObject({ code: 0 });
  expect(mock.rest.unhandled).toEqual(["widget.json with an invite channel"]);
  mock.rest.unhandled.length = 0;
});
