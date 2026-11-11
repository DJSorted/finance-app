-- Time on an invoice (draft or posted) can still have its notes edited. Everything else about billed time stays
-- locked: project, start, end and billable cannot change, and it cannot be deleted. The invoice line text is its
-- own copy, so editing the notes here does not change an invoice already raised.
-- Safe to run more than once.

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
    -- on billed time only the notes can change, or the time can be taken off the invoice
    if (new.invoice_id is null or new.invoice_id = old.invoice_id)
        and (new.project_id, new.start_at, new.end_at, new.billable, new.minutes, new.company_id)
        is not distinct from (old.project_id, old.start_at, old.end_at, old.billable, old.minutes, old.company_id) then
      new.updated_at := now();
      return new;
    end if;
    raise exception 'This time is on an invoice, so only its notes can be changed.';
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
