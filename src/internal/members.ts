import {
  AuditLogEvent,
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIAuditLogChange,
  type APIBan,
  type APIGuildMember,
  type APIRole,
  type APIUser,
  type RESTPutAPIGuildBanJSONBody,
} from "discord-api-types/v10";
import { reasonOf, recordAudit } from "./audit.js";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import {
  respond,
  type RestHandler,
  type RestRequest,
  type RestResponse,
} from "./rest.js";
import { snowflake } from "./snowflake.js";
import type { GuildRecord } from "./state.js";
import { setVoiceState, voiceStateOf } from "./voice.js";

// Guild member, ban and role Routes. Sources: discord-api-docs resources/guild (Get/Modify Guild
// Member, Add/Remove Guild Member Role, Remove Guild Member, Create/Remove/Get Guild Ban, Get Guild
// Bans, Create/Modify/Delete Guild Role),
// topics/permissions#permission-hierarchy, and docs.discord.food/resources/guild. Which JSON code
// each refusal carries isn't documented per route: the pairings below come from Discord's code
// table and are inferred, not checked.

const unknownMember = () => respond.error(404, 10007, "Unknown Member");
const unknownRole = () => respond.error(404, 10011, "Unknown Role");
const unknownBan = () => respond.error(404, 10026, "Unknown Ban");
const unknownGuild = () => respond.error(404, 10004, "Unknown Guild");
// "up to 28 days in the future" (Modify Guild Member, communication_disabled_until).
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

