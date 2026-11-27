import { once } from "node:events";
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
  Routes,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";

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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
}

const permissionsOf = async (route: `/${string}`) =>
  new PermissionsBitField(
    BigInt(
      ((await client.rest.get(route)) as { permissions: string }).permissions,
    ),
  );

it("answers a member's and a role's permissions as discord.js computes them", async () => {
  // Arrange
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  const helpers = mock.createRole(guild, "helpers", Permission.ManageMessages, [
    alice,
  ]);
  mock.setOverwrite(
    general,
    { id: helpers.id, type: 0 },
    { deny: Permission.AddReactions },
  );
  await login();
  const cached = client.guilds.cache.get(guild.id)!;
  const member = await cached.members.fetch(alice.id);
  const channel = cached.channels.cache.get(general.id)!;

  // Act
  const inGuild = await permissionsOf(
    Routes.guildPermissionsMember(guild.id, alice.id),
  );
  const inChannel = await permissionsOf(
    Routes.channelPermissionsMember(general.id, alice.id),
  );
  const roleInChannel = await permissionsOf(
    Routes.channelPermissionsRole(general.id, helpers.id),
  );

  // Assert
  expect(inGuild.bitfield).toBe(member.permissions.bitfield);
  expect(inChannel.bitfield).toBe(channel.permissionsFor(member)!.bitfield);
  expect(roleInChannel.has(Permission.ManageMessages)).toBe(true);
  expect(roleInChannel.has(Permission.AddReactions)).toBe(false);
});

it("masks what a member can't use without View Channel or Send Messages, unless asked not to", async () => {
  // Arrange
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  mock.setOverwrite(
    general,
    { id: alice.id, type: 1 },
    { allow: Permission.AttachFiles, deny: Permission.SendMessages },
  );
  await login();
  const route = Routes.channelPermissionsMember(general.id, alice.id);

  // Act
  const masked = await permissionsOf(route);
  const unmasked = new PermissionsBitField(
    BigInt(
      (
        (await client.rest.get(route, {
          query: new URLSearchParams({ implicit: "false" }),
        })) as { permissions: string }
      ).permissions,
    ),
  );

  // Assert
  expect(masked.has(Permission.ViewChannel)).toBe(true);
  expect(masked.has(Permission.AttachFiles)).toBe(false);
  expect(unmasked.has(Permission.AttachFiles)).toBe(true);
});

it("refuses an unknown user with 10013 and an unknown role with 10011", async () => {
  // Arrange
  const guild = mock.createGuild("g");
  await login();

  // Act
  const user = client.rest.get(Routes.guildPermissionsMember(guild.id, "1"));
  const role = client.rest.get(Routes.guildPermissionsRole(guild.id, "1"));

  // Assert
  await expect(user).rejects.toMatchObject({ code: 10013 });
  await expect(role).rejects.toMatchObject({ code: 10011 });
});
