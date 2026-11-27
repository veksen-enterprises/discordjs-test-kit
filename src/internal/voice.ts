import {
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIVoiceState,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import type { GuildRecord } from "./state.js";

// Voice states, the members' and the bot's. Sources: discord-api-docs resources/voice (the voice
// state object, Get Current User Voice State, Get User Voice State),
// events/gateway-events#voice-state-update ("Sent when someone joins/leaves/moves voice
// channels"), events/gateway (GUILD_VOICE_STATES), topics/voice-connections (the bot's op 4),
// docs.discord.food/resources/voice (Modify Current User Voice State, Modify User Voice State).

/** `userId`'s voice state in `guild`, if they're in a voice channel. */
export function voiceStateOf(
  mock: DiscordMock,
  guild: GuildRecord,
  userId: string,
) {
  return mock.state.voiceStates.get(guild.id)?.get(userId);
}

/**
 * Puts `userId` in voice channel `channelId`, or out of voice with null, and sends
 * VOICE_STATE_UPDATE with their member. Leaving sends the last state with a null channel_id.
 */
export function setVoiceState(
  mock: DiscordMock,
  guild: GuildRecord,
  userId: string,
  change: {
    channelId?: string | null;
    mute?: boolean;
    deaf?: boolean;
    selfMute?: boolean;
    selfDeaf?: boolean;
    suppress?: boolean;
    requestToSpeakTimestamp?: string | null;
  },
) {
  const { state } = mock;
  const member = guild.members.get(userId);
  if (!member)
    throw new Error(`discordjs-test-kit: ${userId} isn't in ${guild.name}`);
  const states =
    state.voiceStates.get(guild.id) ?? new Map<string, APIVoiceState>();
  state.voiceStates.set(guild.id, states);
  const voice: APIVoiceState = states.get(userId) ?? {
    guild_id: guild.id,
    channel_id: null,
    user_id: userId,
    session_id: crypto.randomUUID().replaceAll("-", ""),
    deaf: member.deaf,
    mute: member.mute,
    self_deaf: false,
    self_mute: false,
    self_video: false,
    suppress: false,
    request_to_speak_timestamp: null,
  };
  const previous = voice.channel_id;
  if (change.channelId !== undefined) voice.channel_id = change.channelId;
  if (change.mute !== undefined) voice.mute = member.mute = change.mute;
  if (change.deaf !== undefined) voice.deaf = member.deaf = change.deaf;
  if (change.selfMute !== undefined) voice.self_mute = change.selfMute;
  if (change.selfDeaf !== undefined) voice.self_deaf = change.selfDeaf;
  if (change.suppress !== undefined) voice.suppress = change.suppress;
  if (change.requestToSpeakTimestamp !== undefined)
    voice.request_to_speak_timestamp = change.requestToSpeakTimestamp;
  if (voice.channel_id) states.set(userId, voice);
  else states.delete(userId);
  mock.gateway.dispatch(
    GatewayDispatchEvents.VoiceStateUpdate,
    { ...voice, member },
    GatewayIntentBits.GuildVoiceStates,
  );
  if (previous !== voice.channel_id)
    voiceSessions(mock, guild, previous, voice.channel_id);
}

/**
 * A voice channel's session starts with its first member and ends with its last
 * (gateway-events#voice-channel-start-time-update: "Sent when a voice channel session is started
 * or ended", null when ended), both under GUILDS (using-gateway#list-of-intents). Contract run
 * 45915019593 got the start right after the bot's own VOICE_STATE_UPDATE, and a
 * VOICE_CHANNEL_STATUS_UPDATE with a null status once it left. That the status clears when the
 * session ends, and the order of the two events then, are inferred, not checked.
 */
function voiceSessions(
  mock: DiscordMock,
  guild: GuildRecord,
  left: string | null,
  joined: string | null,
) {
  const inside = (channelId: string) =>
    [...(mock.state.voiceStates.get(guild.id)?.values() ?? [])].filter(
      (v) => v.channel_id === channelId,
    ).length;
  const send = (t: GatewayDispatchEvents, d: Record<string, unknown>) =>
    mock.gateway.dispatch(t, d, GatewayIntentBits.Guilds);
  if (joined && inside(joined) === 1)
    send(GatewayDispatchEvents.VoiceChannelStartTimeUpdate, {
      id: joined,
      guild_id: guild.id,
      voice_start_time: Math.floor(Date.now() / 1000),
    });
  if (left && inside(left) === 0) {
    send(GatewayDispatchEvents.VoiceChannelStartTimeUpdate, {
      id: left,
      guild_id: guild.id,
      voice_start_time: null,
    });
    send(GatewayDispatchEvents.VoiceChannelStatusUpdate, {
      id: left,
      guild_id: guild.id,
      status: null,
    });
  }
}

/**
 * The bot's op 4 (topics/voice-connections#retrieving-voice-server-information): with a
 * channel_id, VOICE_STATE_UPDATE (the bot's, with its session_id, under GUILD_VOICE_STATES, so
 * @discordjs/voice needs that intent) then VOICE_SERVER_UPDATE with a new token and the fake
 * voice server's endpoint, to the session that asked; with null, the bot leaves and its voice
 * connection closes with 4014. "When the voice channel is full, you will not receive the Voice State
 * Update or Voice Server Update events", unless the bot has Move Members. Joining without View
 * Channel and Connect, or anything but a voice or stage channel of a guild the bot is in, is a Gap.
 */
export async function botVoiceStateUpdate(
  mock: DiscordMock,
  d: {
    guild_id: string;
    channel_id: string | null;
    self_mute?: boolean;
    self_deaf?: boolean;
  },
  reply: (t: string, d: unknown) => void,
) {
  const { state } = mock;
  const guild = state.guilds.get(d.guild_id);
  if (!guild || !state.botIn(guild.id))
    return void mock.rest.gap(`voice in a guild the bot isn't in`);
  const bot = state.bot.id;
  if (d.channel_id === null) {
    mock.voiceServer.end(guild.id);
    if (voiceStateOf(mock, guild, bot))
      setVoiceState(mock, guild, bot, { channelId: null });
    return;
  }
  const channel = state.channels.get(d.channel_id);
  if (
    !channel ||
    !("guild_id" in channel) ||
    channel.guild_id !== guild.id ||
    (channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice)
  )
    return void mock.rest.gap(`voice in ${d.channel_id}, not a voice channel`);
  const perms = computePermissions(state, guild, bot, channel);
  const needed = Permission.ViewChannel | Permission.Connect;
  if ((perms & needed) !== needed)
    return void mock.rest.gap("joining voice without View Channel and Connect");
  const limit = "user_limit" in channel ? (channel.user_limit ?? 0) : 0;
  const inside = [...(state.voiceStates.get(guild.id)?.values() ?? [])].filter(
    (v) => v.channel_id === channel.id && v.user_id !== bot,
  ).length;
  if (limit > 0 && inside >= limit && !(perms & Permission.MoveMembers)) return;
  const endpoint = await mock.voiceServer.endpoint();
  setVoiceState(mock, guild, bot, {
    channelId: channel.id,
    selfMute: d.self_mute ?? false,
    selfDeaf: d.self_deaf ?? false,
  });
  const voice = voiceStateOf(mock, guild, bot)!;
  const session = mock.voiceServer.open(
    guild.id,
    channel.id,
    bot,
    voice.session_id,
  );
  reply(GatewayDispatchEvents.VoiceServerUpdate, {
    token: session.token,
    guild_id: guild.id,
    endpoint,
  });
}

export function registerVoiceRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  // Get (Current) User Voice State. "If the specified user is connected to a voice channel, the
  // current user must have permission to connect to the channel." 10065 for someone not in voice
  // is the code table's "Unknown voice state" (pairing inferred, not checked).
  rest.route(
    "GET",
    "/guilds/:guildId/voice-states/:userId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const userId =
        req.params.userId === "@me" ? state.bot.id : req.params.userId!;
      const voice = voiceStateOf(mock, guild, userId);
      if (!voice) return respond.error(404, 10065, "Unknown Voice State");
      const channel = state.requireChannel(voice.channel_id!);
      const perms = computePermissions(state, guild, state.bot.id, channel);
      if (!(perms & Permission.ViewChannel)) return respond.missingAccess();
      if (!(perms & Permission.Connect)) return respond.missingPermissions();
      return respond.json(voice);
    }),
  );

  // Modify (Current) User Voice State, on a stage. The caveats: `channel_id` must be the stage the
  // user is in; Mute Members to unsuppress yourself or anyone else, though you can always suppress
  // yourself; Request to Speak to raise your hand, though you can always lower it; suppressing
  // clears the request; unsuppressing a user who isn't a bot sets their request to now. Answers 204
  // with VOICE_STATE_UPDATE. 10065 for someone not in voice is inferred as for Get; 50013 for a
  // missing permission is inferred. A channel that isn't the user's stage has no documented code:
  // a Gap. The "present or future" check on a raised hand isn't modelled, since discord.js stamps
  // it before sending.
  rest.route(
    "PATCH",
    "/guilds/:guildId/voice-states/:userId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const self = req.params.userId === "@me";
      const userId = self ? state.bot.id : req.params.userId!;
      const voice = voiceStateOf(mock, guild, userId);
      if (!voice) return respond.error(404, 10065, "Unknown Voice State");
      const body = (req.body ?? {}) as {
        channel_id?: string;
        suppress?: boolean;
        request_to_speak_timestamp?: string | null;
        silent?: boolean;
      };
      const allowed = self
        ? ["channel_id", "suppress", "request_to_speak_timestamp", "silent"]
        : ["channel_id", "suppress"];
      const other = Object.keys(body).find((k) => !allowed.includes(k));
      if (other) return rest.gap(`PATCH voice state ${other}`);
      const channel = state.requireChannel(voice.channel_id!);
      if (
        body.channel_id !== channel.id ||
        channel.type !== ChannelType.GuildStageVoice
      )
        return rest.gap("a voice state change outside the user's stage");
      const perms = computePermissions(state, guild, state.bot.id, channel);
      const unsuppressing = body.suppress === false;
      if ((!self || unsuppressing) && !(perms & Permission.MuteMembers))
        return respond.missingPermissions();
      const raising = !!body.request_to_speak_timestamp;
      if (raising && !(perms & Permission.RequestToSpeak))
        return respond.missingPermissions();
      const isBot = !!state.users.get(userId)?.bot;
      setVoiceState(mock, guild, userId, {
        suppress: body.suppress,
        requestToSpeakTimestamp:
          body.suppress === true
            ? null
            : unsuppressing && !isBot
              ? new Date().toISOString()
              : body.request_to_speak_timestamp,
      });
      return respond.noContent();
    }),
  );

  // List Voice Regions and List Guild Voice Regions (docs.discord.food/resources/voice). The list
  // is what contract run 45916746107 got for both routes. `optimal` is "the closest to the
  // current user's client": us-west for that run's machine, kept as it was.
  rest.route(
    "GET",
    "/voice/regions",
    authed(() => respond.json(VOICE_REGIONS)),
  );
  rest.route(
    "GET",
    "/guilds/:guildId/regions",
    authed((req) =>
      state.guilds.has(req.params.guildId!)
        ? respond.json(VOICE_REGIONS)
        : respond.error(404, 10004, "Unknown Guild"),
    ),
  );

  // Set Voice Channel Status (Discord's resources/channel, docs.discord.food/resources/channel):
  // SET_VOICE_CHANNEL_STATUS, "and additionally the MANAGE_CHANNELS permission if the current user
  // is not connected to the voice channel"; up to 500 characters; fires Voice Channel Status
  // Update. The contract run got 204 for a set and for a clear, connected. 50013 for a missing
  // permission and 50035 for a long status are inferred, not checked. A channel that isn't a voice
  // channel has no documented answer: a Gap.
  rest.route(
    "PUT",
    "/channels/:channelId/voice-status",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      if (channel.type !== ChannelType.GuildVoice)
        return rest.gap("a voice status on a channel that isn't voice");
      const guild = state.requireGuild(channel.guild_id!);
      const connected =
        voiceStateOf(mock, guild, state.bot.id)?.channel_id === channel.id;
      const denied = mock.checkBotPerms(
        channel,
        Permission.SetVoiceChannelStatus |
          (connected ? 0n : Permission.ManageChannels),
      );
      if (denied) return denied;
      const { status } = (req.body ?? {}) as { status?: unknown };
      if (
        status !== null &&
        (typeof status !== "string" || status.length > 500)
      )
        return respond.invalidFormBody();
      mock.gateway.dispatch(
        GatewayDispatchEvents.VoiceChannelStatusUpdate,
        { id: channel.id, guild_id: guild.id, status: status || null },
        GatewayIntentBits.Guilds,
      );
      return respond.noContent();
    }),
  );
}

const region = (id: string, name: string, optimal = false) => ({
  id,
  name,
  custom: false,
  deprecated: false,
  optimal,
});
const VOICE_REGIONS = [
  region("brazil", "Brazil"),
  region("hongkong", "Hong Kong"),
  region("india", "India"),
  region("japan", "Japan"),
  region("rotterdam", "Rotterdam"),
  region("singapore", "Singapore"),
  region("southafrica", "South Africa"),
  region("sydney", "Sydney"),
  region("us-central", "US Central"),
  region("us-east", "US East"),
  region("us-south", "US South"),
  region("us-west", "US West", true),
];
