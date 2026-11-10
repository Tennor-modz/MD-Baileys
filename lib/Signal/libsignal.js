"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeLibSignalRepository = makeLibSignalRepository;
const libsignal = __importStar(require("libsignal"));
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const sender_key_name_1 = require("./Group/sender-key-name");
const sender_key_record_1 = require("./Group/sender-key-record");
const Group_1 = require("./Group");

/**
 * FIX 1: Identity key extraction from PreKeyWhisperMessage.
 * Allows detecting identity changes BEFORE decryption, preventing Bad MAC errors
 * caused by stale sessions with a contact who has re-registered or changed devices.
 */
function extractIdentityFromPkmsg(ciphertext) {
    try {
        if (!ciphertext || ciphertext.length < 2) return undefined;
        // Version byte check (must be version 3)
        const version = ciphertext[0];
        if ((version & 0xf) !== 3) return undefined;
        // Minimal protobuf parse to extract identityKey field (tag 4, wire type 2)
        const data = ciphertext.slice(1);
        let i = 0;
        while (i < data.length) {
            const tag = data[i] >> 3;
            const wireType = data[i] & 0x7;
            i++;
            if (wireType === 2) {
                // length-delimited
                let len = 0, shift = 0;
                while (i < data.length) {
                    const b = data[i++];
                    len |= (b & 0x7f) << shift;
                    if (!(b & 0x80)) break;
                    shift += 7;
                }
                if (tag === 4 && len === 33) {
                    // identityKey field
                    return new Uint8Array(data.slice(i, i + len));
                }
                i += len;
            } else if (wireType === 0) {
                // varint - skip
                while (i < data.length && (data[i++] & 0x80));
            } else if (wireType === 5) {
                i += 4;
            } else if (wireType === 1) {
                i += 8;
            } else {
                break;
            }
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function makeLibSignalRepository(auth, logger) {
    const storage = signalStorage(auth, logger);
    const transaction = auth.keys.transaction
        ? (key, work) => auth.keys.transaction(work, key)
        : (_key, work) => work();

    return {
        decryptGroupMessage({ group, authorJid, msg }) {
            const senderName = jidToSignalSenderKeyName(group, authorJid);
            const cipher = new Group_1.GroupCipher(storage, senderName);
            return cipher.decrypt(msg);
        },

        async processSenderKeyDistributionMessage({ item, authorJid }) {
            const builder = new Group_1.GroupSessionBuilder(storage);
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message');
            }
            const senderName = jidToSignalSenderKeyName(item.groupId, authorJid);
            const senderMsg = new Group_1.SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage);
            const senderNameStr = senderName.toString();
            const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
            if (!senderKey) {
                await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord());
            }
            await builder.process(senderName, senderMsg);
        },

        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToSignalProtocolAddress(jid);
            const session = new libsignal.SessionCipher(storage, addr);

            /**
             * FIX 2: Identity key change detection before decryption.
             * When we receive a pkmsg (PreKey message = new session establishment),
             * extract and save the sender's identity key FIRST.
             * If the identity changed (re-registered number), clear old session.
             * This prevents Bad MAC errors from trying to decrypt with stale keys.
             */
            if (type === 'pkmsg') {
                const identityKey = extractIdentityFromPkmsg(ciphertext);
                if (identityKey) {
                    const addrStr = addr.toString();
                    const identityChanged = await storage.saveIdentity(addrStr, identityKey);
                    if (identityChanged && logger) {
                        logger.info({ jid, addr: addrStr }, 'identity key changed, session will be re-established');
                    }
                }
            }

            return transaction(jid, async () => {
                let result;
                switch (type) {
                    case 'pkmsg':
                        result = await session.decryptPreKeyWhisperMessage(ciphertext);
                        break;
                    case 'msg':
                        result = await session.decryptWhisperMessage(ciphertext);
                        break;
                    default:
                        throw new Error(`Unknown message type: ${type}`);
                }
                return result;
            });
        },

        async encryptMessage({ jid, data }) {
            const addr = jidToSignalProtocolAddress(jid);
            const cipher = new libsignal.SessionCipher(storage, addr);
            return transaction(jid, async () => {
                const { type: sigType, body } = await cipher.encrypt(data);
                const type = sigType === 3 ? 'pkmsg' : 'msg';
                return { type, ciphertext: Buffer.from(body, 'binary') };
            });
        },

        async encryptGroupMessage({ group, meId, data }) {
            const senderName = jidToSignalSenderKeyName(group, meId);
            const builder = new Group_1.GroupSessionBuilder(storage);
            const senderNameStr = senderName.toString();
            const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
            if (!senderKey) {
                await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord());
            }
            const senderKeyDistributionMessage = await builder.create(senderName);
            const session = new Group_1.GroupCipher(storage, senderName);
            const ciphertext = await session.encrypt(data);
            return {
                ciphertext,
                senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
            };
        },

        async injectE2ESession({ jid, session }) {
            const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid));
            await cipher.initOutgoing(session);
        },

        jidToSignalProtocolAddress(jid) {
            return jidToSignalProtocolAddress(jid).toString();
        },

        /**
         * FIX 3: validateSession - check if a valid open session exists for a JID.
         * Used by the retry system to decide whether to force re-key before retrying.
         */
        async validateSession(jid) {
            try {
                const addr = jidToSignalProtocolAddress(jid);
                const sess = await storage.loadSession(addr.toString());
                if (!sess) return { exists: false, reason: 'no session' };
                if (!sess.haveOpenSession()) return { exists: false, reason: 'no open session' };
                return { exists: true };
            } catch (error) {
                return { exists: false, reason: 'validation error' };
            }
        },

        /**
         * FIX 4: deleteSession - bulk-delete sessions by JID list.
         * Used to force re-establishment of broken/corrupt sessions
         * rather than letting Bad MAC errors loop indefinitely.
         */
        async deleteSession(jids) {
            if (!jids || !jids.length) return;
            const sessionUpdates = {};
            jids.forEach(jid => {
                const addr = jidToSignalProtocolAddress(jid);
                sessionUpdates[addr.toString()] = null;
            });
            await auth.keys.set({ session: sessionUpdates });
        }
    };
}

