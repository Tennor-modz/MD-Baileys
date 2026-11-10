"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAuthCreds = exports.addTransactionCapability = exports.makeCacheableSignalKeyStore = void 0;
const async_hooks_1 = require("async_hooks");
const crypto_1 = require("crypto");
const node_cache_1 = __importDefault(require("node-cache"));
const uuid_1 = require("uuid");
const Defaults_1 = require("../Defaults");
const crypto_2 = require("./crypto");
const generics_1 = require("./generics");
/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
function makeCacheableSignalKeyStore(store, logger, _cache) {
    const cache = _cache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.SIGNAL_STORE,
        useClones: false,
        deleteOnExpire: true,
    });
    function getUniqueId(type, id) {
        return `${type}.${id}`;
    }
    return {
        async get(type, ids) {
            const data = {};
            const idsToFetch = [];
            for (const id of ids) {
                const item = cache.get(getUniqueId(type, id));
                if (typeof item !== 'undefined') {
                    data[id] = item;
                }
                else {
                    idsToFetch.push(id);
                }
            }
            if (idsToFetch.length) {
                logger.trace({ items: idsToFetch.length }, 'loading from store');
                const fetched = await store.get(type, idsToFetch);
                for (const id of idsToFetch) {
                    const item = fetched[id];
                    if (item) {
                        data[id] = item;
                        cache.set(getUniqueId(type, id), item);
                    }
                }
            }
            return data;
        },
        async set(data) {
            let keys = 0;
            for (const type in data) {
                for (const id in data[type]) {
                    cache.set(getUniqueId(type, id), data[type][id]);
                    keys += 1;
                }
            }
            logger.trace({ keys }, 'updated cache');
            await store.set(data);
        },
        async clear() {
            var _a;
            cache.flushAll();
            await ((_a = store.clear) === null || _a === void 0 ? void 0 : _a.call(store));
        }
    };
}
exports.makeCacheableSignalKeyStore = makeCacheableSignalKeyStore;
/**
 * Minimal keyed async lock. A tail promise per key; callers queue behind it.
 * Deliberately dependency free — this file is loaded on every socket start.
 */
const createKeyedLock = () => {
    const tails = new Map();
    return {
        run: async (key, work) => {
            const previous = tails.get(key) || Promise.resolve();
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            const tail = previous.then(() => gate);
            tails.set(key, tail);
            await previous;
            try {
                return await work();
            }
            finally {
                release();
                if (tails.get(key) === tail) {
                    tails.delete(key);
                }
            }
        }
    };
};
/**
 * Adds DB like transaction capability to the SignalKeyStore.
 *
 * FIX: every transaction now carries its own AsyncLocalStorage context instead of
 * sharing module level `transactionCache` / `mutations` / `transactionsInProgress`.
 * The old implementation was not concurrency safe: two overlapping transactions
 * shared one mutation bag, so whichever finished first committed the other one's
 * partial writes and then cleared them. The second commit wrote nothing — a decrypt
 * or encrypt that reported success was silently dropped from disk, the ratchet moved
 * on, and every following message failed its MAC with no way back.
 *
 * Transactions opened with a key (a JID) are also serialized per key, which is what
 * makes concurrent decrypt/encrypt for the same peer safe.
 */
