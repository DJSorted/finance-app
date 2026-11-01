-- Shared links: the only change the app makes after creating a link is revoking it (js/core/share-link.js).
-- The update policy from 034 let a clerk rewrite any column, e.g. point their link at another company's
-- document, un-revoke it, extend expires_at or set a guessable token. Now only revoked_at can be updated,
-- and only to a revoke. get_shared_document (security definer) still bumps view_count.
-- Safe to run more than once.

revoke update on public.shared_links from authenticated;
grant update (revoked_at) on public.shared_links to authenticated;

drop policy if exists shared_links_update on public.shared_links;
create policy shared_links_update on public.shared_links for update to authenticated
  using (exists (select 1 from public.company_members m where m.company_id = shared_links.company_id and m.user_id = auth.uid()
    and m.role in ('owner', 'admin', 'accountant', 'clerk')))
  with check (revoked_at is not null
    and exists (select 1 from public.company_members m where m.company_id = shared_links.company_id and m.user_id = auth.uid()
      and m.role in ('owner', 'admin', 'accountant', 'clerk')));

notify pgrst, 'reload schema';
