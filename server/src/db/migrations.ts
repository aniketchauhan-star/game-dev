/**
 * Ordered SQL migrations. Never edit an applied migration; add a new one.
 * Each runs in its own transaction and is recorded in schema_migrations.
 */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'draft',
  create_step TEXT NOT NULL DEFAULT 'source',
  brief_json TEXT NOT NULL,
  brief_revision INTEGER NOT NULL DEFAULT 0,
  content_reviewed_at TEXT,
  current_version_id TEXT,
  source_revision TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  page_count INTEGER,
  slide_size_json TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  pages_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX source_documents_project ON source_documents(project_id);

CREATE TABLE source_slides (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  slide_number INTEGER NOT NULL,
  pptx_slide_id INTEGER NOT NULL,
  part_name TEXT NOT NULL,
  hidden INTEGER NOT NULL,
  included INTEGER NOT NULL,
  extract_json TEXT NOT NULL,
  edits_json TEXT NOT NULL,
  locked_wording INTEGER NOT NULL DEFAULT 0,
  required_example INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'needs_review',
  visual_ref_json TEXT,
  content_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, slide_number)
);
CREATE INDEX source_slides_project ON source_slides(project_id, slide_number);

CREATE TABLE slide_changes (
  id TEXT PRIMARY KEY,
  slide_id TEXT NOT NULL REFERENCES source_slides(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX slide_changes_slide ON slide_changes(slide_id, created_at);

CREATE TABLE slide_digests (
  slide_id TEXT NOT NULL REFERENCES source_slides(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  digest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (slide_id, content_hash, model)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  format TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  has_alpha INTEGER,
  duration_seconds REAL,
  source TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  stored_dir TEXT NOT NULL,
  original_file TEXT NOT NULL,
  display_file TEXT NOT NULL,
  display_mime TEXT NOT NULL,
  thumb_file TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX assets_project ON assets(project_id);

CREATE TABLE analyses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  origin TEXT NOT NULL,
  model TEXT,
  job_id TEXT,
  source_revision TEXT NOT NULL,
  source_snapshot_json TEXT NOT NULL DEFAULT '{}',
  brief_revision INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reason TEXT,
  analysis_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, number)
);

CREATE TABLE blueprint_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  parent_id TEXT,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  model TEXT,
  job_id TEXT,
  analysis_id TEXT,
  source_revision TEXT NOT NULL,
  source_snapshot_json TEXT NOT NULL DEFAULT '{}',
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reason TEXT,
  blueprint_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  UNIQUE(project_id, number)
);

CREATE TRIGGER blueprint_approved_content_immutable
BEFORE UPDATE OF blueprint_json, source_revision, source_snapshot_json, analysis_id, number, parent_id ON blueprint_revisions
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'approved blueprint revisions are immutable');
END;

CREATE TRIGGER blueprint_approved_status_forward
BEFORE UPDATE OF status ON blueprint_revisions
WHEN OLD.status <> 'draft' AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'an approved blueprint revision cannot return to draft');
END;

CREATE TABLE game_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  blueprint_revision_id TEXT,
  blueprint_revision_number INTEGER,
  parent_version_id TEXT,
  origin TEXT NOT NULL,
  summary TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, number)
);

CREATE TRIGGER game_versions_immutable
BEFORE UPDATE OF config_json, number, parent_version_id, blueprint_revision_id ON game_versions
BEGIN
  SELECT RAISE(ABORT, 'game versions are immutable');
END;

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_version_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  request TEXT NOT NULL,
  summary TEXT NOT NULL,
  explanation TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  model TEXT,
  job_id TEXT,
  result_version_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX proposals_project ON proposals(project_id, created_at);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  area TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  job_id TEXT,
  proposal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX chat_messages_project ON chat_messages(project_id, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  mode TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  usage_json TEXT,
  model TEXT,
  idempotency_key TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX jobs_idempotency ON jobs(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX jobs_queue ON jobs(status, created_at);
CREATE INDEX jobs_project ON jobs(project_id, created_at);

CREATE TABLE job_stages (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  status TEXT NOT NULL,
  output_json TEXT,
  usage_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, stage_key)
);

CREATE TABLE job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  stage TEXT,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX job_events_job ON job_events(job_id, seq);

CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  version_id TEXT,
  version_number INTEGER,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  include_source_material INTEGER NOT NULL,
  preflight_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  project_id TEXT,
  stage TEXT,
  requested_model TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  stop_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX usage_log_project ON usage_log(project_id, created_at);
`,
  },
  {
    version: 2,
    name: 'grade versions, design imports, screen maps, grade and motion plans',
    sql: `
-- Grade versions: each branch keeps its own blueprint revisions, game versions, screen map,
-- grade profile and motion. Sources and immutable assets stay shared at project level.
CREATE TABLE game_branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_branch_id TEXT,
  forked_from_version_id TEXT,
  current_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX game_branches_project ON game_branches(project_id, created_at);

ALTER TABLE projects ADD COLUMN active_branch_id TEXT;
-- Which bundled sample a sample project replays demo content for.
ALTER TABLE projects ADD COLUMN sample_id TEXT;
UPDATE projects SET sample_id = 'air-traffic' WHERE is_sample = 1;
ALTER TABLE game_versions ADD COLUMN branch_id TEXT;
ALTER TABLE blueprint_revisions ADD COLUMN branch_id TEXT;
ALTER TABLE exports ADD COLUMN branch_id TEXT;

INSERT INTO game_branches (id, project_id, name, parent_branch_id, forked_from_version_id, current_version_id, revision, created_at)
  SELECT 'brn_' || substr(id, 5), id, 'Main', NULL, NULL, current_version_id, 0, created_at FROM projects;
UPDATE projects SET active_branch_id = 'brn_' || substr(id, 5);
UPDATE game_versions SET branch_id = 'brn_' || substr(project_id, 5);
UPDATE blueprint_revisions SET branch_id = 'brn_' || substr(project_id, 5);
CREATE INDEX game_versions_branch ON game_versions(branch_id, number);
CREATE INDEX blueprint_revisions_branch ON blueprint_revisions(branch_id, number);

CREATE TRIGGER game_versions_branch_immutable
BEFORE UPDATE OF branch_id ON game_versions
WHEN OLD.branch_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a game version cannot move to another grade version');
END;

-- GradeProfile: immutable revisions per branch; the latest revision is current.
CREATE TABLE grade_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  origin TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(branch_id, revision)
);
CREATE INDEX grade_profiles_project ON grade_profiles(project_id);
CREATE TRIGGER grade_profiles_immutable
BEFORE UPDATE ON grade_profiles
BEGIN
  SELECT RAISE(ABORT, 'grade profile revisions are immutable');
