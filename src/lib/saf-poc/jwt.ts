import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

export type SigningKey = {
  kid: string;
  privateKeyPem: string;
  publicJwk: Record<string, string>;
};

export function createSigningKey(): SigningKey {
  const kid = randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const exported = publicKey.export({ format: "jwk" });
  return {
    kid,
    privateKeyPem: String(privateKey.export({ format: "pem", type: "pkcs8" })),
    publicJwk: {
      kty: String(exported.kty),
      n: String(exported.n),
      e: String(exported.e),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

export function signSet(
  key: SigningKey,
  payload: Record<string, unknown>,
): string {
  const header = base64Url(
    JSON.stringify({ alg: "RS256", typ: "secevent+jwt", kid: key.kid }),
  );
  const body = base64Url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(key.privateKeyPem).toString("base64url")}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
