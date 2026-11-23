import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIChannel,
  type APIUser,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import type { DiscordState, InviteRecord } from "./state.js";

// Invite Routes and events. Sources: discord-api-docs resources/channel (Create Channel Invite, Get
// Channel Invites), resources/guild (Get Guild Invites), resources/invite (the invite and metadata
// objects, Get Invite, Delete Invite), events/gateway-events (Invite Create, Invite Delete),
// events/gateway (GUILD_INVITES), and docs.discord.food/resources/invite.

const unknownInvite = () => respond.error(404, 10006, "Unknown Invite");
const CODE_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Eight characters, like the docs' examples; Discord documents no format. */
const newCode = () =>
  Array.from(
    { length: 8 },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
  ).join("");

const expiresAt = (invite: InviteRecord) =>
  invite.max_age === 0
    ? null
    : new Date(
        Date.parse(invite.created_at) + invite.max_age * 1000,
      ).toISOString();

/** The invite object; `withMetadata` adds uses, max_uses, max_age, temporary and created_at. */
export function invitePayload(
  state: DiscordState,
  invite: InviteRecord,
  withMetadata: boolean,
) {
  const guild = state.requireGuild(invite.guildId);
  const channel = state.requireChannel(invite.channelId);
  return {
    type: 0,
    code: invite.code,
    guild: {
      id: guild.id,
      name: guild.name,
      splash: null,
      banner: null,
      description: null,
      icon: null,
      features: [],
      verification_level: 0,
      vanity_url_code: null,
      nsfw_level: 0,
      premium_subscription_count: 0,
    },
    channel: {
      id: channel.id,
      name: "name" in channel ? channel.name : null,
      type: channel.type,
    },
    inviter: state.requireUser(invite.inviterId),
    expires_at: expiresAt(invite),
    ...(withMetadata
      ? {
          uses: invite.uses,
          max_uses: invite.max_uses,
          max_age: invite.max_age,
          temporary: invite.temporary,
          created_at: invite.created_at,
        }
      : {}),
  };
}

/**
 * INVITE_CREATE and INVITE_DELETE go out with GUILD_INVITES; discord.js's InviteCreate and
 * InviteDelete actions say they also need MANAGE_CHANNELS in the channel. Discord's docs don't
 * say so: inferred, not checked.
 */
function botHearsInvites(mock: DiscordMock, invite: InviteRecord) {
  const { state } = mock;
  return (
    state.botIn(invite.guildId) &&
    (computePermissions(
      state,
      state.requireGuild(invite.guildId),
      state.bot.id,
      state.requireChannel(invite.channelId),
    ) &
      Permission.ManageChannels) !==
      0n
  );
}

export function announceInviteCreate(mock: DiscordMock, invite: InviteRecord) {
  if (!botHearsInvites(mock, invite)) return;
  mock.gateway.dispatch(
    GatewayDispatchEvents.InviteCreate,
    {
      channel_id: invite.channelId,
      code: invite.code,
      created_at: invite.created_at,
      guild_id: invite.guildId,
      inviter: mock.state.requireUser(invite.inviterId),
      max_age: invite.max_age,
      max_uses: invite.max_uses,
      temporary: invite.temporary,
      uses: 0,
      expires_at: expiresAt(invite),
    },
    GatewayIntentBits.GuildInvites,
  );
}

export function deleteInvite(mock: DiscordMock, invite: InviteRecord) {
  mock.state.invites.delete(invite.code);
  if (!botHearsInvites(mock, invite)) return;
  mock.gateway.dispatch(
    GatewayDispatchEvents.InviteDelete,
    {
      channel_id: invite.channelId,
      guild_id: invite.guildId,
      code: invite.code,
    },
    GatewayIntentBits.GuildInvites,
  );
}

/** A new invite to `channel` by `inviter`, with Create Channel Invite's defaults. */
export function createInvite(
  mock: DiscordMock,
  channel: APIChannel,
  inviter: APIUser,
  opts: { max_age?: number; max_uses?: number; temporary?: boolean } = {},
): InviteRecord {
  if (!("guild_id" in channel) || !channel.guild_id)
    throw new Error("discordjs-test-kit: invites are for guild channels");
  const invite: InviteRecord = {
    code: newCode(),
    guildId: channel.guild_id,
    channelId: channel.id,
    inviterId: inviter.id,
    uses: 0,
    max_uses: opts.max_uses ?? 0,
    max_age: opts.max_age ?? 86400,
    temporary: opts.temporary ?? false,
    created_at: new Date().toISOString(),
  };
  mock.state.invites.set(invite.code, invite);
  announceInviteCreate(mock, invite);
  return invite;
}

