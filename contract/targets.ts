import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";
import { createDiscordMock } from "../src/internal/mock.js";

/** What a scenario needs from either side: raw REST, a guild to work in, and the gateway traffic. */
export interface Target {
  name: "discord" | "mock";
  api: string;
  token: string;
  guildId: string;
  botId: string;
  /** Every gateway dispatch the bot received, in order. */
  dispatches: { t: string; d: unknown }[];
  /** Sends a gateway payload on the guild's shard, as a bot does to join voice or request members. */
  gatewaySend(payload: { op: number; d: unknown }): void;
  close(): Promise<void>;
}

/** The test guild's @everyone permissions (listRoles, run 45112207562). */
const TEST_GUILD_EVERYONE = "2248473465835073";

/** The permissions the test bot was invited with; the mock bot gets the same through a role. */
export const INVITE_PERMISSIONS = 268561488n;

// Beyond what a message bot needs, the intent of every event the scenarios cause, so those
// dispatches are compared too.
const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessageTyping,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.AutoModerationConfiguration,
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
    // Raw fires before discord.js handles the packet, and some handlers write live objects into
    // it (InviteCreateAction assigns channel and guild), so keep a copy of what was sent.
    if (packet.t)
      dispatches.push({ t: packet.t, d: structuredClone(packet.d) });
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
    gatewaySend: (payload) =>
      client.guilds.cache.get(guildId)?.shard.send(payload),
    close: () => client.destroy(),
  };
}

/**
 * The mock's copy of the test guild. `admin` is the second contract bot, invited with
 * Administrator; the first was invited with INVITE_PERMISSIONS.
 */
export async function mockTarget(
  opts: { admin?: boolean } = {},
): Promise<Target> {
  const mock = await createDiscordMock();
  const guild = mock.createGuild("contract");
  mock.createTextChannel(guild, "general");
  mock.createRole(
    guild,
    "contract-bot",
    opts.admin ? PermissionFlagsBits.Administrator : INVITE_PERMISSIONS,
    [mock.state.bot],
  );
  // The test guild's @everyone, read from run 45112207562's listRoles: much wider than the
  // kit's least-privilege World (Create Events, Create Expressions, Change Nickname, threads,
  // polls, ...), so the contract world copies it exactly.
  guild.roles.get(guild.id)!.permissions = TEST_GUILD_EVERYONE;
  const dispatches: Target["dispatches"] = [];
  const client = await connect(mock.token, mock.apiUrl, dispatches);
  return {
    name: "mock",
    api: `${mock.apiUrl}/v10`,
    token: mock.token,
    guildId: guild.id,
    botId: mock.state.bot.id,
    dispatches,
    gatewaySend: (payload) =>
      client.guilds.cache.get(guild.id)?.shard.send(payload),
    close: async () => {
      await client.destroy();
      await mock.close();
    },
  };
}
