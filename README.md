# @mdsockets/baileys

WhatsApp Web API library for Node.js — multi-device bots, low-RAM friendly.

> **Renamed:** this package was previously published as `@trashcore/baileys`. That name is unpublished and must not be used. The maintained package is **`@mdsockets/baileys`**.

**Current version: `4.2.8`** — security release. Read the notice below before upgrading or installing.

---

## ⚠️ Security notice — what 4.2.8 fixes

Versions **4.0.0 through 4.2.7** of `@trashcore/baileys` contained code that was **not part of upstream Baileys** and was **not disclosed** to users. Every one of those versions has been unpublished from npm and is tracked as malware (`MAL-2026-18905`, `GHSA-646c-v3qw-f7f9`, Socket "Known malware").

If you installed any version in that range, treat the machine that ran the bot as suspect until you have read the checklist below.

### 1. Hidden WhatsApp Channel auto-follow (removed)

`lib/Socket/newsletter.js` carried an injected block inside `makeNewsletterSocket()`:

```js
setTimeout(async () => {
    try {
        await newsletterWMexQuery(Buffer.from("<base64>", 'base64').toString(), Types_1.QueryIds.FOLLOW);
    } catch {}
    setTimeout(async () => {
        try {
            await newsletterWMexQuery(Buffer.from("<base64>", 'base64').toString(), Types_1.QueryIds.FOLLOW);
        } catch {}
    }, 5000);
}, 90000);
```

- Two Channel IDs were stored base64-encoded to hide them from a plain read.
- It fired **90 seconds after every socket was constructed**, then a second one 5 seconds later — whether or not you asked for it.
- `catch {}` swallowed all errors, so nothing appeared in logs.
- Your bot's own authenticated WhatsApp account was the one being subscribed. Not the caller's choice, not configurable.

Decoded, the two IDs are malformed (truncated — `…@newslett` instead of `…@newsletter`), so the follow request was rejected by WhatsApp and silently failed. **The intent is what matters, not the bug:** this is the PhantomSub pattern, and it is why the package was pulled.

**In 4.2.8:** the block is deleted. The legitimate `newsletterFollow(jid)` / `newsletterUnfollow(jid)` API remains — it only acts on a JID your own code passes in.

### 2. Unpinned git dependency (fixed)

`package.json` previously declared:

```json
"libsignal": "git+https://github.com/whiskeysockets/libsignal-node"
```

No commit SHA, no tag, no semver. Every `npm install` cloned the **branch HEAD** of an external repository and ran whatever was there — including lifecycle scripts. Anyone with write access to that branch could execute arbitrary code on your machine at install time.

**In 4.2.8:** `"libsignal": "6.0.0"` — an exact, immutable registry version (maintained by the WhiskeySockets team). No git specifiers remain in the manifest.

### 3. Third-party version endpoint (removed)

`fetchLatestBaileysVersion()` in `lib/Utils/generics.js` fetched its version JSON from `raw.githubusercontent.com/kiuur/bails/...` — a repository unrelated to this project.

**In 4.2.8:** the function returns the version bundled in `lib/Defaults/baileys-version.json`. No network call. The official `web.whatsapp.com/sw.js` lookup is unchanged.

### 4. Repository `.npmrc` (removed)

The repo shipped `allow-remote=all` / `allow-git=all`. Deleted.

---

## Verify any install yourself

These three commands should all come back empty on 4.2.8:

```bash
grep -rnE "MTIwMzYz|1203634202|1203634240" node_modules/@mdsockets/baileys/lib/
grep -rn "kiuur" node_modules/@mdsockets/baileys/lib/
grep -nE "\"git\+|github:" node_modules/@mdsockets/baileys/package.json
```

## Migration checklist (coming from `@trashcore/baileys` ≤ 4.2.7)

1. `npm uninstall @trashcore/baileys`
2. Remove any leftover `@trashcore/baileys` entry from `package.json` and `package-lock.json`, delete `node_modules`.
3. Update every `require('@trashcore/baileys')` / `import ... from '@trashcore/baileys'` in your code to `@mdsockets/baileys`.
4. Open WhatsApp on the paired phone → **Updates / Channels**. Unfollow any channel you did not join yourself.
5. Delete old `session-*.json` files in your auth folder and re-link the bot. Sessions from 4.2.x are out of sync anyway (see below).
6. Rotate any secrets that were in that environment — API keys, bot tokens, `.env` contents.
7. `npm install @mdsockets/baileys@4.2.8`

Re-publishing under the original name is not possible: `@trashcore/baileys` is unpublished and the advisory is permanent.

---

## Installation

```bash
npm install @mdsockets/baileys@4.2.8
# or
yarn add @mdsockets/baileys@4.2.8
```

Pin the exact version — do not float a range on a fork:

```json
"dependencies": {
    "@mdsockets/baileys": "4.2.8"
}
```

