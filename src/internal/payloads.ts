import {
  GatewayIntentBits,
  OverwriteType,
  PermissionFlagsBits,
  type APIChannel,
  type APIGuildMember,
} from "discord-api-types/v10";
import type { DiscordState, GuildRecord } from "./state.js";

// Every flag Discord documents, under the names discord.js uses (PermissionFlagsBits).
export const Permission = PermissionFlagsBits;

// Highest documented bit is MANAGE_OFFICIAL_MESSAGES (1 << 53): docs.discord.food/topics/permissions.
export const ALL_PERMISSIONS = (1n << 54n) - 1n;
const ALL = ALL_PERMISSIONS;

/** Discord's permission algorithm: base from roles, then @everyone/role/member overwrites. */
export function computePermissions(
  state: DiscordState,
  guild: GuildRecord,
  userId: string,
  channel?: APIChannel,
): bigint {
  if (guild.ownerId === userId) return ALL;
  const member = guild.members.get(userId);
  if (!member) return 0n;
  let base = BigInt(guild.roles.get(guild.id)!.permissions);
  for (const roleId of member.roles)
    base |= BigInt(guild.roles.get(roleId)?.permissions ?? "0");
  if (base & Permission.Administrator) return ALL;
  // A thread takes its parent's overwrites (docs.discord.food/topics/threads).
  if (channel) channel = state.permissionChannel(channel);
  if (!channel || !("permission_overwrites" in channel)) return base;

  const overwrites = channel.permission_overwrites ?? [];
  const apply = (ow: { allow: string; deny: string } | undefined) => {
    if (!ow) return;
    base &= ~BigInt(ow.deny);
    base |= BigInt(ow.allow);
  };
  apply(overwrites.find((o) => o.id === guild.id));
  let allow = 0n;
  let deny = 0n;
  for (const ow of overwrites) {
    if (ow.type === OverwriteType.Role && member.roles.includes(ow.id)) {
      allow |= BigInt(ow.allow);
      deny |= BigInt(ow.deny);
    }
  }
  apply({ allow: String(allow), deny: String(deny) });
  apply(
    overwrites.find((o) => o.type === OverwriteType.Member && o.id === userId),
  );
  return base;
}

/** The guild object (resources/guild#guild-object): what REST answers and GUILD_UPDATE carries. */
export function guildPayload(guild: GuildRecord) {
  return {
    id: guild.id,
    name: guild.name,
    icon: null,
    splash: null,
    discovery_splash: null,
    owner_id: guild.ownerId,
    afk_channel_id: null,
    afk_timeout: 300,
    verification_level: 0,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    roles: [...guild.roles.values()],
    // The emoji object's `user` comes only from the List and Get Routes (docs.discord.food
    // resources/emoji); the guild object leaves it out (inferred for stickers).
    emojis: [...guild.emojis.values()].map(({ user: _, ...emoji }) => emoji),
    stickers: [...guild.stickers.values()].map(
      ({ user: _, ...sticker }) => sticker,
    ),
    features: [],
    mfa_level: 0,
    application_id: null,
    system_channel_id: null,
    system_channel_flags: 0,
    rules_channel_id: null,
    vanity_url_code: null,
    description: null,
    banner: null,
    premium_tier: 0,
    preferred_locale: "en-US",
    public_updates_channel_id: null,
    nsfw_level: 0,
    premium_progress_bar_enabled: false,
    safety_alerts_channel_id: null,
  };
}

export function guildCreatePayload(
  state: DiscordState,
  guild: GuildRecord,
  intents: number,
) {
  // docs.discord.food/gateway/gateway-events#gateway-guild-object, footnote 1: bots without
  // GUILD_PRESENCES get only their own member and members in voice.
  // With it, a guild under large_threshold (50 by default) sends every member.
  const voiceStates = [...(state.voiceStates.get(guild.id)?.values() ?? [])];
  const members =
    intents & GatewayIntentBits.GuildPresences
      ? [...guild.members.values()]
      : [
          guild.members.get(state.bot.id)!,
          ...voiceStates.map((v) => guild.members.get(v.user_id)!),
        ];
  return {
    ...guildPayload(guild),
    // GUILD_CREATE's roles have no `description`, though REST's do (seen in the contract run).
    roles: [...guild.roles.values()].map((role) => {
      const { description: _, ...rest } = role as typeof role & {
        description?: string | null;
      };
      return rest;
    }),
    joined_at: new Date().toISOString(),
    large: false,
    unavailable: false,
    member_count: guild.members.size,
    members,
    // Channels inside GUILD_CREATE carry no guild_id; the guild is implied.
    channels: guild.channelIds.map((id) => {
      const { guild_id: _, ...channel } = state.channels.get(
        id,
      )! as APIChannel & {
        guild_id?: string;
      };
      return channel;
    }),
    // Active threads the bot can view (docs.discord.food/topics/threads#gateway-events).
    threads: [...state.channels.values()].filter(
      (c) =>
        "thread_metadata" in c &&
        c.guild_id === guild.id &&
        !c.thread_metadata?.archived,
    ),
    // Footnote 2: a bot with GUILD_PRESENCES "receive[s] all presences if the guild has less than
    // large_threshold members". Members who never came online send none (inferred).
    presences:
      intents & GatewayIntentBits.GuildPresences
        ? [...guild.members.keys()].flatMap((id) => {
            const presence = state.presences.get(id);
            return presence && presence.status !== "offline"
              ? [{ ...presence, guild_id: guild.id }]
              : [];
          })
        : [],
    // "Array of partial voice state objects" without guild_id (gateway-events#guild-create).
    voice_states: voiceStates.map(({ guild_id: _, ...voice }) => voice),
    stage_instances: [...state.stageInstances.values()].filter(
      (stage) => stage.guild_id === guild.id,
    ),
    guild_scheduled_events: [...state.scheduledEvents.values()].filter(
      (event) => event.guild_id === guild.id,
    ),
    soundboard_sounds: soundboardSoundsOf(guild),
  };
}

export function interactionMember(
  state: DiscordState,
  guild: GuildRecord,
  member: APIGuildMember,
  channel: APIChannel,
) {
  return {
    ...member,
    permissions: String(
      computePermissions(state, guild, member.user.id, channel),
    ),
  };
}

/**
 * The guild's sounds as GUILD_CREATE and SOUNDBOARD_SOUNDS carry them. Whether `user` is included
 * there is undocumented; it's left out, as the docs list it only where a sound is created or
 * updated, or fetched over REST. Inferred, not checked against Discord.
 */
export function soundboardSoundsOf(guild: GuildRecord) {
  return [...guild.soundboardSounds.values()].map(({ user: _, ...s }) => s);
}