export function registerInviteRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const bot = state.bot.id;
  const invitesIn = (key: "guildId" | "channelId", id: string) =>
    [...state.invites.values()].filter((invite) => invite[key] === id);

  // Create Channel Invite: CREATE_INSTANT_INVITE, guild channels only (a DM is a Gap). max_uses is
  // 0-100. The official docs cap max_age at 604800 and docs.discord.food at 5184000: the contract
  // run got 50035 for 604801 ("Int value should be less than or equal to 604800"). Without `unique`, "try to reuse a similar invite": the mock reuses the bot's invite
  // to the channel with the same max_age, max_uses and temporary (what counts as similar is
  // inferred, not checked). Answers 200 with the metadata (docs.discord.food; status inferred).
  rest.route(
    "POST",
    "/channels/:channelId/invites",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      if (!("guild_id" in channel) || !channel.guild_id)
        return rest.gap("an invite to a DM channel");
      const denied = mock.checkBotPerms(
        channel,
        Permission.CreateInstantInvite,
      );
      if (denied) return denied;
      const body = (req.body ?? {}) as Record<string, unknown>;
      // discord.js sends the target fields as null when unset.
      const other = Object.keys(body).find(
        (key) =>
          body[key] != null &&
          !["max_age", "max_uses", "temporary", "unique"].includes(key),
      );
      if (other) return rest.gap(`an invite with ${other}`);
      const opts = {
        max_age: (body.max_age as number | undefined) ?? 86400,
        max_uses: (body.max_uses as number | undefined) ?? 0,
        temporary: (body.temporary as boolean | undefined) ?? false,
      };
      if (
        opts.max_age < 0 ||
        opts.max_age > 604800 ||
        opts.max_uses < 0 ||
        opts.max_uses > 100
      )
        return respond.invalidFormBody();
      const similar = body.unique
        ? undefined
        : invitesIn("channelId", channel.id).find(
            (i) =>
              i.inviterId === bot &&
              i.max_age === opts.max_age &&
              i.max_uses === opts.max_uses &&
              i.temporary === opts.temporary,
          );
      const invite = similar ?? createInvite(mock, channel, state.bot, opts);
      return respond.json(invitePayload(state, invite, true));
    }),
  );

  // Get Channel Invites: MANAGE_CHANNELS, with metadata.
  rest.route(
    "GET",
    "/channels/:channelId/invites",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const denied = mock.checkBotPerms(channel, Permission.ManageChannels);
      if (denied) return denied;
      return respond.json(
        invitesIn("channelId", channel.id).map((invite) =>
          invitePayload(state, invite, true),
        ),
      );
    }),
  );

  // Get Guild Invites: MANAGE_GUILD or VIEW_AUDIT_LOG; metadata only with MANAGE_GUILD.
  rest.route(
    "GET",
    "/guilds/:guildId/invites",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const perms = computePermissions(state, guild, bot);
      const manage = (perms & Permission.ManageGuild) !== 0n;
      if (!manage && !(perms & Permission.ViewAuditLog))
        return respond.missingPermissions();
      return respond.json(
        invitesIn("guildId", guild.id).map((invite) =>
          invitePayload(state, invite, manage),
        ),
      );
    }),
  );

  // Get Invite: no permission. Counts with `with_counts=true` (presences are always 0: the Model
  // has none).
  rest.route(
    "GET",
    "/invites/:code",
    authed((req) => {
      const invite = state.invites.get(req.params.code!);
      if (!invite) return unknownInvite();
      const counts =
        req.query.get("with_counts") === "true"
          ? {
              approximate_member_count: state.requireGuild(invite.guildId)
                .members.size,
              approximate_presence_count: 0,
            }
          : {};
      return respond.json({
        ...invitePayload(state, invite, false),
        ...counts,
      });
    }),
  );

  // Delete Invite: MANAGE_CHANNELS in its channel or MANAGE_GUILD. Returns the invite, fires
  // INVITE_DELETE.
  rest.route(
    "DELETE",
    "/invites/:code",
    authed((req) => {
      const invite = state.invites.get(req.params.code!);
      if (!invite) return unknownInvite();
      const guild = state.requireGuild(invite.guildId);
      const channel = state.requireChannel(invite.channelId);
      const perms = computePermissions(state, guild, bot, channel);
      if (!(perms & (Permission.ManageChannels | Permission.ManageGuild)))
        return respond.missingPermissions();
      const answer = invitePayload(state, invite, false);
      deleteInvite(mock, invite);
      return respond.json(answer);
    }),
  );
}