const jidToSignalProtocolAddress = (jid) => {
    const { user, device } = (0, WABinary_1.jidDecode)(jid);
    return new libsignal.ProtocolAddress(user, device || 0);
};

const jidToSignalSenderKeyName = (group, user) => {
    return new sender_key_name_1.SenderKeyName(group, jidToSignalProtocolAddress(user));
};

function signalStorage({ creds, keys }, logger) {
    return {
        loadSession: async (id) => {
            try {
                const { [id]: sess } = await keys.get('session', [id]);
                if (sess) {
                    return libsignal.SessionRecord.deserialize(sess);
                }
            } catch (e) {
                if (logger) logger.warn({ id, err: e }, 'failed to load session, returning null');
                return null;
            }
            return null;
        },

        storeSession: async (id, session) => {
            await keys.set({ session: { [id]: session.serialize() } });
        },

        isTrustedIdentity: () => {
            return true; // TOFU - Trust on First Use
        },

        /**
         * FIX 5: loadIdentityKey - expose identity key loading.
         * Required for identity change detection in saveIdentity.
         */
        loadIdentityKey: async (id) => {
            const { [id]: key } = await keys.get('identity-key', [id]);
            return key || undefined;
        },

        /**
         * FIX 6: saveIdentity - detect identity key changes.
         * When a contact re-registers their number, their identity key changes.
         * Old sessions using the previous key will produce Bad MAC on every message.
         * This clears the stale session and saves the new key so re-keying happens.
         */
        saveIdentity: async (id, identityKey) => {
            const { [id]: existingKey } = await keys.get('identity-key', [id]);
            const keysMatch = existingKey &&
                existingKey.length === identityKey.length &&
                existingKey.every((byte, i) => byte === identityKey[i]);
            if (existingKey && !keysMatch) {
                // Identity changed — clear stale session, save new key
                if (logger) logger.info({ id }, 'identity key changed, clearing stale session');
                await keys.set({
                    session: { [id]: null },
                    'identity-key': { [id]: identityKey }
                });
                return true;
            }
            if (!existingKey) {
                // New contact — TOFU
                await keys.set({ 'identity-key': { [id]: identityKey } });
                return true;
            }
            return false;
        },

        loadPreKey: async (id) => {
            const keyId = id.toString();
            const { [keyId]: key } = await keys.get('pre-key', [keyId]);
            if (key) {
                return {
                    privKey: Buffer.from(key.private),
                    pubKey: Buffer.from(key.public)
                };
            }
        },

        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),

        loadSignedPreKey: () => {
            const key = creds.signedPreKey;
            return {
                privKey: Buffer.from(key.keyPair.private),
                pubKey: Buffer.from(key.keyPair.public)
            };
        },

        loadSenderKey: async (senderKeyName) => {
            const keyId = senderKeyName.toString();
            const { [keyId]: key } = await keys.get('sender-key', [keyId]);
            if (key) {
                return sender_key_record_1.SenderKeyRecord.deserialize(key);
            }
            return new sender_key_record_1.SenderKeyRecord();
        },

        storeSenderKey: async (senderKeyName, key) => {
            const keyId = senderKeyName.toString();
            const serialized = JSON.stringify(key.serialize());
            await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } });
        },

        getOurRegistrationId: () => creds.registrationId,

        getOurIdentity: () => {
            const { signedIdentityKey } = creds;
            return {
                privKey: Buffer.from(signedIdentityKey.private),
                pubKey: (0, Utils_1.generateSignalPubKey)(signedIdentityKey.public)
            };
        }
    };
}
