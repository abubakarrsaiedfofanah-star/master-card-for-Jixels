create table if not exists cards (
  id text primary key,
  name text not null,
  location text not null,
  branch text not null,
  national_id text not null unique,
  phone text not null unique,
  email text not null default '',
  position text not null,
  photo text not null,
  verification_token text not null unique,
  status text not null default 'Pending',
  inactive_reason text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  action text not null,
  card_id text,
  actor text not null,
  created_at timestamptz not null default now()
);

create table if not exists attendance_records (
  id text primary key,
  card_id text not null,
  worker_name text not null,
  worker_id text not null,
  branch text not null default '',
  position text not null default '',
  attendance_date date not null,
  signed_in_at timestamptz,
  signed_out_at timestamptz,
  sign_in_latitude numeric,
  sign_in_longitude numeric,
  sign_out_latitude numeric,
  sign_out_longitude numeric,
  location_accuracy numeric,
  scan_source text not null default 'card-scan',
  status text not null default 'Signed Out',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists scanner_devices (
  id text primary key,
  device_id text not null unique,
  device_secret text not null default '',
  device_name text not null default '',
  registered_by text not null default 'admin',
  status text not null default 'Active',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists cards_branch_idx on cards (branch);
create index if not exists cards_status_idx on cards (status);
create index if not exists cards_position_idx on cards (position);
create unique index if not exists cards_email_unique_idx on cards (lower(email)) where email <> '';
create index if not exists attendance_card_idx on attendance_records (card_id);
create index if not exists attendance_date_idx on attendance_records (attendance_date);
create index if not exists attendance_status_idx on attendance_records (status);
create index if not exists scanner_devices_status_idx on scanner_devices (status);

alter table cards add column if not exists email text not null default '';
alter table scanner_devices add column if not exists device_secret text not null default '';

alter table cards enable row level security;
alter table audit_log enable row level security;
alter table attendance_records enable row level security;
alter table scanner_devices enable row level security;

-- Use Supabase service-role key on the server for admin operations.
-- Public verification should be exposed through a server endpoint, not direct anon table reads.
