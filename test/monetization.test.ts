import { once } from "node:events";
import {
  ApplicationRoleConnectionMetadataType,
  Client,
  Events,
  GatewayIntentBits,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function login() {
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

it("lists no SKUs and no entitlements, and refuses unknown ones", async () => {
  // Arrange
  await login();
  const app = client.application!;

  // Act
  const skus = await app.fetchSKUs();
  const entitlements = await app.entitlements.fetch();

  // Assert
  expect([skus.size, entitlements.size]).toEqual([0, 0]);
  await expect(
    app.entitlements.createTest({ sku: "1", guild: "2" }),
  ).rejects.toMatchObject({ status: 400, code: 10027 });
  await expect(
    app.entitlements.fetch({ entitlement: "1" }),
  ).rejects.toMatchObject({ code: 10029 });
  await expect(app.entitlements.deleteTest("1")).rejects.toMatchObject({
    code: 10029,
  });
  await expect(app.entitlements.consume("1")).rejects.toMatchObject({
    code: 10029,
  });
  await expect(
    app.subscriptions.fetch({ sku: "1", user: client.user!.id }),
  ).rejects.toMatchObject({ code: 10027 });
  await expect(
    app.subscriptions.fetch({ sku: "1", subscriptionId: "2" }),
  ).rejects.toMatchObject({ code: 10027 });
});

it("keeps the linked-role metadata the bot sets, and refuses a bad key", async () => {
  // Arrange
  await login();
  const app = client.application!;
  const record = {
    key: "matches_won",
    name: "Matches won",
    description: "Ladder matches won",
    type: ApplicationRoleConnectionMetadataType.IntegerGreaterThanOrEqual,
  };

  // Act
  await app.editRoleConnectionMetadataRecords([record]);
  const stored = await app.fetchRoleConnectionMetadataRecords();

  // Assert
  expect(stored.map((r) => r.key)).toEqual(["matches_won"]);
  await expect(
    app.editRoleConnectionMetadataRecords([{ ...record, key: "Matches Won" }]),
  ).rejects.toMatchObject({ code: 50035 });
});
