// One-off: seed (or refresh) a disposable test user for verifying the document
// vault UI locally. Safe to re-run; prints the user id.
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import bcrypt from 'bcryptjs';
import { supabase } from '../src/utils/supabase';

async function main() {
  const email = 'vault-test@ledger.local';
  const password_hash = await bcrypt.hash('vault-test-password-1', 12);

  const { data: existing } = await supabase
    .from('users').select('id').eq('email', email).maybeSingle();

  if (existing) {
    await supabase.from('users').update({ password_hash, email_verified: true })
      .eq('id', existing.id);
    console.log('refreshed', existing.id);
    return;
  }

  const { data, error } = await supabase.from('users').insert({
    email, name: 'Vault Test', password_hash,
    currency_preference: 'AUD', theme: 'light', plan: 'free',
    onboarding_complete: true, email_verified: true,
  }).select('id').single();
  if (error) throw new Error(error.message);
  console.log('created', data.id);
}

main().catch(err => { console.error(err); process.exit(1); });
