import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  RoleSelectMenuBuilder,
} from "discord.js";
import { expect, it, vi } from "vitest";
import {
  createDiscord,
  respond,
  Permission,
  type Guild,
  type Member,
} from "../src/index.js";
import { commands, createBot } from "./fixtures/bot.js";

async function startBot() {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const generalChannel = discord.textChannel(server, "general");
  const alice = discord.member(server, "alice");
  const bob = discord.member(server, "bob", { nickname: "Bobby" });
  await discord.start(createBot(discord.clientOptions).client, { commands });
  return { discord, server, generalChannel, alice, bob };
}

it("shows the bot's in-place update on the message the test already holds", async () => {
  const { generalChannel, alice } = await startBot();
  const panel = await alice.runCommand(generalChannel, "panel");

  const after = await alice.click(panel, "+1");

  expect(after).toBe(panel);
  expect(panel.content).toBe("count 1");
});

it("finds a message the bot posts after the action returns", async () => {
  const { discord, generalChannel, alice } = await startBot();

  alice.post(generalChannel, { content: "!ping" });

  expect((await discord.waitForMessage(generalChannel, "pong")).content).toBe(
    "pong",
  );
});

it("doesn't take the member's own message for the bot's", async () => {
  const { discord, generalChannel, alice } = await startBot();

  alice.post(generalChannel, { content: "!ping" });

  expect((await discord.waitForMessage(generalChannel, /p.ng/)).content).toBe(
    "pong",
  );
});

it("waits until the bot has gone quiet, so a check for exactly one reply holds", async () => {
  const { discord, generalChannel, alice } = await startBot();
  alice.post(generalChannel, { content: "!ping" });
  await discord.waitForMessage(generalChannel, "pong");
  alice.post(generalChannel, { content: "!ping" });

  await discord.waitForIdle();

  expect(discord.messages(generalChannel).map((m) => m.content)).toEqual([
    "!ping",
    "pong",
    "!ping",
    "pong",
  ]);
});

it("lets a member who holds Manage Server run an admin command, and refuses one who doesn't", async () => {
  const { discord } = await startBot();
  const server = discord.guild("mods");
  const modsChannel = discord.textChannel(server, "mods");
  const mod = discord.member(server, "mod", {
    permissions: Permission.ManageGuild,
  });
  const regular = discord.member(server, "regular");

  expect((await mod.runCommand(modsChannel, "settings")).content).toBe(
    "settings saved",
  );
  await expect(regular.runCommand(modsChannel, "settings")).rejects.toThrow(
    "can't use /settings",
  );
});

it("lets a member DM the bot and finds the answer in their DMs", async () => {
  const { discord, alice } = await startBot();

  alice.dm({ content: "!ping" });

  expect((await discord.waitForDM(alice, "pong")).content).toBe("pong");
});

it("waits for a bot that logs itself in with the test's token", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...discord.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) await interaction.reply("pong");
  });
  // As a bot does on import, from its own config.
  void client.login(discord.token);

  // Act
  await discord.start(client, {
    commands: [{ name: "ping", description: "Pings" }],
  });

  // Assert
  expect((await alice.runCommand(general, "ping")).content).toBe("pong");
});

it("refuses a bot that logged in with another token", async () => {
  // Arrange
  const discord = await createDiscord();
  const client = new Client({ intents: [], ...discord.clientOptions });
  client.token = "Bot.not.this";

  // Act
  const started = discord.start(client);

  // Assert
  await expect(started).rejects.toThrow("a token that isn't discord.token");
});

async function startRoleCheckBot() {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const moderator = discord.role(server, "moderator");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    ...discord.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild())
      return;
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const staff = member.roles.cache.some((r) => r.name === "moderator");
    await interaction.reply(staff ? "locked" : "moderators only");
  });
  await discord.start(client, {
    commands: [{ name: "lock", description: "Lock the channel" }],
  });
  return { discord, server, general, moderator };
}

it("gives a member a role by name, which the bot sees", async () => {
  // Arrange
  const { discord, server, general, moderator } = await startRoleCheckBot();
  const mod = discord.member(server, "Mod", { roles: [moderator] });
  const alice = discord.member(server, "alice");

  // Act
  const modReply = await mod.runCommand(general, "lock");
  const aliceReply = await alice.runCommand(general, "lock");

  // Assert
  expect([modReply.content, aliceReply.content]).toEqual([
    "locked",
    "moderators only",
  ]);
});

