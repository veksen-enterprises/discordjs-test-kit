import type { APIApplicationRoleConnectionMetadata } from "discord-api-types/v10";
import type { DiscordMock } from "./mock.js";
import { respond, type RestHandler, type RestRequest } from "./rest.js";

// SKUs, entitlements, subscriptions and linked-role metadata. Sources: Discord's resources/sku,
// resources/entitlement, resources/subscription and
// resources/application-role-connection-metadata. The World has no SKUs, so it has no
// entitlements or subscriptions either: the lists are empty and every id is unknown. Contract run
// 45916336139 got [] for both lists, 404 10029 for an unknown entitlement (get, delete and
// consume), 400 10027 for a test entitlement to an unknown SKU and 404 10027 for an unknown SKU's
// subscriptions. Another app's id answers 403 50001, as for commands (inferred, not checked).

const MAX_RECORDS = 5;
const KEY = /^[a-z0-9_]{1,50}$/;

export function registerMonetizationRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  const ownApp =
    (handler: RestHandler): RestHandler =>
    (req: RestRequest) =>
      req.params.appId === state.applicationId
        ? handler(req)
        : respond.error(403, 50001, "Missing Access");
  const unknownEntitlement = () =>
    respond.error(404, 10029, "Unknown Entitlement");

  rest.route(
    "GET",
    "/applications/:appId/skus",
    authed(ownApp(() => respond.json([]))),
  );
  rest.route(
    "GET",
    "/applications/:appId/entitlements",
    authed(ownApp(() => respond.json([]))),
  );
  rest.route(
    "POST",
    "/applications/:appId/entitlements",
    authed(ownApp(() => respond.error(400, 10027, "Unknown SKU"))),
  );
  for (const [method, path] of [
    ["GET", "/applications/:appId/entitlements/:entitlementId"],
    ["DELETE", "/applications/:appId/entitlements/:entitlementId"],
    ["POST", "/applications/:appId/entitlements/:entitlementId/consume"],
  ] as const)
    rest.route(method, path, authed(ownApp(unknownEntitlement)));
  for (const path of [
    "/skus/:skuId/subscriptions",
    "/skus/:skuId/subscriptions/:subscriptionId",
  ])
    rest.route(
      "GET",
      path,
      authed(() => respond.error(404, 10027, "Unknown SKU")),
    );

  // "An application can have a maximum of 5 metadata records"; key "a-z, 0-9, or _ characters;
  // 1-50 characters", name 1-100, description 1-200, type 1 to 8. The update "updates and returns"
  // the list. 50035 for a record outside those limits is inferred, not checked.
  rest.route(
    "GET",
    "/applications/:appId/role-connections/metadata",
    authed(ownApp(() => respond.json(state.applicationRoleConnectionMetadata))),
  );
  rest.route(
    "PUT",
    "/applications/:appId/role-connections/metadata",
    authed(
      ownApp((req) => {
        const records = req.body as APIApplicationRoleConnectionMetadata[];
        const length = (value: unknown, max: number) =>
          typeof value === "string" && value.length >= 1 && value.length <= max;
        if (
          !Array.isArray(records) ||
          records.length > MAX_RECORDS ||
          records.some(
            (r) =>
              typeof r.key !== "string" ||
              !KEY.test(r.key) ||
              !length(r.name, 100) ||
              !length(r.description, 200) ||
              !Number.isInteger(r.type) ||
              r.type < 1 ||
              r.type > 8,
          )
        )
          return respond.invalidFormBody();
        state.applicationRoleConnectionMetadata = [...records];
        return respond.json(state.applicationRoleConnectionMetadata);
      }),
    ),
  );
}
