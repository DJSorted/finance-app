-- Document settings: look and wording of printed invoices, credit notes, purchase orders and statements,
-- plus bank details printed on documents (one per currency, or "any currency" when currency_code is null).
-- Safe to run more than once.

create table if not exists public.document_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  template text not null default 'blue' check (template in ('blue', 'modern', 'classic')),
  accent text not null default '#1f5fbf',
  greeting text,
  closing text,
  footer_text text,
  extra1_label text,
  extra2_label text,
  show_project_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_bank_details (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  label text not null,
  currency_code text,
  details text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists document_bank_details_company_idx on public.document_bank_details (company_id, sort_order);

alter table public.document_settings enable row level security;
alter table public.document_bank_details enable row level security;

-- Any member of the company can read (needed to print); owners, admins and accountants can change.
drop policy if exists document_settings_read on public.document_settings;
create policy document_settings_read on public.document_settings for select to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = document_settings.company_id and m.user_id = auth.uid()));

drop policy if exists document_settings_write on public.document_settings;
create policy document_settings_write on public.document_settings for all to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = document_settings.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')))
  with check (exists (select 1 from public.company_members m where m.company_id = document_settings.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')));

drop policy if exists document_bank_details_read on public.document_bank_details;
create policy document_bank_details_read on public.document_bank_details for select to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = document_bank_details.company_id and m.user_id = auth.uid()));

drop policy if exists document_bank_details_write on public.document_bank_details;
create policy document_bank_details_write on public.document_bank_details for all to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = document_bank_details.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')))
  with check (exists (select 1 from public.company_members m where m.company_id = document_bank_details.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')));

grant select, insert, update, delete on public.document_settings, public.document_bank_details to authenticated;