async function startTicketBot() {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...discord.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild())
      return;
    const ticket = await interaction.guild.channels.create({
      name: `ticket-${interaction.user.username}`,
    });
    await ticket.send(`Welcome ${interaction.user.username}`);
    await interaction.reply({ content: `Opened ${ticket}`, ephemeral: true });
  });
  await discord.start(client, {
    commands: [{ name: "ticket", description: "Open a ticket" }],
    permissions: Permission.ManageChannels | Permission.SendMessages,
  });
  return { discord, server, general, alice };
}

it("finds the text channel the bot creates, by name", async () => {
  // Arrange
  const { discord, server, general, alice } = await startTicketBot();
  await alice.runCommand(general, "ticket");

  // Act
  const ticket = await discord.waitForTextChannel(server, "ticket-alice");

  // Assert
  expect((await discord.waitForMessage(ticket, /Welcome/)).content).toBe(
    "Welcome alice",
  );
});

it("names the server's text channels when none matches", async () => {
  // Arrange
  const { discord, server } = await startTicketBot();

  // Act
  const ticket = discord.waitForTextChannel(server, "ticket-bob");

  // Assert
  await expect(ticket).rejects.toThrow(
    'no text channel in SIN matched "ticket-bob" within 2s. Text channels there: #general',
  );
});

async function fetchedContent(
  options: Parameters<typeof createDiscord>[0],
  post: (bot: { id: string }) => string,
) {
  const discord = await createDiscord(options);
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    ...discord.clientOptions,
  });
  await discord.start(client);
  const posted = alice.post(general, { content: post(client.user!) });
  const channel = await client.channels.fetch(general.id);
  if (!channel?.isTextBased()) throw new Error("text channel");
  return (await channel.messages.fetch(posted.id)).content;
}

it("hides message content from a fetch when the app doesn't have Message Content", async () => {
  // Act
  const content = await fetchedContent(
    { privilegedIntents: [GatewayIntentBits.GuildMembers] },
    () => "!ping",
  );

  // Assert
  expect(content).toBe("");
});

it("shows a fetched message that mentions the bot, even without Message Content", async () => {
  // Act
  const content = await fetchedContent(
    { privilegedIntents: [] },
    (bot) => `<@${bot.id}> ping`,
  );

  // Assert
  expect(content).toMatch(/ping$/);
});

it("shows message content to a fetch once the app has Message Content, whatever the bot asked for", async () => {
  // Act
  const content = await fetchedContent({}, () => "!ping");

  // Assert
  expect(content).toBe("!ping");
});

it("refuses a bot deleting a member's message in their DMs", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
    ...discord.clientOptions,
  });
  const refused = new Promise<unknown>((resolve) =>
    client.on(Events.MessageCreate, (message) => {
      if (!message.inGuild()) void message.delete().catch(resolve);
    }),
  );
  await discord.start(client);

  // Act
  alice.dm({ content: "spam" });

  // Assert
  expect(await refused).toMatchObject({ code: 50003 });
  expect(discord.dms(alice).map((m) => m.content)).toEqual(["spam"]);
});

it("lets the bot DM a member, and refuses with 50007 once they close their DMs", async () => {
  const { discord, generalChannel, alice } = await startBot();

  expect((await alice.runCommand(generalChannel, "remind")).content).toBe(
    "check your DMs",
  );
  expect(discord.dms(alice).map((m) => m.content)).toEqual(["reminder set"]);
  alice.closeDMs();
  expect((await alice.runCommand(generalChannel, "remind")).content).toBe(
    "I can't DM you",
  );
});

it("names the channel and its last messages when find gives up", async () => {
  const { discord, generalChannel, alice } = await startBot();
  alice.post(generalChannel, { content: "hello" });

  await expect(
    discord.waitForMessage(generalChannel, /goodbye/),
  ).rejects.toThrow(
    'no message in #general written since the last action matched /goodbye/ within 2s. Last 1: "hello"',
  );
});

it("quotes a message's first non-empty line when find gives up", async () => {
  const { discord, generalChannel, alice } = await startBot();
  alice.post(generalChannel, { content: "\nhello" });

  await expect(
    discord.waitForMessage(generalChannel, /goodbye/),
  ).rejects.toThrow('Last 1: "hello"');
});

it("passes a member handle as a user option, under their server nickname", async () => {
  const { generalChannel, alice, bob } = await startBot();

  const reply = await alice.runCommand(generalChannel, "whois", { user: bob });

  expect(reply.content).toBe("member Bobby");
});

