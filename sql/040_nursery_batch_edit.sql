-- Nursery: edit a batch's details (name, sown date, location, notes) after it is created.
-- Only descriptive fields change. Variety, plant counts and costs stay as posted, so no journals are touched.
-- Safe to run more than once.

create or replace function public.nursery_update_batch(p_company uuid, p_batch uuid, p_name text, p_sown date,
  p_location text, p_notes text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  b nursery_batches%rowtype;
begin
  if not is_member(p_company, array['owner','admin','accountant','clerk']) then
    raise exception 'You do not have access to change nursery batches';
  end if;
  select * into b from nursery_batches where id = p_batch and company_id = p_company for update;
  if not found then raise exception 'Batch not found'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Enter the batch name'; end if;
  if p_sown is null then raise exception 'Enter the sown date'; end if;
  if p_sown > current_date then raise exception 'The sown date cannot be in the future'; end if;
  if b.expected_ready is not null and p_sown > b.expected_ready then
    raise exception 'The sown date cannot be after the expected ready date (%)', b.expected_ready;
  end if;

  update nursery_batches
     set name = trim(p_name), sown_date = p_sown,
         location = nullif(trim(p_location), ''), notes = nullif(trim(p_notes), '')
   where id = p_batch;
end $$;

revoke execute on function public.nursery_update_batch(uuid, uuid, text, date, text, text) from public, anon;
grant execute on function public.nursery_update_batch(uuid, uuid, text, date, text, text) to authenticated;

notify pgrst, 'reload schema';
