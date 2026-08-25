drop policy if exists "authenticated read vehicles" on public.vehicles;
drop policy if exists "public read vehicles" on public.vehicles;
create policy "public read vehicles"
on public.vehicles
for select
to anon, authenticated
using (true);

drop policy if exists "authenticated read vehicle component versions" on public.vehicle_component_versions;
drop policy if exists "public read vehicle component versions" on public.vehicle_component_versions;
create policy "public read vehicle component versions"
on public.vehicle_component_versions
for select
to anon, authenticated
using (true);