it("applies a nickname change and a leave to the member", async () => {
  const { generalChannel, alice, bob } = await startBot();

  bob.setNickname("Robert");
  expect(
    (await alice.runCommand(generalChannel, "whois", { user: bob })).content,
  ).toBe("member Robert");
  bob.leaveGuild();

  await expect(
    bob.runCommand(generalChannel, "echo", { text: "hi" }),
  ).rejects.toThrow("bob isn't a member of SIN");
});

it("shows a member's new display name where they have no nickname", async () => {
  const { generalChannel, alice } = await startBot();

  alice.setDisplayName("Alicia");

  expect(
    (await alice.runCommand(generalChannel, "whois", { user: alice })).content,
  ).toBe("member Alicia");
});

it("ignores a matching message the bot wrote before the latest action", async () => {
  const { discord, generalChannel, alice } = await startBot();
  alice.post(generalChannel, { content: "!ping" });
  await discord.waitForMessage(generalChannel, "pong");

  alice.post(generalChannel, { content: "hello" });

  await expect(discord.waitForMessage(generalChannel, "pong")).rejects.toThrow(
    "no message in #general written since the last action",
  );
});

it("still gives up when the test has faked timers and Date", async () => {
  const { discord, generalChannel } = await startBot();
  vi.useFakeTimers();
  try {
    await expect(
      discord.waitForMessage(generalChannel, "never"),
    ).rejects.toThrow("It has no messages");
  } finally {
    vi.useRealTimers();
  }
});

it("refuses to let a member act in a server they aren't in, even when the types are widened", async () => {
  const { discord, alice } = await startBot();
  const elsewhere: Guild = discord.guild("elsewhere");
  const strangers = discord.textChannel(elsewhere, "strangers");
  const forum = discord.forum(elsewhere, "listings");
  const outsider: Member = alice;
  const insider = discord.member(elsewhere, "carol");
  const message = insider.post(strangers, { content: "hi" });

  expect(() => outsider.post(strangers, { content: "hi" })).toThrow(
    "alice isn't a member of elsewhere",
  );
  expect(() => outsider.react(message, "👍")).toThrow(
    "alice isn't a member of elsewhere",
  );
  expect(() =>
    outsider.postInForum(forum, { title: "wts", content: "x" }),
  ).toThrow("alice isn't a member of elsewhere");
  expect(message.reactions ?? []).toEqual([]);
});

it("runs a user command on a member and a message command on a message, from the Apps menu", async () => {
  const { generalChannel, alice, bob } = await startBot();
  const said = alice.post(generalChannel, { content: "gg" });

  const nickname = await alice.runUserCommand(
    generalChannel,
    "View Nickname",
    bob,
  );
  const quote = await bob.runMessageCommand(generalChannel, "Quote", said);

  expect(nickname.content).toBe("nickname Bobby");
  expect(quote.content).toBe("> gg");
});

it("names the registered commands of that kind when the command isn't one", async () => {
  const { generalChannel, alice, bob } = await startBot();

  await expect(
    alice.runUserCommand(generalChannel, "Quote", bob),
  ).rejects.toThrow(
    'the user command "Quote" isn\'t registered. Registered user commands: "View Nickname"',
  );
});

it("fills the form a command opens, and gets the bot's answer to it", async () => {
  const { generalChannel, alice } = await startBot();

  const thanks = await alice.runCommand(
    generalChannel,
    "feedback",
    {},
    { Topic: "ladder" },
  );

  expect(thanks.content).toBe('thanks for "ladder"');
});

it("fills the form a button opens, and sees the message the bot updated", async () => {
  const { generalChannel, alice } = await startBot();
  const sign = await alice.runCommand(generalChannel, "sign");

  const after = await alice.click(sign, "Rename", { "New text": "Closed" });

  expect(after).toBe(sign);
  expect(sign.content).toBe("Closed");
});

it("refuses a form the Discord app wouldn't submit, and says when the bot opened one", async () => {
  const { generalChannel, alice } = await startBot();

  await expect(alice.runCommand(generalChannel, "feedback")).rejects.toThrow(
    'the bot opened the form "Feedback" (fields "Topic", "Details") instead of replying',
  );
  await expect(
    alice.runCommand(generalChannel, "feedback", {}, { Details: "no topic" }),
  ).rejects.toThrow('field "Topic" of "Feedback"');
  await expect(
    alice.runCommand(generalChannel, "feedback", {}, { Topic: "x".repeat(21) }),
  ).rejects.toThrow("takes at most 20 characters");
  await expect(
    alice.runCommand(generalChannel, "feedback", {}, { Title: "x" }),
  ).rejects.toThrow('has no field "Title"');
});

