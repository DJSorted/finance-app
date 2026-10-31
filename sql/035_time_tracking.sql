-- Time tracking and billing time.
-- Time is logged against a project (projects already belong to a customer and a company). A project can carry an
-- hourly rate and the service item that time is invoiced as. Billing picks unbilled time for one customer and raises a
-- draft sales invoice through save_sales_document; the invoice is numbered from the Sales invoice number sequence when
-- it is posted. Deleting the draft (or releasing it) puts the time back to unbilled. Billed time is locked.
-- Requires the existing save_sales_document and customer_defaults functions. Safe to run more than once.

-- per project: rate and the item time is billed as
alter table public.projects add column if not exists hourly_rate numeric(18,4) check (hourly_rate is null or hourly_rate >= 0);
alter table public.projects add column if not exists time_item_id uuid references public.items(id) on delete set null;

create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete restrict,
  user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  start_at timestamptz not null default now(),
  end_at timestamptz,
  minutes integer,
  notes text,
  billable boolean not null default true,
  invoice_id uuid references public.sales_documents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists time_entries_company_idx on public.time_entries (company_id, start_at desc);
create index if not exists time_entries_project_idx on public.time_entries (project_id, start_at desc);
create index if not exists time_entries_invoice_idx on public.time_entries (invoice_id);
-- one running timer per person, across all their companies
create unique index if not exists time_entries_one_running on public.time_entries (user_id) where end_at is null;

-- Works out minutes, keeps the company in step with the project, and locks time that is on an invoice.
create or replace function public.time_entries_guard()
returns trigger language plpgsql security invoker set search_path = public as $$
declare
  v_proj public.projects%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.invoice_id is not null then
      raise exception 'This time is on an invoice, so it cannot be deleted. Delete or release the draft invoice first.';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.invoice_id is not null then
    -- the only change allowed on billed time is taking it off the invoice
    if new.invoice_id is null and (new.project_id, new.start_at, new.end_at, new.notes, new.billable)
        is not distinct from (old.project_id, old.start_at, old.end_at, old.notes, old.billable) then
      new.updated_at := now();
      return new;
    end if;
    raise exception 'This time is on an invoice, so it cannot be changed.';
  end if;

  select * into v_proj from public.projects where id = new.project_id;
  if not found then raise exception 'Project not found.'; end if;
  if tg_op = 'INSERT' or new.project_id is distinct from old.project_id then
    if v_proj.status = 'closed' then raise exception 'Project % is closed, so no time can be logged to it.', v_proj.code; end if;
  end if;
  new.company_id := v_proj.company_id;

  if new.end_at is not null then
    if new.end_at <= new.start_at then raise exception 'The end time must be after the start time.'; end if;
    new.minutes := greatest(1, round(extract(epoch from (new.end_at - new.start_at)) / 60))::integer;
  else
    new.minutes := null;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists time_entries_guard on public.time_entries;
create trigger time_entries_guard before insert or update or delete on public.time_entries
  for each row execute function public.time_entries_guard();

alter table public.time_entries enable row level security;

-- Any member can read the company's time. Members log their own time; owners, admins and accountants can change anyone's.
drop policy if exists time_entries_read on public.time_entries;
create policy time_entries_read on public.time_entries for select to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = time_entries.company_id and m.user_id = auth.uid()));

drop policy if exists time_entries_insert on public.time_entries;
create policy time_entries_insert on public.time_entries for insert to authenticated
  with check (user_id = auth.uid()
    and exists (select 1 from public.company_members m where m.company_id = time_entries.company_id and m.user_id = auth.uid()));

drop policy if exists time_entries_change on public.time_entries;
create policy time_entries_change on public.time_entries for update to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = time_entries.company_id and m.user_id = auth.uid()
    and (time_entries.user_id = auth.uid() or m.role in ('owner', 'admin', 'accountant'))))
  with check (exists (select 1 from public.company_members m where m.company_id = time_entries.company_id and m.user_id = auth.uid()
    and (time_entries.user_id = auth.uid() or m.role in ('owner', 'admin', 'accountant'))));

