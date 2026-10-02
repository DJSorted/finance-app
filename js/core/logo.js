import { supabase } from './supabase.js';

// Public address of a company's logo, with a version so a new logo shows immediately
export function logoUrl(company) {
  if (!company || !company.logo_path) return '';
  const { data } = supabase.storage.from('logos').getPublicUrl(company.logo_path);
  return `${data.publicUrl}?v=${encodeURIComponent(company.logo_updated_at || '')}`;
}