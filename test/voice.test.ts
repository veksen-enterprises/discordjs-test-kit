import { once } from "node:events";
import { Client, Events, GatewayIntentBits, Routes } from "discord.js";
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

function world() {
  const guild = mock.createGuild("g");
  const lobby = mock.createVoiceChannel(guild, "lobby");
  const games = mock.createVoiceChannel(guild, "games");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  return { guild, lobby, games, alice };
}

async function login() {
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

/** The next voiceStateUpdate, as [old channel name, new channel name]. */
async function nextMove() {
  const [before, after] = await once(client, Events.VoiceStateUpdate);
  return [before.channel?.name ?? null, after.channel?.name ?? null];
}

it("tells the bot when a member joins, moves between and leaves voice channels", async () => {
  const { guild, lobby, games, alice } = world();
  await login();

  let move = nextMove();
  mock.joinVoice(guild, alice, lobby);
  expect(await move).toEqual([null, "lobby"]);
  move = nextMove();
  mock.joinVoice(guild, alice, games);
  expect(await move).toEqual(["lobby", "games"]);
  move = nextMove();
  mock.joinVoice(guild, alice, null);
  expect(await move).toEqual(["games", null]);
});

it("hands a bot that logs in the members already in voice", async () => {
  const { guild, lobby, alice } = world();
  mock.joinVoice(guild, alice, lobby);

  await login();

  const cached = client.guilds.cache.get(guild.id)!;
  expect(cached.voiceStates.cache.get(alice.id)?.channelId).toBe(lobby.id);
  expect(cached.members.cache.get(alice.id)?.voice.channel?.name).toBe("lobby");
});

it("moves, mutes and disconnects a member with Move and Mute Members", async () => {
  const { guild, lobby, games, alice } = world();
  mock.grantBot(
    Permission.MoveMembers | Permission.MuteMembers | Permission.Connect,
  );
  mock.joinVoice(guild, alice, lobby);
  await login();
  const member = client.guilds.cache
    .get(guild.id)!
    .members.cache.get(alice.id)!;

  let move = nextMove();
  await member.voice.setChannel(games.id);
  expect(await move).toEqual(["lobby", "games"]);
  await member.voice.setMute(true);
  expect(
    (await member.guild.voiceStates.fetch(alice.id, { force: true }))
      .serverMute,
  ).toBe(true);
  move = nextMove();
  await member.voice.disconnect();
  expect(await move).toEqual(["games", null]);
  await expect(member.voice.setMute(false)).rejects.toMatchObject({
    code: 40032,
  });
  mock.assertNoUnhandledRequests();
});

it("refuses to move a member without Move Members, and a member can't join without Connect", async () => {
  const { guild, lobby, games, alice } = world();
  mock.joinVoice(guild, alice, lobby);
  await login();
  const member = client.guilds.cache
    .get(guild.id)!
    .members.cache.get(alice.id)!;

  await expect(member.voice.setChannel(games.id)).rejects.toMatchObject({
    code: 50013,
  });
  mock.setOverwrite(
    games,
    { id: guild.id, type: 0 },
    { deny: Permission.Connect },
  );
  expect(() => mock.joinVoice(guild, alice, games)).toThrow("Connect");
});

it("tells the bot when a voice channel's session starts and ends", async () => {
  // Arrange
  const { guild, lobby, alice } = world();
  await login();
  const sessions: { t: string; d: Record<string, unknown> }[] = [];
  client.on(
    Events.Raw,
    (packet: { t?: string; d: Record<string, unknown> }) => {
      if (packet.t?.startsWith("VOICE_CHANNEL_"))
        sessions.push({ t: packet.t, d: packet.d });
    },
  );

  // Act
  let move = nextMove();
  mock.joinVoice(guild, alice, lobby);
  await move;
  move = nextMove();
  mock.joinVoice(guild, alice, null);
  await move;

  // Assert
  expect(sessions).toEqual([
    {
      t: "VOICE_CHANNEL_START_TIME_UPDATE",
      d: {
        id: lobby.id,
        guild_id: guild.id,
        voice_start_time: expect.any(Number),
      },
    },
    {
      t: "VOICE_CHANNEL_START_TIME_UPDATE",
      d: { id: lobby.id, guild_id: guild.id, voice_start_time: null },
    },
    {
      t: "VOICE_CHANNEL_STATUS_UPDATE",
      d: { id: lobby.id, guild_id: guild.id, status: null },
    },
  ]);
});

it("lists the voice regions a channel can use", async () => {
  // Arrange
  const { guild } = world();
  await login();

  // Act
  const regions = await client.fetchVoiceRegions();
  const inGuild = (await client.rest.get(
    Routes.guildVoiceRegions(guild.id),
  )) as { id: string }[];

  // Assert
  expect(regions.get("us-east")?.name).toBe("US East");
  expect(inGuild.map((r) => r.id)).toEqual([...regions.keys()]);
});

it("sets a voice channel's status while connected, and tells the bot", async () => {
  // Arrange
  const { guild, lobby } = world();
  mock.grantBot(Permission.SetVoiceChannelStatus | Permission.Connect);
  await login();
  const joined = nextMove();
  client.guilds.cache.get(guild.id)!.shard.send({
    op: 4,
    d: {
      guild_id: guild.id,
      channel_id: lobby.id,
      self_mute: false,
      self_deaf: false,
    },
  });
  await joined;
  const statuses: unknown[] = [];
  client.on(Events.Raw, (packet: { t?: string; d: unknown }) => {
    if (packet.t === "VOICE_CHANNEL_STATUS_UPDATE") statuses.push(packet.d);
  });

  // Act
  await client.rest.put(Routes.channelVoiceStatus(lobby.id), {
    body: { status: "raid night" },
  });
  await new Promise((r) => setTimeout(r, 50));

  // Assert
  expect(statuses).toEqual([
    { id: lobby.id, guild_id: guild.id, status: "raid night" },
  ]);
});

it("refuses a voice status from a bot that isn't connected and lacks Manage Channels", async () => {
  // Arrange
  const { lobby } = world();
  mock.grantBot(Permission.SetVoiceChannelStatus | Permission.Connect);
  await login();

  // Act
  const set = client.rest.put(Routes.channelVoiceStatus(lobby.id), {
    body: { status: "raid night" },
  });

  // Assert
  await expect(set).rejects.toMatchObject({ code: 50013 });
});
