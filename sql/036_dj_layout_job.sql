-- DJ Sorted invoice layout and a Job per project.
--  * projects.job: free text job name/number, printed on invoices and credit notes when "Show the job" is ticked.
--  * document_settings: template can be 'djsorted' (the DJ Sorted invoice look); show_job_default ticks
--    "Show the job" in the print dialog by default.
--  * shared_links: the job choice and the layout picked when the link was made.
--  * get_shared_document(): returns the job text and the chosen layout.
-- Safe to run more than once.

alter table public.projects add column if not exists job text;

alter table public.document_settings add column if not exists show_job_default boolean not null default false;
alter table public.document_settings drop constraint if exists document_settings_template_check;
alter table public.document_settings add constraint document_settings_template_check
  check (template in ('blue', 'modern', 'classic', 'djsorted'));

alter table public.shared_links add column if not exists show_job boolean not null default false;
alter table public.shared_links add column if not exists template text;

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
  v_jobs text := '';
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
    if v_link.show_job then
      select coalesce(string_agg(distinct p.job, ', '), '') into v_jobs
      from public.sales_document_lines l join public.projects p on p.id = l.project_id
      where l.document_id = v_doc.id and coalesce(trim(p.job), '') <> '';
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
      'job', v_jobs,
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
    'template', v_link.template,
    'extras', v_link.extras);
end;
$$;

revoke all on function public.get_shared_document(text) from public;
grant execute on function public.get_shared_document(text) to anon, authenticated;

-- Make the API see the new columns straight away
notify pgrst, 'reload schema';
