"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useMultiFileAuthState = void 0;
const async_mutex_1 = require("async-mutex");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const WAProto_1 = require("../../WAProto");
const auth_utils_1 = require("./auth-utils");
const generics_1 = require("./generics");
const fileLocks = new Map();
const getFileLock = (path) => {
    let mutex = fileLocks.get(path);
    if (!mutex) {
        mutex = new async_mutex_1.Mutex();
        fileLocks.set(path, mutex);
    }
    return mutex;
};
let tmpSeq = 0;
/**
 * FIX: write to a sibling temp file and rename it into place.
 *
 * fs.writeFile() truncates the target first, so a container Stop / OOM kill / restart
 * in that window leaves a half written session-*.json. On the next boot the record
 * deserialises to something that no longer matches the peer's ratchet, and every
 * message from that device fails its MAC from then on. rename() on the same
 * filesystem is atomic: the file is either the old record or the new one.
 */
const writeFileAtomic = async (filePath, payload) => {
    const tmpPath = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
    await (0, promises_1.writeFile)(tmpPath, payload);
    try {
        await (0, promises_1.rename)(tmpPath, filePath);
    }
    catch (error) {
        await (0, promises_1.unlink)(tmpPath).catch(() => { });
        throw error;
    }
};
/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
const useMultiFileAuthState = async (folder) => {
    const writeData = async (data, file) => {
        const filePath = (0, path_1.join)(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                await writeFileAtomic(filePath, JSON.stringify(data, generics_1.BufferJSON.replacer));
            }
            finally {
                release();
            }
        });
    };
    const readData = async (file) => {
        try {
            const filePath = (0, path_1.join)(folder, fixFileName(file));
            const mutex = getFileLock(filePath);
            return await mutex.acquire().then(async (release) => {
                try {
                    const data = await (0, promises_1.readFile)(filePath, { encoding: 'utf-8' });
                    return JSON.parse(data, generics_1.BufferJSON.reviver);
                }
                finally {
                    release();
                }
            });
        }
        catch (error) {
            return null;
        }
    };
    const removeData = async (file) => {
        try {
            const filePath = (0, path_1.join)(folder, fixFileName(file));
            const mutex = getFileLock(filePath);
            return mutex.acquire().then(async (release) => {
                try {
                    await (0, promises_1.unlink)(filePath);
                }
                catch (_a) {
                }
                finally {
                    release();
                }
            });
        }
        catch (_a) {
        }
    };
    const folderInfo = await (0, promises_1.stat)(folder).catch(() => { });
    if (folderInfo) {
        if (!folderInfo.isDirectory()) {
            throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
        }
    }
    else {
        await (0, promises_1.mkdir)(folder, { recursive: true });
    }
    // leftovers from a crash mid-write are never valid records, drop them
    await (0, promises_1.readdir)(folder).then(files => Promise.all(files
        .filter(name => name.endsWith('.tmp'))
        .map(name => (0, promises_1.unlink)((0, path_1.join)(folder, name)).catch(() => { })))).catch(() => { });
    const fixFileName = (file) => { var _a; return (_a = file === null || file === void 0 ? void 0 : file.replace(/\//g, '__')) === null || _a === void 0 ? void 0 : _a.replace(/:/g, '-'); };
    const creds = await readData('creds.json') || (0, auth_utils_1.initAuthCreds)();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = WAProto_1.proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            return writeData(creds, 'creds.json');
        }
    };
};
exports.useMultiFileAuthState = useMultiFileAuthState;
