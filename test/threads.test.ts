import { once } from "node:events";
import type { APIThreadChannel } from "discord-api-types/v10";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Routes,
  type ForumChannel,
  type TextChannel,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscord } from "../src/index.js";
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

async function start() {
  const guild = mock.createGuild("trade");
  const forum = mock.createForum(guild, "listings");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return { forum, alice };
}

it("moves an archived forum post from the active list to the archived one", async () => {
  const { forum, alice } = await start();
  const { thread } = mock.as(alice).forumPost(forum, { title: "old post" });
  const updated = once(client, Events.ThreadUpdate);

  mock.archiveThread(thread);

  const [, after] = await updated;
  expect(after.archived).toBe(true);
  const channel = (await client.channels.fetch(forum.id)) as ForumChannel;
  expect(channel.type).toBe(ChannelType.GuildForum);
  expect([...(await channel.threads.fetchActive()).threads.keys()]).toEqual([]);
  const archived = await channel.threads.fetchArchived({ type: "public" });
  expect([...archived.threads.keys()]).toEqual([thread.id]);
  mock.assertNoUnhandledRequests();
});

async function startInText(botPermissions: bigint) {
  const guild = mock.createGuild("help");
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

const SEND = Permission.ViewChannel | Permission.SendMessages;

it("starts a thread from a message, with the message's id, and refuses a second one", async () => {
  const { general, channel, alice } = await startInText(
    SEND | Permission.CreatePublicThreads | Permission.SendMessagesInThreads,
  );
  const posted = mock.as(alice).sendMessage(general, "help me");
  const message = await channel.messages.fetch(posted.id);
  const created = once(client, Events.ThreadCreate);

  const thread = await message.startThread({ name: "alice's question" });

  expect(thread.id).toBe(posted.id);
  expect(thread.type).toBe(ChannelType.PublicThread);
  expect((await created)[1]).toBe(true);
  expect(posted.flags! & MessageFlags.HasThread).toBe(MessageFlags.HasThread);
  const again = await client.rest
    .post(Routes.threads(general.id, posted.id), { body: { name: "again" } })
    .catch((e: unknown) => e);
  expect(again).toMatchObject({ code: 160004 });
});

it("refuses a thread to a bot without Create Public Threads", async () => {
  const { general, channel, alice } = await startInText(SEND);
  const posted = mock.as(alice).sendMessage(general, "help me");
  const message = await channel.messages.fetch(posted.id);

  const error = await message
    .startThread({ name: "nope" })
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(DiscordAPIError);
  expect(error).toMatchObject({ code: 50013 });
});

it("opens a private thread, lets in only the members the bot adds, then archives and locks it", async () => {
  const { channel, alice, bob } = await startInText(
    SEND |
      Permission.CreatePrivateThreads |
      Permission.SendMessagesInThreads |
      Permission.ManageThreads,
  );

  const ticket = await channel.threads.create({
    name: "ticket-alice",
    type: ChannelType.PrivateThread,
  });
  await ticket.members.add(alice.id);

  expect(ticket.type).toBe(ChannelType.PrivateThread);
  const record = mock.state.requireChannel(ticket.id);
  expect(mock.as(alice).sendMessage(record, "hi").content).toBe("hi");
  expect(() => mock.as(bob).sendMessage(record, "let me in")).toThrow(
    'bob isn\'t in the private thread "ticket-alice"',
  );
  expect((await ticket.members.fetch()).map((m) => m.id).sort()).toEqual(
    [client.user!.id, alice.id].sort(),
  );
  await ticket.edit({ archived: true, locked: true });
  expect(record).toMatchObject({
    thread_metadata: { archived: true, locked: true },
  });
  expect(
    await ticket.members.add(bob.id).catch((e: unknown) => e),
  ).toMatchObject({ code: 50083 });
});

it("finds the thread the bot started, and the bot's message in it", async () => {
  const discord = await createDiscord();
  const server = discord.guild("help");
  const helpChannel = discord.textChannel(server, "help");
  const alice = discord.member(server, "alice");
  const bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    ...discord.clientOptions,
  });
  bot.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const thread = await message.startThread({
      name: `help for ${message.author.username}`,
    });
    await thread.send("How can I help?");
  });
  await discord.start(bot, {
    permissions:
      Permission.CreatePublicThreads | Permission.SendMessagesInThreads,
  });

  alice.post(helpChannel, { content: "my bot won't start" });
  const thread = await discord.waitForThread(helpChannel, "help for alice");

  expect(
    (await discord.waitForMessage(thread, "How can I help?")).channel_id,
  ).toBe(thread.id);
});

it("unarchives a thread the bot posts in, but refuses a locked one without Manage Threads", async () => {
  const { forum, alice } = await start();
  const { thread } = mock.as(alice).forumPost(forum, { title: "old post" });
  const locked = mock.as(alice).forumPost(forum, { title: "closed" }).thread;
  mock.archiveThread(thread);
  mock.archiveThread(locked);
  (locked as APIThreadChannel).thread_metadata!.locked = true;
  const unarchived = new Promise((resolve) =>
    client.on(Events.ThreadUpdate, (_, after) => {
      if (after.id === thread.id && !after.archived) resolve(after.id);
    }),
  );

  await client.rest.post(Routes.channelMessages(thread.id), {
    body: { content: "bump" },
  });

  expect(await unarchived).toBe(thread.id);
  expect(
    await client.rest
      .post(Routes.channelMessages(locked.id), { body: { content: "bump" } })
      .catch((e: unknown) => e),
  ).toMatchObject({ code: 50083 });
});

