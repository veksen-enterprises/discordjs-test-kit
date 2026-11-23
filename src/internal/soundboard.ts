import {
  AuditLogEvent,
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  RESTJSONErrorCodes,
} from "discord-api-types/v10";
import { reasonOf, recordAudit } from "./audit.js";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import { snowflake } from "./snowflake.js";
import type { GuildRecord } from "./state.js";

// Guild soundboard sounds. Sources: docs.discord.food/resources/soundboard (the sound object, List,
// Get, Create, Modify and Delete Guild Soundboard Sound, names 2-32 characters, volume 0 to 1
// defaulting to 1, the default limit of 8, `user` only for CREATE or MANAGE_EXPRESSIONS),
// docs.discord.food/gateway/gateway-events (Guild Soundboard Sound Create, Update and Delete,
// Request Soundboard Sounds answered with Soundboard Sounds for every guild), Discord's
// events/gateway (the four soundboard events are under GUILD_EXPRESSIONS), discord-api-types
// (AuditLogEvent 130 to 132, error 30045 MaximumNumberOfSoundboardSoundsReached, 10097
// UnknownSound). The 5.2 second duration limit can't be checked without decoding audio: not
// modelled. Boosts and the MORE_SOUNDBOARD feature aren't modelled either.

const SOUND_LIMIT = 8;
const MAX_BYTES = 512 * 1024;

type SoundFields = Record<string, unknown>;

const badName = (name: unknown) =>
  typeof name !== "string" || name.length < 2 || name.length > 32;
const badVolume = (volume: unknown) =>
  volume !== null &&
  volume !== undefined &&
  (typeof volume !== "number" || volume < 0 || volume > 1);

