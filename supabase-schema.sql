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

create index if not exists cards_branch_idx on cards (branch);
create index if not exists cards_status_idx on cards (status);
create index if not exists cards_position_idx on cards (position);
create unique index if not exists cards_email_unique_idx on cards (lower(email)) where email <> '';

alter table cards add column if not exists email text not null default '';

alter table cards enable row level security;
alter table audit_log enable row level security;

-- Use Supabase service-role key on the server for admin operations.
-- Public verification should be exposed through a server endpoint, not direct anon table reads.
