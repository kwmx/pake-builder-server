export type Platform = 'linux' | 'windows' | 'macos';
export const PLATFORMS: Platform[] = ['linux', 'windows', 'macos'];

export interface BuildInput {
  url: string;
  name: string;
  icon?: string;
  width: number;
  height: number;
  platforms: Platform[];
}

export type JobStatus =
  | 'queued'        // accepted, not yet dispatched
  | 'dispatching'   // calling the GitHub dispatch API
  | 'locating'      // waiting for the run to appear
  | 'running'       // run in progress on GitHub
  | 'collecting'    // downloading artifacts
  | 'done'          // finished (see artifacts)
  | 'error';        // failed with no artifacts

export interface LegStatus {
  os: string;                 // linux | windows | macos
  status: string;             // queued | in_progress | completed
  conclusion: string | null;  // success | failure | cancelled | …
}

export interface ArtifactFile {
  os: string;
  file: string;   // path relative to the job dir, e.g. "macos/MyApp.dmg"
  name: string;   // basename for display
  size: number;
}

export interface Job {
  id: string;
  buildId: string;            // unique correlation id echoed into the run name
  input: BuildInput;
  status: JobStatus;
  runId?: number;
  runUrl?: string;
  legs: LegStatus[];
  artifacts: ArtifactFile[];
  log: string[];
  error?: string;
  warning?: string;
  createdAt: number;
  finishedAt?: number;
}