export function registerSoundboardRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state, gateway } = mock;
  const can = (guild: GuildRecord, flag: bigint) =>
    (computePermissions(state, guild, state.bot.id) & flag) !== 0n;
  const either = (guild: GuildRecord) =>
    can(guild, Permission.CreateGuildExpressions) ||
    can(guild, Permission.ManageGuildExpressions);
  // The bot's own sound needs CREATE or MANAGE_EXPRESSIONS; anyone else's needs MANAGE.
  const mayChange = (guild: GuildRecord, creatorId: string) =>
    can(guild, Permission.ManageGuildExpressions) ||
    (creatorId === state.bot.id &&
      can(guild, Permission.CreateGuildExpressions));
  const unknownGuild = () => respond.error(404, 10004, "Unknown Guild");
  const unknownSound = () =>
    respond.error(404, RESTJSONErrorCodes.UnknownSound, "Unknown Sound");
  const shown = (guild: GuildRecord, id: string) => {
    const { user, ...sound } = guild.soundboardSounds.get(id)!;
    return either(guild) ? { ...sound, user } : sound;
  };
  // An emoji the guild doesn't have: what Discord answers is unchecked, so it's a Gap.
  const unknownEmojiGap = (guild: GuildRecord, body: SoundFields) =>
    typeof body.emoji_id === "string" && !guild.emojis.has(body.emoji_id)
      ? rest.gap("a soundboard sound with an emoji the guild doesn't have")
      : undefined;
  // Create and Update carry the sound object; `user` is included where a sound is created or
  // updated, `user_id` only in gateway events.
  const dispatch = (
    guild: GuildRecord,
    t:
      | GatewayDispatchEvents.GuildSoundboardSoundCreate
      | GatewayDispatchEvents.GuildSoundboardSoundUpdate,
    id: string,
  ) => {
    const sound = guild.soundboardSounds.get(id)!;
    gateway.dispatch(
      t,
      { ...sound, user_id: sound.user.id },
      GatewayIntentBits.GuildExpressions,
    );
  };

  rest.route(
    "GET",
    "/guilds/:guildId/soundboard-sounds",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      return respond.json({
        items: [...guild.soundboardSounds.keys()].map((id) => shown(guild, id)),
      });
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/soundboard-sounds/:soundId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      if (!guild.soundboardSounds.has(req.params.soundId!))
        return unknownSound();
      return respond.json(shown(guild, req.params.soundId!));
    }),
  );

  // `sound` is CDN data: discord.js's resolveBase64 sends a data URI with the file's audio type.
  // Over 512 KiB "will fail with a 400 bad request" with no JSON code documented: a Gap. So is a
  // sound that isn't an audio data URI (error unchecked). Bad fields answering 50035 is inferred,
  // not checked against Discord.
  rest.route(
    "POST",
    "/guilds/:guildId/soundboard-sounds",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      if (!can(guild, Permission.CreateGuildExpressions))
        return respond.missingPermissions();
      const body = (req.body ?? {}) as SoundFields;
      const sound = typeof body.sound === "string" ? body.sound : "";
      const match = /^data:audio\/[\w.+-]+;base64,(.*)$/.exec(sound);
      if (!match) return rest.gap("a soundboard sound that isn't audio data");
      if (Buffer.from(match[1]!, "base64").length > MAX_BYTES)
        return rest.gap("a soundboard sound over 512 KiB");
      if (badName(body.name) || badVolume(body.volume))
        return respond.invalidFormBody();
      const emojiGap = unknownEmojiGap(guild, body);
      if (emojiGap) return emojiGap;
      if (guild.soundboardSounds.size >= SOUND_LIMIT)
        return respond.error(
          400,
          RESTJSONErrorCodes.MaximumNumberOfSoundboardSoundsReached,
          `Maximum number of soundboard sounds reached (${SOUND_LIMIT})`,
        );
      const id = snowflake();
      guild.soundboardSounds.set(id, {
        sound_id: id,
        name: body.name as string,
        volume: (body.volume as number | null | undefined) ?? 1,
        emoji_id: (body.emoji_id as string | undefined) ?? null,
        emoji_name: (body.emoji_name as string | undefined) ?? null,
        guild_id: guild.id,
        available: true,
        user: state.bot,
      });
      dispatch(guild, GatewayDispatchEvents.GuildSoundboardSoundCreate, id);
      recordAudit(mock, guild, {
        action_type: AuditLogEvent.SoundboardSoundCreate,
        user_id: state.bot.id,
        target_id: id,
        changes: [{ key: "name", new_value: body.name as string }],
        reason: reasonOf(req),
      });
      // 201, as the contract run got from the test guild.
      return respond.json(shown(guild, id), 201);
    }),
  );

  const EDITABLE = ["name", "volume", "emoji_id", "emoji_name"];
  rest.route(
    "PATCH",
    "/guilds/:guildId/soundboard-sounds/:soundId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      const sound = guild.soundboardSounds.get(req.params.soundId!);
      if (!sound) return unknownSound();
      if (!mayChange(guild, sound.user.id)) return respond.missingPermissions();
      const body = (req.body ?? {}) as SoundFields;
      const other = Object.keys(body).find((k) => !EDITABLE.includes(k));
      if (other) return rest.gap(`PATCH soundboard sound ${other}`);
      if (("name" in body && badName(body.name)) || badVolume(body.volume))
        return respond.invalidFormBody();
      const emojiGap = unknownEmojiGap(guild, body);
      if (emojiGap) return emojiGap;
      const before = sound.name;
      if ("name" in body) sound.name = body.name as string;
      // A null volume is documented as "default 1".
      if ("volume" in body) sound.volume = (body.volume as number | null) ?? 1;
      if ("emoji_id" in body)
        sound.emoji_id = (body.emoji_id as string | null) ?? null;
      if ("emoji_name" in body)
        sound.emoji_name = (body.emoji_name as string | null) ?? null;
      dispatch(
        guild,
        GatewayDispatchEvents.GuildSoundboardSoundUpdate,
        sound.sound_id,
      );
      recordAudit(mock, guild, {
        action_type: AuditLogEvent.SoundboardSoundUpdate,
        user_id: state.bot.id,
        target_id: sound.sound_id,
        changes:
          before === sound.name
            ? []
            : [{ key: "name", old_value: before, new_value: sound.name }],
        reason: reasonOf(req),
      });
      return respond.json(shown(guild, sound.sound_id));
    }),
  );

  rest.route(
    "DELETE",
    "/guilds/:guildId/soundboard-sounds/:soundId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      const sound = guild.soundboardSounds.get(req.params.soundId!);
      if (!sound) return unknownSound();
      if (!mayChange(guild, sound.user.id)) return respond.missingPermissions();
      guild.soundboardSounds.delete(sound.sound_id);
      gateway.dispatch(
        GatewayDispatchEvents.GuildSoundboardSoundDelete,
        { sound_id: sound.sound_id, guild_id: guild.id },
        GatewayIntentBits.GuildExpressions,
      );
      recordAudit(mock, guild, {
        action_type: AuditLogEvent.SoundboardSoundDelete,
        user_id: state.bot.id,
        target_id: sound.sound_id,
        changes: [{ key: "name", old_value: sound.name }],
        reason: reasonOf(req),
      });
      return respond.noContent();
    }),
  );

  // Send Soundboard Sound (discord-api-docs resources/soundboard): "Requires the SPEAK and
  // USE_SOUNDBOARD permissions", and the bot "connected to the voice channel, having a voice state
  // without deaf, self_deaf, mute, or suppress enabled". 204 (docs.discord.food), and "Fires a
  // Voice Channel Effect Send Gateway event", under GUILD_VOICE_STATES (events/gateway). 50013
  // without a permission is inferred; the answer when the bot isn't connected or is muted isn't
  // documented, so that's a Gap. Discord's default sounds aren't modelled, so a sound the guild
  // doesn't have is a Gap rather than 10097, and so is a sound from another guild. The bot hearing
  // its own effect, and the effect's emoji coming from the sound, are inferred, not checked.
  rest.route(
    "POST",
    "/channels/:channelId/send-soundboard-sound",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      if (
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice
      )
        return rest.gap("a soundboard sound outside a voice channel");
      const denied = mock.checkBotPerms(
        channel,
        Permission.Speak | Permission.UseSoundboard,
      );
      if (denied) return denied;
      const guild = state.requireGuild(channel.guild_id!);
      const voice = state.voiceStates.get(guild.id)?.get(state.bot.id);
      if (voice?.channel_id !== channel.id)
        return rest.gap("a soundboard sound from a bot not in the channel");
      if (voice.deaf || voice.self_deaf || voice.mute || voice.suppress)
        return rest.gap("a soundboard sound from a muted or deafened bot");
      const body = (req.body ?? {}) as {
        sound_id?: string;
        source_guild_id?: string;
      };
      if (body.source_guild_id && body.source_guild_id !== guild.id)
        return rest.gap("a soundboard sound from another guild");
      const sound = guild.soundboardSounds.get(body.sound_id ?? "");
      if (!sound)
        return rest.gap("a default soundboard sound, or one the guild lacks");
      gateway.dispatch(
        GatewayDispatchEvents.VoiceChannelEffectSend,
        {
          channel_id: channel.id,
          guild_id: guild.id,
          user_id: state.bot.id,
          emoji:
            sound.emoji_id || sound.emoji_name
              ? { id: sound.emoji_id, name: sound.emoji_name }
              : null,
          sound_id: sound.sound_id,
          sound_volume: sound.volume,
        },
        GatewayIntentBits.GuildVoiceStates,
      );
      return respond.noContent();
    }),
  );
}
