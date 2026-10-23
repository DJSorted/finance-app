-- Shared links: a private link a customer can open to view a posted invoice, credit note or receipt in the
-- browser, without logging in. Each link carries a long random token, expires (90 days by default) and can
-- be revoked. The page reads everything through get_shared_document(), which returns only what the printed
-- document shows.
-- Requires the existing sales_documents, sales_document_lines, customer_receipts, sales_allocations and
-- sales_open_items. Safe to run more than once.

create table if not exists public.shared_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- Exactly one of these is set.
  sales_document_id uuid references public.sales_documents(id) on delete cascade,
  receipt_id uuid references public.customer_receipts(id) on delete cascade,
  -- Two v4 UUIDs without dashes: 64 hex characters, about 244 random bits.
  token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  extras jsonb not null default '[]'::jsonb,         -- [[label, value], ...] as entered when the link was made
  show_project boolean not null default false,
  expires_at timestamptz not null default now() + interval '90 days',
  revoked_at timestamptz,
  view_count integer not null default 0,
  last_viewed_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint shared_links_one_target check ((sales_document_id is null) <> (receipt_id is null))
);
create index if not exists shared_links_sales_document_idx on public.shared_links (sales_document_id);
create index if not exists shared_links_receipt_idx on public.shared_links (receipt_id);

alter table public.shared_links enable row level security;

-- Any member can see the links; anyone who can capture sales documents or receipts can make and revoke
-- them, only for their own company's documents, and only for posted invoices and credit notes.
drop policy if exists shared_links_read on public.shared_links;
create policy shared_links_read on public.shared_links for select to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = shared_links.company_id and m.user_id = auth.uid()));

drop policy if exists shared_links_insert on public.shared_links;
create policy shared_links_insert on public.shared_links for insert to authenticated
  with check (
    exists (select 1 from public.company_members m where m.company_id = shared_links.company_id and m.user_id = auth.uid()
      and m.role in ('owner', 'admin', 'accountant', 'clerk'))
    and (
      exists (select 1 from public.sales_documents d where d.id = shared_links.sales_document_id
        and d.company_id = shared_links.company_id and d.status = 'posted')
      or exists (select 1 from public.customer_receipts r where r.id = shared_links.receipt_id
        and r.company_id = shared_links.company_id)));

