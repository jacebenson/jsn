// Preloaded by the real CLI welcome regression: fail even for swallowed calls.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { AuthManager } from '../../src/auth.js';
let attempts = 0;
function forbidden() { attempts++; throw new Error('Welcome must not perform network/auth operations'); }
net.Socket.prototype.connect = forbidden;
http.request = forbidden;
https.request = forbidden;
globalThis.fetch = forbidden;
for (const name of ['login', 'loginWithBrowser', 'getCredentials', 'refreshToken']) AuthManager.prototype[name] = forbidden;
process.on('exit', () => { if (attempts) process.exitCode = 91; });
