import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIChannel,
  type APIUser,
} from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { Permission, computePermissions } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";

// Typing. Sources: Discord's docs, resources/channel#trigger-typing-indicator ("Returns a 204 empty
// response on success. Fires a Typing Start Gateway event"), events/gateway-events#typing-start
// (channel_id, guild_id?, user_id, timestamp in seconds, member? in a guild), events/gateway
// (GUILD_MESSAGE_TYPING, DIRECT_MESSAGE_TYPING). Neither Discord's docs nor docs.discord.food name
// a permission for the route.

/** TYPING_START for `user` in `channel`, with their member in a guild. */
export function announceTyping(
  mock: DiscordMock,
  user: APIUser,
  channel: APIChannel,
) {
  const guildId = "guild_id" in channel ? channel.guild_id : undefined;
  const member = guildId
    ? mock.state.requireGuild(guildId).members.get(user.id)
    : undefined;
  mock.gateway.dispatch(
    GatewayDispatchEvents.TypingStart,
    {
      channel_id: channel.id,
      user_id: user.id,
      timestamp: Math.floor(Date.now() / 1000),
      ...(guildId ? { guild_id: guildId } : {}),
      ...(member ? { member } : {}),
    },
    guildId
      ? GatewayIntentBits.GuildMessageTyping
      : GatewayIntentBits.DirectMessageTyping,
  );
}

export function registerTypingRoute(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  // Seeing the channel is assumed (inferred, not checked). Typing where the bot can't send
  // messages isn't documented; the contract run got 403 50001 Missing Access.
  rest.route(
    "POST",
    "/channels/:channelId/typing",
    authed((req) => {
      const channel = state.channels.get(req.params.channelId!);
      if (!channel) return respond.unknownChannel();
      const denied = mock.checkBotPerms(channel, 0n);
      if (denied) return denied;
      if (
        "guild_id" in channel &&
        channel.guild_id &&
        !(
          computePermissions(
            state,
            state.requireGuild(channel.guild_id),
            state.bot.id,
            channel,
          ) & Permission.SendMessages
        )
      )
        return respond.missingAccess();
      announceTyping(mock, state.bot, channel);
      return respond.noContent();
    }),
  );
}
