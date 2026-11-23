import { once } from "node:events";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { createDiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";

/** What a scenario needs from either side: raw REST, a guild to work in, and the gateway traffic. */
export interface Target {
  name: "discord" | "mock";
  api: string;
  token: string;
  guildId: string;
  botId: string;
  /** Every gateway dispatch the bot received, in order. */
  dispatches: { t: string; d: unknown }[];
  close(): Promise<void>;
}

/** The permissions the test bot was invited with; the mock bot gets the same through a role. */
export const INVITE_PERMISSIONS = 268561488n;

const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

async function connect(
  token: string,
  api: string | undefined,
  dispatches: Target["dispatches"],
) {
  const client = new Client({
    intents: INTENTS,
    ...(api ? { rest: { api } } : {}),
  });
  client.on(Events.Raw, (packet: { t?: string; d: unknown }) => {
    if (packet.t) dispatches.push({ t: packet.t, d: packet.d });
  });
  const ready = once(client, Events.ClientReady);
  await client.login(token);
  await ready;
  return client;
}

export async function discordTarget(
  token: string,
  guildId: string,
): Promise<Target> {
  const dispatches: Target["dispatches"] = [];
  const client = await connect(token, undefined, dispatches);
  return {
    name: "discord",
    api: "https://discord.com/api/v10",
    token,
    guildId,
    botId: client.user!.id,
    dispatches,
    close: () => client.destroy(),
  };
}

export async function mockTarget(): Promise<Target> {
  const mock = await createDiscordMock();
  const guild = mock.createGuild("contract");
  mock.createTextChannel(guild, "general");
  mock.createRole(guild, "contract-bot", INVITE_PERMISSIONS, [mock.state.bot]);
  // The test guild's @everyone lets the bot start public threads: run 7 got 201 for a thread the
  // invite doesn't grant. The mock's @everyone is narrower, so the bot gets it here.
  // Create Invite and Send Polls are in a new server's @everyone too (inferred; the contract's
  // createInvite and sendPoll check them). So is Create Events: run 45099526148 created an event.
  mock.createRole(
    guild,
    "everyone-extras",
    Permission.CreatePublicThreads |
      Permission.CreateInstantInvite |
      Permission.SendPolls |
      Permission.CreateEvents,
    [mock.state.bot],
  );
  const dispatches: Target["dispatches"] = [];
  const client = await connect(mock.token, mock.apiUrl, dispatches);
  return {
    name: "mock",
    api: `${mock.apiUrl}/v10`,
    token: mock.token,
    guildId: guild.id,
    botId: mock.state.bot.id,
    dispatches,
    close: async () => {
      await client.destroy();
      await mock.close();
    },
  };
}
