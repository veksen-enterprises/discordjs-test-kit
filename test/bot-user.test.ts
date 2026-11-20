import { once } from "node:events";
import { Client, Events, GatewayIntentBits, Routes } from "discord.js";
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
  mock.createGuild("g");
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

// A 1x1 PNG, as discord.js sends an image: a data URI.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

it("renames the bot and hears its own user update", async () => {
  // Arrange
  await login();
  const updated = once(client, Events.UserUpdate);

  // Act
  await client.user!.setUsername("Ladder Bot");

  // Assert
  const [, after] = await updated;
  expect(after.username).toBe("Ladder Bot");
});

it("sets the bot's avatar from image data", async () => {
  // Arrange
  await login();

  // Act
  const user = await client.user!.setAvatar(PNG);

  // Assert
  expect(user.avatar).toMatch(/^[0-9a-f]{32}$/);
});

it("sets the bot's avatar from a file, which discord.js sends as image/jpg", async () => {
  // Arrange
  await login();

  // Act
  const user = await client.user!.setAvatar(
    Buffer.from(PNG.split(",")[1]!, "base64"),
  );

  // Assert
  expect(user.avatar).toMatch(/^[0-9a-f]{32}$/);
});

it("refuses a one-letter username", async () => {
  // Arrange
  await login();

  // Act
  const renamed = client.user!.setUsername("x");

  // Assert
  await expect(renamed).rejects.toMatchObject({ code: 50035 });
});

it("answers the gateway url without authentication", async () => {
  // Arrange
  await login();

  // Act
  const gateway = (await client.rest.get(Routes.gateway(), {
    auth: false,
  })) as { url: string };

  // Assert
  expect(gateway.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+/);
});
