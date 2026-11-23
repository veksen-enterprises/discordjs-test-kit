import { randomBytes } from "node:crypto";
import { ChannelType, type APIChannel } from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { computePermissions, guildPayload, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import type { GuildRecord } from "./state.js";

// Guild Routes. Sources: discord-api-docs resources/user (Get Current User Guilds) and
// resources/guild (Get Guild, Modify Guild), events/gateway-events#guild-update.

const unknownGuild = () => respond.error(404, 10004, "Unknown Guild");

export function registerGuildRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const bot = state.bot.id;
  const counts = (guild: GuildRecord, withCounts: string | null) =>
    withCounts === "true"
      ? {
          approximate_member_count: guild.members.size,
          // The Model has no presences.
          approximate_presence_count: 0,
        }
      : {};

  // Get Current User Guilds: partial guilds, 200 by default, after/before by id. Ascending id
  // order is inferred, not checked.
  rest.route(
    "GET",
    "/users/@me/guilds",
    authed((req) => {
      const after = BigInt(req.query.get("after") ?? 0);
      const before = req.query.get("before");
      const limit = Math.min(200, Number(req.query.get("limit") ?? 200));
      const guilds = [...state.guilds.values()]
        .filter((g) => state.botIn(g.id))
        .filter((g) => BigInt(g.id) > after)
        .filter((g) => !before || BigInt(g.id) < BigInt(before))
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      return respond.json(
        guilds.slice(0, limit).map((guild) => ({
          id: guild.id,
          name: guild.name,
          icon: null,
          banner: null,
          owner: guild.ownerId === bot,
          permissions: String(computePermissions(state, guild, bot)),
          features: [],
          ...counts(guild, req.query.get("with_counts")),
        })),
      );
    }),
  );

  // Get Guild: approximate counts with `with_counts=true`, which discord.js's guilds.fetch sends.
  rest.route(
    "GET",
    "/guilds/:guildId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      return respond.json({
        ...guildPayload(guild),
        ...counts(guild, req.query.get("with_counts")),
      });
    }),
  );

  // Modify Guild: MANAGE_GUILD, returns the guild, fires GUILD_UPDATE. Only `name` (2 to 100
  // characters, trimmed) is modelled; another field is a Gap.
  rest.route(
    "PATCH",
    "/guilds/:guildId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find((key) => key !== "name");
      if (other) return rest.gap(`PATCH guild ${other}`);
      if (!(computePermissions(state, guild, bot) & Permission.ManageGuild))
        return respond.missingPermissions();
      if ("name" in body) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        // Which errors entry Discord gives is unchecked; the code is Invalid Form Body.
        if (name.length < 2 || name.length > 100)
          return respond.invalidFormBody();
        mock.renameGuild(guild, name);
      }
      return respond.json(guildPayload(guild));
    }),
  );

  // Get Guild Widget Settings and Modify Guild Widget (docs.discord.food/resources/guild), both
  // with Manage Server. 50013 without it is inferred, not checked. A channel that isn't one of the
  // guild's has no documented code: a Gap. The 30042 limit on changes isn't modelled.
  const widgetGuild = (guildId: string) => {
    const guild = state.guilds.get(guildId);
    if (!guild) return { refused: unknownGuild() };
    if (!(computePermissions(state, guild, bot) & Permission.ManageGuild))
      return { refused: respond.missingPermissions() };
    return { guild };
  };
  rest.route(
    "GET",
    "/guilds/:guildId/widget",
    authed((req) => {
      const { refused, guild } = widgetGuild(req.params.guildId!);
      return refused ?? respond.json(guild!.widget);
    }),
  );
  rest.route(
    "PATCH",
    "/guilds/:guildId/widget",
    authed((req) => {
      const { refused, guild } = widgetGuild(req.params.guildId!);
      if (refused) return refused;
      const body = (req.body ?? {}) as {
        enabled?: boolean;
        channel_id?: string | null;
      };
      const other = Object.keys(body).find(
        (k) => k !== "enabled" && k !== "channel_id",
      );
      if (other) return rest.gap(`PATCH widget ${other}`);
      if (
        typeof body.channel_id === "string" &&
        !guild!.channelIds.includes(body.channel_id)
      )
        return rest.gap("a widget channel outside the guild");
      if (body.enabled !== undefined) guild!.widget.enabled = body.enabled;
      if (body.channel_id !== undefined)
        guild!.widget.channel_id = body.channel_id;
      return respond.json(guild!.widget);
    }),
  );

  // Get Guild Preview (discord-api-docs resources/guild, docs.discord.food/resources/guild): "If
  // the user is not in the guild, the guild must be discoverable". The World has no discoverable
  // guilds, and the refusal isn't documented, so a guild the bot isn't in is a Gap. Emojis and
  // stickers leave out `user`, as in the guild object (inferred).
  rest.route(
    "GET",
    "/guilds/:guildId/preview",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      if (!state.botIn(guild.id))
        return rest.gap("a preview of a guild the bot isn't in");
      const { id, name, icon, splash, discovery_splash, features } =
        guildPayload(guild);
      const strip = <T extends { user: unknown }>({ user: _, ...item }: T) =>
        item;
      return respond.json({
        id,
        name,
        icon,
        splash,
        discovery_splash,
        features,
        description: null,
        // docs.discord.food's partial guild: "home_header?: ?string"; the contract run got null.
        home_header: null,
        emojis: [...guild.emojis.values()].map(strip),
        stickers: [...guild.stickers.values()].map(strip),
        approximate_member_count: guild.members.size,
        approximate_presence_count: [...guild.members.keys()].filter(
          (userId) => {
            const status = state.presences.get(userId)?.status;
            return status !== undefined && status !== "offline";
          },
        ).length,
      });
    }),
  );

  // Get Guild Widget (discord-api-docs resources/guild, docs.discord.food/resources/guild): the
  // public widget, no permission. "The guild must have the widget enabled": 50004 is discord-api-
  // types' GuildWidgetDisabled; the 403 is inferred, not checked. With an invite channel set,
  // Discord makes an invite on the first fetch, but neither page says whose it is or when it
  // expires, so that's a Gap. Channels: "voice and stage channels which are accessible by
  // @everyone", read as View Channel and Connect (inferred). Members: up to 100 non-offline ones,
  // with `id`, `discriminator` and `avatar` "anonymized": the docs' examples count ids up from "0"
  // with discriminator "0000" and avatar null. The username shown, the member order, and the voice
  // fields appearing only for a member in voice are inferred. The bot's own presence isn't
  // modelled, so it's never listed.
  rest.route(
    "GET",
    "/guilds/:guildId/widget.json",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return unknownGuild();
      if (!guild.widget.enabled)
        return respond.error(403, 50004, "Widget Disabled");
      if (guild.widget.channel_id)
        return rest.gap("widget.json with an invite channel");
      const everyone = (channel: APIChannel) => {
        const overwrite =
          "permission_overwrites" in channel
            ? channel.permission_overwrites?.find((o) => o.id === guild.id)
            : undefined;
        let perms = BigInt(guild.roles.get(guild.id)!.permissions);
        if (perms & Permission.Administrator) return true;
        if (overwrite)
          perms = (perms & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow);
        const needed = Permission.ViewChannel | Permission.Connect;
        return (perms & needed) === needed;
      };
      const channels = guild.channelIds
        .map((id) => state.requireChannel(id))
        .filter(
          (c) =>
            (c.type === ChannelType.GuildVoice ||
              c.type === ChannelType.GuildStageVoice) &&
            everyone(c),
        )
        .map((c) => ({
          id: c.id,
          name: c.name!,
          position: "position" in c ? c.position : 0,
        }));
      const online = [...guild.members.keys()]
        .map((id) => ({ id, presence: state.presences.get(id) }))
        .filter((m) => m.presence && m.presence.status !== "offline");
      const members = online.slice(0, 100).map(({ id, presence }, index) => {
        const voice = state.voiceStates.get(guild.id)?.get(id);
        const activity = presence!.activities?.[0];
        return {
          id: String(index),
          username: state.requireUser(id).username,
          discriminator: "0000",
          avatar: null,
          status: presence!.status,
          avatar_url: `${state.cdnUrl}/widget-avatars/${randomBytes(16).toString("base64url")}`,
          ...(activity && { activity: { name: activity.name } }),
          ...(voice?.channel_id && {
            channel_id: voice.channel_id,
            deaf: voice.deaf,
            mute: voice.mute,
            self_deaf: voice.self_deaf,
            self_mute: voice.self_mute,
            suppress: voice.suppress,
          }),
        };
      });
      return respond.json({
        id: guild.id,
        name: guild.name,
        instant_invite: null,
        channels,
        members,
        presence_count: online.length,
      });
    }),
  );
}
