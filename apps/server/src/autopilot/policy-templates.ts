// Starting points for .factory/policy.yml, from the most careful to the most
// hands-off. Each is a complete, commented file that keeps only what differs
// from the factory's defaults, so a team reads what it chose and why. Every
// one leaves release to a person: `release.auto` is written out as false so
// nobody has to know it's the default.

export interface PolicyTemplate {
  id: string;
  name: string;
  /** One sentence a person can choose by. */
  summary: string;
  yaml: string;
}

const head = (title: string, lines: string[]) => [`# ${title}`, ...lines.map((l) => `# ${l}`), "version: 1", ""].join("\n");

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: "recommended",
    name: "Recommended",
    summary: "Runs start supervised: a person approves the plan, small, low-risk work orders merge on their own, and a person releases.",
    yaml: `${head("Software Factory policy: recommended", [
      "Runs start supervised: a person approves each plan (whoever starts a run can make it",
      "autonomous, and then the critic does). A work order merges on its own when its gates,",
      "review and scans pass and it stays out of sensitive paths; anything else waits in the Inbox.",
      "Releasing into the base branch is always a person's click.",
    ])}autonomy: { default: supervised, max: autonomous }
release: { auto: false }        # a person releases (the default, written out)
`,
  },
  {
    id: "cautious",
    name: "Cautious",
    summary: "A person approves the spec, the plan and every merge, and releases. For a first project or a sensitive system.",
    yaml: `${head("Software Factory policy: cautious", [
      "People approve the spec, the plan and every merge, in every run (outside requests too).",
      "Hidden acceptance tests are on, and reviews block on medium findings too.",
    ])}autonomy: { default: suggest, max: suggest }   # max supervised would let a run's merges follow the rules
review: { blocking: [critical, high, medium] }
hiddenTests: { enabled: true }
release: { auto: false }        # a person releases
budget: { perWorkOrderUsd: 3, perChangeUsd: 15 }
`,
  },
  {
    id: "federal",
    name: "Federal, strict",
    summary: "Supervised, with hidden tests, wider sensitive paths and no outside requests starting runs; the preview is ready to turn on.",
    yaml: `${head("Software Factory policy: federal, strict", [
      "Runs are supervised at most. Hidden acceptance tests are on; turn the preview on once the",
      "app starts with its start command. Auth, crypto, infrastructure, CI and data-access code",
      "always waits for a person, and so does any change to this policy or to AGENTS.md.",
      "Outside requests wait in the Inbox; webhooks are off.",
    ])}autonomy: { default: supervised, max: supervised }
review: { blocking: [critical, high, medium] }
hiddenTests: { enabled: true }
preview: { enabled: false, start: "npm start", paths: ["/"] }   # turn on once the app starts with npm start
autoMerge:
  maxChangedLines: 250
  sensitivePaths: ["**/auth/**", "**/auth.*", "**/crypto/**", "**/*crypto*", "**/migrations/**",
                   "**/db/**", "**/*.sql", "**/security/**", "**/iam/**",
                   ".env", ".env.local", ".env.*.local", ".env.production", ".env.development", "**/*.pem", "**/*.key",
                   "infra/**", "**/terraform/**", "**/*.tf", "**/*.tfvars", "**/k8s/**", "**/helm/**",
                   "Dockerfile*", "docker-compose*.yml", "docker-compose*.yaml",
                   "**/.github/**", ".gitlab/**", ".gitlab-ci.yml", "Jenkinsfile", ".factory/**", "AGENTS.md", "CLAUDE.md"]
intake: { github: inbox, webhook: off, bug: inbox, autonomy: supervised }
release: { auto: false }        # a person releases
`,
  },
  {
    id: "autonomous",
    name: "Hands-off",
    summary: "A critic approves the plan and work orders merge on their own within the rules; a person still releases.",
    yaml: `${head("Software Factory policy: hands-off", [
      "Runs default to autonomous: a critic approves the plan, and work orders merge on their own",
      "within the rules below. People see only what the rules send them, and they still release.",
    ])}autonomy: { default: autonomous, max: autonomous }
hiddenTests: { enabled: true }
queue: { maxActiveRuns: 3 }
release: { auto: false }        # a person releases; set true only for a repo whose base branch isn't production
`,
  },
];

export const templateById = (id: string) => POLICY_TEMPLATES.find((t) => t.id === id);

/** A starter AGENTS.md for a workspace that has none. */
export const STARTER_AGENTS_MD = `# Instructions for agents

The Software Factory's agents read this file. Keep it short and specific to this repo.

- Run the tests before you finish, and leave them passing.
- Never write credentials, tokens or keys into code, tests or config: read them from the environment.
- Pin dependencies to exact versions.
- Keep changes to what the work order asks for.
`;
