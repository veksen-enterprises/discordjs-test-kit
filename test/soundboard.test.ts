import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  type VoiceChannel,
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

async function botWithSounds(botPermissions: bigint) {
  const record = mock.createGuild("g");
  mock.grantBot(botPermissions);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return client.guilds.cache.get(record.id)!;
}

// The first bytes of an Ogg file; the kit doesn't decode audio.
const SOUND = { file: Buffer.from("OggS"), contentType: "audio/ogg" };

it("lets the bot upload a sound with Create Expressions, and hears it", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  const created = once(client, Events.GuildSoundboardSoundCreate);

  // Act
  const sound = await guild.soundboardSounds.create({
    ...SOUND,
    name: "airhorn",
    volume: 0.5,
  });

  // Assert
  expect([sound.name, sound.volume, sound.user?.id]).toEqual([
    "airhorn",
    0.5,
    client.user!.id,
  ]);
  expect((await created)[0].soundId).toBe(sound.soundId);
});

it("refuses a sound upload without Create Expressions", async () => {
  // Arrange
  const guild = await botWithSounds(0n);

  // Act
  const created = guild.soundboardSounds.create({ ...SOUND, name: "airhorn" });

  // Assert
  await expect(created).rejects.toMatchObject({ code: 50013 });
});

it("refuses a ninth sound", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  for (let i = 1; i <= 8; i++)
    await guild.soundboardSounds.create({ ...SOUND, name: `s${i}` });

  // Act
  const created = guild.soundboardSounds.create({ ...SOUND, name: "s9" });

  // Assert
  await expect(created).rejects.toMatchObject({ code: 30045 });
});

it("edits the bot's sound, and hears it", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  const sound = await guild.soundboardSounds.create({ ...SOUND, name: "horn" });
  const updated = once(client, Events.GuildSoundboardSoundUpdate);

  // Act
  const edited = await sound.edit({ name: "airhorn", emojiName: "📯" });

  // Assert
  expect([edited.name, edited.emoji?.name]).toEqual(["airhorn", "📯"]);
  expect((await updated)[1].name).toBe("airhorn");
});

it("deletes the bot's sound, and hears it", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  const sound = await guild.soundboardSounds.create({ ...SOUND, name: "horn" });
  const deleted = once(client, Events.GuildSoundboardSoundDelete);

  // Act
  await sound.delete();

  // Assert
  expect((await deleted)[0].soundId).toBe(sound.soundId);
  await expect(
    guild.soundboardSounds.fetch({
      soundboardSound: sound.soundId,
      force: true,
    }),
  ).rejects.toMatchObject({ code: 10097 });
});

it("lists the guild's sounds and fetches one by id", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  const horn = await guild.soundboardSounds.create({ ...SOUND, name: "horn" });
  await guild.soundboardSounds.create({ ...SOUND, name: "drum" });

  // Act
  const all = await guild.soundboardSounds.fetch();
  const one = await guild.soundboardSounds.fetch({
    soundboardSound: horn.soundId,
    force: true,
  });

  // Assert
  expect(all.map((s) => s.name).sort()).toEqual(["drum", "horn"]);
  expect(one.name).toBe("horn");
});

it("sends the guild's sounds over the gateway when the bot asks for them", async () => {
  // Arrange
  const guild = await botWithSounds(Permission.CreateGuildExpressions);
  await guild.soundboardSounds.create({ ...SOUND, name: "horn" });

  // Act
  const byGuild = await client.guilds.fetchSoundboardSounds({
    guildIds: [guild.id],
  });

  // Assert
  expect(byGuild.get(guild.id)!.map((s) => s.name)).toEqual(["horn"]);
  mock.assertNoUnhandledRequests();
});

async function botInVoice(botPermissions: bigint) {
  const record = mock.createGuild("g");
  const lobby = mock.createVoiceChannel(record, "lobby");
  mock.grantBot(Permission.ViewChannel | Permission.Connect | botPermissions);
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const guild = client.guilds.cache.get(record.id)!;
  const joined = once(client, Events.VoiceStateUpdate);
  guild.shard.send({
    op: 4,
    d: {
      guild_id: guild.id,
      channel_id: lobby.id,
      self_mute: false,
      self_deaf: false,
    },
  });
  await joined;
  const sound = await guild.soundboardSounds.create({
    ...SOUND,
    name: "airhorn",
    volume: 0.5,
  });
  return { channel: guild.channels.cache.get(lobby.id)!, sound };
}

it("plays a sound in the voice channel the bot is in, and hears the effect", async () => {
  // Arrange
  const { channel, sound } = await botInVoice(
    Permission.CreateGuildExpressions |
      Permission.Speak |
      Permission.UseSoundboard,
  );
  const effect = once(client, Events.VoiceChannelEffectSend);

  // Act
  await (channel as VoiceChannel).sendSoundboardSound(sound);

  // Assert
  const [sent] = await effect;
  expect([sent.channelId, sent.userId, sent.soundId, sent.soundVolume]).toEqual(
    [channel.id, client.user!.id, sound.soundId, 0.5],
  );
});

it("refuses to play a sound without Use Soundboard", async () => {
  // Arrange
  const { channel, sound } = await botInVoice(
    Permission.CreateGuildExpressions | Permission.Speak,
  );

  // Act
  const played = (channel as VoiceChannel).sendSoundboardSound(sound);

  // Assert
  await expect(played).rejects.toMatchObject({ code: 50013 });
});

it("records a sound played from outside the channel as unmodelled, since Discord's answer isn't documented", async () => {
  // Arrange
  const guild = await botWithSounds(
    Permission.CreateGuildExpressions |
      Permission.Speak |
      Permission.UseSoundboard,
  );
  const lobby = mock.createVoiceChannel(
    mock.state.requireGuild(guild.id),
    "lobby",
  );
  const sound = await guild.soundboardSounds.create({
    ...SOUND,
    name: "airhorn",
  });
  const channel = (await guild.channels.fetch(lobby.id)) as VoiceChannel;

  // Act
  const played = channel.sendSoundboardSound(sound);

  // Assert
  await expect(played).rejects.toMatchObject({ code: 0 });
  expect(mock.rest.unhandled).toEqual([
    "a soundboard sound from a bot not in the channel",
  ]);
  mock.rest.unhandled.length = 0;
});