END;

-- GradeAdaptationPlan: a proposal; per-item decisions change, the plan content never does.
CREATE TABLE grade_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  grade_profile_id TEXT NOT NULL,
  grade_profile_revision INTEGER NOT NULL,
  from_grade TEXT,
  to_grade TEXT NOT NULL,
  mode TEXT NOT NULL,
  origin TEXT NOT NULL,
  model TEXT,
  job_id TEXT,
  base_version_id TEXT,
  basis_json TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  decisions_json TEXT NOT NULL DEFAULT '{}',
  proposal_id TEXT,
  blueprint_revision_id TEXT,
  result_version_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(project_id, number)
);
CREATE INDEX grade_plans_branch ON grade_plans(branch_id, number);
CREATE TRIGGER grade_plans_content_immutable
BEFORE UPDATE OF plan_json, branch_id, grade_profile_revision, mode, base_version_id, basis_json ON grade_plans
BEGIN
  SELECT RAISE(ABORT, 'grade adaptation plans are immutable');
END;

-- MotionPlan: proposed animation bindings for the next build or for one version.
CREATE TABLE motion_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  grade_profile_revision INTEGER,
  origin TEXT NOT NULL,
  model TEXT,
  job_id TEXT,
  request TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  base_version_id TEXT,
  basis_json TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  decisions_json TEXT NOT NULL DEFAULT '{}',
  proposal_id TEXT,
  result_version_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(project_id, number)
);
CREATE INDEX motion_plans_branch ON motion_plans(branch_id, number);
CREATE TRIGGER motion_plans_content_immutable
BEFORE UPDATE OF plan_json, branch_id, base_version_id, basis_json, grade_profile_revision ON motion_plans
BEGIN
  SELECT RAISE(ABORT, 'motion plans are immutable');
END;

-- DesignImport: one Figma file (or a set of exported screens) brought into the project.
CREATE TABLE design_imports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  file_key TEXT,
  branch_key TEXT,
  requested_node_id TEXT,
  link TEXT,
  file_name TEXT NOT NULL,
  editor_type TEXT,
  source_version TEXT,
  last_modified TEXT,
  access_role TEXT,
  previous_import_id TEXT,
  available_json TEXT NOT NULL DEFAULT '[]',
  diff_json TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  imported_at TEXT,
  approved_at TEXT
);
CREATE INDEX design_imports_project ON design_imports(project_id, created_at);

-- DesignFrameSnapshot: an immutable local snapshot of one frame (elements, styles, render).
CREATE TABLE design_frames (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES design_imports(id) ON DELETE CASCADE,
  node_id TEXT,
  name TEXT NOT NULL,
  page_name TEXT NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  render_asset_id TEXT,
  snapshot_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX design_frames_import ON design_frames(import_id);
CREATE INDEX design_frames_project ON design_frames(project_id);
CREATE TRIGGER design_frames_immutable
BEFORE UPDATE ON design_frames
BEGIN
  SELECT RAISE(ABORT, 'design frame snapshots are immutable');
END;

-- Cached Figma API responses (never tokens), keyed by file version so stale data is not reused.
CREATE TABLE figma_cache (
  cache_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  body_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- SourceScreenMapping: immutable numbered revisions per branch; the latest is current.
CREATE TABLE screen_maps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  blueprint_revision_id TEXT,
  origin TEXT NOT NULL,
  note TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(branch_id, number)
);
CREATE INDEX screen_maps_project ON screen_maps(project_id);
CREATE TRIGGER screen_maps_immutable
BEFORE UPDATE ON screen_maps
BEGIN
  SELECT RAISE(ABORT, 'screen map revisions are immutable');
END;
`,
  },
];
