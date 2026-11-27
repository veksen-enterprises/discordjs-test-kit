import {
  ChannelType,
  OverwriteType,
  type APIChannel,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { ALL_PERMISSIONS, computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";
import type { GuildRecord } from "./state.js";

// Computed permissions. Sources: Discord's resources/guild (Get Guild Member Permissions, Get
// Guild Role Permissions), resources/channel (Get Channel Member Permissions, Get Channel Role
// Permissions) and topics/permissions#implicit-permissions. Each answers `{ permissions }`, a
// stringified bitfield. Contract run 45916746107 got 200 for the bot and @everyone, 404 10013
// "Unknown User" for an unknown user and 404 10011 for an unknown role. The bitfield Discord gives
// an owner or an administrator is taken to be every documented bit (inferred, not checked: the
// contract compares shapes, not values). A timed-out member's permissions aren't masked here;
// neither route says whether they are.

const unknownGuild = () => respond.error(404, 10004, "Unknown Guild");
const unknownUser = () => respond.error(404, 10013, "Unknown User");
const unknownRole = () => respond.error(404, 10011, "Unknown Role");
const answer = (permissions: bigint) =>
  respond.json({ permissions: String(permissions) });

export function registerPermissionRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;

  /** The member `userId` names, or the refusal: unknown user 10013, a user not in it a Gap. */
  const memberOf = (guild: GuildRecord, userId: string) => {
    if (!state.users.has(userId)) return { refused: unknownUser() };
    if (!guild.members.has(userId))
      return { refused: rest.gap("permissions of a user not in the guild") };
    return {};
  };

  /** @everyone plus one role, before overwrites ("does not include other roles"). */
  const roleBase = (guild: GuildRecord, roleId: string) => {
    const base =
      BigInt(guild.roles.get(guild.id)!.permissions) |
      BigInt(guild.roles.get(roleId)!.permissions);
    return base & Permission.Administrator ? ALL_PERMISSIONS : base;
  };

  /**
   * Implicit permissions: without View Channel nothing else holds; without Send Messages, neither
   * Mention Everyone, Send TTS Messages, Attach Files nor Embed Links does. What a missing Connect
   * masks in voice is "other permissions such as MANAGE_CHANNELS", not a list: a Gap.
   */
  const masked = (channel: APIChannel, permissions: bigint) => {
    if (!(permissions & Permission.ViewChannel)) return 0n;
    const voice =
      channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildStageVoice;
    if (voice && !(permissions & Permission.Connect)) return undefined;
    if (!voice && !(permissions & Permission.SendMessages))
      return (
        permissions &
        ~(
          Permission.MentionEveryone |
          Permission.SendTTSMessages |
          Permission.AttachFiles |
          Permission.EmbedLinks
        )
      );
    return permissions;
  };

  /** The guild channel and the bot's right to look at it: View Channel, and Connect for voice. */
  const channelOf = (req: RestRequest) => {
    const channel = state.channels.get(req.params.channelId!);
    if (!channel || !("guild_id" in channel) || !channel.guild_id)
      return { refused: respond.unknownChannel() };
    const voice =
      channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildStageVoice;
    const denied = mock.checkBotPerms(channel, voice ? Permission.Connect : 0n);
    if (denied) return { refused: denied };
    return { channel, guild: state.requireGuild(channel.guild_id) };
  };

  const implicit = (req: RestRequest) => req.query.get("implicit") !== "false";

  rest.route(
    "GET",
    "/guilds/:guildId/permissions/member/:userId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      const { refused } = memberOf(guild, req.params.userId!);
      return (
        refused ?? answer(computePermissions(state, guild, req.params.userId!))
      );
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/permissions/role/:roleId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      if (!guild.roles.has(req.params.roleId!)) return unknownRole();
      return answer(roleBase(guild, req.params.roleId!));
    }),
  );

  // "Not applied when the target member is a bot": the implicit masking.
  rest.route(
    "GET",
    "/channels/:channelId/permissions/member/:userId",
    authed((req) => {
      const { refused, channel, guild } = channelOf(req);
      if (refused) return refused;
      const userId = req.params.userId!;
      const member = memberOf(guild!, userId);
      if (member.refused) return member.refused;
      const permissions = computePermissions(state, guild!, userId, channel);
      if (!implicit(req) || state.users.get(userId)!.bot)
        return answer(permissions);
      const result = masked(channel!, permissions);
      return result === undefined
        ? rest.gap("implicit permissions without Connect")
        : answer(result);
    }),
  );

  // "The permissions granted by the specified role together with @everyone, applying their
  // channel overwrites"; a thread takes its parent's.
  rest.route(
    "GET",
    "/channels/:channelId/permissions/role/:roleId",
    authed((req) => {
      const { refused, channel, guild } = channelOf(req);
      if (refused) return refused;
      const roleId = req.params.roleId!;
      if (!guild!.roles.has(roleId)) return unknownRole();
      let permissions = roleBase(guild!, roleId);
      if (permissions !== ALL_PERMISSIONS) {
        const parent = state.permissionChannel(channel!);
        const overwrites =
          "permission_overwrites" in parent
            ? (parent.permission_overwrites ?? [])
            : [];
        for (const id of [guild!.id, roleId]) {
          const ow = overwrites.find(
            (o) => o.type === OverwriteType.Role && o.id === id,
          );
          if (!ow) continue;
          permissions &= ~BigInt(ow.deny);
          permissions |= BigInt(ow.allow);
        }
      }
      if (!implicit(req)) return answer(permissions);
      const result = masked(channel!, permissions);
      return result === undefined
        ? rest.gap("implicit permissions without Connect")
        : answer(result);
    }),
  );
}
