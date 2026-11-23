import { once } from "node:events";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  type Message,
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

async function start(intents: GatewayIntentBits[] = []) {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  const bob = mock.createUser("bob");
  mock.addMember(guild, alice);
  mock.addMember(guild, bob);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, ...intents],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const channel = client.channels.cache.get(general.id) as TextChannel;
  return { guild, general, alice, bob, channel };
}

const lunch = {
  question: { text: "Lunch?" },
  answers: [{ text: "Pizza" }, { text: "Sushi" }],
  duration: 1,
  allowMultiselect: false,
};

it("sends the bot's poll, counts members' votes, and ends it with a result message", async () => {
  const { general, alice, bob, channel } = await start([
    GatewayIntentBits.GuildMessagePolls,
  ]);
  mock.grantBot(Permission.SendPolls);
  const sent = await channel.send({ poll: lunch });
  const stored = mock.state.requireMessage(general.id, sent.id);
  const added: number[] = [];
  client.on(Events.MessagePollVoteAdd, (answer) => added.push(answer.id));
  const removed = once(client, Events.MessagePollVoteRemove);

  mock.as(alice).vote(stored, ["Pizza"]);
  mock.as(bob).vote(stored, ["Pizza"]);
  mock.as(bob).removeVote(stored);
  await removed;
  mock.as(bob).vote(stored, ["Sushi"]);
  mock.as(alice).removeVote(stored);
  mock.as(alice).vote(stored, ["Sushi"]);
  const ended = await sent.poll!.end();

  expect(added).toEqual([1, 1, 2, 2]);
  expect(ended.poll!.resultsFinalized).toBe(true);
  expect(ended.poll!.answers.get(2)!.voteCount).toBe(2);
  const result = mock.state.messages.get(general.id)!.at(-1)!;
  expect(result.type).toBe(MessageType.PollResult);
  expect(result.embeds[0]!.fields).toContainEqual({
    name: "victor_answer_text",
    value: "Sushi",
  });
  const voters = await ended.poll!.answers.get(2)!.voters.fetch();
  expect([...voters.keys()].sort()).toEqual([alice.id, bob.id].sort());
  expect(() => mock.as(alice).removeVote(stored)).toThrow("poll has ended");
  mock.assertNoUnhandledRequests();
});

it("removes a poll message's buttons and edits its text, and keeps the poll", async () => {
  // Arrange
  const { general, channel } = await start();
  mock.grantBot(Permission.SendPolls);
  const sent = await channel.send({
    poll: lunch,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("end")
          .setLabel("End poll")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  });

  // Act
  await sent.edit({ content: "Vote closes at noon", components: [] });

  // Assert
  const stored = mock.state.requireMessage(general.id, sent.id);
  expect([
    stored.content,
    stored.components,
    stored.poll?.question.text,
  ]).toEqual(["Vote closes at noon", [], "Lunch?"]);
  mock.assertNoUnhandledRequests();
});

it("refuses a poll without Send Polls, and one Discord's limits refuse", async () => {
  const { channel } = await start();

  await expect(channel.send({ poll: lunch })).rejects.toMatchObject({
    code: 50013,
  });
  mock.grantBot(Permission.SendPolls);
  await expect(
    channel.send({ poll: { ...lunch, duration: 800 } }),
  ).rejects.toMatchObject({ code: 50035 });
  await expect(
    channel.send({
      poll: {
        ...lunch,
        answers: Array.from({ length: 11 }, (_, i) => ({ text: `${i}` })),
      },
    }),
  ).rejects.toMatchObject({ code: 50035 });
});

it("takes one answer unless the poll allows several, and one vote at a time", async () => {
  const { general, alice, channel } = await start();
  mock.grantBot(Permission.SendPolls);
  const sent: Message = await channel.send({ poll: lunch });
  const stored = mock.state.requireMessage(general.id, sent.id);

  expect(() => mock.as(alice).vote(stored, ["Pizza", "Sushi"])).toThrow(
    "takes one answer",
  );
  expect(() => mock.as(alice).vote(stored, ["Tacos"])).toThrow(
    'no answer "Tacos"; it has Pizza, Sushi',
  );
  mock.as(alice).vote(stored, ["Pizza"]);
  expect(() => mock.as(alice).vote(stored, ["Sushi"])).toThrow("already voted");
});
