import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";

// Guild settings a bot reads or changes: the welcome screen, onboarding, the vanity invite,
// integrations, member verification, AutoMod incident actions and the widget image. Sources:
// docs.discord.food/resources/guild, /resources/integration and /resources/auto-moderation, and
// Discord's resources/guild. The World has no Community guilds, no vanity invites and no
// integrations; what Discord answers for those with Manage Server isn't known, so it's a Gap.
// Each answer without Manage Server is what contract run 45916336139 got on a guild like that.

export function registerGuildSettingsRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const unknownGuild = () => respond.error(404, 10004, "Unknown Guild");
  const guildOf = (req: RestRequest) => state.guilds.get(req.params.guildId!);
  const managesGuild = (req: RestRequest) =>
    (computePermissions(state, guildOf(req)!, state.bot.id) &
      Permission.ManageGuild) !==
    0n;
  /** Refused without Manage Server (50013), a Gap with it. */
  const needsManageGuild = (what: string) =>
    authed((req) => {
      if (!guildOf(req)) return unknownGuild();
      if (!managesGuild(req)) return respond.missingPermissions();
      return rest.gap(`${what} with Manage Server`);
    });

  // Get Guild Welcome Screen: "Requires the MANAGE_GUILD permission if the welcome screen is not
  // yet enabled". The contract run got 404 10069 without it.
  rest.route(
    "GET",
    "/guilds/:guildId/welcome-screen",
    authed((req) => {
      if (!guildOf(req)) return unknownGuild();
      if (managesGuild(req))
        return rest.gap("a welcome screen read with Manage Server");
      return respond.error(404, 10069, "Unknown Guild Welcome Screen");
    }),
  );
  rest.route(
    "PATCH",
    "/guilds/:guildId/welcome-screen",
    needsManageGuild("a welcome screen change"),
  );

  // Get Guild Onboarding: docs.discord.food says a disabled onboarding needs MANAGE_GUILD, but the
  // contract run got 200 and this object without it.
  rest.route(
    "GET",
    "/guilds/:guildId/onboarding",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild) return unknownGuild();
      return respond.json({
        guild_id: guild.id,
        prompts: [],
        default_channel_ids: [],
        enabled: false,
        mode: 0,
        below_requirements: false,
        responses: [],
        onboarding_prompts_seen: {},
        onboarding_responses_seen: {},
      });
    }),
  );
  rest.route(
    "PUT",
    "/guilds/:guildId/onboarding",
    needsManageGuild("an onboarding change"),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/vanity-url",
    needsManageGuild("a vanity invite read"),
  );
  // The bot's own integration isn't modelled, so the list is a Gap with Manage Server.
  rest.route(
    "GET",
    "/guilds/:guildId/integrations",
    needsManageGuild("an integration list"),
  );
  // The contract run got 404 10005 without Manage Server: the integration is looked up first.
  rest.route(
    "DELETE",
    "/guilds/:guildId/integrations/:integrationId",
    authed((req) =>
      guildOf(req)
        ? respond.error(404, 10005, "Unknown Integration")
        : unknownGuild(),
    ),
  );

  // Get Guild Member Verification on a guild without one: the contract run got 403 with code
  // 10004 "Unknown Guild", for a guild the bot is in.
  rest.route(
    "GET",
    "/guilds/:guildId/member-verification",
    authed((req) =>
      guildOf(req)
        ? respond.error(403, 10004, "Unknown Guild")
        : unknownGuild(),
    ),
  );
  rest.route(
    "PATCH",
    "/guilds/:guildId/member-verification",
    needsManageGuild("a member verification change"),
  );

  rest.route(
    "PUT",
    "/guilds/:guildId/incident-actions",
    needsManageGuild("an incident actions change"),
  );

  // Get Guild Widget Image: "The guild must have the widget enabled". The contract run got 404
  // 10004 with it disabled. The PNG itself isn't modelled.
  rest.route(
    "GET",
    "/guilds/:guildId/widget.png",
    authed((req) => {
      const guild = guildOf(req);
      if (!guild || !guild.widget.enabled) return unknownGuild();
      return rest.gap("a widget image");
    }),
  );
}
