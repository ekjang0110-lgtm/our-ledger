// 암호 걸린 엑셀(Office 2010+ Agile 암호화) 풀기 — 브라우저 WebCrypto만 사용, 파일은 밖으로 나가지 않음
const subtle = globalThis.crypto.subtle;
const u8 = b => b instanceof Uint8Array ? b : new Uint8Array(b);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; a.forEach(x => { o.set(x, p); p += x.length; }); return o; };
const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hash = async (alg, d) => u8(await subtle.digest(alg, d));
const fit = (b, n, pad) => { if (b.length >= n) return b.slice(0, n); const o = new Uint8Array(n).fill(pad); o.set(b); return o; };
// 패딩 없는 AES-CBC 복호화: WebCrypto는 PKCS7 패딩을 요구하므로 패딩 블록을 만들어 붙인 뒤 푼다
async function cbcRaw(keyBytes, iv, data) {
  const key = await subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const last = data.slice(data.length - 16);
  const padBlock = u8(await subtle.encrypt({ name: 'AES-CBC', iv: last }, key, new Uint8Array(0))).slice(0, 16);
  return u8(await subtle.decrypt({ name: 'AES-CBC', iv }, key, cat(data, padBlock)));
}
export const isEncryptedOffice = (XLSX, buf) => { try { const cfb = XLSX.CFB.read(u8(buf), { type: 'array' }); return !!XLSX.CFB.find(cfb, 'EncryptionInfo'); } catch { return false; } };
export async function decryptOffice(XLSX, buf, password) {
  const cfb = XLSX.CFB.read(u8(buf), { type: 'array' });
  const info = u8(XLSX.CFB.find(cfb, 'EncryptionInfo').content), pkg = u8(XLSX.CFB.find(cfb, 'EncryptedPackage').content);
  const pw = new Uint8Array(password.length * 2); for (let i = 0; i < password.length; i++) { const c = password.charCodeAt(i); pw[i * 2] = c & 255; pw[i * 2 + 1] = c >> 8; }
  if (info[2] === 2 && (info[0] === 3 || info[0] === 4)) return standard(info, pkg, pw);
  if (!(info[0] === 4 && info[2] === 4)) throw new Error('지원하지 않는 암호 방식입니다.');
  const xml = new TextDecoder().decode(info.slice(8));
  const attr = (tag, name) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
  const kd = { salt: b64(attr('keyData', 'saltValue')), block: +attr('keyData', 'blockSize'), bits: +attr('keyData', 'keyBits'), alg: attr('keyData', 'hashAlgorithm') };
  const ke = { salt: b64(attr('encryptedKey', 'saltValue')), spin: +attr('encryptedKey', 'spinCount'), bits: +attr('encryptedKey', 'keyBits'), alg: attr('encryptedKey', 'hashAlgorithm'), val: b64(attr('encryptedKey', 'encryptedKeyValue')) };
  const H = a => ({ SHA512: 'SHA-512', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA1: 'SHA-1' })[a.replace('-', '')];
  let h = await hash(H(ke.alg), cat(ke.salt, pw)); for (let i = 0; i < ke.spin; i++) h = await hash(H(ke.alg), cat(le32(i), h));
  const blockKey = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);
  const kek = fit(await hash(H(ke.alg), cat(h, blockKey)), ke.bits / 8, 0x36);
  let secret;
  try { secret = (await cbcRaw(kek, ke.salt.slice(0, 16), ke.val)).slice(0, kd.bits / 8); } catch { throw new Error('비밀번호가 맞지 않습니다.'); }
  const size = Number(new DataView(pkg.buffer, pkg.byteOffset, 8).getBigUint64(0, true)); const enc = pkg.slice(8); const parts = [];
  for (let i = 0, seg = 0; i < enc.length; i += 4096, seg++) { const iv = fit(await hash(H(kd.alg), cat(kd.salt, le32(seg))), kd.block, 0x36); parts.push(await cbcRaw(secret, iv, enc.slice(i, Math.min(i + 4096, enc.length)))); }
  const out = cat(...parts).slice(0, size); if (out[0] !== 0x50 || out[1] !== 0x4b) throw new Error('비밀번호가 맞지 않습니다.'); return out;
}
// Standard 암호화(AES-ECB, SHA-1 50,000회) — 토스뱅크 등 은행 엑셀이 주로 사용
async function ecbDecrypt(keyBytes, data) { const raw = await cbcRaw(keyBytes, new Uint8Array(16), data); for (let i = 16; i < data.length; i++) raw[i] ^= data[i - 16]; return raw.slice(0, data.length); }
async function standard(info, pkg, pw) {
  const dv = new DataView(info.buffer, info.byteOffset, info.length); const hsize = dv.getUint32(8, true); const h0 = 12;
  const keyBits = dv.getUint32(h0 + 16, true) || 128; const v = h0 + hsize; const saltSize = dv.getUint32(v, true);
  const salt = info.slice(v + 4, v + 4 + saltSize), encVer = info.slice(v + 4 + saltSize, v + 20 + saltSize); const verHashSize = dv.getUint32(v + 20 + saltSize, true); const encVerHash = info.slice(v + 24 + saltSize, v + 24 + saltSize + 32);
  let h = await hash('SHA-1', cat(salt, pw)); for (let i = 0; i < 50000; i++) h = await hash('SHA-1', cat(le32(i), h));
  h = await hash('SHA-1', cat(h, le32(0)));
  const x = async c => { const b = new Uint8Array(64).fill(c); for (let i = 0; i < h.length; i++) b[i] ^= h[i]; return hash('SHA-1', b); };
  const key = cat(await x(0x36), await x(0x5c)).slice(0, keyBits / 8);
  const ver = await ecbDecrypt(key, encVer), verHash = (await ecbDecrypt(key, encVerHash)).slice(0, verHashSize);
  const real = await hash('SHA-1', ver); if (real.some((b, i) => b !== verHash[i])) throw new Error('비밀번호가 맞지 않습니다.');
  const size = Number(new DataView(pkg.buffer, pkg.byteOffset, 8).getBigUint64(0, true)); let enc = pkg.slice(8); if (enc.length % 16) enc = enc.slice(0, enc.length - enc.length % 16);
  return (await ecbDecrypt(key, enc)).slice(0, size);
}