drop policy if exists time_entries_delete on public.time_entries;
create policy time_entries_delete on public.time_entries for delete to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = time_entries.company_id and m.user_id = auth.uid()
    and (time_entries.user_id = auth.uid() or m.role in ('owner', 'admin', 'accountant'))));

grant select, insert, update, delete on public.time_entries to authenticated;

-- Starts a timer on a project, stopping any timer you already have running (in any company). Returns the new entry id.
create or replace function public.start_timer(p_project uuid, p_notes text default null)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
begin
  update public.time_entries set end_at = greatest(now(), start_at + interval '1 minute')
    where user_id = auth.uid() and end_at is null;
  insert into public.time_entries (company_id, project_id, user_id, start_at, notes)
    select p.company_id, p.id, auth.uid(), now(), nullif(trim(p_notes), '') from public.projects p where p.id = p_project
    returning id into v_id;
  if v_id is null then raise exception 'Project not found.'; end if;
  return v_id;
end $$;

-- Stops your running timer, if any. Returns the entry id (null when nothing was running).
create or replace function public.stop_timer(p_notes text default null)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
begin
  update public.time_entries
    set end_at = greatest(now(), start_at + interval '1 minute'), notes = coalesce(nullif(trim(p_notes), ''), notes)
    where user_id = auth.uid() and end_at is null
    returning id into v_id;
  return v_id;
end $$;

-- Raises a draft invoice for the chosen time entries (all for one customer) and returns its id.
-- p_detail false: one line per project (total hours). true: one line per entry (date and notes).
-- p_discount: percentage taken off the rate.
create or replace function public.bill_time(p_company uuid, p_entries uuid[], p_date date,
  p_detail boolean default false, p_discount numeric default 0)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_cust uuid;
  v_n integer;
  v_def record;
  v_cur text;
  v_due date;
  v_terms public.payment_terms%rowtype;
  v_lines jsonb;
  v_doc uuid;
  v_bad text;
  v_disc numeric := coalesce(p_discount, 0);
