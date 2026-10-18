// Attestations made only from recorded facts: an in-toto Statement v1 about a
// finished run's artifact commit, in a DSSE envelope signed with this
// factory's Ed25519 key (data/signing/, made on first use, never backed up or
// sent anywhere but the public half), and an OSCAL assessment-results
// document. Each lists what's missing instead of being produced with a gap.
// Both say what they are: the factory's statement of what it recorded, not a
// person's signature, a certification or an authorization to operate.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EvidenceConflict, type EvidenceExport } from "./evidence.js";

type Packet = EvidenceExport["packet"];

/** An export the facts don't support yet; `missing` says what each gap is. */
export class MissingFacts extends EvidenceConflict {
  constructor(what: string, readonly missing: string[]) {
    super(`${what}: ${missing.join(" ")}`);
  }
}

export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const PREDICATE_TYPE = "urn:software-factory:run-verification:v1";

/** This factory's signing key, made on first use (the private half stays in <dataDir>/signing, readable by this user only). */
export function signingKey(dataDir: string): { privateKey: KeyObject; publicKeyPem: string; keyid: string } {
  const dir = path.join(dataDir, "signing");
  const file = path.join(dir, "factory-ed25519.pem");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const { privateKey } = generateKeyPairSync("ed25519");
    try {
      writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; // another process made it first: use that one
    }
    chmodSync(file, 0o600);
  }
  const privateKey = createPrivateKey(readFileSync(file, "utf8"));
  const publicKey = createPublicKey(privateKey);
  const keyid = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  return { privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), keyid };
}

/** DSSE's pre-authentication encoding: what the signature covers. */
const pae = (type: string, body: Buffer) => Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${body.length} `), body]);

export interface Dsse {
  payloadType: string;
  payload: string; // base64
  signatures: { keyid: string; sig: string }[];
}

export function signDsse(statement: unknown, key: { privateKey: KeyObject; keyid: string }): Dsse {
  const body = Buffer.from(JSON.stringify(statement));
  return { payloadType: PAYLOAD_TYPE, payload: body.toString("base64"), signatures: [{ keyid: key.keyid, sig: sign(null, pae(PAYLOAD_TYPE, body), key.privateKey).toString("base64") }] };
}

/** The statement, when `envelope` carries a valid signature by `publicKeyPem`; null otherwise. */
export function verifyDsse(envelope: Dsse, publicKeyPem: string): unknown {
  const body = Buffer.from(envelope.payload, "base64");
  const key = createPublicKey(publicKeyPem);
  const ok = envelope.signatures.some((s) => verify(null, pae(envelope.payloadType, body), key, Buffer.from(s.sig, "base64")));
  return ok ? JSON.parse(body.toString("utf8")) : null;
}

/** Each merged work order's last commit the factory verified (the one integrate() merged), or null. */
function verifiedCommits(packet: Packet) {
  return packet.workOrders
    .filter((wo) => wo.state === "merged")
    .map((wo) => {
      const verified = packet.checks.filter((c) => c.workOrderId === wo.id && c.name === "verified" && c.ok && c.commit).at(-1);
      return { wo, commit: verified?.commit ?? null, at: verified?.at ?? null, passed: packet.checks.filter((c) => c.workOrderId === wo.id && c.ok && verified && c.commit === verified.commit).map((c) => c.name) };
    });
}

/** What an attestation of the run needs and the packet doesn't show. */
export function attestationGaps(packet: Packet): string[] {
  const gaps: string[] = [];
  if (packet.run.state !== "done") gaps.push(`The run isn't done (it's ${packet.run.state}).`);
  if (!packet.artifact.commit) gaps.push("No artifact commit is recorded.");
  else if (!packet.artifact.available) gaps.push(`The artifact commit ${packet.artifact.commit.slice(0, 12)} isn't in the workspace repository.`);
  for (const { wo, commit } of verifiedCommits(packet)) if (!commit) gaps.push(`WO-${wo.seq} has no commit the factory verified.`);
  return gaps;
}

/** What an assessment of the run's controls needs beyond an attestation: the agency's plan, and an ISSO's approval of each implementing commit. */
export function assessmentGaps(packet: Packet, assessmentPlan: string | null): string[] {
  const gaps = attestationGaps(packet);
  if (!assessmentPlan) gaps.push("The policy names no assessment plan (governance.assessmentPlan).");
  const merged = verifiedCommits(packet);
  if (!merged.some(({ wo }) => wo.controls.length)) gaps.push("No merged work order maps a security control.");
  for (const { wo, commit } of merged) {
    if (!wo.controls.length || !commit) continue;
    if (!isso(packet, wo.id, commit)) gaps.push(`${wo.controls.join(", ")} (WO-${wo.seq}): no ISSO approval of its verified commit.`);
  }
  return gaps;
}

const isso = (packet: Packet, workOrderId: string, commit: string) =>
  packet.decisions.findLast((d) => d.workOrderId === workOrderId && d.kind === "control_approval" && d.decision === "approve" && d.commit === commit);

