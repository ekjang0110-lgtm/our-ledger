// 지문·얼굴 잠금: 이 기기의 생체인증(WebAuthn 플랫폼 인증기)으로 앱을 연다.
// 로그인 상태는 그대로 유지되고, 화면을 여는 단계에서만 기기 잠금을 한 번 더 확인한다. 생체 정보는 기기 밖으로 나가지 않는다.
const KEY = 'ol_bio_v1', ASKED = 'ol_bio_asked';
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } } };
export async function bioAvailable() { try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; } }
export const bioEnabled = () => { try { return !!JSON.parse(ls.get(KEY) || 'null'); } catch { return false; } };
export const bioAsked = () => ls.get(ASKED) === '1';
export const markAsked = () => ls.set(ASKED, '1');
export async function bioEnable(email) {
  const cred = await navigator.credentials.create({ publicKey: { challenge: rand(32), rp: { name: '우리의 장부' }, user: { id: rand(16), name: email || '우리의 장부', displayName: email || '우리의 장부' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }, timeout: 60000, attestation: 'none' } });
  ls.set(KEY, JSON.stringify({ id: b64(cred.rawId), email, at: new Date().toISOString() })); markAsked(); return true;
}
export const bioDisable = () => ls.set(KEY, null);
export async function bioUnlock() {
  const c = JSON.parse(ls.get(KEY) || 'null'); if (!c) return true;
  const r = await navigator.credentials.get({ publicKey: { challenge: rand(32), allowCredentials: [{ type: 'public-key', id: unb64(c.id) }], userVerification: 'required', timeout: 60000 } });
  return !!r;
}
