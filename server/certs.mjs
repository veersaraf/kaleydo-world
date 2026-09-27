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
 * Returns { key, cert, caPem, caDer, caFingerprint, caName } for the given LAN IPs,
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

  let caName = 'KALEIDO Local CA';
  try {
    caName = forge.pki.certificateFromPem(ca.certPem).subject.getField('CN')?.value || caName;
  } catch {}

  return {
    key: leaf.keyPem,
    cert: leaf.certPem + ca.certPem, // full chain
    caPem: ca.certPem,
    caDer,
    caFingerprint,
    /** the CA's common name, as Settings shows it */
    caName,
  };
}

/** a stable UUID made from some text (the same CA always gets the same profile ids) */
function uuidFrom(text) {
  const h = crypto.createHash('sha256').update(text).digest('hex');
  const v = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/**
 * An iOS configuration profile (.mobileconfig) holding the CA as a root
 * certificate payload. Installing it (Settings → General → VPN & Device
 * Management) adds the certificate; turning on full trust (Settings → General
 * → About → Certificate Trust Settings) makes Safari trust the game's https.
 * The ids come from the CA's fingerprint, so downloading it again replaces the
 * same profile instead of adding a second one.
 */
export function mobileconfig({ caDer, caName, caFingerprint }) {
  const id = `local.kaleido.ca.${caFingerprint.slice(0, 16)}`;
  const b64 = caDer.toString('base64').replace(/(.{64})/g, '$1\n\t\t\t\t').trim();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadCertificateFileName</key>
			<string>KALEIDO-Local-CA.cer</string>
			<key>PayloadContent</key>
			<data>
				${b64}
			</data>
			<key>PayloadDescription</key>
			<string>Adds the certificate of the KALEIDO game on your Mac.</string>
			<key>PayloadDisplayName</key>
			<string>${xml(caName)}</string>
			<key>PayloadIdentifier</key>
			<string>${id}.root</string>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadUUID</key>
			<string>${uuidFrom(caFingerprint + ':root')}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Lets this phone trust the KALEIDO game on your Mac, so it can be a motion remote without security warnings. Remove it any time in Settings → General → VPN &amp; Device Management.</string>
	<key>PayloadDisplayName</key>
	<string>${xml(caName)}</string>
	<key>PayloadIdentifier</key>
	<string>${id}</string>
	<key>PayloadOrganization</key>
	<string>KALEIDO</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${uuidFrom(caFingerprint + ':profile')}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}
