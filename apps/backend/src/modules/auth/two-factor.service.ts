import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { Authenticator } from '@otplib/v12-adapter';
import { prisma } from '../../prisma';
import { decryptCredential, encryptCredential } from '../../lib/credential-crypto';

const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000;
const SETUP_CHALLENGE_TTL = '10m';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const authenticator = new Authenticator({ window: 1 });

type LoginChallengeClaims = jwt.JwtPayload & {
  purpose: 'TWO_FACTOR_LOGIN';
  challengeId: string;
  identityId: string;
};

type SetupChallengeClaims = jwt.JwtPayload & {
  purpose: 'TWO_FACTOR_SETUP';
  identityId: string;
  secretEnc: string;
};

export class TwoFactorError extends Error {
  constructor(message = 'Invalid or expired verification code') {
    super(message);
    this.name = 'TwoFactorError';
  }
}

function jwtSecret(): string {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  return process.env.JWT_SECRET;
}

function recoveryHashKey(): string {
  if (!process.env.CHANNEL_ENCRYPTION_KEY) throw new Error('CHANNEL_ENCRYPTION_KEY is required');
  return process.env.CHANNEL_ENCRYPTION_KEY;
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code: string): string {
  return crypto
    .createHmac('sha256', recoveryHashKey())
    .update(normalizeRecoveryCode(code))
    .digest('hex');
}

function randomRecoveryPart(length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  }
  return value;
}

export function generateRecoveryCodes(): Array<{ code: string; codeHash: string }> {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const code = `${randomRecoveryPart(4)}-${randomRecoveryPart(4)}-${randomRecoveryPart(4)}`;
    return { code, codeHash: hashRecoveryCode(code) };
  });
}

export async function buildTwoFactorSetup(identityId: string, email: string) {
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(email, 'RabiTech', secret);
  const setupToken = jwt.sign(
    {
      purpose: 'TWO_FACTOR_SETUP',
      identityId,
      secretEnc: encryptCredential(secret),
    },
    jwtSecret(),
    { expiresIn: SETUP_CHALLENGE_TTL },
  );
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
    width: 224,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#111827', light: '#ffffff' },
  });
  return { secret, setupToken, qrDataUrl, expiresIn: 600 };
}

export function verifySetupChallenge(setupToken: string, expectedIdentityId: string): string {
  try {
    const claims = jwt.verify(setupToken, jwtSecret()) as SetupChallengeClaims;
    if (
      claims.purpose !== 'TWO_FACTOR_SETUP'
      || claims.identityId !== expectedIdentityId
      || !claims.secretEnc
    ) {
      throw new TwoFactorError('Invalid setup challenge');
    }
    return decryptCredential(claims.secretEnc);
  } catch (error) {
    if (error instanceof TwoFactorError) throw error;
    throw new TwoFactorError('Setup challenge expired');
  }
}

export function verifyTotp(code: string, secret: string): boolean {
  return /^\d{6}$/.test(code) && authenticator.check(code, secret);
}

export function generateTotp(secret: string): string {
  return authenticator.generate(secret);
}

export async function createLoginChallenge(identityId: string) {
  const expiresAt = new Date(Date.now() + LOGIN_CHALLENGE_TTL_MS);
  await prisma.twoFactorChallenge.deleteMany({
    where: { identityId, expiresAt: { lt: new Date() } },
  });
  const challenge = await prisma.twoFactorChallenge.create({
    data: { identityId, expiresAt },
  });
  const challengeToken = jwt.sign(
    {
      purpose: 'TWO_FACTOR_LOGIN',
      challengeId: challenge.id,
      identityId,
    },
    jwtSecret(),
    { expiresIn: '5m' },
  );
  return { challengeToken, expiresIn: LOGIN_CHALLENGE_TTL_MS / 1000 };
}

function parseLoginChallenge(challengeToken: string): LoginChallengeClaims {
  try {
    const claims = jwt.verify(challengeToken, jwtSecret()) as LoginChallengeClaims;
    if (
      claims.purpose !== 'TWO_FACTOR_LOGIN'
      || !claims.challengeId
      || !claims.identityId
    ) {
      throw new TwoFactorError();
    }
    return claims;
  } catch (error) {
    if (error instanceof TwoFactorError) throw error;
    throw new TwoFactorError('Login challenge expired');
  }
}

export async function consumeLoginSecondFactor(challengeToken: string, rawCode: string) {
  const claims = parseLoginChallenge(challengeToken);
  const code = rawCode.trim();

  return prisma.$transaction(async (tx) => {
    const consumedChallenge = await tx.twoFactorChallenge.updateMany({
      where: {
        id: claims.challengeId,
        identityId: claims.identityId,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    if (consumedChallenge.count !== 1) throw new TwoFactorError('Login challenge already used or expired');

    const identity = await tx.identity.findUnique({ where: { id: claims.identityId } });
    if (!identity?.totpSecretEnc || !identity.totpEnabledAt) throw new TwoFactorError();

    const secret = decryptCredential(identity.totpSecretEnc);
    const delta = /^\d{6}$/.test(code) ? authenticator.checkDelta(code, secret) : null;
    if (delta !== null) {
      const counter = BigInt(Math.floor(Date.now() / 30_000) + delta);
      const consumedTotp = await tx.identity.updateMany({
        where: {
          id: identity.id,
          OR: [
            { totpLastUsedCounter: null },
            { totpLastUsedCounter: { lt: counter } },
          ],
        },
        data: { totpLastUsedCounter: counter },
      });
      if (consumedTotp.count !== 1) throw new TwoFactorError('Verification code was already used');
      return identity;
    }

    const recovery = await tx.identityRecoveryCode.updateMany({
      where: {
        identityId: identity.id,
        codeHash: hashRecoveryCode(code),
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
    if (recovery.count !== 1) throw new TwoFactorError();
    return identity;
  });
}

export async function consumeExistingFactor(identityId: string, rawCode: string): Promise<boolean> {
  const code = rawCode.trim();
  return prisma.$transaction(async (tx) => {
    const identity = await tx.identity.findUnique({ where: { id: identityId } });
    if (!identity?.totpSecretEnc || !identity.totpEnabledAt) return false;

    const delta = /^\d{6}$/.test(code)
      ? authenticator.checkDelta(code, decryptCredential(identity.totpSecretEnc))
      : null;
    if (delta !== null) {
      const counter = BigInt(Math.floor(Date.now() / 30_000) + delta);
      const consumed = await tx.identity.updateMany({
        where: {
          id: identityId,
          OR: [
            { totpLastUsedCounter: null },
            { totpLastUsedCounter: { lt: counter } },
          ],
        },
        data: { totpLastUsedCounter: counter },
      });
      return consumed.count === 1;
    }

    const recovery = await tx.identityRecoveryCode.updateMany({
      where: { identityId, codeHash: hashRecoveryCode(code), usedAt: null },
      data: { usedAt: new Date() },
    });
    return recovery.count === 1;
  });
}
