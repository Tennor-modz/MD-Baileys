# @trashcore/baileys

[![npm](https://img.shields.io/npm/v/@trashcore/baileys?color=b6ff3c&label=npm)](https://www.npmjs.com/package/@trashcore/baileys)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)

**MD-Baileys** is a modified WhatsApp Web API library for Node.js, built for multi-device bots with extended features and stability fixes. Maintained by [Tennor-modz](https://github.com/Tennor-modz) / Trashcore.

**Current version: `4.2.7`**

---

## 🆕 What's new in 4.2.7

### Fixed: Bad MAC / "Failed to decrypt message with any known session"
Messages from LID-addressed contacts were being decrypted against the wrong Signal session, which produced endless `Bad MAC` errors. The Signal layer is now LID-aware.

- **LID-aware decryption**: messages are decrypted under the mapped LID address, and the LID ↔ phone-number mapping is learned from the incoming stanza (`lib/Utils/decode-wa-message.js`).
- **Session migration**: existing PN sessions are migrated to their LID address, including your own account's session on connect (`lib/Signal/libsignal.js`, `lib/Socket/socket.js`).
- **Identity-change detection fixed**: the identity key was being read from the wrong protobuf field (4 instead of 3), so the check never fired. It now reads the correct field and clears stale sessions when a contact re-registers.
- **Commit failures are no longer swallowed**: if the final key-store commit failed, the ratchet advanced in memory but not on disk and every later message failed. The error is now thrown (`lib/Utils/auth-utils.js`).
- **Private-chat replies fixed**: `relayMessage` attached an AI `bot` node to every 1-to-1 message by default, so DMs were not delivered while groups worked. It is now opt-in (`AI = false`); messages sent with `ai: true` still get the node (`lib/Socket/messages-send.js`).
- **Self-chat / own-device fix**: the sender's own device is now also matched by LID when building the device list, so the bot no longer tries to encrypt to itself (`lib/Utils/signal.js`, `lib/Socket/messages-send.js`).
- **Hosted device 99 crash fixed**: hosted / Cloud-API companion devices (`:99`) are now skipped when building the device list, so replies no longer fail with `Unexpected non-hosted device JID with device 99` (`lib/Utils/signal.js`).
- **Dependency**: `libsignal` updated from `libsignal-node@^2.0.1` to `^6.0.0`.

> ⚠️ **After upgrading from an older version**, delete the old `session-*.json` files in your auth folder once (or link a fresh session). Existing sessions are already out of sync and will not recover on their own.

---

## 📦 Installation

```bash
npm install @trashcore/baileys
# or
yarn add @trashcore/baileys
```

Pin the exact version:

```json
"dependencies": {
  "@trashcore/baileys": "^4.2.7"
}
```

Install the latest dev build straight from GitHub (may be unstable):

```bash
npm install github:Tennor-modz/MD-Baileys
```

### Drop-in replacement for `@whiskeysockets/baileys`

Keep your existing imports and alias the package in `package.json`:

```json
"dependencies": {
  "@whiskeysockets/baileys": "npm:@trashcore/baileys@latest"
}
```

Then run `npm install`.

---

## ⚡ Quick start

```js
const { default: TrashcoreConnect } = require('@trashcore/baileys')

async function startBot() {
  const trashcore = await TrashcoreConnect({
    printQRInTerminal: true,
    browser: ['Ubuntu', 'Opera', '100.0.4815.0']
  })

  trashcore.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    if (msg.message.conversation === 'ping') {
      await trashcore.sendMessage(msg.key.remoteJid, { text: 'pong!' })
    }
  })

  // Optional: pairing code instead of QR
  // const code = await trashcore.requestPairingCode('1234567890', 'TRASHBOT')
}

startBot()
```

---

## ✨ Features

- QR and custom pairing-code login
- Low-RAM friendly (runs on ~512 MB hosts)
- WhatsApp Business buttons, list menus and CTAs
- LID (Linked Identity) support with session migration
- Stable multi-device linking and reconnection

---

## 🧩 Included modules

Ported from upstream Baileys v7 and shipped in `lib/`:

| Module | Purpose |
|---|---|
| `Signal/lid-mapping.js` | Bidirectional LID ↔ PN mapping with LRU cache and request coalescing |
| `Utils/message-retry-manager.js` | Retry tracking with immediate session recreation on MAC errors |
| `Utils/identity-change-handler.js` | Rebuilds sessions when a contact's identity key changes |
| `Utils/pre-key-manager.js` | Serialises pre-key access to prevent races |
| `Utils/offline-node-processor.js` | Processes offline backlog without blocking the event loop |
| `Utils/stanza-ack.js` | Correct ACK/NACK stanza construction |
| `Utils/tc-token-utils.js` | Privacy-token (`tctoken`) handling for 1-to-1 sends |
| `WABinary/jid-utils.js` | Extended JID helpers (`isPnUser`, `isHostedLidUser`, `transferDevice`, `WAJIDDomains`, …) |

> **Integration status:** `lid-mapping.js` is wired into the Signal layer as of 4.2.7. The retry manager, identity-change handler, pre-key manager, offline processor, ACK builder and tctoken utilities are present but still need their call sites added in `messages-recv.js`, `messages-send.js` and `auth-utils.js` to be fully active.

---

## 🛠 Troubleshooting

| Problem | Fix |
|---|---|
| `ENOENT: git not found` | Install git (`pkg install git` on Termux) |
| `Module not found` | Run `npm install` |
| Bot replies in groups but not in private chats | Update to 4.2.7 |
| `Unexpected non-hosted device JID with device 99` | Update to 4.2.7 (hosted devices are now skipped) |
| `Bad MAC` / `Failed to decrypt message with any known session` | Update to 4.2.7, then delete old `session-*.json` files once |

> Don't post raw console logs publicly: libsignal session dumps can contain private keys.

---

## 🔗 Links

- Repository: https://github.com/Tennor-modz/MD-Baileys
- Issues: https://github.com/Tennor-modz/MD-Baileys/issues
- Upstream: https://github.com/WhiskeySockets/Baileys

## License

MIT
