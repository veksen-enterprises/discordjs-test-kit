import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";
import {
  createScheduledEvent,
  deleteScheduledEvent,
  editScheduledEvent,
  setInterest,
} from "../src/internal/scheduled-events.js";

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

const start = new Date("2026-12-01T20:00:00Z");

it("tells the bot when a member creates, edits and deletes an event", async () => {
  const guild = mock.createGuild("g");
  const lobby = mock.createVoiceChannel(guild, "lobby");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  mock.createRole(guild, "hosts", Permission.CreateEvents, [alice]);
  await login([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildScheduledEvents,
  ]);

  const created = once(client, Events.GuildScheduledEventCreate);
  const event = createScheduledEvent(mock, guild, alice, {
    name: "Raid night",
    start,
    place: { channel: lobby },
  });
  const [heard] = await created;
  // discord.js patches the cached event in place, so read it before the edit.
  expect([heard.name, heard.creatorId, heard.channelId]).toEqual([
    "Raid night",
    alice.id,
    lobby.id,
  ]);
  expect(heard.entityType).toBe(GuildScheduledEventEntityType.Voice);
  expect(heard.scheduledStartTimestamp).toBe(start.getTime());
  const updated = once(client, Events.GuildScheduledEventUpdate);
  editScheduledEvent(mock, guild, alice, event, { name: "Raid night 2" });
  const [before, after] = await updated;
  const deleted = once(client, Events.GuildScheduledEventDelete);
  deleteScheduledEvent(mock, guild, alice, event);
  await deleted;

  expect([before?.name, after.name]).toEqual(["Raid night", "Raid night 2"]);
  expect(client.guilds.cache.get(guild.id)!.scheduledEvents.cache.size).toBe(0);
});

it("refuses an event from a member without Create Events, and someone else's edit without Manage Events", async () => {
  const guild = mock.createGuild("g");
  const alice = mock.createUser("alice");
  const bob = mock.createUser("bob");
  mock.addMember(guild, alice);
  mock.addMember(guild, bob);
  mock.createRole(guild, "hosts", Permission.CreateEvents, [alice, bob]);

  expect(() =>
    createScheduledEvent(mock, guild, mock.createUser("carol"), {
      name: "x",
      start,
      place: { location: "the park" },
    }),
  ).toThrow("without Create Events");
  const event = createScheduledEvent(mock, guild, alice, {
    name: "Meetup",
    start,
    place: { location: "the park" },
  });

  expect(() =>
    editScheduledEvent(mock, guild, bob, event, { name: "mine" }),
  ).toThrow("without Manage Events");
});

it("lists the guild's events, with ones made before the bot connected in its guild", async () => {
  const guild = mock.createGuild("g");
  const owner = mock.state.requireUser(guild.ownerId);
  const event = createScheduledEvent(mock, guild, owner, {
    name: "Meetup",
    start,
    place: { location: "the park" },
  });
  await login([GatewayIntentBits.Guilds]);
  const cached = client.guilds.cache.get(guild.id)!;

  const fetched = await cached.scheduledEvents.fetch({ withUserCount: true });
  const one = await cached.scheduledEvents.fetch({
    guildScheduledEvent: event.id,
    force: true,
  });

  expect(cached.scheduledEvents.cache.has(event.id)).toBe(true);
  expect(fetched.map((e) => e.entityMetadata?.location)).toEqual(["the park"]);
  expect(one.scheduledEndTimestamp).toBe(start.getTime() + 3_600_000);
  await expect(
    cached.scheduledEvents.fetch({ guildScheduledEvent: "1", force: true }),
  ).rejects.toMatchObject({ code: 10070 });
  mock.assertNoUnhandledRequests();
});

async function botWithEvents(botPermissions: bigint) {
  const record = mock.createGuild("g");
  const lobby = mock.createVoiceChannel(record, "lobby");
  const alice = mock.createUser("alice");
  mock.addMember(record, alice);
  mock.grantBot(botPermissions);
  await login([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildScheduledEvents,
  ]);
  const guild = client.guilds.cache.get(record.id)!;
  return { record, guild, lobby, alice };
}

const HOST =
  Permission.CreateEvents | Permission.ViewChannel | Permission.Connect;

const tournament = {
  name: "Tournament",
  scheduledStartTime: start,
  scheduledEndTime: new Date(start.getTime() + 7_200_000),
  privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
  entityType: GuildScheduledEventEntityType.External,
  entityMetadata: { location: "Lobby 3" },
} as const;

it("creates an event at a place outside Discord, with the bot interested", async () => {
  // Arrange
  const { guild } = await botWithEvents(HOST);
  const created = once(client, Events.GuildScheduledEventCreate);

  // Act
  const event = await guild.scheduledEvents.create(tournament);

  // Assert
  expect([event.creatorId, event.entityMetadata?.location]).toEqual([
    client.user!.id,
    "Lobby 3",
  ]);
  expect((await created)[0].id).toBe(event.id);
  expect((await event.fetchSubscribers()).map((s) => s.user.id)).toEqual([
    client.user!.id,
  ]);
});

// A 1x1 PNG, as discord.js sends an image: a buffer it turns into a data URI.
const COVER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

