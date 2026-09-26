// Local certificate authority for the phone controllers.
//
// iPhones only expose motion sensors to pages served over HTTPS, so the
// server needs a certificate for its LAN address. We mint a small local CA
// once (so a player can optionally install & trust it on their phone, which
// removes the browser warning and enables WebSockets on iOS) and a leaf
// certificate for the current set of IPs, regenerated whenever the IPs change.

import forge from 'node-forge';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const DAY = 24 * 60 * 60 * 1000;

function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return {
    publicKey: forge.pki.publicKeyFromPem(publicKey),
    privateKey: forge.pki.privateKeyFromPem(privateKey),
    privatePem: privateKey,
  };
}

function serial() {
  // Positive, random, unique per issuance (browsers dislike reused serials).
  return '01' + crypto.randomBytes(15).toString('hex');
}

function makeCA() {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 3650 * DAY);
  const attrs = [
    { name: 'commonName', value: `KALEIDO Local CA (${os.hostname()})` },
    { name: 'organizationName', value: 'KALEIDO' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem };
}

function makeLeaf(ca, ips, dnsNames) {
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  // Apple requires TLS server certificates to be valid for at most 825 days.
  cert.validity.notAfter = new Date(Date.now() + 800 * DAY);
  cert.setSubject([
    { name: 'commonName', value: ips[0] || 'localhost' },
    { name: 'organizationName', value: 'KALEIDO' },
  ]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        ...dnsNames.map((value) => ({ type: 2, value })),
        ...ips.map((ip) => ({ type: 7, ip })),
      ],
    },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem };
}

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Returns { key, cert, caPem, caDer, caFingerprint } for the given LAN IPs,
 * creating or refreshing files in `dir` as needed.
 */
export function ensureCerts(dir, lanIps) {
  fs.mkdirSync(dir, { recursive: true });
  const p = (n) => path.join(dir, n);

  let ca = { certPem: read(p('ca.crt')), keyPem: read(p('ca.key')) };
  if (!ca.certPem || !ca.keyPem) {
    ca = makeCA();
    fs.writeFileSync(p('ca.crt'), ca.certPem);
    fs.writeFileSync(p('ca.key'), ca.keyPem, { mode: 0o600 });
  }

  const host = os.hostname().replace(/\.local$/, '');
  const ips = [...new Set(['127.0.0.1', ...lanIps])].sort();
  const dns = [...new Set(['localhost', `${host}.local`, host])].sort();
  const caFingerprint = crypto.createHash('sha256').update(ca.certPem).digest('hex');
  const want = JSON.stringify({ ips, dns, ca: caFingerprint });

  let leaf = { certPem: read(p('leaf.crt')), keyPem: read(p('leaf.key')) };
  const meta = read(p('leaf.json'));
  let expiring = true;
  if (leaf.certPem) {
    try {
      const c = forge.pki.certificateFromPem(leaf.certPem);
      expiring = c.validity.notAfter.getTime() - Date.now() < 30 * DAY;
    } catch {
      expiring = true;
    }
  }
  if (!leaf.certPem || !leaf.keyPem || meta !== want || expiring) {
    leaf = makeLeaf(ca, ips, dns);
    fs.writeFileSync(p('leaf.crt'), leaf.certPem);
    fs.writeFileSync(p('leaf.key'), leaf.keyPem, { mode: 0o600 });
    fs.writeFileSync(p('leaf.json'), want);
  }

  const caDer = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(ca.certPem))).getBytes(),
    'binary',
  );

  return {
    key: leaf.keyPem,
    cert: leaf.certPem + ca.certPem, // full chain
    caPem: ca.certPem,
    caDer,
    caFingerprint,
  };
}
