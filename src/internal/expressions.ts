import {
  AuditLogEvent,
  GatewayDispatchEvents,
  GatewayIntentBits,
  StickerFormatType,
  StickerType,
  type APIEmoji,
  type APIUser,
} from "discord-api-types/v10";
import { reasonOf, recordAudit } from "./audit.js";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";
import { snowflake } from "./snowflake.js";
import type { GuildRecord } from "./state.js";

// Custom emojis and guild stickers ("expressions"). Sources: discord-api-docs resources/emoji
// (the emoji object, List, Get, Create, Modify, Delete Guild Emoji), resources/sticker (the
// sticker object, List and Get Guild Stickers), events/gateway-events (Guild Emojis Update and
// Guild Stickers Update carry the guild's whole list), events/gateway (GUILD_EXPRESSIONS),
// resources/audit-log (EMOJI_CREATE 60 to 62, STICKER_CREATE 90 to 92), opcodes-and-status-codes
// (30008, 30039), docs.discord.food/resources/emoji (names 2-32 characters, 50 emojis without
// boosts, `user` only from List and Get), docs.discord.food/resources/sticker (the bot's Create,
// Modify and Delete Guild Sticker).

export type ExpressionKind = "emoji" | "sticker";

// docs.discord.food: "The default emoji limit is 50", for normal and animated each; discord-api-docs
// resources/sticker: "five free sticker slots by default". Boosts aren't modelled.
const EMOJI_LIMIT = 50;
const STICKER_LIMIT = 5;

const NAME_LENGTH = { emoji: [2, 32], sticker: [2, 30] } as const;

const store = (guild: GuildRecord, kind: ExpressionKind) =>
  kind === "emoji" ? guild.emojis : guild.stickers;

function badName(kind: ExpressionKind, name: unknown) {
  const [min, max] = NAME_LENGTH[kind];
  return typeof name !== "string" || name.length < min || name.length > max;
}

/** CREATE_GUILD_EXPRESSIONS creates, and edits or deletes one's own; MANAGE_GUILD_EXPRESSIONS any. */
function mayChange(
  mock: DiscordMock,
  guild: GuildRecord,
  userId: string,
  creatorId: string | undefined,
) {
  const perms = computePermissions(mock.state, guild, userId);
  if (perms & Permission.ManageGuildExpressions) return true;
  return (
    (creatorId === undefined || creatorId === userId) &&
    (perms & Permission.CreateGuildExpressions) !== 0n
  );
}

/** GUILD_EMOJIS_UPDATE or GUILD_STICKERS_UPDATE with the guild's whole list, without `user`. */
function announce(mock: DiscordMock, guild: GuildRecord, kind: ExpressionKind) {
  if (kind === "emoji")
    mock.gateway.dispatch(
      GatewayDispatchEvents.GuildEmojisUpdate,
      {
        guild_id: guild.id,
        emojis: [...guild.emojis.values()].map(({ user: _, ...e }) => e),
      },
      GatewayIntentBits.GuildExpressions,
    );
  else
    mock.gateway.dispatch(
      GatewayDispatchEvents.GuildStickersUpdate,
      {
        guild_id: guild.id,
        stickers: [...guild.stickers.values()].map(({ user: _, ...s }) => s),
      },
      GatewayIntentBits.GuildExpressions,
    );
}

const AUDIT = {
  emoji: [
    AuditLogEvent.EmojiCreate,
    AuditLogEvent.EmojiUpdate,
    AuditLogEvent.EmojiDelete,
  ],
  sticker: [
    AuditLogEvent.StickerCreate,
    AuditLogEvent.StickerUpdate,
    AuditLogEvent.StickerDelete,
  ],
} as const;

/** Whether `guild` is at its limit for this kind (and, for emojis, animated or not). */
function full(guild: GuildRecord, kind: ExpressionKind, animated: boolean) {
  if (kind === "sticker") return guild.stickers.size >= STICKER_LIMIT;
  return (
    [...guild.emojis.values()].filter((e) => !!e.animated === animated)
      .length >= EMOJI_LIMIT
  );
}