/** The in-toto Statement v1 for the run's artifact commit. Call only when attestationGaps is empty. */
export function runStatement(packet: Packet, evidence: { file: string; sha256: string }, keyid: string, release: unknown) {
  const r = release as { status: string; decidedBy: string | null; envelope: { sha256: string } | null } | null;
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: packet.run.integrationBranch, digest: { gitCommit: packet.artifact.commit as string } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      attester: { id: "software-factory", keyid, kind: "factory", note: "Signed with this factory's key: what the factory recorded, not a person's approval." },
      run: { id: packet.run.id, change: packet.run.change, policyHash: packet.run.policyHash, baseBranch: packet.run.baseBranch, createdBy: packet.run.createdBy, createdAt: packet.run.createdAt, finishedAt: packet.run.updatedAt },
      evidence: { file: evidence.file, digest: { sha256: evidence.sha256 }, canonicalization: "sf-canonical-json-v1" },
      verification: packet.verification,
      workOrders: verifiedCommits(packet).map(({ wo, commit, passed }) => ({ id: wo.id, title: wo.title, controls: wo.controls, verifiedCommit: commit, checksPassed: passed, mergedBy: wo.mergedBy })),
      assurance: packet.assurance,
      release: r ? { status: r.status, decidedBy: r.decidedBy, envelope: r.envelope ? { sha256: r.envelope.sha256 } : null } : null,
      limitations: [
        "A statement of what this factory recorded and checked, signed by the factory's own key. It doesn't certify the software or authorize its use.",
        ...packet.limitations.filter((l) => !l.startsWith("This unsigned digest")),
      ],
    },
  };
}

const oscalId = (control: string) => control.trim().toLowerCase().replace(/\((\d+)\)/g, ".$1");

/** OSCAL 1.1.2 assessment results for the run's controls. Call only when assessmentGaps is empty. */
export function assessmentResults(packet: Packet, evidence: { file: string; sha256: string }, assessmentPlan: string) {
  const merged = verifiedCommits(packet).filter(({ wo }) => wo.controls.length);
  const parties = new Map<string, string>(); // ISSO actor -> party uuid
  const observations = merged.map(({ wo, commit, at, passed }) => {
    const approval = isso(packet, wo.id, commit as string);
    if (approval?.decidedBy && !parties.has(approval.decidedBy)) parties.set(approval.decidedBy, randomUUID());
    return {
      wo,
      approval,
      observation: {
        uuid: randomUUID(),
        title: `WO-${wo.seq} verified at ${(commit as string).slice(0, 12)}`,
        description: `The factory's checks passed on commit ${commit} of "${wo.title}": ${passed.join(", ")}. ${approval?.decidedBy} (ISSO) approved that commit for ${wo.controls.join(", ")}.`,
        methods: ["TEST"],
        collected: at as string,
        "relevant-evidence": [{ href: `evidence/${evidence.file}`, description: `Software Factory evidence packet, sha256 ${evidence.sha256} (sf-canonical-json-v1).` }],
      },
    };
  });
  const controls = [...new Set(merged.flatMap(({ wo }) => wo.controls))].sort();
  return {
    "assessment-results": {
      uuid: randomUUID(),
      metadata: {
        title: `Software Factory assessment results: ${packet.run.change} (${packet.run.id})`,
        "last-modified": new Date().toISOString(),
        version: "1",
        "oscal-version": "1.1.2",
        parties: [...parties].map(([actor, uuid]) => ({ uuid, type: "person", name: actor })),
        remarks: "Made by the Software Factory from recorded facts: an ISSO's approval of each verified commit that implements a control. It is not an authorization to operate, and it covers only what the run's work orders map.",
      },
      "import-ap": { href: assessmentPlan },
      results: [
        {
          uuid: randomUUID(),
          title: `Run ${packet.run.id}: ${packet.run.change}`,
          description: `Controls the run's merged work orders implement, at artifact commit ${packet.artifact.commit} of ${packet.run.integrationBranch}.`,
          start: packet.run.createdAt,
          end: packet.run.updatedAt,
          "reviewed-controls": { "control-selections": [{ "include-controls": controls.map((c) => ({ "control-id": oscalId(c) })) }] },
          observations: observations.map((o) => o.observation),
          findings: controls.map((control) => {
            const related = observations.filter((o) => o.wo.controls.includes(control));
            return {
              uuid: randomUUID(),
              title: control,
              description: `Implemented by ${related.map((o) => `WO-${o.wo.seq}`).join(", ")}; an ISSO approved each one's verified commit.`,
              origins: [{ actors: [...new Set(related.map((o) => o.approval?.decidedBy as string))].map((actor) => ({ type: "party", "actor-uuid": parties.get(actor) as string })) }],
              target: { type: "objective-id", "target-id": `${oscalId(control)}_obj`, status: { state: "satisfied" } },
              "related-observations": related.map((o) => ({ "observation-uuid": o.observation.uuid })),
            };
          }),
        },
      ],
    },
  };
}
