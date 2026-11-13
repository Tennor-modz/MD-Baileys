"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decryptMessageNode = exports.decodeMessageNode = exports.MISSING_KEYS_ERROR_TEXT = exports.NO_MESSAGE_FOUND_ERROR_TEXT = void 0;
const boom_1 = require("@hapi/boom");
const WAProto_1 = require("../../WAProto");
const WABinary_1 = require("../WABinary");
const generics_1 = require("./generics");


// ---- LID-aware decryption (ported from junexbaileys) ----
const getDecryptionJid = async (sender, repository) => {
    if ((0, WABinary_1.isLidUser)(sender) || (0, WABinary_1.isHostedLidUser)(sender)) {
        return sender;
    }
    const mapped = repository.lidMapping ? await repository.lidMapping.getLIDForPN(sender) : null;
    return mapped || sender;
};
exports.getDecryptionJid = getDecryptionJid;

const storeMappingFromEnvelope = async (stanza, sender, repository, decryptionJid, logger) => {
    if (!repository.lidMapping) return;
    const addressingMode = stanza.attrs.addressing_mode || (((stanza.attrs.participant || stanza.attrs.from) || '').endsWith('lid') ? 'lid' : 'pn');
    const senderAlt = addressingMode === 'lid'
        ? (stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn)
        : (stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid);
    if (senderAlt && (0, WABinary_1.isLidUser)(senderAlt) && (0, WABinary_1.isPnUser)(sender) && decryptionJid === sender) {
        try {
            await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }]);
            await repository.migrateSession(sender, senderAlt);
            logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope');
        } catch (error) {
            logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping');
        }
    }
};

// Where a LID-addressed stanza carries the matching phone number (and vice versa)
const extractAddressingContext = (stanza) => {
    const sender = stanza.attrs.participant || stanza.attrs.from;
    const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn');
    let senderAlt;
    if (addressingMode === 'lid') {
        senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn;
    } else {
        senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid;
    }
    return { addressingMode, senderAlt };
};
exports.extractAddressingContext = extractAddressingContext;

const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node';
exports.NO_MESSAGE_FOUND_ERROR_TEXT = NO_MESSAGE_FOUND_ERROR_TEXT;

const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled';
exports.MISSING_KEYS_ERROR_TEXT = MISSING_KEYS_ERROR_TEXT;

/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
function decodeMessageNode(stanza, meId, meLid) {
    var _a, _b;
    let msgType;
    let chatId;
    let author;
    const msgId = stanza.attrs.id;
    const from = stanza.attrs.from;
    const participant = stanza.attrs.participant;
    const recipient = stanza.attrs.recipient;
    const isMe = (jid) => (0, WABinary_1.areJidsSameUser)(jid, meId);
    const isMeLid = (jid) => (0, WABinary_1.areJidsSameUser)(jid, meLid);

    if ((0, WABinary_1.isJidUser)(from)) {
        if (recipient) {
            if (!isMe(from)) {
                throw new boom_1.Boom('receipient present, but msg not from me', { data: stanza });
            }
            chatId = recipient;
        } else {
            chatId = from;
        }
        msgType = 'chat';
        author = from;
    } else if ((0, WABinary_1.isLidUser)(from)) {
        if (recipient) {
            if (!isMeLid(from)) {
                throw new boom_1.Boom('receipient present, but msg not from me', { data: stanza });
            }
            chatId = recipient;
        } else {
            chatId = from;
        }
        msgType = 'chat';
        author = from;
    } else if ((0, WABinary_1.isJidGroup)(from)) {
        if (!participant) {
            throw new boom_1.Boom('No participant in group message');
        }
        msgType = 'group';
        author = participant;
        chatId = from;
    } else if ((0, WABinary_1.isJidBroadcast)(from)) {
        if (!participant) {
            throw new boom_1.Boom('No participant in group message');
        }
        const isParticipantMe = isMe(participant);
        if ((0, WABinary_1.isJidStatusBroadcast)(from)) {
            msgType = isParticipantMe ? 'direct_peer_status' : 'other_status';
        } else {
            msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast';
        }
        chatId = from;
        author = participant;
    } else if ((0, WABinary_1.isJidNewsLetter)(from)) {
        msgType = 'newsletter';
        author = from;
        chatId = from;
    } else {
        throw new boom_1.Boom('Unknown message type', { data: stanza });
    }

    const fromMe = (0, WABinary_1.isJidNewsLetter)(from)
        ? !!((_a = stanza.attrs) === null || _a === void 0 ? void 0 : _a.is_sender)
        : ((0, WABinary_1.isLidUser)(from) ? isMeLid : isMe)(stanza.attrs.participant || stanza.attrs.from);

    const pushname = stanza.attrs.notify;
    const addressingContext = extractAddressingContext(stanza);
    const key = {
        remoteJid: chatId,
        remoteJidAlt: !(0, WABinary_1.isJidGroup)(chatId) ? addressingContext.senderAlt : undefined,
        fromMe,
        id: msgId,
        participant,
        participantAlt: (0, WABinary_1.isJidGroup)(chatId) ? addressingContext.senderAlt : undefined,
        addressingMode: addressingContext.addressingMode
    };
    const fullMessage = {
        key,
        messageTimestamp: +stanza.attrs.t,
        pushName: pushname,
        broadcast: (0, WABinary_1.isJidBroadcast)(from)
    };
    if (msgType === 'newsletter') {
        fullMessage.newsletterServerId = +((_b = stanza.attrs) === null || _b === void 0 ? void 0 : _b.server_id);
    }
    if (key.fromMe) {
        fullMessage.status = WAProto_1.proto.WebMessageInfo.Status.SERVER_ACK;
    }
    return {
        fullMessage,
        author,
        sender: msgType === 'chat' ? author : chatId
    };
}
exports.decodeMessageNode = decodeMessageNode;

