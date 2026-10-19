-- Interest on overdue customer invoices.
-- Simple interest, daily: outstanding at the run date x annual rate x days / 365. Interest starts the given number of
-- grace days after the due date, and each run charges from where the last one stopped, so nothing is charged twice.
-- A run raises one posted invoice per customer and currency, with a line per overdue invoice, to the interest income account.
-- Interest invoices themselves never attract interest.
-- Requires the existing save_sales_document, post_sales_document and sales_open_items functions. Safe to run more than once.

-- company defaults (Company Defaults page)
alter table public.company_settings add column if not exists interest_rate numeric(9,4) check (interest_rate is null or interest_rate >= 0);
alter table public.company_settings add column if not exists interest_grace_days integer not null default 0 check (interest_grace_days >= 0);
alter table public.company_settings add column if not exists interest_account_id uuid references public.gl_accounts(id) on delete restrict;
alter table public.company_settings add column if not exists interest_tax_code_id uuid references public.tax_codes(id) on delete restrict;

-- per customer: use the company rate, a rate of their own, or no interest
alter table public.customers add column if not exists interest_mode text not null default 'default';
alter table public.customers add column if not exists interest_rate numeric(9,4) check (interest_rate is null or interest_rate >= 0);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_interest_mode_check') then
    alter table public.customers add constraint customers_interest_mode_check check (interest_mode in ('default', 'custom', 'none'));
  end if;
end $$;

create table if not exists public.interest_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  run_date date not null,
  invoices_count integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists interest_runs_company_idx on public.interest_runs (company_id, run_date desc);

create table if not exists public.interest_charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  run_id uuid not null references public.interest_runs(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  invoice_id uuid not null references public.sales_documents(id) on delete restrict,
  interest_doc_id uuid not null references public.sales_documents(id) on delete restrict,
  currency_code text not null,
  from_date date not null,
  to_date date not null,
  days integer not null,
  outstanding numeric(18,4) not null,
  rate numeric(9,4) not null,
  amount numeric(18,4) not null,
  created_at timestamptz not null default now()
);
create index if not exists interest_charges_invoice_idx on public.interest_charges (invoice_id, to_date desc);
create index if not exists interest_charges_doc_idx on public.interest_charges (interest_doc_id);
create index if not exists interest_charges_run_idx on public.interest_charges (run_id);

alter table public.interest_runs enable row level security;
alter table public.interest_charges enable row level security;

