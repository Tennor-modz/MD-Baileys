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
        if (mod != null) for (var i = 0, k = ownKeys(mod); i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
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

/**
 * FIX 7: "Bad MAC" / "no session" classification.
 * A MAC failure means the stored ratchet no longer matches the sender's, and
 * libsignal will never advance past it. The record has to be dropped so the next
 * retry receipt (which carries <keys>) or pkmsg can establish a clean session.
 */
function isStaleSessionError(error) {
    const msg = String((error && (error.message || error)) || '');
    return msg.includes('Bad MAC')
        || msg.includes('No matching sessions found')
        || msg.includes('No sessions available');
}

/**
 * FIX 8: session key variants.
 * Upstream Baileys stores addresses as `user_<domainType>` (LID chats become
 * `1234_1.0`), this fork always stored plain `user`. Lookups fall back across both
 * spellings so records written by either convention are found instead of silently
 * desyncing, and writes go back to the spelling that was actually loaded.
 */
const splitAddress = (id) => {
    const dot = id.lastIndexOf('.');
    if (dot === -1) return { user: id, device: '0' };
    return { user: id.slice(0, dot), device: id.slice(dot + 1) };
};
const sessionKeyVariants = (id) => {
    const { user, device } = splitAddress(id);
    const bare = user.replace(/_\d+$/, '');
    const out = [id];
    for (const domain of [1, 2, 3]) {
        const key = `${bare}_${domain}.${device}`;
        if (!out.includes(key)) out.push(key);
    }
    const plain = `${bare}.${device}`;
    if (!out.includes(plain)) out.push(plain);
    return out;
};

function makeLibSignalRepository(auth, logger) {
    const storage = signalStorage(auth, logger);
    const keys = auth && auth.keys;

    /**
     * FIX 9: run Signal work inside a per-JID transaction.
     * Upstream wraps decrypt/encrypt in keys.transaction(work, jid); this fork called
     * the ciphers bare, so two updates to the same peer's SessionRecord could commit
     * out of order and leave the ratchet behind the sender's.
     */
    const withTransaction = async (jid, work) => {
        if (!keys || typeof keys.transaction !== 'function') {
            return work();
        }
        return keys.transaction(work, jid);
    };

    /** drop a session record that can never decrypt again (throttled per address) */
    const recentPurges = new Map();
    const dropStaleSession = async (jid, addr) => {
        if (!keys || typeof keys.set !== 'function') return;
        const address = addr.toString();
        const now = Date.now();
        const last = recentPurges.get(address) || 0;
        if (now - last < 30 * 1000) return;
        recentPurges.set(address, now);
        try {
            await keys.set({ session: { [address]: null } });
            if (logger) logger.info({ jid, address }, 'dropped stale signal session after MAC failure, peer will re-key on retry');
        } catch (error) {
            if (logger) logger.warn({ jid, address, error }, 'failed to drop stale signal session');
        }
    };

    return {
        decryptGroupMessage({ group, authorJid, msg }) {
            const senderName = jidToSignalSenderKeyName(group, authorJid);
            return withTransaction(group, async () => {
                const cipher = new Group_1.GroupCipher(storage, senderName);
                return cipher.decrypt(msg);
            });
        },

        async processSenderKeyDistributionMessage({ item, authorJid }) {
            const builder = new Group_1.GroupSessionBuilder(storage);
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message');
            }
            const senderName = jidToSignalSenderKeyName(item.groupId, authorJid);
            const senderMsg = new Group_1.SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage);
            await withTransaction(item.groupId, async () => {
                const senderNameStr = senderName.toString();
                const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
                if (!senderKey) {
                    await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord());
                }
                await builder.process(senderName, senderMsg);
            });
        },

        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToSignalProtocolAddress(jid);

            try {
                return await withTransaction(jid, async () => {
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

                    switch (type) {
                        case 'pkmsg':
                            return await session.decryptPreKeyWhisperMessage(ciphertext);
                        case 'msg':
                            return await session.decryptWhisperMessage(ciphertext);
                        default:
                            throw new Error(`Unknown message type: ${type}`);
                    }
                });
            }
            catch (error) {
                // Committed outside the failed transaction on purpose: the purge has to
                // survive the throw, otherwise the next retry hits the same record again.
                if (isStaleSessionError(error)) {
                    await dropStaleSession(jid, addr);
                }
                throw error;
            }
        },

        async encryptMessage({ jid, data }) {
            const addr = jidToSignalProtocolAddress(jid);
            return withTransaction(jid, async () => {
                const cipher = new libsignal.SessionCipher(storage, addr);
                const { type: sigType, body } = await cipher.encrypt(data);
                const type = sigType === 3 ? 'pkmsg' : 'msg';
                return { type, ciphertext: Buffer.from(body, 'binary') };
            });
        },

        async encryptGroupMessage({ group, meId, data }) {
            const senderName = jidToSignalSenderKeyName(group, meId);
            return withTransaction(group, async () => {
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
            });
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
    // address -> key spelling that was actually found on disk
    const resolvedSessionKeys = new Map();

    const loadSessionKey = async (id) => {
        for (const candidate of sessionKeyVariants(id)) {
            try {
                const { [candidate]: sess } = await keys.get('session', [candidate]);
                if (sess) {
                    resolvedSessionKeys.set(id, candidate);
                    return { key: candidate, value: sess };
                }
            } catch (error) {
                if (logger) logger.warn({ id: candidate, err: error }, 'failed to load session, trying next variant');
            }
        }
        return null;
    };

    return {
        loadSession: async (id) => {
            try {
                const found = await loadSessionKey(id);
                if (found) {
                    return libsignal.SessionRecord.deserialize(found.value);
                }
            } catch (e) {
                if (logger) logger.warn({ id, err: e }, 'failed to load session, returning null');
                return null;
            }
            return null;
        },

        storeSession: async (id, session) => {
            const key = resolvedSessionKeys.get(id) || id;
            await keys.set({ session: { [key]: session.serialize() } });
        },

        isTrustedIdentity: () => {
            return true; // TOFU - Trust on First Use
        },

        /**
         * FIX 5: loadIdentityKey - expose identity key loading.
         * Required for identity change detection in saveIdentity.
         */
        loadIdentityKey: async (id) => {
            for (const key of sessionKeyVariants(id)) {
                const { [key]: value } = await keys.get('identity-key', [key]);
                if (value) return value;
            }
            return undefined;
        },

        /**
         * FIX 6: saveIdentity - detect identity key changes.
         * When a contact re-registers their number, their identity key changes.
         * Old sessions using the previous key will produce Bad MAC on every message.
         * This clears the stale session and saves the new key so re-keying happens.
         */
        saveIdentity: async (id, identityKey) => {
            const existingKey = await (async () => {
                for (const key of sessionKeyVariants(id)) {
                    const { [key]: value } = await keys.get('identity-key', [key]);
                    if (value) return value;
                }
                return undefined;
            })();
            const keysMatch = existingKey &&
                existingKey.length === identityKey.length &&
                Array.prototype.every.call(existingKey, (byte, i) => byte === identityKey[i]);
            const key = resolvedSessionKeys.get(id) || id;
            if (existingKey && !keysMatch) {
                // Identity changed — clear stale session, save new key
                if (logger) logger.info({ id }, 'identity key changed, clearing stale session');
                const sessionUpdates = {};
                for (const variant of sessionKeyVariants(id)) {
                    sessionUpdates[variant] = null;
                }
                await keys.set({
                    session: sessionUpdates,
                    'identity-key': { [key]: identityKey }
                });
                return true;
            }
            if (!existingKey) {
                // New contact — TOFU
                await keys.set({ 'identity-key': { [key]: identityKey } });
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
