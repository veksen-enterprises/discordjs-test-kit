import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import * as tls from "node:tls";

// @discordjs/voice connects to `wss://${endpoint}` (VoiceConnection.createWebSocket), so the fake
// voice server must speak TLS with a certificate the bot's process trusts. Node can't create
// certificates, so this builds a self-signed X.509 v3 certificate for 127.0.0.1 by hand (RFC 5280
// DER), with a P-256 key that never leaves the process. `trustCertificate` adds it to the default
// CA list (tls.setDefaultCACertificates, Node 22.15+) next to the system CAs, and gives back a
// function that restores the list: no other host's verification changes.

const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length =
    n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [a! * 40 + b!];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};
const time = (date: Date) =>
  der(
    0x17,
    Buffer.from(date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"),
  );

export function selfSignedCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const ecdsaSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  const name = sequence(
    der(
      0x31,
      sequence(oid("2.5.4.3"), der(0x0c, Buffer.from("discordjs-test-kit"))),
    ),
  );
  // A positive INTEGER in minimal DER: a first byte of 0x00 would be padding, which OpenSSL
  // refuses ("illegal padding"); clearing only the top bit did that about once in 200 certificates.
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x3f) | 0x40;
  const now = Date.now();
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    ecdsaSha256,
    name,
    sequence(time(new Date(now - 60_000)), time(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(
      0xa3,
      sequence(
        // subjectAltName: IP 127.0.0.1
        sequence(
          oid("2.5.29.17"),
          der(0x04, sequence(der(0x87, Buffer.from([127, 0, 0, 1])))),
        ),
      ),
    ),
  );
  const signature = sign("sha256", tbs, privateKey);
  const cert = sequence(
    tbs,
    ecdsaSha256,
    der(0x03, Buffer.from([0]), signature),
  );
  const pem = `-----BEGIN CERTIFICATE-----\n${cert
    .toString("base64")
    .replace(/.{64}/g, "$&\n")
    .trim()}\n-----END CERTIFICATE-----\n`;
  return {
    cert: pem,
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

/** Trusts `cert` in this process until the returned function runs. */
export function trustCertificate(cert: string): () => void {
  if (typeof tls.setDefaultCACertificates !== "function")
    throw new Error(
      `discordjs-test-kit: voice connections need Node 22.15 or newer (tls.setDefaultCACertificates); this is ${process.version}`,
    );
  const before = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...before, cert]);
  return () => tls.setDefaultCACertificates(before);
}