export function registerMemberRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state, gateway } = mock;
  const bot = state.bot.id;

  const guildOf = (req: RestRequest) => state.guilds.get(req.params.guildId!);
  const userOf = (req: RestRequest) =>
    req.params.userId === "@me" ? bot : req.params.userId!;
  const botHas = (guild: GuildRecord, needed: bigint) =>
    (computePermissions(state, guild, bot) & needed) === needed;
  const highest = (guild: GuildRecord, userId: string) =>
    Math.max(
      0,
      ...(guild.members.get(userId)?.roles ?? []).map(
        (id) => guild.roles.get(id)?.position ?? 0,
      ),
    );
  // "A bot can only kick, ban, and edit nicknames for users whose highest role is lower than the
  // bot's highest role." Nobody acts on the owner (discord.js GuildMember.manageable).
  const outranks = (guild: GuildRecord, targetId: string) =>
    targetId !== guild.ownerId &&
    (guild.ownerId === bot || highest(guild, bot) > highest(guild, targetId));
  // The bot's own member update reaches it without GUILD_MEMBERS: the contract run got one, on
  // the Guilds intent alone, when the bot changed its nickname.
  // Guild Member Update has no deaf or mute (seen in the contract run), unlike REST's member.
  const announceUpdate = (guild: GuildRecord, member: APIGuildMember) =>
    gateway.dispatch(
      GatewayDispatchEvents.GuildMemberUpdate,
      { ...member, deaf: undefined, mute: undefined, guild_id: guild.id },
      member.user.id === bot
        ? GatewayIntentBits.Guilds
        : GatewayIntentBits.GuildMembers,
    );

  // docs.discord.food/resources/guild#leave-guild: 204. An owner can't leave without handing the
  // guild over; what Discord answers then is unchecked, so it's a Gap.
  rest.route(
    "DELETE",
    "/users/@me/guilds/:guildId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (guild.ownerId === bot)
        return rest.gap("the bot leaving a guild it owns");
      mock.removeBot(guild);
      return respond.noContent();
    }),
  );

  // List Guild Members (docs.discord.food/resources/guild#list-guild-members): ascending by user id,
  // `limit` 1-1000 (default 1), `after` a user id. "Restricted according to whether the
  // GUILD_MEMBERS Privileged Intent is enabled": what Discord answers without it is unchecked, so
  // it's a Gap. A limit out of range answering 50035 is inferred.
  const limitOf = (req: RestRequest) => {
    const limit = Number(req.query.get("limit") ?? 1);
    return Number.isInteger(limit) && limit >= 1 && limit <= 1000
      ? limit
      : undefined;
  };
  const byId = (a: APIGuildMember, b: APIGuildMember) =>
    BigInt(a.user.id) < BigInt(b.user.id) ? -1 : 1;
  rest.route(
    "GET",
    "/guilds/:guildId/members",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (!(mock.privilegedIntents & GatewayIntentBits.GuildMembers))
        return rest.gap("listing members without the GUILD_MEMBERS intent");
      const limit = limitOf(req);
      if (!limit) return respond.invalidFormBody();
      const after = BigInt(req.query.get("after") ?? 0);
      const members = [...guild.members.values()]
        .filter((m) => BigInt(m.user.id) > after)
        .sort(byId);
      return respond.json(members.slice(0, limit));
    }),
  );

  // Query Guild Members (#query-guild-members): `query` against username and nickname, `limit`
  // 1-1000 (default 1). docs.discord.food says "contains" but also "functionally identical" to
  // gateway op 8, which matches a prefix; discord.js documents a prefix. The mock matches a
  // case-insensitive prefix of either: inferred, not checked. Registered before
  // /members/:userId, which would otherwise answer "search" as a user id.
  rest.route(
    "GET",
    "/guilds/:guildId/members/search",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const query = req.query.get("query");
      const limit = limitOf(req);
      if (query === null || !limit) return respond.invalidFormBody();
      const prefix = query.toLowerCase();
      const matches = (name: string | null | undefined) =>
        !!name && name.toLowerCase().startsWith(prefix);
      return respond.json(
        [...guild.members.values()]
          .filter((m) => matches(m.user.username) || matches(m.nick))
          .sort(byId)
          .slice(0, limit),
      );
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/members/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const member = guild.members.get(userOf(req));
      return member ? respond.json(member) : unknownMember();
    }),
  );

  rest.route(
    "PATCH",
    "/guilds/:guildId/members/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const userId = userOf(req);
      const member = guild.members.get(userId);
      if (!member) return unknownMember();
      const body = (req.body ?? {}) as Record<string, unknown>;
      if ("flags" in body) return rest.gap("PATCH member flags");
      const self = userId === bot;

      if ("nick" in body) {
        // Your own nickname through @me needs CHANGE_NICKNAME; through an id, even the bot's own,
        // MANAGE_NICKNAMES (contract run 45915019593 got 403 50013 with Change Nickname alone),
        // and the hierarchy for anyone else. The bot's own id with MANAGE_NICKNAMES is inferred.
        const allowed =
          req.params.userId === "@me"
            ? botHas(guild, Permission.ChangeNickname)
            : botHas(guild, Permission.ManageNicknames) &&
              (self || outranks(guild, userId));
        if (!allowed) return respond.missingPermissions();
      }
      if ("roles" in body) {
        const roles = (body.roles as string[] | null) ?? [];
        if (roles.some((id) => !guild.roles.has(id))) return unknownRole();
        // "A bot can grant roles to other users that are of a lower position than its own highest role."
        const changed = [
          ...roles.filter((id) => !member.roles.includes(id)),
          ...member.roles.filter((id) => !roles.includes(id)),
        ];
        if (
          !botHas(guild, Permission.ManageRoles) ||
          changed.some(
            (id) => guild.roles.get(id)!.position >= highest(guild, bot),
          )
        )
          return respond.missingPermissions();
      }
      if ("communication_disabled_until" in body) {
        const until = body.communication_disabled_until as string | null;
        // "Will throw a 403 error if the user has the ADMINISTRATOR permission or is the owner."
        const isAdmin =
          (computePermissions(state, guild, userId) &
            Permission.Administrator) !==
          0n;
        if (
          !botHas(guild, Permission.ModerateMembers) ||
          !outranks(guild, userId) ||
          isAdmin
        )
          return respond.missingPermissions();
        if (until && Date.parse(until) - Date.now() > MAX_TIMEOUT_MS)
          return respond.invalidFormBody();
      }

      // Voice: mute needs MUTE_MEMBERS, deaf DEAFEN_MEMBERS, channel_id MOVE_MEMBERS plus CONNECT
      // to the target (null disconnects). Each "will throw a 400 error if the user is not in a
      // voice channel"; 40032 "Target user is not connected to voice" is the code table's
      // (pairing inferred, not checked), as is checking permissions first.
      const voiceFields = {
        mute: Permission.MuteMembers,
        deaf: Permission.DeafenMembers,
        channel_id: Permission.MoveMembers,
      };
      const voiceChange = Object.entries(voiceFields).filter(
        ([key]) => key in body,
      );
      if (voiceChange.some(([, needed]) => !botHas(guild, needed)))
        return respond.missingPermissions();
      const target = body.channel_id as string | null | undefined;
      if (target) {
        const channel = state.channels.get(target);
        if (
          !channel ||
          !("guild_id" in channel) ||
          channel.guild_id !== guild.id ||
          channel.type !== ChannelType.GuildVoice
        )
          return rest.gap(
            "moving a member to a channel that isn't a voice channel in the guild",
          );
        const denied = mock.checkBotPerms(channel, Permission.Connect);
        if (denied) return denied;
      }
      if (voiceChange.length > 0 && !voiceStateOf(mock, guild, userId))
        return respond.error(
          400,
          40032,
          "Target user is not connected to voice",
        );

      const memberChanges = (
        ["nick", "communication_disabled_until", "mute", "deaf"] as const
      )
        .filter((key) => key in body && body[key] !== (member[key] ?? null))
        .map((key) => change(key, member[key] ?? null, body[key] ?? null));
      const roleChanges =
        "roles" in body
          ? roleDiff(guild, member.roles, (body.roles as string[] | null) ?? [])
          : [];
      const reason = reasonOf(req);

      if ("nick" in body) member.nick = (body.nick as string | null) || null;
      if ("roles" in body)
        member.roles = [...((body.roles as string[] | null) ?? [])];
      if ("communication_disabled_until" in body)
        member.communication_disabled_until =
          (body.communication_disabled_until as string | null) ?? null;
      if (voiceChange.length > 0)
        setVoiceState(mock, guild, userId, {
          channelId: target,
          mute: body.mute as boolean | undefined,
          deaf: body.deaf as boolean | undefined,
        });
      // A move or disconnect is MEMBER_MOVE or MEMBER_DISCONNECT, which merge; not recorded yet.
      if (memberChanges.length > 0)
        recordAudit(mock, guild, {
          action_type: AuditLogEvent.MemberUpdate,
          user_id: bot,
          target_id: userId,
          changes: memberChanges,
          reason,
        });
      if (roleChanges.length > 0)
        recordAudit(mock, guild, {
          action_type: AuditLogEvent.MemberRoleUpdate,
          user_id: bot,
          target_id: userId,
          changes: roleChanges,
          reason,
        });
      announceUpdate(guild, member);
      return respond.json(member);
    }),
  );

  // Add Guild Member (docs.discord.food/resources/guild) needs an OAuth2 access token with the
  // guilds.join scope. The World issues no OAuth2 tokens, so every token is refused with 50025:
  // the contract run got 403 50025 for a made-up token, even for a user already in the guild.
  // "The bot must be a member of the guild with the CREATE_INSTANT_INVITE permission"; 50013
  // without it, and checking it before the token, are inferred, not checked.
  rest.route(
    "PUT",
    "/guilds/:guildId/members/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const body = (req.body ?? {}) as { access_token?: unknown };
      if (typeof body.access_token !== "string")
        return rest.gap("Add Guild Member without an access token");
      if (!botHas(guild, Permission.CreateInstantInvite))
        return respond.missingPermissions();
      return respond.error(403, 50025, "Invalid OAuth2 access token");
    }),
  );

  // Modify Current Guild Member Nick (docs.discord.food/resources/guild): deprecated, "see Modify
  // Current Guild Member". The contract run got 200 and the member object, as through @me, with
  // Change Nickname.
  rest.route(
    "PATCH",
    "/guilds/:guildId/members/@me/nick",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const member = guild.members.get(bot)!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find((key) => key !== "nick");
      if (other) return rest.gap(`PATCH members/@me/nick ${other}`);
      if (!botHas(guild, Permission.ChangeNickname))
        return respond.missingPermissions();
      const nick = (body.nick as string | null | undefined) || null;
      if (nick !== (member.nick ?? null))
        recordAudit(mock, guild, {
          action_type: AuditLogEvent.MemberUpdate,
          user_id: bot,
          target_id: bot,
          changes: [change("nick", member.nick ?? null, nick)],
          reason: reasonOf(req),
        });
      member.nick = nick;
      announceUpdate(guild, member);
      return respond.json(member);
    }),
  );

  const memberRole = (add: boolean) =>
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const member = guild.members.get(req.params.userId!);
      if (!member) return unknownMember();
      const role = guild.roles.get(req.params.roleId!);
      if (!role) return unknownRole();
      if (
        !botHas(guild, Permission.ManageRoles) ||
        role.position >= highest(guild, bot)
      )
        return respond.missingPermissions();
      const had = member.roles.includes(role.id);
      if (add && !had) member.roles.push(role.id);
      if (!add && had)
        member.roles = member.roles.filter((id) => id !== role.id);
      if (add !== had) {
        announceUpdate(guild, member);
        recordAudit(mock, guild, {
          action_type: AuditLogEvent.MemberRoleUpdate,
          user_id: bot,
          target_id: member.user.id,
          changes: roleDiff(guild, add ? [] : [role.id], add ? [role.id] : []),
          reason: reasonOf(req),
        });
      }
      return respond.noContent();
    });
  rest.route(
    "PUT",
    "/guilds/:guildId/members/:userId/roles/:roleId",
    memberRole(true),
  );
  rest.route(
    "DELETE",
    "/guilds/:guildId/members/:userId/roles/:roleId",
    memberRole(false),
  );

  rest.route(
    "DELETE",
    "/guilds/:guildId/members/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const userId = req.params.userId!;
      if (!guild.members.has(userId)) return unknownMember();
      if (!botHas(guild, Permission.KickMembers) || !outranks(guild, userId))
        return respond.missingPermissions();
      kickMember(mock, guild, state.requireUser(userId), bot, reasonOf(req));
      return respond.noContent();
    }),
  );

  rest.route(
    "PUT",
    "/guilds/:guildId/bans/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const userId = req.params.userId!;
      const user = state.users.get(userId);
      if (!user) return respond.error(404, 10013, "Unknown User");
      if (
        !botHas(guild, Permission.BanMembers) ||
        (guild.members.has(userId) && !outranks(guild, userId))
      )
        return respond.missingPermissions();
      // docs.discord.food Create Guild Ban: `delete_message_seconds` "0-604800, default 0" deletes
      // "previous messages sent by the banned user". Out of range answering 50035 is inferred.
      const seconds = Number(
        (req.body as RESTPutAPIGuildBanJSONBody | undefined)
          ?.delete_message_seconds ?? 0,
      );
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 604_800)
        return respond.invalidFormBody();
      banUser(mock, guild, user, bot, reasonOf(req), seconds);
      return respond.noContent();
    }),
  );

  rest.route(
    "DELETE",
    "/guilds/:guildId/bans/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (!botHas(guild, Permission.BanMembers))
        return respond.missingPermissions();
      const ban = guild.bans.get(req.params.userId!);
      if (!ban) return unknownBan();
      guild.bans.delete(req.params.userId!);
      announceBan(mock, guild, GatewayDispatchEvents.GuildBanRemove, ban);
      recordAudit(mock, guild, {
        action_type: AuditLogEvent.MemberBanRemove,
        user_id: bot,
        target_id: ban.user.id,
        reason: reasonOf(req),
      });
      return respond.noContent();
    }),
  );

  // Bulk Guild Ban (#bulk-guild-ban, deprecated for /bulk-ban/v2, which discord.js 14 doesn't
  // call): BAN_MEMBERS and MANAGE_GUILD, at most 200 ids. A ban fails "if the user is already
  // banned, the user has a higher role than the current user, the user is the owner of the
  // guild, or the user is the current user"; none banned is 500000. The HTTP status for 500000,
  // and 10013 for an id that names no user, are inferred, not checked.
  rest.route(
    "POST",
    "/guilds/:guildId/bulk-ban",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const body = (req.body ?? {}) as {
        user_ids?: string[];
        delete_message_seconds?: number;
      };
      const ids = body.user_ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200)
        return respond.invalidFormBody();
      if (!botHas(guild, Permission.BanMembers | Permission.ManageGuild))
        return respond.missingPermissions();
      if ((body.delete_message_seconds ?? 0) > 0)
        return rest.gap("bulk ban with delete_message_seconds");
      const banned: string[] = [];
      const failed: string[] = [];
      for (const id of ids) {
        const user = state.users.get(id);
        if (
          !user ||
          id === bot ||
          guild.bans.has(id) ||
          (guild.members.has(id) && !outranks(guild, id))
        )
          failed.push(id);
        else {
          banUser(mock, guild, user, bot, reasonOf(req));
          banned.push(id);
        }
      }
      if (!banned.length)
        return respond.error(400, 500000, "Failed to ban users");
      return respond.json({ banned_users: banned, failed_users: failed });
    }),
  );

  const canReadBans = (guild: GuildRecord) =>
    botHas(guild, Permission.BanMembers) ||
    botHas(guild, Permission.ViewAuditLog);

  rest.route(
    "GET",
    "/guilds/:guildId/bans/:userId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (!canReadBans(guild)) return respond.missingPermissions();
      const ban = guild.bans.get(req.params.userId!);
      return ban ? respond.json(ban) : unknownBan();
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/bans",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (!canReadBans(guild)) return respond.missingPermissions();
      // "Users will always be returned in ascending order by user.id. If both before and after are
      // provided, only before is respected."
      const limit = Number(req.query.get("limit") ?? 1000);
      const before = req.query.get("before");
      const after = before ? null : req.query.get("after");
      const ids = [...guild.bans.keys()]
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
        .filter((id) => !before || BigInt(id) < BigInt(before))
        .filter((id) => !after || BigInt(id) > BigInt(after));
      const page = before ? ids.slice(-limit) : ids.slice(0, limit);
      return respond.json(page.map((id) => guild.bans.get(id)!));
    }),
  );

  // topics/permissions#permission-hierarchy: "A bot can edit roles of a lower position than its
  // highest role, but it can only grant permissions it has to those roles." The 50013 for either
  // is inferred, not checked.
  const grantable = (guild: GuildRecord, permissions: unknown) =>
    permissions == null ||
    botHas(guild, BigInt(permissions as string | number));
  const announceRole = (
    guild: GuildRecord,
    t: string,
    payload: { role: APIRole } | { role_id: string },
  ) =>
    gateway.dispatch(
      t,
      { guild_id: guild.id, ...payload },
      GatewayIntentBits.Guilds,
    );
  const ROLE_FIELDS = ["name", "permissions", "colors", "hoist", "mentionable"];

  // docs.discord.food/resources/guild#list-guild-roles: every role. "User must be a member of the guild."
  rest.route(
    "GET",
    "/guilds/:guildId/roles",
    authed((req) => {
      const guild = guildOf(req);
      return guild ? respond.json([...guild.roles.values()]) : unknownGuild();
    }),
  );

  // Get Guild Role Member Counts (#get-guild-role-member-counts): role id to member count. The
  // example leaves out @everyone, and discord.js says so (RoleManager#fetchMemberCounts: "This
  // does not include the @everyone role"). Registered before /roles/:roleId,
  // which would otherwise answer "member-counts" as an unknown role.
  rest.route(
    "GET",
    "/guilds/:guildId/roles/member-counts",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const members = [...guild.members.values()];
      return respond.json(
        Object.fromEntries(
          [...guild.roles.keys()]
            .filter((id) => id !== guild.id)
            .map((id) => [
              id,
              members.filter((m) => m.roles.includes(id)).length,
            ]),
        ),
      );
    }),
  );

  // Get Guild Role (#get-guild-role): the role, else 10011 Unknown Role.
  rest.route(
    "GET",
    "/guilds/:guildId/roles/:roleId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const role = guild.roles.get(req.params.roleId!);
      return role ? respond.json(role) : unknownRole();
    }),
  );

  // Modify Guild Role Positions (#modify-guild-role-positions): an array of { id, position },
  // MANAGE_ROLES, answers every role, fires GUILD_ROLE_UPDATE for each role that moved. How
  // Discord reorders the rest isn't documented: the mock sorts by the requested positions, the
  // moved roles ahead on a tie, and renumbers from 1 (inferred). The bot moving a role at or above
  // its own highest, or onto such a position, is refused like any role edit (50013, inferred).
  rest.route(
    "PATCH",
    "/guilds/:guildId/roles",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      if (!Array.isArray(req.body)) return respond.invalidFormBody();
      const moves = new Map<string, number>();
      for (const entry of req.body as {
        id?: string;
        position?: number | null;
      }[]) {
        if (!entry.id || !guild.roles.has(entry.id)) return unknownRole();
        if (entry.position != null) moves.set(entry.id, entry.position);
      }
      const top = highest(guild, bot);
      const moved = [...moves].filter(
        ([id, position]) => guild.roles.get(id)!.position !== position,
      );
      if (
        !botHas(guild, Permission.ManageRoles) ||
        (guild.ownerId !== bot &&
          moved.some(
            ([id, position]) =>
              guild.roles.get(id)!.position >= top || position >= top,
          ))
      )
        return respond.missingPermissions();
      const before = new Map(
        [...guild.roles.values()].map((r) => [r.id, r.position]),
      );
      const ranked = [...guild.roles.values()]
        .filter((r) => r.id !== guild.id)
        .map((r) => ({
          role: r,
          key: moves.get(r.id) ?? r.position,
          mover: moves.has(r.id),
        }))
        .sort((a, b) => a.key - b.key || Number(a.mover) - Number(b.mover));
      ranked.forEach(({ role }, index) => (role.position = index + 1));
      for (const role of guild.roles.values())
        if (before.get(role.id) !== role.position)
          announceRole(guild, GatewayDispatchEvents.GuildRoleUpdate, { role });
      return respond.json([...guild.roles.values()]);
    }),
  );

  // Create Guild Role: "All JSON params are optional"; name defaults to "new role", permissions to
  // @everyone's. Fires GUILD_ROLE_CREATE. Where the new role sits isn't documented: the mock puts
  // it at position 1, just above @everyone, as Discord's app shows new roles (checked nightly).
  rest.route(
    "POST",
    "/guilds/:guildId/roles",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find((key) => !ROLE_FIELDS.includes(key));
      if (other) return rest.gap(`create role with ${other}`);
      if (
        !botHas(guild, Permission.ManageRoles) ||
        !grantable(guild, body.permissions)
      )
        return respond.missingPermissions();
      for (const role of guild.roles.values())
        if (role.position >= 1) role.position++;
      const everyone = guild.roles.get(guild.id)!;
      const role: APIRole = {
        ...everyone,
        ...body,
        id: snowflake(),
        name: (body.name as string | undefined) ?? "new role",
        permissions: String(body.permissions ?? everyone.permissions),
        position: 1,
      };
      guild.roles.set(role.id, role);
      announceRole(guild, GatewayDispatchEvents.GuildRoleCreate, { role });
      return respond.json(role);
    }),
  );

  // Modify Guild Role: "All parameters to this endpoint are optional and nullable." Fires
  // GUILD_ROLE_UPDATE.
  rest.route(
    "PATCH",
    "/guilds/:guildId/roles/:roleId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const role = guild.roles.get(req.params.roleId!);
      if (!role) return unknownRole();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find((key) => !ROLE_FIELDS.includes(key));
      if (other) return rest.gap(`modify role ${other}`);
      if (
        !botHas(guild, Permission.ManageRoles) ||
        (guild.ownerId !== bot && role.position >= highest(guild, bot)) ||
        !grantable(guild, body.permissions)
      )
        return respond.missingPermissions();
      Object.assign(role, body, {
        ...(body.permissions == null
          ? {}
          : { permissions: String(body.permissions) }),
      });
      announceRole(guild, GatewayDispatchEvents.GuildRoleUpdate, { role });
      return respond.json(role);
    }),
  );

  // Delete Guild Role: 204, fires GUILD_ROLE_DELETE. @everyone can't be deleted; 50028 Invalid
  // Role is the code table's closest entry, so the pairing is inferred.
  rest.route(
    "DELETE",
    "/guilds/:guildId/roles/:roleId",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      const role = guild.roles.get(req.params.roleId!);
      if (!role) return unknownRole();
      if (role.id === guild.id)
        return respond.error(400, 50028, "Invalid Role");
      if (
        !botHas(guild, Permission.ManageRoles) ||
        (guild.ownerId !== bot && role.position >= highest(guild, bot))
      )
        return respond.missingPermissions();
      guild.roles.delete(role.id);
      for (const member of guild.members.values())
        member.roles = member.roles.filter((id) => id !== role.id);
      announceRole(guild, GatewayDispatchEvents.GuildRoleDelete, {
        role_id: role.id,
      });
      return respond.noContent();
    }),
  );

  // Prune (resources/guild#get-guild-prune-count, #begin-guild-prune): Manage Server and Kick
  // Members; `days` 1-30, 7 by default; members with no roles, or only roles in `include_roles`,
  // who haven't been seen for `days`. Begin Prune fires GUILD_MEMBER_REMOVE for each, and `pruned`
  // is null when compute_prune_count is false. Inferred, not checked: "seen" is the member's
  // `inactiveDays` from the World (everyone else was seen just now), 50035 for days out of range,
  // and one MEMBER_PRUNE audit log entry. The PRUNE_REQUIRES_ADMIN feature isn't modelled, and a
  // role at or above the bot's in `include_roles` is a Gap.
  const prunable = (guild: GuildRecord, days: number, include: string[]) => {
    const since = Date.now() - days * 86_400_000;
    return [...guild.members.values()].filter(
      (m) =>
        m.roles.every((id) => include.includes(id)) &&
        (guild.lastSeen.get(m.user.id) ?? Date.now()) <= since,
    );
  };
  const pruneRequest = (
    req: RestRequest,
    days: unknown,
    include: string[],
    run: (guild: GuildRecord, days: number, include: string[]) => RestResponse,
  ) => {
    const guild = guildOf(req);
    if (!guild) return respond.error(404, 10004, "Unknown Guild");
    if (!botHas(guild, Permission.ManageGuild | Permission.KickMembers))
      return respond.missingPermissions();
    const n = days === undefined ? 7 : Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 30)
      return respond.invalidFormBody();
    if (
      include.some(
        (id) =>
          guild.ownerId !== bot &&
          (guild.roles.get(id)?.position ?? 0) >= highest(guild, bot),
      )
    )
      return rest.gap("pruning a role at or above the bot's");
    return run(guild, n, include);
  };
  rest.route(
    "GET",
    "/guilds/:guildId/prune",
    authed((req) =>
      pruneRequest(
        req,
        req.query.get("days") ?? undefined,
        req.query.get("include_roles")?.split(",").filter(Boolean) ?? [],
        (guild, days, include) =>
          respond.json({ pruned: prunable(guild, days, include).length }),
      ),
    ),
  );
  rest.route(
    "POST",
    "/guilds/:guildId/prune",
    authed((req) => {
      const body = (req.body ?? {}) as {
        days?: unknown;
        include_roles?: string[];
        compute_prune_count?: boolean;
      };
      return pruneRequest(
        req,
        body.days,
        body.include_roles ?? [],
        (guild, days, include) => {
          const pruned = prunable(guild, days, include);
          for (const m of pruned) mock.removeMember(guild, m.user);
          recordAudit(mock, guild, {
            action_type: AuditLogEvent.MemberPrune,
            user_id: bot,
            target_id: null,
            options: {
              delete_member_days: String(days),
              members_removed: String(pruned.length),
            },
            reason: reasonOf(req),
          });
          return respond.json({
            pruned: body.compute_prune_count === false ? null : pruned.length,
          });
        },
      );
    }),
  );
}