it("adds a member the bot mentions in its private thread, so they can answer there", async () => {
  const { channel, alice } = await startInText(
    SEND | Permission.CreatePrivateThreads | Permission.SendMessagesInThreads,
  );
  const ticket = await channel.threads.create({
    name: "ticket",
    type: ChannelType.PrivateThread,
  });

  await ticket.send(`Hello <@${alice.id}>!`);

  const record = mock.state.requireChannel(ticket.id);
  expect(mock.as(alice).sendMessage(record, "hi").content).toBe("hi");
});

it("refuses a thread name over 100 characters, which discord.js sends as is", async () => {
  const { general, channel, alice } = await startInText(
    SEND | Permission.CreatePublicThreads,
  );
  const posted = mock.as(alice).sendMessage(general, "a very long question");
  const message = await channel.messages.fetch(posted.id);

  const error = await message
    .startThread({ name: "x".repeat(101) })
    .catch((e: unknown) => e);

  expect(error).toMatchObject({ code: 50035 });
  expect(mock.state.channels.has(posted.id)).toBe(false);
});

it("deletes a thread with Manage Threads, and the bot hears threadDelete", async () => {
  const { general, channel, alice } = await startInText(
    SEND | Permission.CreatePublicThreads | Permission.ManageThreads,
  );
  const posted = mock.as(alice).sendMessage(general, "help me");
  const thread = await (
    await channel.messages.fetch(posted.id)
  ).startThread({ name: "to delete" });
  const deleted = once(client, Events.ThreadDelete);

  await thread.delete();

  const [gone] = await deleted;
  expect(gone.id).toBe(thread.id);
  expect(gone.parentId).toBe(general.id);
  expect(mock.state.channels.has(thread.id)).toBe(false);
});

it("deletes a thread the bot started without Manage Threads, as Discord did in contract run 12", async () => {
  const { general, channel, alice } = await startInText(
    SEND | Permission.CreatePublicThreads,
  );
  const posted = mock.as(alice).sendMessage(general, "help me");
  const thread = await (
    await channel.messages.fetch(posted.id)
  ).startThread({ name: "to delete" });

  await thread.delete();

  expect(mock.state.channels.has(thread.id)).toBe(false);
});

it("refuses to delete a member's thread without Manage Threads", async () => {
  const { forum, alice } = await start();
  const { thread } = mock.as(alice).forumPost(forum, { title: "mine" });

  const error = await client.rest
    .delete(Routes.channel(thread.id))
    .catch((e: unknown) => e);

  expect(error).toMatchObject({ code: 50013 });
});

async function threadWithAlice() {
  const ctx = await startInText(
    SEND |
      Permission.CreatePublicThreads |
      Permission.SendMessagesInThreads |
      Permission.ManageThreads,
  );
  const thread = await ctx.channel.threads.create({ name: "help" });
  await thread.members.add(ctx.alice.id);
  return { ...ctx, thread };
}

it("fetches one member of a thread", async () => {
  // Arrange
  const { thread, alice } = await threadWithAlice();

  // Act
  const member = await thread.members.fetch({ member: alice.id, force: true });

  // Assert
  expect(member.id).toBe(alice.id);
});

it("removes a member from a thread with Manage Threads", async () => {
  // Arrange
  const { thread, alice } = await threadWithAlice();

  // Act
  await thread.members.remove(alice.id);

  // Assert
  expect((await thread.members.fetch()).map((m) => m.id)).toEqual([
    client.user!.id,
  ]);
});

it("leaves a thread", async () => {
  // Arrange
  const { thread, alice } = await threadWithAlice();

  // Act
  await thread.leave();

  // Assert
  expect((await thread.members.fetch()).map((m) => m.id)).toEqual([alice.id]);
});

async function archivedPrivateThread(botPermissions: bigint) {
  const ctx = await startInText(
    SEND |
      Permission.CreatePrivateThreads |
      Permission.SendMessagesInThreads |
      botPermissions,
  );
  const thread = await ctx.channel.threads.create({
    name: "mods only",
    type: ChannelType.PrivateThread,
  });
  mock.archiveThread(mock.state.requireChannel(thread.id));
  return { ...ctx, thread };
}

it("lists every archived private thread with Manage Threads", async () => {
  // Arrange
  const { channel, thread } = await archivedPrivateThread(
    Permission.ReadMessageHistory | Permission.ManageThreads,
  );

  // Act
  const archived = await channel.threads.fetchArchived({
    type: "private",
    fetchAll: true,
  });

  // Assert
  expect([...archived.threads.keys()]).toEqual([thread.id]);
});

it("refuses every archived private thread without Manage Threads, with Missing Access", async () => {
  // Arrange
  const { channel } = await archivedPrivateThread(
    Permission.ReadMessageHistory,
  );

  // Act
  const archived = channel.threads.fetchArchived({
    type: "private",
    fetchAll: true,
  });

  // Assert
  await expect(archived).rejects.toMatchObject({ code: 50001 });
});

it("lists the archived private threads the bot joined", async () => {
  // Arrange
  const { channel, thread } = await archivedPrivateThread(
    Permission.ReadMessageHistory,
  );

  // Act
  const archived = await channel.threads.fetchArchived({ type: "private" });

  // Assert
  expect([...archived.threads.keys()]).toEqual([thread.id]);
});

it("leaves archived private threads out of the public list", async () => {
  // Arrange
  const { channel } = await archivedPrivateThread(
    Permission.ReadMessageHistory,
  );

  // Act
  const archived = await channel.threads.fetchArchived({ type: "public" });

  // Assert
  expect(archived.threads.size).toBe(0);
});
