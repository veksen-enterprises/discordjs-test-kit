import { ChannelType, OverwriteType } from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { computePermissions, guildPayload, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import type { DiscordState, GuildRecord, TemplateRecord } from "./state.js";

// Guild template Routes. Sources: discord-api-docs and docs.discord.food resources/guild-template
// (the template object; Get, List, Create, Sync, Modify and Delete, all but Get with MANAGE_GUILD;
// name 1-100, description up to 120; Delete answers the deleted template), discord-api-types'
// APITemplateSerializedSourceGuild (the snapshot has Create Guild's body shape, so roles and
// channels carry placeholder ids) and its error codes 10057 UnknownGuildTemplate and 30031
// GuildAlreadyHasTemplate. Inferred, not checked: the code format, 50035 for a bad name or
// description, the statuses of 10057 and 30031, `is_dirty` being null rather than false while in
// sync, member overwrites being left out of the snapshot, and which role and channel fields it keeps.

const unknownTemplate = () =>
  respond.error(404, 10057, "Unknown Guild Template");
const CODE_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Twelve characters, like the docs' example; Discord documents no format. */
const newCode = () =>
  Array.from(
    { length: 12 },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
  ).join("");

/** The guild as a template keeps it: roles and channels by placeholder id, no members. */
function serialize(state: DiscordState, guild: GuildRecord) {
  const g = guildPayload(guild);
  const roles = [...guild.roles.values()].sort((a, b) =>
    a.id === guild.id ? -1 : b.id === guild.id ? 1 : a.position - b.position,
  );
  const roleIds = new Map(roles.map((r, i) => [r.id, i]));
  const channels = guild.channelIds
    .map((id) => state.requireChannel(id))
    .filter(
      (c) =>
        c.type !== ChannelType.PublicThread &&
        c.type !== ChannelType.PrivateThread &&
        c.type !== ChannelType.AnnouncementThread,
    );
  const channelIds = new Map(channels.map((c, i) => [c.id, i]));
  return {
    name: g.name,
    description: g.description,
    region: null,
    icon_hash: g.icon,
    verification_level: g.verification_level,
    default_message_notifications: g.default_message_notifications,
    explicit_content_filter: g.explicit_content_filter,
    preferred_locale: g.preferred_locale,
    afk_channel_id: null,
    afk_timeout: g.afk_timeout,
    system_channel_id: null,
    system_channel_flags: g.system_channel_flags,
    roles: roles.map((r) => ({
      id: roleIds.get(r.id)!,
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.permissions,
      icon: null,
      unicode_emoji: null,
    })),
    channels: channels.map((c) => {
      const raw = c as unknown as Record<string, unknown>;
      return {
        id: channelIds.get(c.id)!,
        type: c.type,
        name: c.name,
        position: raw.position ?? 0,
        topic: raw.topic ?? null,
        bitrate: raw.bitrate ?? 64000,
        user_limit: raw.user_limit ?? 0,
        nsfw: raw.nsfw ?? false,
        rate_limit_per_user: raw.rate_limit_per_user ?? 0,
        parent_id:
          typeof raw.parent_id === "string"
            ? (channelIds.get(raw.parent_id) ?? null)
            : null,
        permission_overwrites: (
          ("permission_overwrites" in c && c.permission_overwrites) ||
          []
        )
          .filter((o) => o.type === OverwriteType.Role && roleIds.has(o.id))
          .map((o) => ({
            id: roleIds.get(o.id)!,
            type: o.type,
            allow: o.allow,
            deny: o.deny,
          })),
      };
    }),
  };
}

function templatePayload(state: DiscordState, template: TemplateRecord) {
  const guild = state.requireGuild(template.guildId);
  const dirty =
    JSON.stringify(serialize(state, guild)) !==
    JSON.stringify(template.snapshot);
  return {
    code: template.code,
    name: template.name,
    description: template.description,
    usage_count: 0,
    creator_id: template.creatorId,
    creator: state.requireUser(template.creatorId),
    created_at: template.created_at,
    updated_at: template.updated_at,
    source_guild_id: template.guildId,
    serialized_source_guild: template.snapshot,
    is_dirty: dirty ? true : null,
  };
}

export function registerTemplateRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const bot = state.bot.id;
  const templateOf = (guildId: string) =>
    [...state.templates.values()].find((t) => t.guildId === guildId);

  /** The guild, if it exists and the bot has Manage Server in it. */
  const managed = (guildId: string) => {
    const guild = state.guilds.get(guildId);
    if (!guild) return { refused: respond.error(404, 10004, "Unknown Guild") };
    if (!(computePermissions(state, guild, bot) & Permission.ManageGuild))
      return { refused: respond.missingPermissions() };
    return { guild };
  };
  /** The guild's template by code, if the bot may manage it. */
  const managedTemplate = (guildId: string, code: string) => {
    const { refused, guild } = managed(guildId);
    if (refused) return { refused };
    const template = state.templates.get(code);
    if (!template || template.guildId !== guild!.id)
      return { refused: unknownTemplate() };
    return { template };
  };
  const badText = (body: { name?: unknown; description?: unknown }) =>
    (body.name !== undefined &&
      (typeof body.name !== "string" ||
        body.name.length < 1 ||
        body.name.length > 100)) ||
    (body.description != null &&
      (typeof body.description !== "string" || body.description.length > 120));

  rest.route(
    "GET",
    "/guilds/templates/:code",
    authed((req) => {
      const template = state.templates.get(req.params.code!);
      return template
        ? respond.json(templatePayload(state, template))
        : unknownTemplate();
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/templates",
    authed((req) => {
      const { refused, guild } = managed(req.params.guildId!);
      if (refused) return refused;
      const template = templateOf(guild!.id);
      return respond.json(template ? [templatePayload(state, template)] : []);
    }),
  );

  rest.route(
    "POST",
    "/guilds/:guildId/templates",
    authed((req) => {
      const { refused, guild } = managed(req.params.guildId!);
      if (refused) return refused;
      const body = (req.body ?? {}) as {
        name?: unknown;
        description?: unknown;
      };
      if (body.name === undefined || badText(body))
        return respond.invalidFormBody();
      if (templateOf(guild!.id))
        return respond.error(
          400,
          30031,
          "A server can only have a single template.",
        );
      const now = new Date().toISOString();
      const template: TemplateRecord = {
        code: newCode(),
        guildId: guild!.id,
        creatorId: bot,
        name: body.name as string,
        description: (body.description as string | null | undefined) ?? null,
        created_at: now,
        updated_at: now,
        snapshot: serialize(state, guild!),
      };
      state.templates.set(template.code, template);
      return respond.json(templatePayload(state, template));
    }),
  );

  rest.route(
    "PUT",
    "/guilds/:guildId/templates/:code",
    authed((req) => {
      const { refused, template } = managedTemplate(
        req.params.guildId!,
        req.params.code!,
      );
      if (refused) return refused;
      template!.snapshot = serialize(
        state,
        state.requireGuild(template!.guildId),
      );
      template!.updated_at = new Date().toISOString();
      return respond.json(templatePayload(state, template!));
    }),
  );

  rest.route(
    "PATCH",
    "/guilds/:guildId/templates/:code",
    authed((req) => {
      const { refused, template } = managedTemplate(
        req.params.guildId!,
        req.params.code!,
      );
      if (refused) return refused;
      const body = (req.body ?? {}) as {
        name?: unknown;
        description?: unknown;
      };
      if (badText(body)) return respond.invalidFormBody();
      if (body.name !== undefined) template!.name = body.name as string;
      if (body.description !== undefined)
        template!.description = body.description as string | null;
      return respond.json(templatePayload(state, template!));
    }),
  );

  rest.route(
    "DELETE",
    "/guilds/:guildId/templates/:code",
    authed((req) => {
      const { refused, template } = managedTemplate(
        req.params.guildId!,
        req.params.code!,
      );
      if (refused) return refused;
      const deleted = templatePayload(state, template!);
      state.templates.delete(template!.code);
      return respond.json(deleted);
    }),
  );
}
