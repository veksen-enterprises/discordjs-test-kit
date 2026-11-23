import { once } from "node:events";
import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";
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

async function start() {
  const guild = mock.createGuild("g");
  const lobby = mock.createVoiceChannel(guild, "lobby");
  mock.grantBot(Permission.ViewChannel | Permission.Connect | Permission.Speak);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const cached = client.guilds.cache.get(guild.id)!;
  return { guild, lobby, cached };
}

/** 50 Opus frames of noise, as a music bot's already-encoded track would be. */
const track = () =>
  Readable.from(
    Array.from({ length: 50 }, () => Buffer.from([0xfc, 0xff, 0xfe, 0x01])),
  );

it("connects the bot's voice connection and hears the audio it plays", async () => {
  const { lobby, cached } = await start();

  const connection = joinVoiceChannel({
    channelId: lobby.id,
    guildId: cached.id,
    adapterCreator: cached.voiceAdapterCreator,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 5_000);
  const player = createAudioPlayer();
  connection.subscribe(player);
  player.play(createAudioResource(track(), { inputType: StreamType.Opus }));
  await entersState(player, AudioPlayerStatus.Playing, 5_000);
  await entersState(player, AudioPlayerStatus.Idle, 5_000);

  const session = mock.voiceServer.sessions.get(cached.id)!;
  expect(session.channelId).toBe(lobby.id);
  expect(session.soundPackets).toBe(50);
  expect(cached.members.me?.voice.channelId).toBe(lobby.id);

  connection.destroy();
  await new Promise((r) => setTimeout(r, 50));
  expect(mock.voiceServer.sessions.has(cached.id)).toBe(false);
  mock.assertNoUnhandledRequests();
});

it("refuses a voice connection that doesn't offer DAVE with 4017", async () => {
  const { lobby, cached } = await start();

  const connection = joinVoiceChannel({
    channelId: lobby.id,
    guildId: cached.id,
    adapterCreator: cached.voiceAdapterCreator,
    daveEncryption: false,
  });
  // @discordjs/voice rejoins after any close but 4014, so it never gets ready.
  while (!mock.voiceServer.refusals.has(cached.id))
    await new Promise((r) => setTimeout(r, 10));
  connection.destroy();

  expect(mock.voiceServer.refusals.get(cached.id)).toBe(
    "4017 E2EE/DAVE protocol required",
  );
});

it("gives a Lavalink-style bot the voice server for its own op 4, as TitanBot's riffy reads it", async () => {
  const { lobby, cached } = await start();
  // riffy forwards the raw packet (TitanBot's riffySetup.js); discord.js before 14.27 doesn't emit
  // voiceServerUpdate at all.
  const server = new Promise<{
    token: string;
    endpoint: string;
    guild_id: string;
  }>((resolve) =>
    client.on(Events.Raw, (packet: { t?: string; d: never }) => {
      if (packet.t === "VOICE_SERVER_UPDATE") resolve(packet.d);
    }),
  );

  cached.shard.send({
    op: 4,
    d: {
      guild_id: cached.id,
      channel_id: lobby.id,
      self_mute: false,
      self_deaf: true,
    },
  });
  const update = await server;

  expect(update.endpoint).toMatch(/^127\.0\.0\.1:\d+$/);
  expect(update.guild_id).toBe(cached.id);
  expect(mock.voiceServer.sessions.get(cached.id)?.token).toBe(update.token);
  expect(cached.members.me?.voice.selfDeaf).toBe(true);
});

it("leaves a Gap when the bot joins voice without Connect", async () => {
  const { guild, cached } = await start();
  const locked = mock.createVoiceChannel(guild, "locked");
  mock.setOverwrite(
    locked,
    { id: mock.state.bot.id, type: 1 },
    { deny: Permission.Connect },
  );

  cached.shard.send({
    op: 4,
    d: { guild_id: cached.id, channel_id: locked.id },
  });
  await vi.waitFor(() =>
    expect(mock.rest.unhandled).toEqual([
      "joining voice without View Channel and Connect",
    ]),
  );
});