begin
  if p_entries is null or cardinality(p_entries) = 0 then raise exception 'Choose the time to bill.'; end if;
  if v_disc < 0 or v_disc >= 100 then raise exception 'The discount must be from 0 up to (not including) 100%%.'; end if;

  select count(*) into v_n from public.time_entries where id = any(p_entries) and company_id = p_company;
  if v_n <> cardinality(p_entries) then raise exception 'Some of the chosen time was not found in this company.'; end if;
  if exists (select 1 from public.time_entries where id = any(p_entries) and invoice_id is not null) then
    raise exception 'Some of the chosen time is already on an invoice.';
  end if;
  if exists (select 1 from public.time_entries where id = any(p_entries) and end_at is null) then
    raise exception 'Stop the running timer before billing its time.';
  end if;
  if exists (select 1 from public.time_entries where id = any(p_entries) and not billable) then
    raise exception 'Some of the chosen time is marked as not billable.';
  end if;

  select min(p.code) into v_bad from public.time_entries t join public.projects p on p.id = t.project_id
    where t.id = any(p_entries) and p.customer_id is null;
  if v_bad is not null then raise exception 'Project % has no customer, so its time cannot be invoiced.', v_bad; end if;
  select count(distinct p.customer_id) into v_n from public.time_entries t join public.projects p on p.id = t.project_id
    where t.id = any(p_entries);
  if v_n > 1 then raise exception 'Bill one customer at a time.'; end if;
  select p.customer_id into v_cust from public.time_entries t join public.projects p on p.id = t.project_id
    where t.id = any(p_entries) limit 1;

  select min(p.code) into v_bad from public.time_entries t join public.projects p on p.id = t.project_id
    left join public.items i on i.id = p.time_item_id
    where t.id = any(p_entries) and (i.id is null or i.item_type <> 'service');
  if v_bad is not null then raise exception 'Set the billing item (a service item) on project % first.', v_bad; end if;
  select min(p.code) into v_bad from public.time_entries t join public.projects p on p.id = t.project_id
    join public.items i on i.id = p.time_item_id
    where t.id = any(p_entries) and coalesce(p.hourly_rate, i.sales_price) is null;
  if v_bad is not null then raise exception 'Set the hourly rate on project % (or a sales price on its item) first.', v_bad; end if;

  select * into v_def from public.customer_defaults(p_customer => v_cust) limit 1;
  v_cur := coalesce(v_def.currency_code, (select cc.code from public.company_currencies cc where cc.company_id = p_company and cc.is_base));
  v_due := p_date;
  if v_def.payment_terms_id is not null then
    select * into v_terms from public.payment_terms where id = v_def.payment_terms_id;
    if found then
      v_due := case when v_terms.basis = 'days_from_month_end'
        then (date_trunc('month', p_date) + interval '1 month - 1 day')::date + v_terms.days
        else p_date + v_terms.days end;
    end if;
  end if;

  with e as (
    select t.*, p.code as p_code, p.name as p_name, p.id as p_id,
      coalesce(p.hourly_rate, i.sales_price) * (1 - v_disc / 100) as rate,
      i.id as item_id, coalesce(i.sales_tax_code_id, c.sales_tax_code_id, v_def.tax_code_id) as tax_id
    from public.time_entries t
    join public.projects p on p.id = t.project_id
    join public.items i on i.id = p.time_item_id
    left join public.item_categories c on c.id = i.category_id
    where t.id = any(p_entries)
  ), l as (
    select min(e.start_at) as first_at, e.p_code,
      jsonb_build_object(
        'item_id', e.item_id, 'source_line_id', null, 'project_id', e.p_id, 'account_id', null, 'tax_code_id', e.tax_id,
        'quantity', round(sum(e.minutes) / 60.0, 2), 'unit_price', round(e.rate, 4),
        'description', case when p_detail
          then concat_ws(': ', to_char(min(e.start_at), 'YYYY-MM-DD'), coalesce(nullif(min(e.notes), ''), e.p_name))
          else format('%s: %s to %s', e.p_name, to_char(min(e.start_at), 'YYYY-MM-DD'), to_char(max(e.start_at), 'YYYY-MM-DD')) end
          || case when v_disc > 0 then format(' (%s%% discount)', trim(to_char(v_disc, 'FM990.##'))) else '' end
      ) as line
    from e
    group by case when p_detail then e.id end, e.p_id, e.p_code, e.p_name, e.item_id, e.tax_id, e.rate
  )
  select jsonb_agg(l.line order by l.p_code, l.first_at) into v_lines from l;

  v_doc := public.save_sales_document(
    p_company => p_company, p_doc => null, p_type => 'invoice', p_customer => v_cust,
    p_date => p_date, p_due => v_due, p_terms => null, p_currency => v_cur,
    p_reference => 'Time', p_notes => null, p_manual_rate => null, p_lines => v_lines, p_warehouse => null);

  update public.time_entries set invoice_id = v_doc where id = any(p_entries);
  return v_doc;
end $$;

-- Takes all time off a draft invoice (the draft itself is left as it is).
create or replace function public.release_time(p_doc uuid)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_n integer;
begin
  if exists (select 1 from public.sales_documents where id = p_doc and status <> 'draft') then
    raise exception 'The invoice is posted, so its time stays billed. Credit the invoice instead.';
  end if;
  update public.time_entries set invoice_id = null where invoice_id = p_doc;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

grant execute on function public.start_timer(uuid, text) to authenticated;
grant execute on function public.stop_timer(text) to authenticated;
grant execute on function public.bill_time(uuid, uuid[], date, boolean, numeric) to authenticated;
grant execute on function public.release_time(uuid) to authenticated;
