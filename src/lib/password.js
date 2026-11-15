/* Account security rules shared by sign-up and password reset. Mirrors the policy set in Supabase Auth
   (minimum 12 characters; lowercase, uppercase and digits), so people get the reason before the server refuses. */
const COMMON=new Set(['password','password1','password123','passw0rd','qwerty','qwerty123','letmein','welcome','welcome1','admin','admin123',
  'iloveyou','monkey','dragon','sunshine','football','baseball','123456789','1234567890','abc123','dentist','dental','clinic']);
export const PASSWORD_HINT='At least 12 characters, with upper- and lowercase letters and a number.';

export function passwordProblem(pw,email=''){
  if(pw.length<12)return'Use at least 12 characters.';
  if(pw.length>72)return'Use 72 characters or fewer.';
  if(!/[a-z]/.test(pw)||!/[A-Z]/.test(pw)||!/\d/.test(pw))return'Mix upper- and lowercase letters and at least one number.';
  const lower=pw.toLowerCase(),name=(email.split('@')[0]||'').toLowerCase();
  if(COMMON.has(lower.replace(/[^a-z0-9]/g,''))||['password','passw0rd','qwerty','letmein','iloveyou','123456789'].some(c=>lower.includes(c)))return'That password is too common. Choose something harder to guess.';
  if(name.length>=4&&lower.includes(name))return"Don't include your email name in the password.";
  if(/^(.)\1+$/.test(pw)||/(0123|1234|2345|3456|4567|5678|6789|abcd|qwer)/i.test(pw)&&new Set(pw).size<8)return'That password is too easy to guess.';
  return'';
}

/* Server messages that would reveal whether an email has an account are replaced with neutral ones. */
export function authMessage(err,kind){
  const m=String(err?.message||err||'');
  if(/rate limit|too many|429/i.test(m))return'Too many attempts. Please wait a few minutes and try again.';
  if(/weak|pwned|leaked|compromised/i.test(m))return'That password has appeared in a data breach or is too weak. Please choose another.';
  if(kind==='signin')return'Email or password is incorrect, or the email has not been confirmed yet.';
  if(kind==='signup'&&/already|registered|exists/i.test(m))return'Check your email to confirm your account, then sign in.';
  if(kind==='reset')return'If that email has an account, a reset link is on its way.';
  return m||'Something went wrong. Please try again.';
}