const change = (key: string, oldValue: unknown, newValue: unknown) =>
  ({
    key,
    // "If old_value isn't included, it indicated that the property was previously null", and a
    // missing new_value means it was reset to null.
    ...(oldValue === null ? {} : { old_value: oldValue }),
    ...(newValue === null ? {} : { new_value: newValue }),
  }) as APIAuditLogChange;

/** MEMBER_ROLE_UPDATE's changes: `$add` and `$remove`, each with partial roles (id and name). */
function roleDiff(guild: GuildRecord, before: string[], after: string[]) {
  const partial = (ids: string[]) =>
    ids.map((id) => ({ id, name: guild.roles.get(id)?.name ?? "" }));
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  return [
    ...(added.length ? [{ key: "$add", new_value: partial(added) }] : []),
    ...(removed.length
      ? [{ key: "$remove", new_value: partial(removed) }]
      : []),
  ] as APIAuditLogChange[];
}

/** GUILD_BAN_ADD/REMOVE: GUILD_MODERATION, "only sent to bots with the BAN_MEMBERS or VIEW_AUDIT_LOG permission". */
function announceBan(
  mock: DiscordMock,
  guild: GuildRecord,
  t: string,
  ban: APIBan,
  extra: Record<string, unknown> = {},
) {
  const perms = computePermissions(mock.state, guild, mock.state.bot.id);
  if (perms & (Permission.BanMembers | Permission.ViewAuditLog))
    mock.gateway.dispatch(
      t,
      { guild_id: guild.id, user: ban.user, ...extra },
      GatewayIntentBits.GuildModeration,
    );
}