function add(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  kind: ExpressionKind,
  name: string,
  opts: {
    animated?: boolean;
    roles?: string[];
    reason?: string;
    description?: string | null;
    tags?: string;
    formatType?: StickerFormatType;
  } = {},
) {
  const id = snowflake();
  if (kind === "emoji")
    guild.emojis.set(id, {
      id,
      name,
      roles: opts.roles ?? [],
      user,
      require_colons: true,
      managed: false,
      animated: opts.animated ?? false,
      available: true,
    });
  else
    guild.stickers.set(id, {
      id,
      name,
      description: opts.description ?? null,
      tags: opts.tags ?? name,
      type: StickerType.Guild,
      format_type: opts.formatType ?? StickerFormatType.PNG,
      available: true,
      guild_id: guild.id,
      user,
    });
  announce(mock, guild, kind);
  recordAudit(mock, guild, {
    action_type: AUDIT[kind][0],
    user_id: user.id,
    target_id: id,
    changes: [{ key: "name", new_value: name }],
    reason: opts.reason,
  });
  return id;
}

function rename(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  kind: ExpressionKind,
  id: string,
  name: string,
  reason?: string,
) {
  const expression = store(guild, kind).get(id)!;
  const before = expression.name;
  expression.name = name;
  announce(mock, guild, kind);
  recordAudit(mock, guild, {
    action_type: AUDIT[kind][1],
    user_id: user.id,
    target_id: id,
    changes: [{ key: "name", old_value: before ?? undefined, new_value: name }],
    reason,
  });
}

function remove(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  kind: ExpressionKind,
  id: string,
  reason?: string,
) {
  const expression = store(guild, kind).get(id)!;
  store(guild, kind).delete(id);
  announce(mock, guild, kind);
  recordAudit(mock, guild, {
    action_type: AUDIT[kind][2],
    user_id: user.id,
    target_id: id,
    changes: [{ key: "name", old_value: expression.name ?? undefined }],
    reason,
  });
}

function requireChange(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  kind: ExpressionKind,
  id: string,
) {
  const expression = store(guild, kind).get(id);
  if (!expression)
    throw new Error(`discordjs-test-kit: that ${kind} was deleted`);
  if (!mayChange(mock, guild, user.id, expression.user.id))
    throw new Error(
      `discordjs-test-kit: ${user.username} can't change someone else's ${kind} without Manage Expressions, or their own without Create Expressions`,
    );
}

/** `user` uploads an emoji or sticker from the Discord app; returns its id. */
export function uploadExpression(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  kind: ExpressionKind,
  name: string,
) {
  if (badName(kind, name))
    throw new Error(
      `discordjs-test-kit: a ${kind} name is ${NAME_LENGTH[kind].join("-")} characters`,
    );
  if (!mayChange(mock, guild, user.id, undefined))
    throw new Error(
      `discordjs-test-kit: ${user.username} can't upload a ${kind} without Create Expressions`,
    );
  if (full(guild, kind, false))
    throw new Error(
      `discordjs-test-kit: ${guild.name} has no ${kind} slots left`,
    );
  return add(mock, guild, user, kind, name);
}

/** `user` renames an emoji or sticker from the Discord app. */
export function renameExpression(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  kind: ExpressionKind,
  id: string,
  name: string,
) {
  requireChange(mock, guild, user, kind, id);
  if (badName(kind, name))
    throw new Error(
      `discordjs-test-kit: a ${kind} name is ${NAME_LENGTH[kind].join("-")} characters`,
    );
  rename(mock, guild, user, kind, id, name);
}

/** `user` deletes an emoji or sticker from the Discord app. */
export function deleteExpression(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  kind: ExpressionKind,
  id: string,
) {
  requireChange(mock, guild, user, kind, id);
  remove(mock, guild, user, kind, id);
}

