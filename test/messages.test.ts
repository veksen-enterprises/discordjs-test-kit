import { once } from "node:events";
import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Routes,
  SnowflakeUtil,
  type TextChannel,
} from "discord.js";
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

async function start(botPermissions: bigint) {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  const bob = mock.createUser("bob");
  mock.addMember(guild, bob);
  mock.grantBot(botPermissions);
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const channel = client.channels.cache.get(general.id) as TextChannel;
  return { general, channel, alice, bob };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DiscordAPIError);
  return error as DiscordAPIError;
}

it("pins and unpins with Pin Messages, lists pins newest first, and announces each change", async () => {
  const { general, channel, alice } = await start(Permission.PinMessages);
  const first = mock.as(alice).sendMessage(general, "rules");
  const second = mock.as(alice).sendMessage(general, "faq");
  const pinsChanged = once(client, Events.ChannelPinsUpdate);

  await channel.messages.pin(first.id);
  await channel.messages.pin(second.id);

  expect((await pinsChanged)[0].id).toBe(channel.id);
  const pins = await channel.messages.fetchPins();
  expect(pins.items.map((p) => p.message.content)).toEqual(["faq", "rules"]);
  expect(pins.hasMore).toBe(false);
  await channel.messages.unpin(second.id);
  const afterUnpin = await channel.messages.fetchPins();
  expect(afterUnpin.items.map((p) => p.message.content)).toEqual(["rules"]);
  mock.assertNoUnhandledRequests();
});

it("pins and unpins through the deprecated routes @discordjs/core still calls", async () => {
  // Arrange
  const { general, channel, alice } = await start(Permission.PinMessages);
  const message = mock.as(alice).sendMessage(general, "rules");

  // Act
  await client.rest.put(Routes.channelPin(channel.id, message.id));
  const pinned = (await client.rest.get(Routes.channelPins(channel.id))) as {
    content: string;
  }[];

  // Assert
  expect(pinned.map((m) => m.content)).toEqual(["rules"]);
  mock.assertNoUnhandledRequests();
});

it("refuses to pin with only Manage Messages, which no longer grants it", async () => {
  const { general, channel, alice } = await start(Permission.ManageMessages);
  const message = mock.as(alice).sendMessage(general, "rules");

  expect((await refusal(channel.messages.pin(message.id))).code).toBe(50013);
});

it("bulk deletes messages, skipping unknown ids, and the bot hears one bulk event", async () => {
  const { general, channel, alice } = await start(Permission.ManageMessages);
  const kept = mock.as(alice).sendMessage(general, "keep");
  const spam = [1, 2].map(() => mock.as(alice).sendMessage(general, "spam"));
  const bulk = once(client, Events.MessageBulkDelete);
  const unknown = SnowflakeUtil.generate().toString();

  await channel.bulkDelete([...spam.map((m) => m.id), unknown]);

  const [deleted] = await bulk;
  expect([...deleted.keys()].sort()).toEqual(spam.map((m) => m.id).sort());
  expect(mock.messagesIn(general)).toEqual([kept]);
  mock.assertNoUnhandledRequests();
});

it("refuses a bulk delete with a message over two weeks old, or too few ids", async () => {
  const { general, channel, alice } = await start(Permission.ManageMessages);
  const recent = mock.as(alice).sendMessage(general, "new");
  const old = SnowflakeUtil.generate({
    timestamp: Date.now() - 15 * 24 * 60 * 60 * 1000,
  }).toString();

  expect(
    (await refusal(channel.bulkDelete([recent.id, old], false))).code,
  ).toBe(50034);
  expect(
    (
      await refusal(
        client.rest.post(`/channels/${general.id}/messages/bulk-delete`, {
          body: { messages: [recent.id] },
        }),
      )
    ).code,
  ).toBe(50035);
});

it("refuses a reply to a message that isn't in the channel, naming the reference", async () => {
  // Arrange
  const { channel } = await start(
    Permission.SendMessages | Permission.ReadMessageHistory,
  );

  // Act
  const sent = channel.send({
    content: "reply",
    reply: { messageReference: "1000000000000000000", failIfNotExists: true },
  });

  // Assert
  await expect(sent).rejects.toMatchObject({
    code: 50035,
    rawError: {
      errors: {
        message_reference: {
          _errors: [{ code: "MESSAGE_REFERENCE_UNKNOWN_MESSAGE" }],
        },
      },
    },
  });
});

it("refuses to list who reacted without Read Message History, with Missing Access", async () => {
  // Arrange
  const { general, channel, alice } = await start(
    Permission.ReadMessageHistory,
  );
  const posted = mock.as(alice).sendMessage(general, "poll");
  mock.as(alice).react(posted, "👍");
  const message = await channel.messages.fetch(posted.id);
  mock.setOverwrite(
    general,
    { id: mock.state.bot.id, type: 1 },
    { deny: Permission.ReadMessageHistory },
  );

  // Act
  const users = message.reactions.resolve("👍")!.users.fetch();

  // Assert
  await expect(users).rejects.toMatchObject({ code: 50001 });
});

it("removes another user's reaction, an emoji's, then all, lists who reacted, and announces each", async () => {
  const { general, channel, alice, bob } = await start(
    Permission.ManageMessages | Permission.ReadMessageHistory,
  );
  const posted = mock.as(alice).sendMessage(general, "poll");
  for (const user of [alice, bob]) mock.as(user).react(posted, "👍");
  mock.as(alice).react(posted, "👎");
  const message = await channel.messages.fetch(posted.id);
  const thumbsUp = message.reactions.resolve("👍")!;

  const removed = once(client, Events.MessageReactionRemove);
  await thumbsUp.users.remove(alice.id);
  expect((await removed)[1].id).toBe(alice.id);
  expect((await thumbsUp.users.fetch()).map((u) => u.username)).toEqual([
    "bob",
  ]);

  const emojiCleared = once(client, Events.MessageReactionRemoveEmoji);
  await thumbsUp.remove();
  expect((await emojiCleared)[0].emoji.name).toBe("👍");

  const allCleared = once(client, Events.MessageReactionRemoveAll);
  await message.reactions.removeAll();
  await allCleared;
  expect(posted.reactions).toEqual([]);
  mock.assertNoUnhandledRequests();
});

it("unpins through the deprecated route", async () => {
  // Arrange
  const { general, channel, alice } = await start(Permission.PinMessages);
  const message = mock.as(alice).sendMessage(general, "rules");
  await client.rest.put(Routes.channelPin(channel.id, message.id));

  // Act
  await client.rest.delete(Routes.channelPin(channel.id, message.id));

  // Assert
  expect((await channel.messages.fetchPins()).items).toEqual([]);
});

it("removes the bot's own reaction and announces it", async () => {
  // Arrange
  const { general, channel, alice } = await start(
    Permission.ViewChannel |
      Permission.ReadMessageHistory |
      Permission.AddReactions,
  );
  const posted = mock.as(alice).sendMessage(general, "vote");
  const message = await channel.messages.fetch(posted.id);
  const reaction = await message.react("👍");
  const removed = once(client, Events.MessageReactionRemove);

  // Act
  await reaction.users.remove();

  // Assert
  expect((await removed)[1].id).toBe(client.user!.id);
});
