import jwt, { type JwtHeader, type JwtPayload, type SigningKeyCallback } from "jsonwebtoken";
import { JwksClient } from "jwks-rsa";
import { getAddress, type Address } from "viem";

type DynamicCredential = { address?: string; chain?: string; id?: string; wallet_name?: string };
type DynamicClaims = JwtPayload & {
  environment_id?: string;
  verified_account?: DynamicCredential;
  verified_credentials?: DynamicCredential[];
  scopes?: string[];
  scope?: string;
};

export type DynamicIdentity = {
  userId: string;
  email?: string;
  evmWallets: Address[];
  verifiedAccount?: Address;
};

type TokenVerifier = (token: string) => Promise<DynamicClaims>;

export class DynamicAuthService {
  private readonly verifyToken: TokenVerifier;

  constructor(environmentId = process.env.DYNAMIC_ENVIRONMENT_ID, verifier?: TokenVerifier) {
    if (verifier) { this.verifyToken = verifier; return; }
    if (!environmentId) {
      this.verifyToken = async () => { throw new Error("Dynamic is not configured. Set DYNAMIC_ENVIRONMENT_ID."); };
      return;
    }
    const client = new JwksClient({
      jwksUri: `https://app.dynamic.xyz/api/v0/sdk/${environmentId}/.well-known/jwks`,
      cache: true, cacheMaxEntries: 5, cacheMaxAge: 600_000, rateLimit: true,
    });
    this.verifyToken = (token) => new Promise((resolve, reject) => {
      const key = (header: JwtHeader, callback: SigningKeyCallback) => {
        if (!header.kid) return callback(new Error("Dynamic JWT has no key id."));
        client.getSigningKey(header.kid).then((value) => callback(null, value.getPublicKey())).catch(callback);
      };
      jwt.verify(token, key, { algorithms: ["RS256"] }, (error, decoded) => {
        if (error || !decoded || typeof decoded === "string") return reject(error ?? new Error("Invalid Dynamic JWT."));
        resolve(decoded as DynamicClaims);
      });
    });
  }

  async authenticate(authorizationHeader?: string): Promise<DynamicIdentity> {
    const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new Error("A Dynamic Bearer token is required.");
    const claims = await this.verifyToken(match[1]);
    if (!claims.sub) throw new Error("Dynamic JWT has no user id.");
    const scopes = [...(claims.scopes ?? []), ...(claims.scope?.split(/\s+/) ?? [])];
    if (scopes.includes("requiresAdditionalAuth")) throw new Error("Dynamic requires additional authentication.");
    const credentials = claims.verified_credentials ?? [];
    const evmWallets = uniqueAddresses(credentials.filter((credential) => credential.chain === "eip155" && credential.address).map((credential) => credential.address!));
    const verifiedAccount = claims.verified_account?.chain === "eip155" && claims.verified_account.address ? getAddress(claims.verified_account.address) : undefined;
    return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined, evmWallets: uniqueAddresses([...evmWallets, ...(verifiedAccount ? [verifiedAccount] : [])]), verifiedAccount };
  }

  requireWallet(identity: DynamicIdentity, requestedAddress: string): Address {
    const address = getAddress(requestedAddress);
    if (!identity.evmWallets.some((wallet) => wallet.toLowerCase() === address.toLowerCase())) throw new Error("This wallet is not verified by the Dynamic session.");
    return address;
  }
}

function uniqueAddresses(values: string[]): Address[] {
  return [...new Set(values.map((value) => getAddress(value).toLowerCase()))].map((value) => getAddress(value));
}