/**
 * Removes `user`'s messages in `guild` (threads included) posted within the last `seconds`. Guild
 * Ban Add carries `delete_message_secs` (docs.discord.food gateway-events). Neither page says the
 * deletion fires Message Delete events, so the mock sends none: a bot that needs them fails here
 * rather than passing where Discord might not send them. Inferred, not checked.
 */
function deleteRecentMessages(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  seconds: number,
) {
  const since = Date.now() - seconds * 1000;
  for (const channel of mock.state.channels.values()) {
    if (!("guild_id" in channel) || channel.guild_id !== guild.id) continue;
    for (const message of [...(mock.state.messages.get(channel.id) ?? [])])
      if (
        message.author.id === user.id &&
        Date.parse(message.timestamp) >= since
      )
        mock.state.deleteMessage(channel.id, message.id);
  }
}

/** `executorId` kicks `user`: GUILD_MEMBER_REMOVE, and a MEMBER_KICK audit log entry. */
export function kickMember(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  executorId: string,
  reason?: string,
) {
  mock.removeMember(guild, user);
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.MemberKick,
    user_id: executorId,
    target_id: user.id,
    reason,
  });
}

/**
 * `executorId` bans `user`. docs.discord.food: "Fires a Guild Ban Add and optionally a Guild
 * Member Remove"; and a MEMBER_BAN_ADD audit log entry.
 */
export function banUser(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  executorId: string,
  reason?: string,
  deleteMessageSeconds = 0,
) {
  const ban: APIBan = { user, reason: reason ?? null };
  guild.bans.set(user.id, ban);
  if (guild.members.has(user.id)) mock.removeMember(guild, user);
  if (deleteMessageSeconds > 0)
    deleteRecentMessages(mock, guild, user, deleteMessageSeconds);
  announceBan(mock, guild, GatewayDispatchEvents.GuildBanAdd, ban, {
    delete_message_secs: deleteMessageSeconds,
  });
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.MemberBanAdd,
    user_id: executorId,
    target_id: user.id,
    reason,
  });
}
