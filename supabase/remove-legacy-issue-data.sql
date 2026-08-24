do $$
begin
  if to_regclass('public.sheet_configs') is not null then
    delete from public.sheet_configs where key = 'sheet-1';
  end if;
end;
$$;
