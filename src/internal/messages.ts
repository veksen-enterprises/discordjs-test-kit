import {
  AuditLogEvent,
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIChannel,
  type APIMessage,
  type RESTPostAPIChannelMessagesBulkDeleteJSONBody,
} from "discord-api-types/v10";
import { reasonOf, recordAudit } from "./audit.js";
import type { DiscordMock } from "./mock.js";
import { Permission } from "./payloads.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";

// Pin, bulk delete and reaction Routes. Sources: discord-api-docs resources/message (Get Channel
// Pins, Pin Message, Unpin Message, Bulk Delete Messages, Get Reactions, Delete User Reaction,
// Delete All Reactions, Delete All Reactions for Emoji), topics/opcodes-and-status-codes for the
// JSON codes, and docs.discord.food/resources/message. HTTP statuses the docs don't give are
// inferred, not checked.

const MAX_PINS = 250; // 30003 "Maximum number of pins reached for the channel (250)"
const DISCORD_EPOCH = 1420070400000n;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

const createdAt = (id: string) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

/**
 * Registered before the Model's message Routes: `GET /messages/pins` would otherwise match
 * `GET /messages/:messageId`, as Discord's router never does.
 */
export function registerMessageRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state, gateway } = mock;
  /** When each pinned message was pinned, by message id. */
  const pinnedAt = new Map<string, string>();

  const guildIdOf = (channel: APIChannel) =>
    "guild_id" in channel && channel.guild_id ? channel.guild_id : undefined;
  /** The channel and message a route names, or the refusal Discord gives. */
  const target = (req: RestRequest, needed: bigint) => {
    const channel = state.channels.get(req.params.channelId!);
    if (!channel) return { refused: respond.unknownChannel() };
    const denied = mock.checkBotPerms(channel, needed);
    if (denied) return { refused: denied };
    const message = mock
      .historyIn(channel)
      .find((m) => m.id === req.params.messageId);
    if (!message) return { refused: respond.unknownMessage() };
    return { channel, message };
  };
  const pinsIn = (channel: APIChannel) =>
    mock
      .historyIn(channel)
      .filter((m) => m.pinned)
      .sort((a, b) => pinnedAt.get(b.id)!.localeCompare(pinnedAt.get(a.id)!));
  const withoutReactions = (m: APIMessage) => ({ ...m, reactions: undefined });

  /** CHANNEL_PINS_UPDATE (gateway-events#channel-pins-update): GUILDS in guilds, DIRECT_MESSAGES in DMs. */
  const announcePins = (channel: APIChannel) => {
    const guildId = guildIdOf(channel);
    const latest = pinsIn(channel)[0];
    gateway.dispatch(
      GatewayDispatchEvents.ChannelPinsUpdate,
      {
        ...(guildId ? { guild_id: guildId } : {}),
        channel_id: channel.id,
        last_pin_timestamp: latest ? pinnedAt.get(latest.id)! : null,
      },
      guildId ? GatewayIntentBits.Guilds : GatewayIntentBits.DirectMessages,
    );
  };

  // Get Channel Pins: VIEW_CHANNEL; without READ_MESSAGE_HISTORY "no pins will be returned".
  // Newest pin first; `before` is a pinned_at timestamp.
  rest.route(
    "GET",
    "/channels/:channelId/messages/pins",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const denied = mock.checkBotPerms(channel, 0n);
      if (denied) return denied;
      if (mock.checkBotPerms(channel, Permission.ReadMessageHistory))
        return respond.json({ items: [], has_more: false });
      const before = req.query.get("before");
      const limit = Math.min(50, Number(req.query.get("limit") ?? 50));
      const pins = pinsIn(channel).filter(
        (m) => !before || pinnedAt.get(m.id)! < new Date(before).toISOString(),
      );
      return respond.json({
        items: pins.slice(0, limit).map((m) => ({
          pinned_at: pinnedAt.get(m.id)!,
          message: withoutReactions(m),
        })),
        has_more: pins.length > limit,
      });
    }),
  );

  // List Pinned Messages (deprecated; discord.js's fetchPinned still calls it): up to 50 messages.
  rest.route(
    "GET",
    "/channels/:channelId/pins",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const denied = mock.checkBotPerms(channel, Permission.ReadMessageHistory);
      if (denied) return denied;
      return respond.json(pinsIn(channel).slice(0, 50).map(withoutReactions));
    }),
  );

  // Pin and Unpin Message need PIN_MESSAGES, split from MANAGE_MESSAGES on 2026-02-23
  // (discord-api-docs change-log). 204, fires CHANNEL_PINS_UPDATE. Pinning a pinned message,
  // or unpinning one that isn't, is answered 204 without an event (inferred, not checked).
  const pin = authed((req) => {
    const { refused, channel, message } = target(req, Permission.PinMessages);
    if (refused) return refused;
    if (message.pinned) return respond.noContent();
    if (pinsIn(channel).length >= MAX_PINS)
      return respond.error(
        400,
        30003,
        "Maximum number of pins reached for the channel (250)",
      );
    message.pinned = true;
    pinnedAt.set(message.id, new Date().toISOString());
    announcePins(channel);
    return respond.noContent();
  });
  const unpin = authed((req) => {
    const { refused, channel, message } = target(req, Permission.PinMessages);
    if (refused) return refused;
    if (!message.pinned) return respond.noContent();
    message.pinned = false;
    pinnedAt.delete(message.id);
    announcePins(channel);
    return respond.noContent();
  });
  rest.route("PUT", "/channels/:channelId/messages/pins/:messageId", pin);
  rest.route("DELETE", "/channels/:channelId/messages/pins/:messageId", unpin);
  // Pin Message (deprecated) and Unpin Message (deprecated), docs.discord.com resources/message:
  // "Use Pin Message instead". @discordjs/core 2.x's pinMessage still calls them. The docs give
  // them no behaviour of their own, so they answer as the current routes (inferred, not checked).
  rest.route("PUT", "/channels/:channelId/pins/:messageId", pin);
  rest.route("DELETE", "/channels/:channelId/pins/:messageId", unpin);

  // Bulk Delete Messages: guild channels only, MANAGE_MESSAGES, 2 to 100 ids. Ids that don't
  // exist "count towards the minimum and maximum" and are skipped; one older than two weeks, or a
  // duplicate, fails the request with a 400. Fires MESSAGE_DELETE_BULK with the ids it deleted.
  rest.route(
    "POST",
    "/channels/:channelId/messages/bulk-delete",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const guildId = guildIdOf(channel);
      if (!guildId || channel.type === ChannelType.GroupDM)
        return respond.error(
          400,
          50003,
          "Cannot execute action on a DM channel",
        );
      const denied = mock.checkBotPerms(channel, Permission.ManageMessages);
      if (denied) return denied;
      const ids: unknown = (
        req.body as RESTPostAPIChannelMessagesBulkDeleteJSONBody | undefined
      )?.messages;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
        return respond.invalidFormBody();
      // Contract run 11: one id is 400 + 50035, not 50016 as the code table suggests. Over 100 is
      // taken to be the same (inferred, not checked).
      if (ids.length < 2 || ids.length > 100) return respond.invalidFormBody();
      // Which code a duplicate gets isn't documented: 50035 is inferred, not checked.
      if (new Set(ids).size !== ids.length) return respond.invalidFormBody();
      if (ids.some((id) => Date.now() - createdAt(id) > TWO_WEEKS_MS))
        return respond.error(
          400,
          50034,
          "A message provided was too old to bulk delete",
        );
      const deleted = mock
        .historyIn(channel)
        .filter((m) => ids.includes(m.id))
        .map((m) => {
          state.deleteMessage(channel.id, m.id);
          pinnedAt.delete(m.id);
          return m.id;
        });
      gateway.dispatch(
        GatewayDispatchEvents.MessageDeleteBulk,
        { ids: deleted, channel_id: channel.id, guild_id: guildId },
        GatewayIntentBits.GuildMessages,
      );
      // MESSAGE_BULK_DELETE: target_id is the channel, count how many went (audit-log docs).
      recordAudit(mock, state.requireGuild(guildId), {
        action_type: AuditLogEvent.MessageBulkDelete,
        user_id: state.bot.id,
        target_id: channel.id,
        options: { count: String(deleted.length) },
        reason: reasonOf(req),
      });
      return respond.noContent();
    }),
  );

  /** Reaction events: GUILD_MESSAGE_REACTIONS in guilds, DIRECT_MESSAGE_REACTIONS in DMs. */
  const announceReaction = (
    t: GatewayDispatchEvents,
    channel: APIChannel,
    message: APIMessage,
    extra: object,
  ) => {
    const guildId = guildIdOf(channel);
    gateway.dispatch(
      t,
      {
        channel_id: channel.id,
        message_id: message.id,
        ...(guildId ? { guild_id: guildId } : {}),
        ...extra,
      },
      guildId
        ? GatewayIntentBits.GuildMessageReactions
        : GatewayIntentBits.DirectMessageReactions,
    );
  };

  // Get Reactions: users who reacted with `emoji`, ordered by id for `after`, 25 by default.
  // Without READ_MESSAGE_HISTORY, 50001 Missing Access (checked by the contract run).
  rest.route(
    "GET",
    "/channels/:channelId/messages/:messageId/reactions/:emoji",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (channel && mock.checkBotPerms(channel, Permission.ReadMessageHistory))
        return respond.missingAccess();
      const { refused, message } = target(req, Permission.ReadMessageHistory);
      if (refused) return refused;
      const after = BigInt(req.query.get("after") ?? 0);
      const limit = Math.min(100, Number(req.query.get("limit") ?? 25));
      const ids = [
        ...(state.reactors.get(`${message.id}:${req.params.emoji}`) ?? []),
      ]
        .filter((id) => BigInt(id) > after)
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      return respond.json(
        ids.slice(0, limit).map((id) => state.requireUser(id)),
      );
    }),
  );

  // Delete User Reaction: MANAGE_MESSAGES. The bot's own reaction has its @me Route.
  rest.route(
    "DELETE",
    "/channels/:channelId/messages/:messageId/reactions/:emoji/:userId",
    authed((req) => {
      if (req.params.userId === "@me") return undefined;
      const { refused, channel, message } = target(
        req,
        Permission.ManageMessages,
      );
      if (refused) return refused;
      const emoji = req.params.emoji!;
      const userId = req.params.userId!;
      if (state.removeReaction(channel.id, message.id, emoji, userId))
        announceReaction(
          GatewayDispatchEvents.MessageReactionRemove,
          channel,
          message,
          {
            user_id: userId,
            emoji: { id: null, name: emoji },
            type: 0,
            burst: false,
          },
        );
      return respond.noContent();
    }),
  );

  // Delete All Reactions for Emoji: MANAGE_MESSAGES, fires MESSAGE_REACTION_REMOVE_EMOJI. With
  // nothing to remove the mock sends no event, here and below (inferred, not checked).
  rest.route(
    "DELETE",
    "/channels/:channelId/messages/:messageId/reactions/:emoji",
    authed((req) => {
      const { refused, channel, message } = target(
        req,
        Permission.ManageMessages,
      );
      if (refused) return refused;
      const emoji = req.params.emoji!;
      if (state.clearReactions(message, emoji))
        announceReaction(
          GatewayDispatchEvents.MessageReactionRemoveEmoji,
          channel,
          message,
          { emoji: { id: null, name: emoji } },
        );
      return respond.noContent();
    }),
  );

  // Delete All Reactions: MANAGE_MESSAGES, fires MESSAGE_REACTION_REMOVE_ALL.
  rest.route(
    "DELETE",
    "/channels/:channelId/messages/:messageId/reactions",
    authed((req) => {
      const { refused, channel, message } = target(
        req,
        Permission.ManageMessages,
      );
      if (refused) return refused;
      if (state.clearReactions(message))
        announceReaction(
          GatewayDispatchEvents.MessageReactionRemoveAll,
          channel,
          message,
          {},
        );
      return respond.noContent();
    }),
  );
}
