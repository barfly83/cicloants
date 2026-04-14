-- RESET COMPLETO DATI APPLICATIVI
-- Da eseguire nello SQL Editor di Supabase quando vuoi ripartire da zero.
-- ATTENZIONE: distrugge tutti i dati tracce/feromoni/profili.

begin;

truncate table public.pheromones;
truncate table public.tracks;
truncate table public.profiles;

commit;
