alter table scanner_devices add column if not exists device_secret text not null default '';
alter table scanner_devices add column if not exists password_salt text not null default '';
alter table scanner_devices add column if not exists password_hash text not null default '';
alter table scanner_devices add column if not exists device_owner text not null default '';
alter table scanner_devices add column if not exists device_phone text not null default '';

notify pgrst, 'reload schema';