it("fails one channel by its literal path, and leaves the others working", async () => {
  const { discord, generalChannel, alice } = await startBot();
  const server = discord.guild("news");
  const board = discord.textChannel(server, "board");
  const news = discord.textChannel(server, "news");
  discord.answerWith(
    "POST",
    `/channels/${board.id}/messages`,
    respond.missingPermissions(),
  );

  const failed = await alice.runCommand(generalChannel, "announce", {
    channel: board.id,
  });
  const posted = await alice.runCommand(generalChannel, "announce", {
    channel: news.id,
  });

  expect(failed.content).toBe("failed: 50013");
  expect(posted.content).toBe("posted");
});

it("shows the bot's suggestions while a member types, then runs the command with one", async () => {
  const { generalChannel, alice } = await startBot();

  const choices = await alice.typeInOption(
    generalChannel,
    "docs",
    "query",
    "Promise.al",
  );
  const reply = await alice.runCommand(generalChannel, "docs", {
    query: choices[1]!.value,
  });

  expect(choices.map((c) => c.name)).toEqual([
    "Promise.all",
    "Promise.allSettled",
  ]);
  expect(reply.content).toBe("docs for Promise.allSettled");
  await expect(
    alice.typeInOption(generalChannel, "echo", "text", "hi"),
  ).rejects.toThrow('option "text" doesn\'t have autocomplete');
});

it("stops members using the bot's commands once it's kicked", async () => {
  const { discord, server, generalChannel, alice } = await startBot();

  discord.kickBot(server);

  await expect(
    alice.runCommand(generalChannel, "echo", { text: "hi" }),
  ).rejects.toThrow("the bot isn't in SIN any more");
});

it("renames the guild as its owner, which a member without Manage Server can't", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const alice = discord.member(server, "alice");
  const { client } = createBot(discord.clientOptions);
  await discord.start(client, { commands });

  expect(() => alice.renameGuild("mine")).toThrow("without Manage Server");
  discord.owner(server).renameGuild("SIN 2");

  await vi.waitFor(() =>
    expect(client.guilds.cache.get(server.id)!.name).toBe("SIN 2"),
  );
});

it("counts a join through a member's invite, and refuses a used-up one", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "alice");
  const { client } = createBot(discord.clientOptions);
  await discord.start(client, {
    commands,
    permissions: Permission.ManageGuild,
  });
  const code = alice.createInvite(general, { maxUses: 2 });

  discord.member(server, "carol", { invite: code });

  const invites = await client.guilds.cache.get(server.id)!.invites.fetch();
  expect(invites.get(code)?.uses).toBe(1);
  const once = alice.createInvite(general, { maxUses: 1 });
  discord.member(server, "dave", { invite: once });
  expect(() => discord.member(server, "erin", { invite: once })).toThrow(
    "used up",
  );
});

it("tells the bot a member joined and left voice", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const lobby = discord.voiceChannel(server, "lobby");
  const alice = discord.member(server, "alice");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    ...discord.clientOptions,
  });
  const seen: (string | null)[] = [];
  client.on(Events.VoiceStateUpdate, (_, after) =>
    seen.push(after.channel?.name ?? null),
  );
  await discord.start(client);

  alice.joinVoice(lobby);
  alice.leaveVoice();

  await vi.waitFor(() => expect(seen).toEqual(["lobby", null]));
  expect(() => alice.leaveVoice()).toThrow("isn't in voice");
});

it("lets an admin open an admin-only command to one member", async () => {
  const { discord, server, generalChannel, alice, bob } = await startBot();
  await expect(alice.runCommand(generalChannel, "settings")).rejects.toThrow(
    "needs permissions ManageGuild",
  );

  discord.setCommandPermissions(server, "settings", [
    { target: alice, allow: true },
    { target: bob, allow: false },
  ]);

  await expect(
    alice.runCommand(generalChannel, "settings"),
  ).resolves.toBeTruthy();
  await expect(bob.runCommand(generalChannel, "settings")).rejects.toThrow(
    "an override denies them",
  );
});

