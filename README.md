# discordjs-test-kit

A fake Discord your discord.js bot logs in to, so a test runs the bot as it ships. It refuses what Discord refuses, and a request it doesn't know fails the test.

```ts
import { createDiscord } from "discordjs-test-kit";
import { expect, it } from "vitest";
import { commands, createBot } from "./bot";

it("DMs the player you challenge", async () => {
  // Arrange
  const discord = await createDiscord();
  const server = discord.guild("SIN");
  const channel = discord.textChannel(server, "challenges");
  const alice = discord.member(server, "Alice");
  const bob = discord.member(server, "Bob");
  await discord.start(createBot(discord.clientOptions), { commands });

  // Act
  const reply = await alice.runCommand(channel, "challenge", { opponent: bob });

  // Assert
  expect(reply.content).toBe("Challenge sent to Bob.");
  const dm = await discord.waitForDM(bob, "challenged you");
  expect(dm.content).toBe("Alice challenged you.");
});
```

The one change a bot needs: spread `discord.clientOptions` into its `new Client(...)`. The bot is [`examples/challenge/bot.ts`](examples/challenge/bot.ts), and this test runs as [`test/docs/readme.test.ts`](test/docs/readme.test.ts).

## Install

```sh
npm install --save-dev discordjs-test-kit
```

Needs `discord.js` 14.26.4 or later, `vitest` 4.1.2+ or 5, and Node 22, 24 or 26.

## Start with an agent

The package ships a skill for coding agents. Paste this into Claude Code, or any coding agent, at the root of your bot's repo:

```text
Add tests for this discord.js bot with discordjs-test-kit.
1. Install it: npm install --save-dev discordjs-test-kit vitest
2. Read node_modules/discordjs-test-kit/skills/discordjs-test-kit/SKILL.md and follow it.
3. Make the bot's Client accept client options, as the skill shows.
4. Write one test per thing a user does with the bot: each slash command, button and message
   flow, acting as members and asserting what they see.
5. Run the tests. If one fails with "unhandled requests", the kit doesn't model that Discord
   route yet: tell me which, and don't stub it. If one fails on the bot's behaviour, show me.
```

To keep the skill loaded in later sessions: `npm i -D skills-npm && npx skills-npm setup`.

## Compared with hand-rolled fakes

The same test with a hand-rolled fake, as most bots test their commands today:

```ts
import type { ChatInputCommandInteraction } from "discord.js";
import { expect, it, vi } from "vitest";
import { executeChallenge } from "./bot";

it("DMs the player you challenge", async () => {
  // Arrange
  const bob = { displayName: "Bob", send: vi.fn() };
  const interaction = {
    user: { displayName: "Alice" },
    options: { getUser: () => bob },
    reply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;

  // Act
  await executeChallenge(interaction);

  // Assert
  expect(interaction.reply).toHaveBeenCalledWith("Challenge sent to Bob.");
  expect(bob.send).toHaveBeenCalledWith("Alice challenged you.");
});
```

It calls the handler directly with a hand-built interaction, so the command is never registered or routed.

### Bugs the fakes miss

Each bug was planted in [`examples/challenge/bot.ts`](examples/challenge/bot.ts), then both tests were run. The fakes test passed every time.

| Planted bug                                      | Kit test fails with                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| The command is registered as `/challenge-player` | `/challenge isn't registered. Registered: /challenge-player`                                   |
| The option is registered as `player`             | `/challenge has no option "opponent". It has: player`                                          |
| The handler checks for `"Challenge"`, capital C  | `the bot didn't answer within 3s, so Discord shows the user "The application did not respond"` |

## Clicks and selects wait for the bot

Before a member clicks a button or picks from a select, the kit waits until the bot has been quiet for 100ms, so a bot that starts listening for the click just after replying hears it. A test that clicks 40 times spends 4 seconds waiting. If your bot does nothing between sending a message and listening for its buttons, lower the wait: `createDiscord({ quietTimeMs: 20 })`. Set it too low and a click lands before the bot listens: the test fails with "The application did not respond", though the bot works on Discord. This wait counts only time your test could run, so a busy machine that pauses the test doesn't make the kit click too early. Discord's 3-second deadline for answering an interaction stays real time, as on Discord.

If your app hasn't turned on a privileged intent in the Developer Portal, say so: `createDiscord({ privilegedIntents: [GatewayIntentBits.GuildMembers] })`. Without Message Content, the messages your bot reads, including the ones it fetches, arrive without their text, as on Discord.

## Not modelled yet

- About half of Discord's API: 112 of 228 REST routes and 54 of 79 gateway events. A request the kit doesn't model fails the test and names the route.
- Gateway compression. If `zlib-sync` is installed, discord.js asks for it and the bot reconnects in a loop until the test times out.
- Partials, and form fields other than text inputs.

## Docs

- [Every action](site/src/content/docs/reference/actions.md) a test can take, with what it returns
- [Discord rules the kit enforces](site/src/content/docs/reference/discord-rules.md), by area
- [Discord failing](site/src/content/docs/recipes/discord-failing.mdx): 5xx, rate limits, lost sessions
- [Testing guide](skills/discordjs-test-kit/SKILL.md): the skill agents read