-- Any member of the company can read; owners, admins and accountants can run interest.
drop policy if exists interest_runs_read on public.interest_runs;
create policy interest_runs_read on public.interest_runs for select to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = interest_runs.company_id and m.user_id = auth.uid()));
drop policy if exists interest_runs_write on public.interest_runs;
create policy interest_runs_write on public.interest_runs for all to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = interest_runs.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')))
  with check (exists (select 1 from public.company_members m where m.company_id = interest_runs.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')));

drop policy if exists interest_charges_read on public.interest_charges;
create policy interest_charges_read on public.interest_charges for select to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = interest_charges.company_id and m.user_id = auth.uid()));
drop policy if exists interest_charges_write on public.interest_charges;
create policy interest_charges_write on public.interest_charges for all to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = interest_charges.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')))
  with check (exists (select 1 from public.company_members m where m.company_id = interest_charges.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')));

grant select, insert, update, delete on public.interest_runs, public.interest_charges to authenticated;

-- What a run at p_as_of would charge: one row per overdue invoice.
create or replace function public.interest_calc(p_company uuid, p_as_of date)
returns table (
  customer_id uuid, customer_code text, customer_name text, currency_code text,
  invoice_id uuid, doc_no text, due_date date, outstanding numeric,
  rate numeric, from_date date, days integer, amount numeric
)
language sql stable security invoker set search_path = public as $$
  with s as (
    select cs.interest_rate, cs.interest_grace_days from public.company_settings cs where cs.company_id = p_company
  ), o as (
    select oi.* from public.sales_open_items(p_company => p_company, p_customer => null::uuid, p_as_of => p_as_of) oi
    where oi.doc_kind = 'invoice' and oi.outstanding > 0
      and not exists (select 1 from public.interest_charges x where x.interest_doc_id = oi.doc_id)
  ), c as (
    select o.*, cu.code as c_code, cu.name as c_name,
      case cu.interest_mode when 'custom' then cu.interest_rate when 'none' then null else s.interest_rate end as r,
      greatest(o.due_date + s.interest_grace_days,
        (select max(ic.to_date) from public.interest_charges ic where ic.invoice_id = o.doc_id)) as f,
      coalesce((select k.decimals from public.currencies k where k.code = o.currency_code), 2) as dec
    from o
    join public.customers cu on cu.id = o.customer_id
    cross join s
  )
  select c.customer_id, c.c_code::text, c.c_name::text, c.currency_code::text,
    c.doc_id, c.doc_no::text, c.due_date, c.outstanding::numeric,
    c.r::numeric, c.f, (p_as_of - c.f)::integer,
    round(c.outstanding * c.r / 100 * (p_as_of - c.f) / 365, c.dec::integer)::numeric
  from c
  where c.r > 0 and c.f is not null and p_as_of > c.f
    and round(c.outstanding * c.r / 100 * (p_as_of - c.f) / 365, c.dec::integer) > 0
  order by c.c_code, c.currency_code, c.due_date, c.doc_no;
$$;

-- Charges interest at p_date for the chosen customers and returns the run id.
create or replace function public.post_interest_run(p_company uuid, p_date date, p_customers uuid[])
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_set public.company_settings%rowtype;
  v_rows jsonb;
  v_run uuid;
  v_doc uuid;
  v_grp record;
  v_count integer := 0;
begin
  if not exists (select 1 from public.company_members m where m.company_id = p_company and m.user_id = auth.uid()
      and m.role in ('owner', 'admin', 'accountant')) then
    raise exception 'Only owners, admins and accountants can charge interest.';
  end if;
  select * into v_set from public.company_settings where company_id = p_company;
  if v_set.interest_account_id is null then
    raise exception 'Set the interest income account on Company Defaults first.';
  end if;

  select jsonb_agg(to_jsonb(c)) into v_rows
  from public.interest_calc(p_company, p_date) c where c.customer_id = any(p_customers);
  if v_rows is null then raise exception 'There is no interest to charge for the chosen customers at %.', p_date; end if;

  insert into public.interest_runs (company_id, run_date) values (p_company, p_date) returning id into v_run;

  for v_grp in
    select r.customer_id, r.currency_code,
      jsonb_agg(jsonb_build_object(
        'item_id', null, 'source_line_id', null, 'project_id', null,
        'description', format('Interest on %s: %s days from %s to %s at %s%% a year on %s',
          r.doc_no, r.days, r.from_date, p_date, trim(to_char(r.rate, 'FM999990.####')), trim(to_char(r.outstanding, 'FM999G999G999G990D00'))),
        'quantity', 1, 'unit_price', r.amount,
        'tax_code_id', v_set.interest_tax_code_id, 'account_id', v_set.interest_account_id
      ) order by r.due_date, r.doc_no) as lines
    from jsonb_to_recordset(v_rows) as r(customer_id uuid, currency_code text, doc_no text, due_date date, outstanding numeric,
      rate numeric, from_date date, days integer, amount numeric)
    group by r.customer_id, r.currency_code
  loop
    v_doc := public.save_sales_document(
      p_company => p_company, p_doc => null, p_type => 'invoice', p_customer => v_grp.customer_id,
      p_date => p_date, p_due => p_date, p_terms => null, p_currency => v_grp.currency_code,
      p_reference => 'Interest', p_notes => format('Interest on overdue invoices up to %s.', p_date),
      p_manual_rate => null, p_lines => v_grp.lines, p_warehouse => null);
    perform public.post_sales_document(p_doc => v_doc);

    insert into public.interest_charges (company_id, run_id, customer_id, invoice_id, interest_doc_id, currency_code,
      from_date, to_date, days, outstanding, rate, amount)
    select p_company, v_run, r.customer_id, r.invoice_id, v_doc, r.currency_code, r.from_date, p_date, r.days, r.outstanding, r.rate, r.amount
    from jsonb_to_recordset(v_rows) as r(customer_id uuid, currency_code text, invoice_id uuid, outstanding numeric,
      rate numeric, from_date date, days integer, amount numeric)
    where r.customer_id = v_grp.customer_id and r.currency_code = v_grp.currency_code;
    v_count := v_count + 1;
  end loop;

  update public.interest_runs set invoices_count = v_count where id = v_run;
  return v_run;
end $$;

grant execute on function public.interest_calc(uuid, date) to authenticated;
grant execute on function public.post_interest_run(uuid, date, uuid[]) to authenticated;