it("lets a moderator kick a member, which the audit log credits to them", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const mod = discord.member(server, "mod", {
    permissions: Permission.KickMembers,
  });
  const alice = discord.member(server, "alice");
  const { client } = createBot(discord.clientOptions);
  await discord.start(client, {
    commands,
    permissions: Permission.ViewAuditLog,
  });

  expect(() => alice.kick(mod)).toThrow("Kick Members");
  mod.kick(alice, "spam");

  const log = await client.guilds.cache.get(server.id)!.fetchAuditLogs();
  expect(log.entries.first()?.executor?.username).toBe("mod");
});

it("picks roles in a role select by handle, and refuses a member there", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const general = discord.textChannel(server, "general");
  const alice = discord.member(server, "alice");
  const ranked = discord.role(server, "ranked");
  const casual = discord.role(server, "casual");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...discord.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand())
      await interaction.reply({
        components: [
          new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
            new RoleSelectMenuBuilder().setCustomId("roles").setMaxValues(2),
          ),
        ],
      });
    if (interaction.isRoleSelectMenu())
      await interaction.update({
        content: interaction.roles.map((r) => r.name).join(","),
        components: [],
      });
  });
  await discord.start(client, {
    commands: [{ name: "roles", description: "Pick your roles" }],
  });
  const menu = await alice.runCommand(general, "roles");

  await expect(alice.select(menu, alice)).rejects.toThrow(
    "no select menu that offers them",
  );
  const picked = await alice.select(menu, [ranked, casual]);

  expect(picked.content).toBe("ranked,casual");
});

it("tells a bot with the intent about a member's event, which an ordinary member can't create", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const lobby = discord.voiceChannel(server, "lobby");
  const alice = discord.member(server, "alice");
  const host = discord.member(server, "host", {
    permissions: Permission.CreateEvents,
  });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents],
    ...discord.clientOptions,
  });
  const heard: string[] = [];
  client.on(Events.GuildScheduledEventCreate, (e) => heard.push(e.name));
  await discord.start(client, { commands: [] });

  expect(() => alice.createEvent("x", "the park", new Date())).toThrow(
    "Create Events",
  );
  host.createEvent("Raid night", lobby, new Date("2026-12-01T20:00Z"));
  await discord.waitForIdle();

  expect(heard).toEqual(["Raid night"]);
});

it("tells an event bot who marks an event Interested", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const lobby = discord.voiceChannel(server, "lobby");
  const alice = discord.member(server, "alice");
  const host = discord.member(server, "host", {
    permissions: Permission.CreateEvents,
  });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents],
    partials: [Partials.User],
    ...discord.clientOptions,
  });
  const interested: string[] = [];
  client.on(Events.GuildScheduledEventUserAdd, (_, user) =>
    interested.push(user.id),
  );
  await discord.start(client, { commands: [] });
  const raid = host.createEvent("Raid", lobby, new Date("2026-12-01T20:00Z"));

  // Act
  alice.markInterested(raid);

  // Assert
  await discord.waitForIdle();
  expect(interested).toEqual([alice.id]);
});

it("tells a bot that logs expressions about a moderator's new emoji, which a member can't add", async () => {
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const alice = discord.member(server, "alice");
  const mod = discord.member(server, "mod", {
    permissions: Permission.CreateGuildExpressions,
  });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildExpressions],
    ...discord.clientOptions,
  });
  const heard: string[] = [];
  client.on(Events.GuildEmojiCreate, (e) => heard.push(e.name!));
  client.on(Events.GuildEmojiUpdate, (_, e) => heard.push(e.name!));
  await discord.start(client, { commands: [] });

  expect(() => alice.addEmoji("pog")).toThrow("Create Expressions");
  const pog = mod.addEmoji("pog");
  mod.renameExpression(pog, "poggers");
  await discord.waitForIdle();

  expect(heard).toEqual(["pog", "poggers"]);
});

it("gives the bot its invite permissions in a server built after start", async () => {
  const discord = await createDiscord();
  discord.guild("first");
  const { client } = createBot(discord.clientOptions);
  await discord.start(client, { permissions: Permission.ManageGuild });

  const later = discord.guild("later");
  await vi.waitFor(() => expect(client.guilds.cache.has(later.id)).toBe(true));

  expect(
    client.guilds.cache
      .get(later.id)!
      .members.me!.permissions.has(Permission.ManageGuild),
  ).toBe(true);
});