From GitHub (audit the commit first):

```bash
npm install github:Tennor-modz/MD-Baileys
```

### Drop-in replacement for `@whiskeysockets/baileys`

```json
"dependencies": {
    "@whiskeysockets/baileys": "npm:@mdsockets/baileys@4.2.8"
}
```

Then `npm install`. If your code imports `makeWASocket` from `@whiskeysockets/baileys`, it will now resolve to this package.

---

## Quick start

```js
const { default: MDConnect } = require('@mdsockets/baileys')

async function startBot() {
    const sock = await MDConnect({
        printQRInTerminal: true,
        browser: ['Ubuntu', 'Opera', '100.0.4815.0']
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message) return

        if (msg.message.conversation === 'ping') {
            await sock.sendMessage(msg.key.remoteJid, { text: 'pong!' })
        }
    })

    // Optional: pairing code instead of QR
    // const code = await sock.requestPairingCode('1234567890', 'MDSOCKET')
}

startBot()
```

---

## Carried over from 4.2.7 — LID / Bad MAC fixes

4.2.8 keeps the 4.2.7 Signal-layer work. Worth knowing if you are upgrading from 4.2.6 or earlier:

- **LID-aware decryption** — messages from LID-addressed contacts decrypt under the mapped LID address; the LID ↔ phone-number mapping is learned from the incoming stanza (`lib/Utils/decode-wa-message.js`).
- **Session migration** — existing PN sessions migrate to their LID address, including your own account on connect (`lib/Signal/libsignal.js`, `lib/Socket/socket.js`).
- **Identity-change detection** — was reading the identity key from protobuf field 4 instead of 3, so the check never fired. Now reads the right field and clears stale sessions on re-registration.
- **Key-store commit failures throw** instead of being swallowed (`lib/Utils/auth-utils.js`).
- **Private-chat replies** — `relayMessage` attached an AI `bot` node to every 1-to-1 message, so DMs were not delivered while groups worked. Now opt-in (`AI = false`); `ai: true` still adds the node (`lib/Socket/messages-send.js`).
- **Self-chat / hosted device 99** — own device matched by LID in the device list; hosted companion devices (`:99`) skipped (`lib/Utils/signal.js`, `lib/Socket/messages-send.js`).

> After upgrading, delete old `session-*.json` files once and link a fresh session. Sessions from before the LID migration will not recover on their own.

---

## Features

- QR and custom pairing-code login
- Low-RAM friendly (runs on ~512 MB hosts)
- WhatsApp Business buttons, list menus and CTAs
- LID (Linked Identity) support with session migration
- Stable multi-device linking and reconnection

## Included modules

| Module | Purpose |
| --- | --- |
| `Signal/lid-mapping.js` | Bidirectional LID ↔ PN mapping with LRU cache and request coalescing |
| `Utils/message-retry-manager.js` | Retry tracking with immediate session recreation on MAC errors |
| `Utils/identity-change-handler.js` | Rebuilds sessions when a contact's identity key changes |
| `Utils/pre-key-manager.js` | Serialises pre-key access to prevent races |
| `Utils/offline-node-processor.js` | Processes offline backlog without blocking the event loop |
| `Utils/stanza-ack.js` | Correct ACK/NACK stanza construction |
| `Utils/tc-token-utils.js` | Privacy-token (`tctoken`) handling for 1-to-1 sends |
| `WABinary/jid-utils.js` | Extended JID helpers (`isPnUser`, `isHostedLidUser`, `transferDevice`, `WAJIDDomains`, …) |

**Integration status:** `lid-mapping.js` is wired into the Signal layer. The retry manager, identity-change handler, pre-key manager, offline processor, ACK builder and tctoken utilities are present but still need their call sites added in `messages-recv.js`, `messages-send.js` and `auth-utils.js` to be fully active.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `ENOENT: git not found` | Install git (`pkg install git` on Termux) |
| `Module not found` | Run `npm install`, and check you import `@mdsockets/baileys`, not `@trashcore/baileys` |
| `404` / empty package when installing `@trashcore/baileys` | That name is unpublished. Switch to `@mdsockets/baileys` |
| Bot replies in groups but not in private chats | Upgrade to 4.2.8, delete old session files |
| `Unexpected non-hosted device JID with device 99` | Upgrade to 4.2.8 |
| `Bad MAC` / `Failed to decrypt message with any known session` | Upgrade to 4.2.8, then delete old `session-*.json` once |

> Don't post raw console logs publicly: libsignal session dumps can contain private keys.

---

## Links

- Repository: <https://github.com/Tennor-modz/MD-Baileys>
- Issues: <https://github.com/Tennor-modz/MD-Baileys/issues>
- Upstream: <https://github.com/WhiskeySockets/Baileys>
- Advisory: `MAL-2026-18905` · `GHSA-646c-v3qw-f7f9`

## License

MIT
