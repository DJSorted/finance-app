-- Item barcodes: one optional barcode per item, unique within a company.
-- Holds a supplier's EAN/UPC, an in-store EAN-13 made by the app (starts with 20), or any Code 128 text.
-- Item link: an optional web address (product photo or web page) shown as a preview on items, POS and invoices.
-- Safe to run more than once.

alter table public.items add column if not exists barcode text;
alter table public.items add column if not exists link_url text;

alter table public.items drop constraint if exists items_link_url_web;
alter table public.items add constraint items_link_url_web check (link_url is null or link_url ~* '^https?://');

-- Blank barcodes are stored as null so many items can be without one.
update public.items set barcode = null where barcode is not null and btrim(barcode) = '';

alter table public.items drop constraint if exists items_barcode_not_blank;
alter table public.items add constraint items_barcode_not_blank check (barcode is null or btrim(barcode) <> '');

create unique index if not exists items_company_id_barcode_key on public.items (company_id, barcode) where barcode is not null;