drop policy if exists shared_links_update on public.shared_links;
create policy shared_links_update on public.shared_links for update to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = shared_links.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant', 'clerk')))
  with check (exists (select 1 from public.company_members m where m.company_id = shared_links.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant', 'clerk')));

grant select, insert, update on public.shared_links to authenticated;

-- Everything needed to show one shared document, or null when the token is unknown, expired or revoked.
-- Runs as the function owner so it can read past row level security; it only ever returns the one document
-- the token points at, and only the columns the printed document uses.
create or replace function public.get_shared_document(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_link public.shared_links%rowtype;
  v_doc public.sales_documents%rowtype;
  v_rec public.customer_receipts%rowtype;
  v_company uuid;
  v_customer uuid;
  v_cur text;
  v_base text;
  v_out numeric;
  v_prev_sub text;
  v_projects text := '';
  v_result jsonb;
  v_addr constant text[] := array['address', 'address1', 'address_line1', 'address_line_1', 'address2', 'address_line2',
    'address_line_2', 'street', 'suburb', 'city', 'state', 'province', 'postal_code', 'postcode', 'zip', 'country',
    'email', 'phone', 'mobile', 'website',
    'tax_number', 'vat_number', 'vat_no', 'tax_no', 'registration_number', 'company_registration', 'reg_no'];
begin
  if p_token is null or length(p_token) < 32 then return null; end if;

  select * into v_link from public.shared_links
  where token = p_token and revoked_at is null and expires_at > now();
  if not found then return null; end if;

  if v_link.sales_document_id is not null then
    select * into v_doc from public.sales_documents where id = v_link.sales_document_id and status = 'posted';
    if not found then return null; end if;
    v_company := v_doc.company_id; v_customer := v_doc.customer_id; v_cur := v_doc.currency_code;
  else
    select * into v_rec from public.customer_receipts where id = v_link.receipt_id;
    if not found then return null; end if;
    v_company := v_rec.company_id; v_customer := v_rec.customer_id; v_cur := v_rec.currency_code;
  end if;

  update public.shared_links set view_count = view_count + 1, last_viewed_at = now() where id = v_link.id;

  select code into v_base from public.company_currencies where company_id = v_company and is_base;

  if v_link.sales_document_id is not null then
    if v_link.show_project then
      select coalesce(string_agg(distinct p.code || ' - ' || p.name, ', '), '') into v_projects
      from public.sales_document_lines l join public.projects p on p.id = l.project_id
      where l.document_id = v_doc.id;
    end if;

    -- Amount still owed today, as the app prints it. Runs as the person who made the link, in case
    -- sales_open_items checks the caller is a company member. If it fails (say they have left the
    -- company), the invoice still shows, just without the paid / balance due lines.
    if v_doc.doc_type = 'invoice' then
      v_prev_sub := current_setting('request.jwt.claim.sub', true);
      begin
        perform set_config('request.jwt.claim.sub', coalesce(v_link.created_by::text, ''), true);
        select coalesce(sum(oi.outstanding), 0) into v_out
        from public.sales_open_items(p_company => v_company, p_customer => v_customer, p_as_of => current_date) oi
        where oi.doc_id = v_doc.id and oi.doc_kind = 'invoice';
      exception when others then
        v_out := null;
      end;
      perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
    end if;

    v_result := jsonb_build_object(
      'kind', 'sales',
      'doc', (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(v_doc)) where key = any(array['doc_type', 'doc_no',
        'doc_date', 'due_date', 'reference', 'currency_code', 'fx_rate', 'net_total', 'tax_total', 'gross_total', 'notes', 'status'])),
      'lines', coalesce((select jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity,
          'unit_price', l.unit_price, 'tax_rate', l.tax_rate, 'net_amount', l.net_amount, 'tax_amount', l.tax_amount,
          'items', case when i.id is null then null
            else jsonb_build_object('code', i.code, 'name', i.name, 'description', i.description) end) order by l.line_no)
        from public.sales_document_lines l left join public.items i on i.id = l.item_id
        where l.document_id = v_doc.id), '[]'::jsonb),
      'terms', (select name from public.payment_terms where id = v_doc.payment_terms_id),
      -- The one bank account the printed invoice would show: same currency first, else "any currency".
      'bank', (select jsonb_build_object('label', b.label, 'details', b.details) from public.document_bank_details b
        where b.company_id = v_company and (b.currency_code = v_cur or b.currency_code is null)
        order by (b.currency_code is null), b.sort_order, b.created_at limit 1),
      'project', v_projects,
      'outstanding', v_out);
  else
    v_result := jsonb_build_object(
      'kind', 'receipt',
      'receipt', (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(v_rec)) where key = any(array['receipt_no',
        'receipt_date', 'reference', 'currency_code', 'fx_rate', 'amount', 'allocated_amount', 'notes', 'status', 'reversed_on'])),
      'allocations', coalesce((select jsonb_agg(jsonb_build_object('amount', a.amount,
          'doc', jsonb_build_object('doc_no', d.doc_no, 'doc_date', d.doc_date, 'gross_total', d.gross_total)) order by a.created_at)
        from public.sales_allocations a left join public.sales_documents d on d.id = a.invoice_id
        where a.receipt_id = v_rec.id), '[]'::jsonb),
      'received_into', (select g.name from public.gl_accounts g where g.id = v_rec.bank_account_id));
  end if;

  return v_result || jsonb_build_object(
    'customer', (select jsonb_object_agg(key, value) from public.customers c, jsonb_each(to_jsonb(c))
      where c.id = v_customer and key = any(v_addr || array['name', 'code'])),
    'company', (select jsonb_object_agg(key, value) from public.companies c, jsonb_each(to_jsonb(c))
      where c.id = v_company and key = any(v_addr || array['name', 'logo_path', 'logo_updated_at',
        'print_footer', 'document_footer', 'bank_details'])),
    'base', v_base,
    'decimals', (select decimals from public.currencies where code = v_cur),
    'settings', (select to_jsonb(s) - 'company_id' - 'created_at' - 'updated_at'
      from public.document_settings s where s.company_id = v_company),
    'extras', v_link.extras);
end;
$$;

revoke all on function public.get_shared_document(text) from public;
grant execute on function public.get_shared_document(text) to anon, authenticated;