it("creates an event with a cover image, and replaces the cover", async () => {
  // Arrange
  const { guild } = await botWithEvents(HOST);
  const event = await guild.scheduledEvents.create({
    ...tournament,
    image: COVER,
  });
  const first = event.image;

  // Act
  const edited = await event.edit({ image: COVER });

  // Assert
  expect(first).toMatch(/^[0-9a-f]{32}$/);
  expect(edited.image).toMatch(/^[0-9a-f]{32}$/);
  expect(edited.image).not.toBe(first);
  expect(edited.coverImageURL()).toContain(
    `/guild-events/${event.id}/${edited.image}`,
  );
});

it("refuses a cover that isn't an image", async () => {
  // Arrange
  const { guild } = await botWithEvents(HOST);

  // Act
  const created = guild.scheduledEvents.create({
    ...tournament,
    image: "data:text/plain;base64,aGk=",
  });

  // Assert
  await expect(created).rejects.toMatchObject({ code: 50035 });
});

it("creates an event in a voice channel", async () => {
  // Arrange
  const { guild, lobby } = await botWithEvents(HOST);

  // Act
  const event = await guild.scheduledEvents.create({
    name: "Raid night",
    scheduledStartTime: start,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType: GuildScheduledEventEntityType.Voice,
    channel: lobby.id,
  });

  // Assert
  expect(event.channelId).toBe(lobby.id);
});

it("refuses a place event without an end time", async () => {
  // Arrange
  const { guild } = await botWithEvents(HOST);

  // Act
  const created = guild.scheduledEvents.create({
    ...tournament,
    scheduledEndTime: undefined,
  });

  // Assert
  await expect(created).rejects.toMatchObject({ code: 50035 });
});

it("refuses to create an event without Create Events", async () => {
  // Arrange
  const { guild } = await botWithEvents(0n);

  // Act
  const created = guild.scheduledEvents.create(tournament);

  // Assert
  await expect(created).rejects.toMatchObject({ code: 50013 });
});

it("starts the bot's event, and the bot hears the update", async () => {
  // Arrange
  const { guild } = await botWithEvents(HOST);
  const event = await guild.scheduledEvents.create(tournament);
  const updated = once(client, Events.GuildScheduledEventUpdate);

  // Act
  await event.setStatus(GuildScheduledEventStatus.Active);

  // Assert
  expect((await updated)[1].status).toBe(GuildScheduledEventStatus.Active);
});

it("refuses to restart a completed event", async () => {
  // Arrange
  const { guild } = await botWithEvents(HOST);
  const event = await guild.scheduledEvents.create(tournament);
  await event.setStatus(GuildScheduledEventStatus.Active);
  await event.setStatus(GuildScheduledEventStatus.Completed);

  // Act
  const restarted = guild.scheduledEvents.edit(event.id, {
    status: GuildScheduledEventStatus.Active,
  });

  // Assert
  await expect(restarted).rejects.toMatchObject({ code: 50035 });
});

it("refuses to edit someone else's event without Manage Events", async () => {
  // Arrange
  const { record, guild, alice } = await botWithEvents(HOST);
  mock.createRole(record, "hosts", Permission.CreateEvents, [alice]);
  const theirs = createScheduledEvent(mock, record, alice, {
    name: "Movie night",
    start,
    place: { location: "Cinema" },
  });

  // Act
  const renamed = guild.scheduledEvents.edit(theirs.id, { name: "Mine now" });

  // Assert
  await expect(renamed).rejects.toMatchObject({ code: 50013 });
});

it("deletes the bot's event", async () => {
  // Arrange
  const { guild } = await botWithEvents(HOST);
  const event = await guild.scheduledEvents.create(tournament);
  const deleted = once(client, Events.GuildScheduledEventDelete);

  // Act
  await event.delete();

  // Assert
  expect((await deleted)[0].id).toBe(event.id);
});

it("tells the bot when a member marks an event Interested, and lists them with their member", async () => {
  // Arrange
  const { record, guild, alice } = await botWithEvents(HOST);
  const event = await guild.scheduledEvents.create(tournament);
  // discord.js drops the event for a user it hasn't cached, unless the bot enables Partials.User.
  await client.users.fetch(alice.id);
  const added = once(client, Events.GuildScheduledEventUserAdd);

  // Act
  setInterest(
    mock,
    record,
    alice,
    mock.state.scheduledEvents.get(event.id)!,
    true,
  );

  // Assert
  const [, user] = await added;
  expect(user.id).toBe(alice.id);
  const subscribers = await event.fetchSubscribers({ withMember: true });
  expect(subscribers.get(alice.id)?.member?.id).toBe(alice.id);
});

it("tells the bot when a member takes Interested back", async () => {
  // Arrange
  const { record, guild, alice } = await botWithEvents(HOST);
  const event = await guild.scheduledEvents.create(tournament);
  const stored = mock.state.scheduledEvents.get(event.id)!;
  setInterest(mock, record, alice, stored, true);
  await client.users.fetch(alice.id);
  const removed = once(client, Events.GuildScheduledEventUserRemove);

  // Act
  setInterest(mock, record, alice, stored, false);

  // Assert
  expect((await removed)[1].id).toBe(alice.id);
});