export function registerExpressionRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const bot = () => state.bot;
  const can = (guild: GuildRecord, flag: bigint) =>
    (computePermissions(state, guild, state.bot.id) & flag) !== 0n;
  const unknownEmoji = () => respond.error(404, 10014, "Unknown Emoji");
  const unknownSticker = () => respond.error(404, 10060, "Unknown Sticker");
  const guildOf = (id: string) => state.guilds.get(id);
  const unknownGuild = () => respond.error(404, 10004, "Unknown Guild");
  const shown = <T extends { user: APIUser }>(item: T, withUser: boolean) => {
    if (withUser) return item;
    const { user: _, ...withoutUser } = item;
    return withoutUser;
  };
  const either = (guild: GuildRecord) =>
    can(guild, Permission.CreateGuildExpressions) ||
    can(guild, Permission.ManageGuildExpressions);

  // List Guild Emojis / Stickers: `user` with CREATE or MANAGE_GUILD_EXPRESSIONS.
  rest.route(
    "GET",
    "/guilds/:guildId/emojis",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      return respond.json(
        [...guild.emojis.values()].map((e) => shown(e, either(guild))),
      );
    }),
  );
  rest.route(
    "GET",
    "/guilds/:guildId/stickers",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      return respond.json(
        [...guild.stickers.values()].map((s) => shown(s, either(guild))),
      );
    }),
  );

  // Get Guild Emoji: `user` with MANAGE_GUILD_EXPRESSIONS, or CREATE_GUILD_EXPRESSIONS on the
  // bot's own. Get Guild Sticker: with either.
  rest.route(
    "GET",
    "/guilds/:guildId/emojis/:emojiId",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      const emoji = guild.emojis.get(req.params.emojiId!);
      if (!emoji) return unknownEmoji();
      const withUser =
        can(guild, Permission.ManageGuildExpressions) ||
        (emoji.user.id === state.bot.id &&
          can(guild, Permission.CreateGuildExpressions));
      return respond.json(shown(emoji, withUser));
    }),
  );
  rest.route(
    "GET",
    "/guilds/:guildId/stickers/:stickerId",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      const sticker = guild.stickers.get(req.params.stickerId!);
      if (!sticker) return unknownSticker();
      return respond.json(shown(sticker, either(guild)));
    }),
  );

  // Get Sticker (docs.discord.food/resources/sticker): any sticker by id, for client.fetchSticker()
  // and sticker.fetch(). `user` is documented only for List and Get Guild Sticker, so it's left out.
  // Standard stickers aren't modelled, so an id that's no guild's sticker answers 10060. A sticker
  // from a guild the bot isn't in is a Gap: the page doesn't say whether Discord serves it.
  rest.route(
    "GET",
    "/stickers/:stickerId",
    authed((req) => {
      for (const guild of state.guilds.values()) {
        const sticker = guild.stickers.get(req.params.stickerId!);
        if (!sticker) continue;
        if (!state.botIn(guild.id))
          return rest.gap("a sticker from a guild the bot isn't in");
        return respond.json(shown(sticker, false));
      }
      return unknownSticker();
    }),
  );

  // Create Guild Emoji: CREATE_GUILD_EXPRESSIONS; `image` is image data (reference#image-data, a
  // data URI). A GIF is animated (inferred from the image type). Over 256 KiB Discord answers 400
  // without a JSON code, so that's a Gap; so is an image that isn't a data URI (error inferred).
  rest.route(
    "POST",
    "/guilds/:guildId/emojis",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      if (!can(guild, Permission.CreateGuildExpressions))
        return respond.missingPermissions();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const image = typeof body.image === "string" ? body.image : "";
      const match = /^data:(image\/[a-z]+);base64,(.*)$/.exec(image);
      if (!match) return rest.gap("an emoji image that isn't a data URI");
      if (Buffer.from(match[2]!, "base64").length > 256 * 1024)
        return rest.gap("an emoji image over 256 KiB");
      if (badName("emoji", body.name)) return respond.invalidFormBody();
      const animated = match[1] === "image/gif";
      if (full(guild, "emoji", animated))
        return respond.error(
          400,
          30008,
          `Maximum number of emojis reached (${EMOJI_LIMIT})`,
        );
      const id = add(mock, guild, bot(), "emoji", body.name as string, {
        animated,
        roles: (body.roles as string[] | undefined) ?? [],
        reason: reasonOf(req),
      });
      // 201 without `user`, as the contract run got from the test guild.
      return respond.json(shown(guild.emojis.get(id)!, false), 201);
    }),
  );

  // Modify Guild Emoji: `name` and `roles`.
  rest.route(
    "PATCH",
    "/guilds/:guildId/emojis/:emojiId",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      const emoji = guild.emojis.get(req.params.emojiId!);
      if (!emoji) return unknownEmoji();
      if (!mayChange(mock, guild, state.bot.id, emoji.user.id))
        return respond.missingPermissions();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find(
        (k) => k !== "name" && k !== "roles",
      );
      if (other) return rest.gap(`PATCH emoji ${other}`);
      if ("name" in body && badName("emoji", body.name))
        return respond.invalidFormBody();
      if ("roles" in body) emoji.roles = (body.roles as string[] | null) ?? [];
      if ("name" in body && body.name !== emoji.name)
        rename(
          mock,
          guild,
          bot(),
          "emoji",
          emoji.id,
          body.name as string,
          reasonOf(req),
        );
      else announce(mock, guild, "emoji");
      // Without `user`, like the upload (contract run 45912869868).
      return respond.json(shown(emoji, false));
    }),
  );

  rest.route(
    "DELETE",
    "/guilds/:guildId/emojis/:emojiId",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      const emoji = guild.emojis.get(req.params.emojiId!);
      if (!emoji) return unknownEmoji();
      if (!mayChange(mock, guild, state.bot.id, emoji.user.id))
        return respond.missingPermissions();
      remove(mock, guild, bot(), "emoji", emoji.id, reasonOf(req));
      return respond.noContent();
    }),
  );

  // Create Guild Sticker: multipart, CREATE_EXPRESSIONS; name 2-30, description up to 100, tags
  // 1-200 characters, and a PNG, APNG, GIF or Lottie JSON `file`. An APNG can't be told from a PNG
  // by its type, so it's stored as PNG (inferred). Lottie needs the VERIFIED or PARTNERED
  // feature, which the World doesn't give, and a file over 500 KiB "will fail with a 400 bad
  // request" with no JSON code: both are a Gap. Bad fields answering 50035 is inferred.
  const STICKER_FORMATS: Record<string, StickerFormatType> = {
    "image/png": StickerFormatType.PNG,
    "image/gif": StickerFormatType.GIF,
  };
  const stickerFieldsBad = (body: Record<string, unknown>, creating: boolean) =>
    ((creating || "name" in body) && badName("sticker", body.name)) ||
    ("description" in body &&
      body.description !== null &&
      (typeof body.description !== "string" ||
        body.description.length > 100)) ||
    ((creating || "tags" in body) &&
      (typeof body.tags !== "string" ||
        body.tags.length < 1 ||
        body.tags.length > 200));
  rest.route(
    "POST",
    "/guilds/:guildId/stickers",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      if (!can(guild, Permission.CreateGuildExpressions))
        return respond.missingPermissions();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const file = req.files[0];
      if (!file || stickerFieldsBad(body, true))
        return respond.invalidFormBody();
      if (file.type === "application/json") return rest.gap("a Lottie sticker");
      const formatType = STICKER_FORMATS[file.type];
      if (formatType === undefined) return respond.invalidFormBody();
      if (file.size > 500 * 1024) return rest.gap("a sticker over 500 KiB");
      if (full(guild, "sticker", false))
        return respond.error(
          400,
          30039,
          `Maximum number of stickers reached (${STICKER_LIMIT})`,
        );
      const id = add(mock, guild, bot(), "sticker", body.name as string, {
        description: (body.description as string) || null,
        tags: body.tags as string,
        formatType,
        reason: reasonOf(req),
      });
      // 201 without `user`, as contract runs 45914682250 and 45915019593 got from Discord.
      return respond.json(shown(guild.stickers.get(id)!, false), 201);
    }),
  );

  // Modify Guild Sticker: name, description and tags. Like emojis, the bot's own sticker needs
  // CREATE or MANAGE_EXPRESSIONS, someone else's MANAGE_EXPRESSIONS.
  rest.route(
    "PATCH",
    "/guilds/:guildId/stickers/:stickerId",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      const sticker = guild.stickers.get(req.params.stickerId!);
      if (!sticker) return unknownSticker();
      if (!mayChange(mock, guild, state.bot.id, sticker.user.id))
        return respond.missingPermissions();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find(
        (k) => !["name", "description", "tags"].includes(k),
      );
      if (other) return rest.gap(`PATCH sticker ${other}`);
      if (stickerFieldsBad(body, false)) return respond.invalidFormBody();
      if ("description" in body)
        sticker.description = (body.description as string | null) || null;
      if ("tags" in body) sticker.tags = body.tags as string;
      if ("name" in body && body.name !== sticker.name)
        rename(
          mock,
          guild,
          bot(),
          "sticker",
          sticker.id,
          body.name as string,
          reasonOf(req),
        );
      else announce(mock, guild, "sticker");
      // Without `user`, like the upload (contract run 45915019593).
      return respond.json(shown(sticker, false));
    }),
  );

  rest.route(
    "DELETE",
    "/guilds/:guildId/stickers/:stickerId",
    authed((req) => {
      const guild = guildOf(req.params.guildId!);
      if (!guild) return unknownGuild();
      const sticker = guild.stickers.get(req.params.stickerId!);
      if (!sticker) return unknownSticker();
      if (!mayChange(mock, guild, state.bot.id, sticker.user.id))
        return respond.missingPermissions();
      remove(mock, guild, bot(), "sticker", sticker.id, reasonOf(req));
      return respond.noContent();
    }),
  );

  // Application emojis (docs.discord.food/resources/emoji#list-application-emojis and the routes
  // after it): up to 2,000, names 2-32 characters and unique, never role-locked, `user` always
  // included (the bot, inferred). A duplicate name and the 2,000 limit have no documented error,
  // so they're a Gap, as is another application's id (the World has one app).
  const ofApp = (req: RestRequest) =>
    req.params.appId === state.applicationId
      ? undefined
      : rest.gap("another application's emojis");
  const nameTaken = (name: unknown, exceptId?: string) =>
    [...state.applicationEmojis.values()].some(
      (e) => e.name === name && e.id !== exceptId,
    );
  rest.route(
    "GET",
    "/applications/:appId/emojis",
    authed(
      (req) =>
        ofApp(req) ??
        respond.json({ items: [...state.applicationEmojis.values()] }),
    ),
  );
  rest.route(
    "GET",
    "/applications/:appId/emojis/:emojiId",
    authed((req) => {
      const refused = ofApp(req);
      if (refused) return refused;
      const emoji = state.applicationEmojis.get(req.params.emojiId!);
      return emoji ? respond.json(emoji) : unknownEmoji();
    }),
  );
  rest.route(
    "POST",
    "/applications/:appId/emojis",
    authed((req) => {
      const refused = ofApp(req);
      if (refused) return refused;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const image = typeof body.image === "string" ? body.image : "";
      const match = /^data:(image\/[a-z]+);base64,(.*)$/.exec(image);
      if (!match) return rest.gap("an emoji image that isn't a data URI");
      if (Buffer.from(match[2]!, "base64").length > 256 * 1024)
        return rest.gap("an emoji image over 256 KiB");
      if (badName("emoji", body.name)) return respond.invalidFormBody();
      if (nameTaken(body.name))
        return rest.gap("a duplicate application emoji name");
      if (state.applicationEmojis.size >= 2000)
        return rest.gap("more than 2,000 application emojis");
      const emoji: APIEmoji = {
        id: snowflake(),
        name: body.name as string,
        roles: [],
        user: state.bot,
        require_colons: true,
        managed: false,
        animated: match[1] === "image/gif",
        available: true,
      };
      state.applicationEmojis.set(emoji.id!, emoji);
      // 201 without `user`, as contract runs 45912556990 and 45912869868 got from Discord.
      const { user: _, ...created } = emoji;
      return respond.json(created, 201);
    }),
  );
  rest.route(
    "PATCH",
    "/applications/:appId/emojis/:emojiId",
    authed((req) => {
      const refused = ofApp(req);
      if (refused) return refused;
      const emoji = state.applicationEmojis.get(req.params.emojiId!);
      if (!emoji) return unknownEmoji();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find((k) => k !== "name");
      if (other) return rest.gap(`PATCH application emoji ${other}`);
      if ("name" in body) {
        if (badName("emoji", body.name)) return respond.invalidFormBody();
        if (nameTaken(body.name, emoji.id!))
          return rest.gap("a duplicate application emoji name");
        emoji.name = body.name as string;
      }
      // Without `user`, like the upload (contract run 45912869868).
      const { user: _, ...modified } = emoji;
      return respond.json(modified);
    }),
  );
  rest.route(
    "DELETE",
    "/applications/:appId/emojis/:emojiId",
    authed((req) => {
      const refused = ofApp(req);
      if (refused) return refused;
      return state.applicationEmojis.delete(req.params.emojiId!)
        ? respond.noContent()
        : unknownEmoji();
    }),
  );
}
