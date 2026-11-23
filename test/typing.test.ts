import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  type TextChannel,
  type Typing,
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

async function start(intents: GatewayIntentBits[]) {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, ...intents],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return {
    general,
    alice,
    channel: client.channels.cache.get(general.id) as TextChannel,
  };
}

it("tells the bot a member is typing, with their member, under Guild Message Typing", async () => {
  const { general, alice } = await start([
    GatewayIntentBits.GuildMessageTyping,
  ]);
  const heard = once(client, Events.TypingStart);

  mock.as(alice).startTyping(general);

  const [typing] = (await heard) as [Typing];
  expect([typing.user.id, typing.channel.id, typing.member?.id]).toEqual([
    alice.id,
    general.id,
    alice.id,
  ]);
});

it("shows the bot typing with a 204, and refuses it with Missing Access where it can't send messages", async () => {
  const { general, channel } = await start([]);

  await expect(channel.sendTyping()).resolves.toBeUndefined();
  mock.assertNoUnhandledRequests();
  mock.setOverwrite(
    general,
    { id: mock.state.bot.id, type: 1 },
    { deny: Permission.SendMessages },
  );
  await expect(channel.sendTyping()).rejects.toMatchObject({ code: 50001 });
});
