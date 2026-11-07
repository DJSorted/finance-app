-- Stock revaluation: split one value change (freight, write-down, price correction) across selected items
-- in a warehouse, weighted by each item's stock value on hand. Quantities stay the same; value and average
-- cost change. Posts Dr/Cr inventory against each item's category adjustment account, numbered from the
-- stock_adjustment sequence and listed on the Stock Adjustments page.
-- Movements have qty 0: stock_ledger, stock_valuation and stock_reconciliation already handle that.
-- Safe to run more than once.

alter table public.stock_movements drop constraint if exists stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check check (movement_type in (
  'opening', 'adjustment', 'revaluation', 'transfer_in', 'transfer_out', 'receipt', 'return_out', 'issue', 'sale',
  'sale_return', 'production_in', 'production_out'));

alter table public.stock_documents drop constraint if exists stock_documents_doc_type_check;
alter table public.stock_documents add constraint stock_documents_doc_type_check
  check (doc_type in ('opening', 'adjustment', 'revaluation', 'transfer'));

create or replace function public.post_stock_revaluation(p_company uuid, p_date date, p_warehouse uuid, p_reason text,
  p_reference text, p_total numeric, p_items uuid[])
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid; v_no text; v_j uuid; v_base text; wh warehouses%rowtype; n int;
  v_total numeric; v_weight numeric; v_left numeric; v_top uuid; v_share numeric; i int := 0; r record;
begin
  if not is_member(p_company, array['owner','admin','accountant']) then
    raise exception 'Only an accountant can post stock revaluations';
  end if;
  if p_date is null then raise exception 'Enter the date'; end if;
  select * into wh from warehouses where id = p_warehouse and company_id = p_company and is_active;
  if not found then raise exception 'Choose an active warehouse'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Enter a reason for the revaluation'; end if;
  v_total := round(p_total, 2);
  if v_total is null or v_total = 0 then raise exception 'Enter the value to split'; end if;
  if p_items is null or cardinality(p_items) = 0 then raise exception 'Choose at least one item'; end if;
  v_base := base_currency(p_company);

  -- lock the balances, then check every chosen item before splitting
  perform 1 from stock_balances
   where company_id = p_company and warehouse_id = p_warehouse and item_id = any (p_items)
     for update;
  for r in
    select s.id, it.code, it.is_active, it.item_type, b.qty_on_hand, b.value
      from (select distinct unnest(p_items) as id) s
      left join items it on it.id = s.id and it.company_id = p_company
      left join stock_balances b on b.company_id = p_company and b.item_id = s.id and b.warehouse_id = p_warehouse
  loop
    if r.code is null or not r.is_active then raise exception 'An item was not found or is inactive'; end if;
    if r.item_type not in ('stock','manufactured') then raise exception '% is a service and is not held in stock', r.code; end if;
    if coalesce(r.qty_on_hand, 0) <= 0 or coalesce(r.value, 0) <= 0 then
      raise exception '% has no stock value on hand in %, so it cannot share in the revaluation', r.code, wh.code;
    end if;
  end loop;

  -- each item's share by value on hand; the rounding difference goes to the item with the largest value
  select sum(value) into v_weight
    from stock_balances where company_id = p_company and warehouse_id = p_warehouse and item_id = any (p_items);
  if v_total < 0 and -v_total > v_weight then
    raise exception 'The write-down of % is more than the % stock value of the chosen items', -v_total, v_weight;
  end if;
  select v_total - sum(round(v_total * value / v_weight, 2)) into v_left
    from stock_balances where company_id = p_company and warehouse_id = p_warehouse and item_id = any (p_items);
  select b.item_id into v_top
    from stock_balances b join items it on it.id = b.item_id
   where b.company_id = p_company and b.warehouse_id = p_warehouse and b.item_id = any (p_items)
   order by b.value desc, it.code limit 1;

  v_no := next_doc_number(p_company, 'stock_adjustment');
  insert into stock_documents (company_id, doc_type, doc_no, doc_date, warehouse_id, reason, reference)
  values (p_company, 'revaluation', v_no, p_date, p_warehouse, trim(p_reason), nullif(trim(p_reference), ''))
  returning id into v_id;
  insert into journals (company_id, journal_date, description, reference, source_type, source_id)
  values (p_company, p_date, 'Stock revaluation ' || v_no || ' - ' || wh.name, nullif(trim(p_reference), ''),
          'stock_adjustment', v_id)
  returning id into v_j;

  for r in
    select b.item_id, it.code, b.qty_on_hand as qty, b.value
      from stock_balances b join items it on it.id = b.item_id
     where b.company_id = p_company and b.warehouse_id = p_warehouse and b.item_id = any (p_items)
     order by it.code
  loop
    v_share := round(v_total * r.value / v_weight, 2) + case when r.item_id = v_top then v_left else 0 end;
    continue when v_share = 0;
    if r.value + v_share < 0 then raise exception 'The write-down would take % below zero value', r.code; end if;
    i := i + 1;
    update stock_balances set value = value + v_share, avg_cost = round((value + v_share) / qty_on_hand, 6), updated_at = now()
     where company_id = p_company and item_id = r.item_id and warehouse_id = p_warehouse;
    insert into stock_movements (company_id, item_id, warehouse_id, movement_date, movement_type, qty, value,
                                 qty_after, value_after, source_type, source_id, source_no)
    values (p_company, r.item_id, p_warehouse, p_date, 'revaluation', 0, v_share, r.qty, r.value + v_share,
            'stock_adjustment', v_id, v_no);
    -- unit_cost holds the change in average cost per unit
    insert into stock_document_lines (company_id, document_id, line_no, item_id, qty, unit_cost, value,
                                      inventory_account_id, counter_account_id)
    values (p_company, v_id, i, r.item_id, 0, round(v_share / r.qty, 6), v_share,
            item_account(r.item_id, 'inventory'), item_account(r.item_id, 'adjustment'));
  end loop;
  if i = 0 then raise exception 'The value is too small to split across the chosen items'; end if;

  insert into journal_lines (company_id, journal_id, line_no, account_id, description, currency_code,
                             trx_debit, trx_credit, fx_rate, rate_source)
  select p_company, v_j, 100 + (row_number() over (order by y.acc))::int, y.acc, 'Stock revaluation', v_base,
         case when y.net > 0 then y.net else 0 end, case when y.net < 0 then -y.net else 0 end, 1, 'base'
    from (select x.acc, sum(x.amt) as net from (
            select inventory_account_id as acc, value as amt from stock_document_lines where document_id = v_id
            union all
            select counter_account_id, -value from stock_document_lines where document_id = v_id) x
          group by x.acc) y
   where y.net <> 0;
  get diagnostics n = row_count;

  if n = 0 then
    delete from journals where id = v_j;     -- inventory and adjustment account are the same, nothing to post
  else
    perform post_journal_internal(v_j);
    update stock_documents set journal_id = v_j where id = v_id;
  end if;
  update stock_documents set total_value = v_total where id = v_id;
  return v_id;
end $$;

revoke execute on function public.post_stock_revaluation(uuid, date, uuid, text, text, numeric, uuid[]) from public, anon;
grant execute on function public.post_stock_revaluation(uuid, date, uuid, text, text, numeric, uuid[]) to authenticated;

notify pgrst, 'reload schema';
