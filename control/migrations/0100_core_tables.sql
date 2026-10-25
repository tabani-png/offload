-- S2-01 control core: tenants and the org model (ADR 0101, 0102).
-- Every tenant table leads with tenant_id; foreign keys are composite (tenant_id, id) so a row can never point at
-- another tenant's row even though FK checks themselves ignore RLS.

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  workos_org_id text UNIQUE,
  workos_directory_id text UNIQUE,
  reporting_timezone text NOT NULL DEFAULT 'UTC',
  group_floor integer NOT NULL DEFAULT 5 CHECK (group_floor BETWEEN 5 AND 100),
  identity_sso boolean NOT NULL DEFAULT false,
  identity_directory_sync boolean NOT NULL DEFAULT false,
  retention_per_person_days integer NOT NULL DEFAULT 90 CHECK (retention_per_person_days BETWEEN 1 AND 90),
  retention_working_time_days integer NOT NULL DEFAULT 30 CHECK (retention_working_time_days BETWEEN 1 AND 30),
  retention_group_months integer NOT NULL DEFAULT 24 CHECK (retention_group_months BETWEEN 1 AND 24),
  monthly_worker_budget_cents bigint NOT NULL DEFAULT 0 CHECK (monthly_worker_budget_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  parent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES departments (tenant_id, id)
);

CREATE TABLE department_group_mappings (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  directory_group text NOT NULL CHECK (length(directory_group) BETWEEN 1 AND 200),
  department_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, directory_group),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE people (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  access_role text NOT NULL DEFAULT 'member'
    CHECK (access_role IN ('owner', 'admin', 'dept_lead', 'member', 'auditor')),
  department_id uuid,
  dept_lead_of jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dept_lead_of) = 'array'),
  jurisdiction text NOT NULL DEFAULT 'ZZ' CHECK (jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'leaving', 'frozen', 'departed')),
  leaving_on date,
  source text NOT NULL CHECK (source IN ('directory', 'invite', 'manual')),
  notice_ack_version_id uuid,
  workos_user_id text,
  directory_user_id text,
  pending_freeze_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)
);
CREATE UNIQUE INDEX people_email_uq ON people (tenant_id, lower(email));
CREATE UNIQUE INDEX people_directory_user_uq ON people (tenant_id, directory_user_id) WHERE directory_user_id IS NOT NULL;
CREATE UNIQUE INDEX people_workos_user_uq ON people (tenant_id, workos_user_id) WHERE workos_user_id IS NOT NULL;

CREATE TABLE job_roles (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  department_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)
);

CREATE TABLE job_role_holders (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  job_role_id uuid NOT NULL,
  person_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, job_role_id, person_id),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

-- References only: the credential lives in Composio / a Managed Agents vault (ADR 0101 §6).
CREATE TABLE connections (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('gmail', 'google_workspace_shared', 'outlook', 'm365_shared_mailbox',
    'composio_org', 'company_mcp', 'api', 'crm', 'company_linkedin_page', 'linkedin_personal', 'other')),
  ownership text NOT NULL CHECK (ownership IN ('company', 'personal-allowed', 'personal-forbidden')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  owner_person_id uuid,
  job_role_id uuid,
  provider text NOT NULL CHECK (provider IN ('composio', 'managed_agents_vault', 'mcp', 'api')),
  external_ref text NOT NULL CHECK (length(external_ref) <= 200),
  health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('ok', 'failed', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, id),
  CHECK (NOT (kind = 'linkedin_personal' AND ownership = 'company'))
);

CREATE TABLE role_identities (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_role_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  address text CHECK (length(address) <= 254),
  connection_id uuid NOT NULL,
  signature text NOT NULL DEFAULT '' CHECK (length(signature) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id)
);

CREATE TABLE support_grants (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  granted_by uuid NOT NULL,
  hours integer NOT NULL CHECK (hours BETWEEN 1 AND 72),
  read_only boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES people (tenant_id, id)
);
