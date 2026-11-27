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
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

it("shows a guild's onboarding as switched off", async () => {
  // Arrange
  const guild = mock.createGuild("g");
  await login();

  // Act
  const onboarding = await client.guilds.cache.get(guild.id)!.fetchOnboarding();

  // Assert
  expect([onboarding.enabled, onboarding.prompts.size]).toEqual([false, 0]);
});

it("refuses the settings a bot without Manage Server can't read or change", async () => {
  // Arrange
  const guild = mock.createGuild("g");
  await login();
  const cached = client.guilds.cache.get(guild.id)!;

  // Act
  const reads = [
    cached.fetchWelcomeScreen(),
    cached.fetchVanityData(),
    cached.fetchIntegrations(),
    cached.editWelcomeScreen({ description: "hi" }),
    cached.editOnboarding({ enabled: false }),
    client.rest.patch(Routes.guildMemberVerification(guild.id), {
      body: { enabled: false },
    }),
    client.guilds.setIncidentActions(guild.id, { invitesDisabledUntil: null }),
  ];

  // Assert
  await expect(reads[0]).rejects.toMatchObject({ code: 10069 });
  for (const refused of reads.slice(1))
    await expect(refused).rejects.toMatchObject({ code: 50013 });
});

it("answers member verification, a missing integration and a disabled widget image as Discord does", async () => {
  // Arrange
  const guild = mock.createGuild("g");
  await login();

  // Act
  const verification = client.rest.get(
    Routes.guildMemberVerification(guild.id),
  );
  const integration = client.rest.delete(
    Routes.guildIntegration(guild.id, "1"),
  );
  const image = client.rest.get(Routes.guildWidgetImage(guild.id));

  // Assert
  await expect(verification).rejects.toMatchObject({
    status: 403,
    code: 10004,
  });
  await expect(integration).rejects.toMatchObject({ code: 10005 });
  await expect(image).rejects.toMatchObject({ status: 404, code: 10004 });
});
