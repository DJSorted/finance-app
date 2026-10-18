-- Item groups: a managed list for grouping items, separate from the category.
-- The category drives the accounting; the group is only for sorting, searching and reports (not printed on documents).
-- Safe to run more than once. If an earlier draft of this file added a free-text items.item_group column,
-- its values are moved into the list and the column is dropped.

create table if not exists public.item_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

alter table public.items add column if not exists item_group_id uuid references public.item_groups(id) on delete restrict;
create index if not exists items_item_group_id_idx on public.items (item_group_id) where item_group_id is not null;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'item_group') then
    insert into public.item_groups (company_id, code, name)
    select distinct on (company_id, upper(btrim(item_group))) company_id, upper(btrim(item_group)), btrim(item_group)
    from public.items where item_group is not null and btrim(item_group) <> ''
    on conflict (company_id, code) do nothing;
    update public.items i set item_group_id = g.id
    from public.item_groups g
    where g.company_id = i.company_id and g.code = upper(btrim(i.item_group)) and i.item_group_id is null;
    alter table public.items drop constraint if exists items_item_group_not_blank;
    drop index if exists public.items_company_id_item_group_idx;
    alter table public.items drop column item_group;
  end if;
end $$;

alter table public.item_groups enable row level security;

-- Any member of the company can read; owners, admins and accountants can change.
drop policy if exists item_groups_read on public.item_groups;
create policy item_groups_read on public.item_groups for select to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = item_groups.company_id and m.user_id = auth.uid()));

drop policy if exists item_groups_write on public.item_groups;
create policy item_groups_write on public.item_groups for all to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = item_groups.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')))
  with check (exists (select 1 from public.company_members m where m.company_id = item_groups.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant')));

grant select, insert, update, delete on public.item_groups to authenticated;
