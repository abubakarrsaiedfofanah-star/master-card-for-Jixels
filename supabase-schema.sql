create table if not exists cards (
  id text primary key,
  organization_id text,
  organization_name text,
  card_type text not null default 'user',
  role_type text,
  fields jsonb not null default '{}'::jsonb,
  name text not null,
  location text not null,
  branch text not null,
  national_id text not null,
  phone text not null,
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

create table if not exists organizations (
  id text primary key,
  name text not null,
  type text not null default 'custom',
  business_number text not null,
  email text not null,
  phone text not null,
  logo text not null default '',
  brand_color text not null default '#357fbd',
  template_id text not null default 'sample',
  owner_name text not null default '',
  salt text not null,
  password_hash text not null,
  status text not null default 'Pending',
  subscription_status text not null default 'Pending',
  back_settings jsonb not null default '{}'::jsonb,
  master_card jsonb not null default '{}'::jsonb,
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
create index if not exists cards_organization_idx on cards (organization_id);
create unique index if not exists organizations_email_unique_idx on organizations (lower(email));
create unique index if not exists organizations_business_number_unique_idx on organizations (lower(business_number));

alter table cards add column if not exists email text not null default '';
alter table cards add column if not exists organization_id text;
alter table cards add column if not exists organization_name text;
alter table cards add column if not exists card_type text not null default 'user';
alter table cards add column if not exists role_type text;
alter table cards add column if not exists fields jsonb not null default '{}'::jsonb;
alter table organizations add column if not exists brand_color text not null default '#357fbd';

alter table cards drop constraint if exists cards_national_id_key;
alter table cards drop constraint if exists cards_phone_key;
drop index if exists cards_email_unique_idx;

create unique index if not exists cards_scoped_national_id_unique_idx on cards (coalesce(organization_id, 'legacy'), national_id) where national_id <> '';
create unique index if not exists cards_scoped_phone_unique_idx on cards (coalesce(organization_id, 'legacy'), phone) where phone <> '';
create unique index if not exists cards_scoped_email_unique_idx on cards (coalesce(organization_id, 'legacy'), lower(email)) where email <> '';

alter table cards enable row level security;
alter table audit_log enable row level security;
alter table organizations enable row level security;

-- Use Supabase service-role key on the server for admin operations.
-- Public verification should be exposed through a server endpoint, not direct anon table reads.