const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs } = {}) => {
    const txStorage = new async_hooks_1.AsyncLocalStorage();
    const locks = createKeyedLock();
    const writeQueues = createKeyedLock();
    const maxRetries = typeof maxCommitRetries === 'number' ? maxCommitRetries : 10;
    const retryDelay = typeof delayBetweenTriesMs === 'number' ? delayBetweenTriesMs : 3000;
    const isInTransaction = () => !!txStorage.getStore();
    const commitWithRetry = async (mutations) => {
        if (!Object.keys(mutations).length) {
            logger.trace('no mutations in transaction');
            return;
        }
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                await state.set(mutations);
                logger.trace({ mutationCount: Object.keys(mutations).length }, 'committed transaction');
                return;
            }
            catch (error) {
                const retriesLeft = maxRetries - attempt - 1;
                logger.warn(`failed to commit mutations, retries left=${retriesLeft}`);
                if (retriesLeft === 0) {
                    throw error;
                }
                await (0, generics_1.delay)(retryDelay);
            }
        }
    };
    return {
        get: async (type, ids) => {
            const ctx = txStorage.getStore();
            if (!ctx) {
                return state.get(type, ids);
            }
            const cached = ctx.cache[type] || {};
            const missing = ids.filter(id => !(id in cached));
            if (missing.length) {
                ctx.dbQueries += 1;
                logger.trace({ type, count: missing.length }, 'fetching missing keys in transaction');
                const fetched = await state.get(type, missing);
                ctx.cache[type] = ctx.cache[type] || {};
                Object.assign(ctx.cache[type], fetched);
            }
            const result = {};
            for (const id of ids) {
                const value = ctx.cache[type] ? ctx.cache[type][id] : undefined;
                if (value !== undefined && value !== null) {
                    result[id] = value;
                }
            }
            return result;
        },
        set: async (data) => {
            const ctx = txStorage.getStore();
            if (!ctx) {
                const types = Object.keys(data);
                await Promise.all(types.map(type => writeQueues.run(type, () => state.set({ [type]: data[type] }))));
                return;
            }
            logger.trace({ types: Object.keys(data) }, 'caching in transaction');
            for (const key in data) {
                ctx.cache[key] = ctx.cache[key] || {};
                ctx.mutations[key] = ctx.mutations[key] || {};
                Object.assign(ctx.cache[key], data[key]);
                Object.assign(ctx.mutations[key], data[key]);
            }
        },
        isInTransaction,
        transaction: async (work, key) => {
            const existing = txStorage.getStore();
            if (existing) {
                logger.trace('reusing existing transaction context');
                return work();
            }
            const run = async () => {
                const ctx = { cache: {}, mutations: {}, dbQueries: 0 };
                logger.trace('entering transaction');
                try {
                    const result = await txStorage.run(ctx, work);
                    await commitWithRetry(ctx.mutations);
                    logger.trace({ dbQueries: ctx.dbQueries }, 'transaction completed');
                    return result;
                }
                catch (error) {
                    logger.error({ error }, 'transaction failed, discarding mutations');
                    throw error;
                }
            };
            // Legacy call sites pass no key: still isolated, just not serialized.
            if (key === undefined || key === null) {
                return run();
            }
            return locks.run(String(key), run);
        }
    };
};
exports.addTransactionCapability = addTransactionCapability;
const initAuthCreds = () => {
    const identityKey = crypto_2.Curve.generateKeyPair();
    return {
        noiseKey: crypto_2.Curve.generateKeyPair(),
        pairingEphemeralKeyPair: crypto_2.Curve.generateKeyPair(),
        signedIdentityKey: identityKey,
        signedPreKey: (0, crypto_2.signedKeyPair)(identityKey, 1),
        registrationId: (0, generics_1.generateRegistrationId)(),
        advSecretKey: (0, crypto_1.randomBytes)(32).toString('base64'),
        processedHistoryMessages: [],
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSyncCounter: 0,
        accountSettings: {
            unarchiveChats: false
        },
        // mobile creds
        deviceId: Buffer.from((0, uuid_1.v4)().replace(/-/g, ''), 'hex').toString('base64url'),
        phoneId: (0, uuid_1.v4)(),
        identityId: (0, crypto_1.randomBytes)(20),
        registered: false,
        backupToken: (0, crypto_1.randomBytes)(20),
        registration: {},
        pairingCode: undefined,
        lastPropHash: undefined,
        routingInfo: undefined,
    };
};
exports.initAuthCreds = initAuthCreds;
