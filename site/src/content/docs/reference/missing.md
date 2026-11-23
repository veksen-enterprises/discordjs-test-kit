---
title: What's missing
description: The parts of Discord's API the kit doesn't cover yet.
---

At 0.6.0 the kit's tests reach 165 of the 213 REST routes a bot can call, and 64 of the 79 gateway events. If your bot calls a route the kit doesn't model, the test fails and names the route.

Only calls a test makes through discord.js count. A route the kit answers but no test calls is listed here as missing. Another 15 routes need a user or OAuth2 token, which a bot doesn't have, so they're left out of the 213.

## By area

- **Paid apps.** Entitlements, SKUs, subscriptions and their events.
- **Server integrations** such as Twitch and YouTube, and their events.
- **Community servers.** Onboarding, the welcome screen, membership screening, the vanity URL, and pausing invites or DMs during a raid.
- **Lists Discord fills in.** Voice regions, sticker packs and the default soundboard sounds. The kit would have to make up their contents.
- **Linked roles and app identities.** Role connection metadata, application identities, activity instances.
- **Permission lookups** for a member or role, in a server or a channel.
- **Also:** group DM members, message search, the widget image, voice channel status, invite target users, and adding a member with their OAuth2 token.
- discord.js partials.

## Every route and event

Each `:` stands for an id or a token.

### REST routes (48)

- `DELETE /applications/:/entitlements/:`
- `DELETE /channels/:/recipients/:`
- `DELETE /guilds/:/integrations/:`
- `GET /applications/:/activity-instances/:`
- `GET /applications/:/application-identities/:/:`
- `GET /applications/:/entitlements`
- `GET /applications/:/entitlements/:`
- `GET /applications/:/role-connections/metadata`
- `GET /applications/:/skus`
- `GET /applications/:/users/:/identities/:/profile`
- `GET /channels/:/permissions/member/:`
- `GET /channels/:/permissions/role/:`
- `GET /guilds/:/integrations`
- `GET /guilds/:/member-verification`
- `GET /guilds/:/messages/search`
- `GET /guilds/:/onboarding`
- `GET /guilds/:/permissions/member/:`
- `GET /guilds/:/permissions/role/:`
- `GET /guilds/:/regions`
- `GET /guilds/:/vanity-url`
- `GET /guilds/:/welcome-screen`
- `GET /guilds/:/widget.png`
- `GET /invites/:/target-users`
- `GET /invites/:/target-users/job-status`
- `GET /oauth2/applications/@me`
- `GET /skus/:/subscriptions`
- `GET /skus/:/subscriptions/:`
- `GET /soundboard-default-sounds`
- `GET /sticker-packs`
- `GET /sticker-packs/:`
- `GET /users/:/application-identities/:`
- `GET /voice/regions`
- `PATCH /applications/:/users/:/identities/:/profile`
- `PATCH /guilds/:/member-verification`
- `PATCH /guilds/:/members/@me/nick`
- `PATCH /guilds/:/welcome-screen`
- `POST /applications/:/entitlements`
- `POST /applications/:/entitlements/:/consume`
- `POST /users/:/application-identities/:/:/:/delete`
- `POST /webhooks/:/:/github`
- `POST /webhooks/:/:/slack`
- `PUT /applications/:/role-connections/metadata`
- `PUT /channels/:/recipients/:`
- `PUT /channels/:/voice-status`
- `PUT /guilds/:/incident-actions`
- `PUT /guilds/:/members/:`
- `PUT /guilds/:/onboarding`
- `PUT /invites/:/target-users`

### Gateway events (15)

- `CHANNEL_INFO`
- `ENTITLEMENT_CREATE`
- `ENTITLEMENT_DELETE`
- `ENTITLEMENT_UPDATE`
- `GUILD_INTEGRATIONS_UPDATE`
- `GUILD_SOUNDBOARD_SOUNDS_UPDATE`
- `INTEGRATION_CREATE`
- `INTEGRATION_DELETE`
- `INTEGRATION_UPDATE`
- `RATE_LIMITED`
- `SUBSCRIPTION_CREATE`
- `SUBSCRIPTION_DELETE`
- `SUBSCRIPTION_UPDATE`
- `VOICE_CHANNEL_START_TIME_UPDATE`
- `VOICE_CHANNEL_STATUS_UPDATE`
