'use strict';

/* Encrypts passwords kept in the database (Setup -> Configuration) with
 * AES-256-GCM, so a copy of the database alone doesn't give away the Syspro
 * logins. The key lives only in server/.env (SETTINGS_ENCRYPTION_KEY) -- lose
 * it and the saved passwords have to be typed in again.
 */
const crypto = require('crypto');
const env = require('../config/env');
const ApiError = require('./ApiError');

function key() {
  if (!env.settingsEncryptionKey) throw new ApiError(500, 'SETTINGS_ENCRYPTION_KEY is not set in server/.env, so passwords cannot be saved');
  return env.settingsEncryptionKey;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(stored) {
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new ApiError(500, 'A saved password could not be read -- SETTINGS_ENCRYPTION_KEY has changed. Type the password in again.');
  }
}

module.exports = { encrypt, decrypt };
