import { supabase } from './supabase.js';

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export async function requireAuth() {
  const session = await getSession();
  if (!session) { location.href = '/pages/login.html'; return null; }
  return session;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { emailRedirectTo: location.origin + '/' },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getMemberships(userId) {
  const { data, error } = await supabase
    .from('company_members')
    .select('role, company_id, companies(id, name)')
    .eq('user_id', userId);
  if (error) throw error;
  return data;
}

const KEY = 'activeCompanyId';
export function setActiveCompany(id) { try { localStorage.setItem(KEY, id); } catch (e) { /* ignore */ } }
export function getActiveMembership(memberships) {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
  return memberships.find((m) => m.company_id === saved) || memberships[0];
}

export async function createCompany(name, baseCurrency) {
  const { data, error } = await supabase.rpc('create_company', { p_name: name, p_base: baseCurrency });
  if (error) throw error;
  return data;
}