const decryptMessageNode = (stanza, meId, meLid, repository, logger) => {
    const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid);
    return {
        fullMessage,
        category: stanza.attrs.category,
        author,
        async decrypt() {
            var _a;
            let decryptables = 0;

            async function processSenderKeyDistribution(msg) {
                if (msg.senderKeyDistributionMessage) {
                    try {
                        await repository.processSenderKeyDistributionMessage({
                            authorJid: author,
                            item: msg.senderKeyDistributionMessage
                        });
                    } catch (err) {
                        logger.error({ key: fullMessage.key, err }, 'failed to process senderKeyDistribution');
                    }
                }
            }

            if ((0, WABinary_1.isJidNewsLetter)(fullMessage.key.remoteJid)) {
                const node = (0, WABinary_1.getBinaryNodeChild)(stanza, 'plaintext');
                const msg = WAProto_1.proto.Message.decode(node === null || node === void 0 ? void 0 : node.content);
                await processSenderKeyDistribution(msg);
                fullMessage.message = msg;
                decryptables += 1;
            } else if (Array.isArray(stanza.content)) {
                for (const { tag, attrs, content } of stanza.content) {
                    if (tag === 'verified_name' && content instanceof Uint8Array) {
                        const cert = WAProto_1.proto.VerifiedNameCertificate.decode(content);
                        const details = WAProto_1.proto.VerifiedNameCertificate.Details.decode(cert.details);
                        fullMessage.verifiedBizName = details.verifiedName;
                    }

                    // FIX 7: Also handle 'plaintext' tag (not just 'enc') for view-once stubs
                    if (tag === 'unavailable' && attrs.type === 'view_once') {
                        fullMessage.key.isViewOnce = true;
                    }

                    if (attrs.count && tag === 'enc') {
                        fullMessage.retryCount = Number(attrs.count);
                    }

                    if (tag !== 'enc' && tag !== 'plaintext') {
                        continue;
                    }
                    if (!(content instanceof Uint8Array)) {
                        continue;
                    }

                    decryptables += 1;
                    let msgBuffer;
                    const decryptionJid = await getDecryptionJid(author, repository);
                    if (tag !== 'plaintext') {
                        await storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger);
                    }

                    try {
                        const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type;

                        switch (e2eType) {
                            case 'skmsg':
                                msgBuffer = await repository.decryptGroupMessage({
                                    group: sender,
                                    authorJid: author,
                                    msg: content
                                });
                                break;
                            case 'pkmsg':
                            case 'msg': {
                                msgBuffer = await repository.decryptMessage({
                                    jid: decryptionJid,
                                    type: e2eType,
                                    ciphertext: content
                                });
                                break;
                            }
                            case 'plaintext':
                                msgBuffer = content;
                                break;
                            default:
                                throw new Error(`Unknown e2e type: ${e2eType}`);
                        }

                        let msg = WAProto_1.proto.Message.decode(
                            e2eType !== 'plaintext' ? (0, generics_1.unpadRandomMax16)(msgBuffer) : msgBuffer
                        );
                        msg = ((_a = msg.deviceSentMessage) === null || _a === void 0 ? void 0 : _a.message) || msg;
                        await processSenderKeyDistribution(msg);
                        if (fullMessage.message) {
                            Object.assign(fullMessage.message, msg);
                        } else {
                            fullMessage.message = msg;
                        }
                    } catch (err) {
                        // FIX 8: Richer error context matching upstream — includes isSessionRecordError flag
                        // so callers can distinguish "Bad MAC / corrupt session" from other errors
                        const errorContext = {
                            key: fullMessage.key,
                            err,
                            messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
                            sender,
                            author,
                            isSessionRecordError: isSessionRecordError(err)
                        };
                        logger.error(errorContext, 'failed to decrypt message');
                        fullMessage.messageStubType = WAProto_1.proto.WebMessageInfo.StubType.CIPHERTEXT;
                        fullMessage.messageStubParameters = [err.message];
                    }
                }
            }

            // if nothing was found to decrypt
            if (!decryptables && !fullMessage.key?.isViewOnce) {
                fullMessage.messageStubType = WAProto_1.proto.WebMessageInfo.StubType.CIPHERTEXT;
                fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT, JSON.stringify(stanza, generics_1.BufferJSON.replacer)];
            }
        }
    };
};
exports.decryptMessageNode = decryptMessageNode;

/**
 * FIX 9: isSessionRecordError helper.
 * Identifies errors that indicate a missing/corrupt session record
 * vs. a Bad MAC (authentication failure). This distinction is important:
 * - Missing session → can be fixed by requesting a retry (re-key)
 * - Bad MAC on existing session → may need identity reset
 */
function isSessionRecordError(error) {
    const msg = (error && (error.message || error.toString())) || '';
    return msg.includes('No session record') || msg.includes('SessionError: No session record');
}
