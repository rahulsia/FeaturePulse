import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Plus,
  Camera,
  Video,
  Pin,
  CheckCircle2,
  GitCompare,
  ClipboardCheck,
  RefreshCw,
  GitBranch,
  Bot,
  Sparkles,
  PanelLeft,
  PanelLeftClose,
  PlayCircle,
  Trash2,
  FlaskConical,
  ShieldCheck,
  ShieldAlert,
  History,
  AlertTriangle,
  Bookmark,
} from "lucide-react";
import "./style.css";
type Item = {
  id: number;
  feature_id: number;
  reported_release_id: number;
  title: string;
  description: string;
  source_url: string;
  reporter: string;
  assignee: string;
  severity: string;
  status: string;
  regression_required: boolean;
  evidence: { id: number; name: string; mime_type: string }[];
  validation?: { result: string; tester: string } | null;
  created_at: string;
  jira_ticket: string;
};
type App = { id: number; name: string };
type Group = {
  id: number;
  application_id: number;
  name: string;
  description: string;
  source: string;
};
type Feature = {
  id: number;
  application_id: number;
  group_id?: number | null;
  name: string;
  reviewer: string;
};
type Question = {
  id: number;
  feature_id: number;
  prompt: string;
  kind: string;
  required: boolean;
};
type Release = { id: number; application_id: number; version: string };
type Repo = {
  id: number;
  application_id: number;
  url: string;
  branch: string;
  last_commit: string;
  last_scanned_at?: string;
};
type Suggestion = {
  id: number;
  application_id: number;
  name: string;
  category: string;
  evidence: string;
  confidence: number;
  status: string;
};
type Step = {
  action: string;
  selector?: string;
  text?: string;
  value?: string;
  url?: string;
  name?: string;
  timeout?: number;
};
type TestDef = {
  id: number;
  feature_id: number;
  feature_name: string;
  application_id: number | null;
  name: string;
  target_url: string;
  steps: Step[];
  last_run?: { id: number; status: string } | null;
};
type TestRun = {
  id: number;
  test_id: number;
  release_id?: number | null;
  status: string;
  duration_ms: number;
  steps_log: {
    index: number;
    action: string;
    ok: boolean;
    message: string;
    ms: number;
  }[];
  screenshots: string[];
  console_errors: string[];
  error: string;
  created_at: string;
};
const ACTIONS = [
  "goto",
  "waitFor",
  "click",
  "fill",
  "expectVisible",
  "expectText",
  "screenshot",
  "wait",
];
// Lightweight duplicate-title detection: Jaccard similarity over meaningful
// words, no backend round trip. Good enough to flag "someone already
// reported this" without claiming to be a real text-matching model.
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "on",
  "for", "and", "or", "with", "this", "that", "it", "be", "not", "no",
  "when", "after", "before", "has", "have", "does", "doesn", "don",
]);
function titleTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}
function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a),
    tb = titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}
const DUP_THRESHOLD = 0.34;
const api = async (
  path: string,
  method = "GET",
  body?: unknown,
  token = "",
) => {
  const res = await fetch("/api" + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.text()).slice(0, 300));
  return res.json();
};
// A plain <img src="/api/..."> never sends the Authorization header, so once API_TOKEN is
// set every screenshot would 401. Fetch it with the header instead and render the blob —
// same approach the evidence-download button already uses.
function AuthImage({
  src,
  alt,
  token,
}: {
  src: string;
  alt: string;
  token: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    fetch(src, { headers: token ? { Authorization: "Bearer " + token } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("load failed"))))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, token]);
  if (!url) return <div className="shot-loading" aria-label={alt} />;
  return (
    <img
      src={url}
      alt={alt}
      onClick={() => window.open(url, "_blank")}
      style={{ cursor: "zoom-in" }}
    />
  );
}
function UI() {
  const [groups, setGroups] = useState<Group[]>([]),
    [questions, setQuestions] = useState<Question[]>([]);
  // sessionStorage rather than localStorage: this token unlocks the whole API, so it's
  // worth not having it persist indefinitely across browser restarts. This is a partial
  // mitigation, not a fix — any script able to run on this origin can still read it; a
  // real fix is an HttpOnly session cookie, which would need a backend session endpoint.
  const [token, setToken] = useState(() => {
    try {
      return sessionStorage.getItem("fp_token") || "";
    } catch {
      return "";
    }
  });
  const [apps, setApps] = useState<App[]>([]),
    [features, setFeatures] = useState<Feature[]>([]),
    [releases, setReleases] = useState<Release[]>([]),
    [items, setItems] = useState<Item[]>([]),
    [regressions, setRegressions] = useState<Item[]>([]);
  const [page, setPage] = useState("Feedback"),
    [navCollapsed, setNavCollapsed] = useState(false),
    [appId, setAppId] = useState(0),
    [releaseId, setReleaseId] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [browserUrl, setBrowserUrl] = useState("https://example.com"),
    [previewUrl, setPreviewUrl] = useState("https://example.com"),
    [featureId, setFeatureId] = useState(0),
    [reporter, setReporter] = useState(""),
    [assignee, setAssignee] = useState(""),
    [assigneeTouched, setAssigneeTouched] = useState(false),
    [severity, setSeverity] = useState("Medium"),
    [pin, setPin] = useState(true),
    [attachments, setAttachments] = useState<File[]>([]);
  const [fileRef] = [useRef<HTMLInputElement>(null)];
  const [recording, setRecording] = useState(false),
    recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null);
  const [compareA, setCompareA] = useState(0),
    [compareB, setCompareB] = useState(0),
    [comparison, setComparison] = useState<any>(null);
  const [repos, setRepos] = useState<Repo[]>([]),
    [suggestions, setSuggestions] = useState<Suggestion[]>([]),
    [repoUrl, setRepoUrl] = useState(""),
    [repoBranch, setRepoBranch] = useState("main"),
    [assistantMsg, setAssistantMsg] = useState(""),
    [assistantReply, setAssistantReply] = useState<any>(null);
  const [tests, setTests] = useState<TestDef[]>([]),
    [testRuns, setTestRuns] = useState<TestRun[]>([]),
    [egressPolicy, setEgressPolicy] = useState<{
      enforced: boolean;
      patterns: string[];
    } | null>(null),
    [jiraConfig, setJiraConfig] = useState<{
      configured: boolean;
      can_create: boolean;
      base_url: string;
      project_key: string;
      issue_type: string;
    } | null>(null),
    [jiraDrafts, setJiraDrafts] = useState<Record<number, string>>({}),
    [copiedId, setCopiedId] = useState<number | null>(null),
    [tName, setTName] = useState(""),
    [tUrl, setTUrl] = useState("http://localhost:5173/"),
    [tFeature, setTFeature] = useState(0),
    [tSteps, setTSteps] = useState<Step[]>([
      { action: "waitFor", selector: "body" },
    ]),
    [editingTest, setEditingTest] = useState<number | null>(null),
    [importText, setImportText] = useState(""),
    [importFmt, setImportFmt] = useState("auto"),
    [expandedTest, setExpandedTest] = useState<number | null>(null);
  const call = (p: string, m = "GET", b?: unknown) => api(p, m, b, token);
  const load = async () => {
    try {
      const [a, g, f, q, r, i, rr, ss, ts, trs, ep, jc] = await Promise.all([
        call("/applications"),
        call("/feature-groups"),
        call("/features"),
        call("/feedback-questions"),
        call("/releases"),
        call("/feedback"),
        call("/repositories"),
        call("/feature-suggestions"),
        call("/tests"),
        call("/test-runs"),
        call("/tests/egress-policy"),
        call("/integrations/jira"),
      ]);
      setApps(a);
      setGroups(g);
      setFeatures(f);
      setQuestions(q);
      setReleases(r);
      setItems(i);
      setRepos(rr);
      setSuggestions(ss);
      setTests(ts);
      setTestRuns(trs);
      setEgressPolicy(ep);
      setJiraConfig(jc);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    load();
  }, [token]);
  useEffect(() => {
    if (page === "Regression")
      call("/regression" + (releaseId ? "?release_id=" + releaseId : ""))
        .then(setRegressions)
        .catch((e) => setError(String(e)));
  }, [page, releaseId, items]);
  // Reuse the globally selected feature as the Tests builder's default, so
  // a feature you already picked above doesn't have to be picked again here.
  useEffect(() => {
    if (page === "Tests" && !editingTest && !tFeature && featureId)
      setTFeature(featureId);
  }, [page, featureId]);
  // Auto-assign new feedback to the feature's reviewer, visibly — the field fills in so
  // the reporter can see and still override it, not a silent default. Re-derives whenever
  // the selected feature changes, unless the reporter has typed something themselves —
  // otherwise switching from feature A to feature B kept showing A's reviewer.
  useEffect(() => {
    if (page !== "New feedback" || !featureId || assigneeTouched) return;
    const reviewer = features.find((f) => f.id === featureId)?.reviewer;
    setAssignee(reviewer || "");
  }, [page, featureId, features, assigneeTouched]);
  const availableFeatures = features.filter(
      (f) => !appId || f.application_id === appId,
    ),
    availableReleases = releases.filter(
      (r) => !appId || r.application_id === appId,
    );
  const filtered = items.filter(
    (f) =>
      (!appId ||
        features.find((x) => x.id === f.feature_id)?.application_id ===
          appId) &&
      (!releaseId || f.reported_release_id === releaseId) &&
      (!featureId || f.feature_id === featureId),
  );
  // Full history for the selected feature, across every release — independent
  // of the release filter above, so past reports are never hidden by it.
  // While a title is being typed, each entry also gets a similarity score so
  // the likeliest duplicate floats to the top instead of just the newest.
  const draftTitle = title.trim();
  const featureHistory = featureId
    ? items
        .filter((x) => x.feature_id === featureId)
        .map((x) => ({
          ...x,
          match:
            draftTitle.length >= 4 ? titleSimilarity(draftTitle, x.title) : 0,
        }))
        .sort((a, b) => (draftTitle ? b.match - a.match : b.id - a.id))
    : [];
  const likelyDuplicate = featureHistory[0]?.match >= DUP_THRESHOLD;
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const openPreview = () => {
    const candidate = browserUrl.trim();
    if (!candidate) {
      setPreviewUrl("");
      return;
    }
    try {
      const parsed = new URL(
        /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
      );
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
      if (parsed.origin === window.location.origin) {
        // The preview iframe's sandbox combines allow-scripts with allow-same-origin
        // (needed so previewed apps keep working), which a same-origin page could use to
        // strip its own sandbox and reach this app's own window — so it's never allowed.
        setError(
          "Can't preview this app's own origin in the browser panel (sandbox restriction).",
        );
        return;
      }
      setBrowserUrl(parsed.href);
      setPreviewUrl(parsed.href);
      setError("");
    } catch {
      setError("Enter a valid http:// or https:// URL.");
    }
  };
  const capture = async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const track = s.getVideoTracks()[0];
      const video = document.createElement("video");
      video.srcObject = s;
      await video.play();
      await new Promise((r) => setTimeout(r, 350));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      canvas.toBlob((b) => {
        if (b)
          setAttachments((a) => [
            ...a,
            new File([b], `screenshot-${Date.now()}.png`, {
              type: "image/png",
            }),
          ]);
      }, "image/png");
      track.stop();
      video.srcObject = null;
    } catch (e) {
      setError(String(e));
    }
  };
  const record = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      stream.current = s;
      const chunks: Blob[] = [];
      const mime = MediaRecorder.isTypeSupported("video/webm")
        ? "video/webm"
        : "video/mp4";
      const rec = new MediaRecorder(s, { mimeType: mime });
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: mime });
        setAttachments((a) => [
          ...a,
          new File(
            [blob],
            `recording-${Date.now()}.${mime === "video/webm" ? "webm" : "mp4"}`,
            { type: mime },
          ),
        ]);
        s.getTracks().forEach((t) => t.stop());
        setRecording(false);
      };
      s.getVideoTracks()[0].onended = () => {
        if (rec.state !== "inactive") rec.stop();
      };
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(String(e));
    }
  };
  const submit = () =>
    action(async () => {
      if (!featureId || !releaseId || !title.trim())
        throw new Error("Choose a feature and release and enter a title");
      const f = features.find((x) => x.id === featureId),
        r = releases.find((x) => x.id === releaseId);
      if (f?.application_id !== r?.application_id)
        throw new Error(
          "Feature and release must belong to the same application",
        );
      const x = await call("/feedback", "POST", {
        feature_id: featureId,
        reported_release_id: releaseId,
        title,
        description,
        source_url: previewUrl,
        reporter,
        assignee,
        severity,
        regression_required: pin,
      });
      for (const file of attachments) {
        const form = new FormData();
        form.append("file", file);
        await call(`/feedback/${x.id}/evidence`, "POST", form);
      }
      setTitle("");
      setDescription("");
      setBrowserUrl("");
      setPreviewUrl("");
      setAttachments([]);
      setReporter("");
      setAssignee("");
      setAssigneeTouched(false);
      setPage("Feedback");
    });
  const updStep = (i: number, patch: Partial<Step>) =>
    setTSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addStep = () =>
    setTSteps((s) => [...s, { action: "click", selector: "" }]);
  const rmStep = (i: number) =>
    setTSteps((s) => s.filter((_, j) => j !== i));
  const resetBuilder = () => {
    setEditingTest(null);
    setTName("");
    setTFeature(0);
    setTUrl("http://localhost:5173/");
    setTSteps([{ action: "waitFor", selector: "body" }]);
  };
  const saveTest = () =>
    action(async () => {
      if (!tFeature || !tName.trim() || !tUrl.trim())
        throw new Error("Pick a feature, and enter a name and target URL");
      const body = {
        feature_id: tFeature,
        name: tName,
        target_url: tUrl,
        steps: tSteps,
      };
      if (editingTest)
        await call(`/tests/${editingTest}`, "PATCH", {
          name: tName,
          target_url: tUrl,
          steps: tSteps,
        });
      else await call("/tests", "POST", body);
      resetBuilder();
    });
  const editTest = (t: TestDef) => {
    setEditingTest(t.id);
    setTName(t.name);
    setTFeature(t.feature_id);
    setTUrl(t.target_url);
    setTSteps(t.steps.length ? t.steps : [{ action: "waitFor", selector: "body" }]);
    setPage("Tests");
  };
  const runTest = (id: number) =>
    action(() =>
      call(`/tests/${id}/run`, "POST", { release_id: releaseId || null }),
    );
  const deleteTest = (id: number) =>
    action(() => call(`/tests/${id}`, "DELETE"));
  const importTests = () =>
    action(async () => {
      if (!importText.trim()) throw new Error("Paste test cases to import");
      if (!tFeature)
        throw new Error("Pick the feature these tests belong to (left of the box)");
      const res = await call("/tests/import", "POST", {
        application_id: appId || features.find((f) => f.id === tFeature)?.application_id || 0,
        feature_id: tFeature,
        target_url: tUrl,
        format: importFmt,
        content: importText,
      });
      setImportText("");
      setError("");
      alert(`Imported ${res.imported} test(s).`);
    });
  const addEntity = async (
    type: "applications" | "feature-groups" | "features" | "releases",
  ) => {
    const name = prompt(type === "releases" ? "Release version" : "Name");
    if (!name?.trim()) return;
    if (type !== "applications" && !appId) {
      setError("Select an application first");
      return;
    }
    let body: any =
      type === "applications"
        ? { name }
        : type === "releases"
          ? { version: name, application_id: appId }
          : type === "feature-groups"
            ? { name, application_id: appId, description: "", source: "Manual" }
            : { name, application_id: appId, group_id: null };
    if (type === "features") {
      const gs = groups.filter((g) => g.application_id === appId);
      if (gs.length) {
        const gid = prompt(
          "Feature Group ID (optional):\n" +
            gs.map((g) => `${g.id}: ${g.name}`).join("\n"),
        );
        if (gid) body.group_id = +gid;
      }
      const reviewer = prompt(
        "Reviewer for this feature (name or email, optional) — new feedback on it auto-assigns here",
      );
      if (reviewer?.trim()) body.reviewer = reviewer.trim();
    }
    await action(() => call("/" + type, "POST", body));
  };
  const setFeatureReviewer = (f: Feature) => {
    const reviewer = prompt(
      `Reviewer for "${f.name}" (name or email, blank to clear):`,
      f.reviewer || "",
    );
    if (reviewer === null) return;
    action(() =>
      call("/features/" + f.id, "PATCH", { reviewer: reviewer.trim() }),
    );
  };
  const addQuestion = async () => {
    if (!featureId) {
      setError("Select a feature first");
      return;
    }
    const promptText = prompt(
      "Feedback question, e.g. How easy is this feature to use?",
    );
    if (!promptText) return;
    const kind = prompt("Type: rating, text, yes_no", "rating") || "rating";
    await action(() =>
      call("/feedback-questions", "POST", {
        feature_id: featureId,
        prompt: promptText,
        kind,
        required: false,
      }),
    );
  };
  const jiraReportText = (f: Item) => {
    const feat = features.find((x) => x.id === f.feature_id)?.name || "—";
    const rel = releases.find((r) => r.id === f.reported_release_id)?.version || "—";
    return [
      `Summary: ${f.title}`,
      `Feature: ${feat}`,
      `Release: ${rel}`,
      `Severity: ${f.severity}`,
      `Reporter: ${f.reporter || "—"}`,
      f.source_url ? `Observed on: ${f.source_url}` : "",
      "",
      "Description:",
      f.description || "(none provided)",
      "",
      `FeaturePulse feedback #${f.id}`,
    ]
      .filter(Boolean)
      .join("\n");
  };
  const copyJiraReport = async (f: Item) => {
    const text = jiraReportText(f);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(f.id);
      setTimeout(() => setCopiedId((id) => (id === f.id ? null : id)), 1800);
    } catch {
      setError("Could not copy automatically — select and copy the text manually.");
    }
  };
  const saveJiraTicket = (f: Item) =>
    action(() =>
      call("/feedback/" + f.id, "PATCH", {
        jira_ticket: (jiraDrafts[f.id] ?? f.jira_ticket ?? "").trim(),
      }),
    );
  const createJiraTicket = (f: Item) =>
    action(() => call(`/feedback/${f.id}/jira-ticket`, "POST"));
  const jiraTicketHref = (ticket: string) => {
    if (!ticket) return "";
    if (/^https?:\/\//i.test(ticket)) return ticket;
    return jiraConfig?.base_url ? `${jiraConfig.base_url}/browse/${ticket}` : "";
  };
  return (
    <div className={"shell" + (navCollapsed ? " nav-collapsed" : "")}>
      <aside>
        <div className="brand">
          <Activity /> FeaturePulse
        </div>
        <div className="subtitle">Engineering quality hub</div>
        {[
          "Feedback",
          "New feedback",
          "Tests",
          "Regression",
          "Compare releases",
          "Setup",
        ].map((p) => (
          <button
            key={p}
            className={"nav " + (page === p ? "selected" : "")}
            onClick={() => {
              setPage(p);
              setError("");
            }}
          >
            {p === "Feedback" ? (
              <Activity />
            ) : p === "New feedback" ? (
              <Plus />
            ) : p === "Tests" ? (
              <FlaskConical />
            ) : p === "Regression" ? (
              <ClipboardCheck />
            ) : p === "Compare releases" ? (
              <GitCompare />
            ) : (
              <RefreshCw />
            )}
            {p}
          </button>
        ))}
        <div className="asidefoot">
          Internal application feedback
          <br />
          Release-to-release intelligence
        </div>
      </aside>
      <main>
        <header>
          <div className="headleft">
            <button
              className="outline iconbtn"
              onClick={() => setNavCollapsed((v) => !v)}
              aria-label={navCollapsed ? "Show navigation" : "Hide navigation"}
              title={navCollapsed ? "Show navigation" : "Hide navigation"}
            >
              {navCollapsed ? (
                <PanelLeft size={18} />
              ) : (
                <PanelLeftClose size={18} />
              )}
            </button>
            <div>
              <h1>{page}</h1>
              <p>
                Capture, improve and continuously validate your applications.
              </p>
            </div>
          </div>
          <div className="headright">
            {page !== "New feedback" && (
              <button
                className="primary-cta"
                onClick={() => setPage("New feedback")}
              >
                <Plus size={16} /> Add feedback
              </button>
            )}
            <button className="outline" onClick={load}>
              <RefreshCw size={16} /> Refresh
            </button>
          </div>
        </header>
        {error && (
          <div className="alert">
            {error}
            <button onClick={() => setError("")}>×</button>
          </div>
        )}
        <div className="toolbar">
          <label>
            Application{" "}
            <select
              value={appId}
              onChange={(e) => {
                setAppId(+e.target.value);
                setReleaseId(0);
                setFeatureId(0);
              }}
            >
              <option value="0">All applications</option>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Release{" "}
            <select
              value={releaseId}
              onChange={(e) => setReleaseId(+e.target.value)}
            >
              <option value="0">All releases</option>
              {availableReleases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Feature{" "}
            <select
              value={featureId}
              onChange={(e) => setFeatureId(+e.target.value)}
            >
              <option value="0">All features</option>
              {availableFeatures.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {page === "Feedback" && (
          <>
            <div className="metrics">
              {[
                ["Total feedback", filtered.length],
                ["Open", filtered.filter((x) => x.status === "Open").length],
                [
                  "Regressions",
                  filtered.filter((x) => x.status === "Regression").length,
                ],
                [
                  "Pinned for QA",
                  filtered.filter((x) => x.regression_required).length,
                ],
              ].map(([k, v]) => (
                <div className="metric" key={k}>
                  <strong>{v}</strong>
                  <span>{k}</span>
                </div>
              ))}
            </div>
            <section>
              <div className="sectionhead">
                <h2>Feedback queue</h2>
              </div>
              {filtered.length === 0 ? (
                <p className="muted">
                  No feedback yet. Create an application, feature and release in
                  Setup.
                </p>
              ) : (
                filtered.map((f) => (
                  <article key={f.id}>
                    <div className="row">
                      <b>
                        #{f.id} {f.title}
                      </b>
                      <span className={"badge " + f.status.replaceAll(" ", "")}>
                        {f.status}
                      </span>
                    </div>
                    <p>{f.description}</p>
                    {f.source_url && (
                      <a className="page-link" href={f.source_url} target="_blank" rel="noreferrer">
                        Viewed page: {f.source_url}
                      </a>
                    )}
                    <div className="muted">
                      {features.find((x) => x.id === f.feature_id)?.name} ·{" "}
                      {
                        releases.find((x) => x.id === f.reported_release_id)
                          ?.version
                      }{" "}
                      · {f.assignee || "Unassigned"} · {f.severity}
                      {f.jira_ticket &&
                        (jiraTicketHref(f.jira_ticket) ? (
                          <>
                            {" "}
                            ·{" "}
                            <a
                              href={jiraTicketHref(f.jira_ticket)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {f.jira_ticket}
                            </a>
                          </>
                        ) : (
                          <> · JIRA: {f.jira_ticket}</>
                        ))}
                    </div>
                    <div className="actions">
                      {f.regression_required && (
                        <span className="pinned">
                          <Pin size={14} /> Persistent regression
                        </span>
                      )}
                      {f.evidence.map((e) => (
                        <button
                          className="link"
                          key={e.id}
                          onClick={async () => {
                            try {
                              const response = await fetch(
                                "/api/evidence/" + e.id,
                                {
                                  headers: token
                                    ? { Authorization: "Bearer " + token }
                                    : {},
                                },
                              );
                              if (!response.ok)
                                throw Error("Cannot open evidence");
                              const url = URL.createObjectURL(
                                await response.blob(),
                              );
                              window.open(url, "_blank");
                              setTimeout(() => URL.revokeObjectURL(url), 60000);
                            } catch (err) {
                              setError(String(err));
                            }
                          }}
                        >
                          {e.name}
                        </button>
                      ))}
                      <select
                        value={f.status}
                        onChange={(e) =>
                          action(() =>
                            call("/feedback/" + f.id, "PATCH", {
                              status: e.target.value,
                            }),
                          )
                        }
                      >
                        {[
                          "Open",
                          "In Progress",
                          "Fixed",
                          "By Design",
                          "Will Fix Later",
                          "Resolved",
                          "Validation",
                          "Closed",
                          "Regression",
                        ].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                      <button
                        className="outline"
                        onClick={() =>
                          action(() =>
                            call("/feedback/" + f.id, "PATCH", {
                              regression_required: !f.regression_required,
                            }),
                          )
                        }
                      >
                        {f.regression_required ? "Unpin" : "Pin for regression"}
                      </button>
                    </div>
                    {f.status === "Will Fix Later" && (
                      <div className="jira-panel">
                        <div className="jira-head">
                          <Bookmark size={14} /> Deferred — JIRA ticket for
                          this
                        </div>

                        {f.jira_ticket ? (
                          <p className="jira-linked">
                            Linked to{" "}
                            {jiraTicketHref(f.jira_ticket) ? (
                              <a
                                href={jiraTicketHref(f.jira_ticket)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {f.jira_ticket}
                              </a>
                            ) : (
                              <b>{f.jira_ticket}</b>
                            )}
                          </p>
                        ) : jiraConfig?.can_create ? (
                          <button
                            type="button"
                            onClick={() => createJiraTicket(f)}
                            disabled={busy}
                          >
                            Create JIRA ticket
                          </button>
                        ) : null}

                        <details className="jira-manual">
                          <summary>
                            {f.jira_ticket
                              ? "Change the linked ticket"
                              : "Link an existing ticket instead"}
                          </summary>
                          <div className="jira-row">
                            <input
                              placeholder="PROJ-123 or a full ticket URL"
                              value={jiraDrafts[f.id] ?? f.jira_ticket ?? ""}
                              onChange={(e) =>
                                setJiraDrafts((d) => ({
                                  ...d,
                                  [f.id]: e.target.value,
                                }))
                              }
                            />
                            <button
                              className="outline"
                              onClick={() => saveJiraTicket(f)}
                              disabled={busy}
                            >
                              Save
                            </button>
                          </div>
                          <div className="jira-row">
                            <button
                              type="button"
                              className="outline"
                              onClick={() => copyJiraReport(f)}
                            >
                              {copiedId === f.id
                                ? "Copied ✓"
                                : "Copy bug report for JIRA"}
                            </button>
                            {jiraConfig?.configured &&
                              !jiraConfig?.can_create && (
                                <a
                                  className="link"
                                  href={`${jiraConfig.base_url}/secure/CreateIssue.jspa${
                                    jiraConfig.project_key
                                      ? "?pid=" + jiraConfig.project_key
                                      : ""
                                  }`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open JIRA to create a ticket ↗
                                </a>
                              )}
                          </div>
                        </details>

                        {!jiraConfig?.configured && (
                          <p className="muted jira-hint">
                            No JIRA site configured on the server — copy the
                            report above, create the ticket in JIRA
                            yourself, then paste its key or link here to
                            save it.
                          </p>
                        )}
                      </div>
                    )}
                  </article>
                ))
              )}
            </section>
          </>
        )}
        {page === "New feedback" && (
          <section className="form">
            <h2>Submit feature feedback</h2>
            <div className="report-layout has-rail">
              <div className="feature-rail">
                <h3>Features to test</h3>
                <p className="muted">
                  {availableFeatures.length} feature(s) loaded. Pick one to test.
                </p>
                {availableFeatures.length === 0 ? (
                  <p className="muted">
                    No features yet — add or discover features in Setup.
                  </p>
                ) : (
                  availableFeatures.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={
                        "feature-chip " + (featureId === f.id ? "active" : "")
                      }
                      onClick={() => setFeatureId(f.id)}
                    >
                      {f.name}
                    </button>
                  ))
                )}
                {suggestions.filter(
                  (s) => !appId || s.application_id === appId,
                ).length > 0 && (
                  <>
                    <h3 style={{ marginTop: 16 }}>Discovered (review in Setup)</h3>
                    {suggestions
                      .filter((s) => !appId || s.application_id === appId)
                      .slice(0, 12)
                      .map((s) => (
                        <div key={s.id} className="feature-chip ghost">
                          {s.name}
                          <span className="conf">{s.confidence}%</span>
                        </div>
                      ))}
                  </>
                )}
              </div>
              <div className="browser-panel">
                <div className="browser-toolbar">
                  <input
                    aria-label="Website URL to review"
                    value={browserUrl}
                    onChange={(e) => setBrowserUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && openPreview()}
                    placeholder="https://your-site.example/page"
                  />
                  <button type="button" onClick={openPreview}>
                    Open
                  </button>
                </div>
                {previewUrl ? (
                  <iframe
                    key={previewUrl}
                    className="browser-frame"
                    src={previewUrl}
                    title="Website preview for feedback"
                    sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                  />
                ) : (
                  <div className="browser-empty">Enter a URL to preview it.</div>
                )}
                <div className="browser-footer">
                  {previewUrl && (
                    <a href={previewUrl} target="_blank" rel="noreferrer">
                      Open in new tab
                    </a>
                  )}
                  <span>Some websites block embedded previews.</span>
                </div>
              </div>
              <div className="report-fields">
            <label>
              Feature under test
              <div className="selected-feature">
                {features.find((x) => x.id === featureId)?.name ||
                  "Pick a feature from the left panel"}
              </div>
            </label>
            {featureId > 0 && (
              <div
                className={
                  "history-panel" + (likelyDuplicate ? " warn" : "")
                }
              >
                <div className="history-head">
                  {likelyDuplicate ? (
                    <AlertTriangle size={14} />
                  ) : (
                    <History size={14} />
                  )}
                  {featureHistory.length === 0
                    ? "No prior feedback for this feature — check before you submit."
                    : likelyDuplicate
                      ? "Possible duplicate — a similarly titled report already exists"
                      : draftTitle
                        ? `${featureHistory.length} prior report(s) for this feature — no close title match`
                        : `${featureHistory.length} prior report(s) for this feature, across all releases`}
                </div>
                {featureHistory.length > 0 && (
                  <ul className="history-list">
                    {featureHistory.slice(0, 6).map((h) => (
                      <li
                        key={h.id}
                        className={h.match >= DUP_THRESHOLD ? "match" : ""}
                      >
                        <span className={"badge " + h.status}>
                          {h.status}
                        </span>
                        <b>{h.title}</b>
                        {h.match >= DUP_THRESHOLD && (
                          <span className="match-pct">
                            ~{Math.round(h.match * 100)}% match
                          </span>
                        )}
                        <span className="muted">
                          {releases.find((r) => r.id === h.reported_release_id)
                            ?.version || "—"}{" "}
                          · {h.severity} ·{" "}
                          {new Date(h.created_at).toLocaleDateString()}
                        </span>
                      </li>
                    ))}
                    {featureHistory.length > 6 && (
                      <li className="muted">
                        +{featureHistory.length - 6} more — see Feedback with
                        this feature filtered.
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
            <label>
              Title
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Describe the issue or suggestion"
              />
            </label>
            <label>
              Description / reproduction steps
              <textarea
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What happened? What should happen?"
              />
            </label>
            <div className="two">
              <label>
                Reporter
                <input
                  value={reporter}
                  onChange={(e) => setReporter(e.target.value)}
                />
              </label>
              <label>
                Assigned engineer
                <input
                  value={assignee}
                  onChange={(e) => {
                    setAssignee(e.target.value);
                    setAssigneeTouched(true);
                  }}
                />
              </label>
            </div>
            <label>
              Severity
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
              >
                {["Low", "Medium", "High", "Critical"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={pin}
                onChange={(e) => setPin(e.target.checked)}
              />{" "}
              Include in future regression suites
            </label>
            <div className="attachments">
              <h3>Evidence</h3>
              <p className="muted">
                Capture your screen, record a demonstration, or attach files
                (max 50 MB each). Review sensitive content before submission.
              </p>
              <div className="actions">
                <button className="outline" onClick={capture}>
                  <Camera size={16} /> Screenshot
                </button>
                <button className="outline" onClick={record}>
                  <Video size={16} />
                  {recording ? "Stop recording" : "Record screen"}
                </button>
                <button
                  className="outline"
                  onClick={() => fileRef.current?.click()}
                >
                  Upload files
                </button>
                <input
                  ref={fileRef}
                  hidden
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,video/webm,video/mp4"
                  onChange={(e) =>
                    setAttachments((a) => [
                      ...a,
                      ...Array.from(e.target.files || []),
                    ])
                  }
                />
              </div>
              {attachments.map((f, i) => (
                <div className="file" key={i}>
                  {f.name} ({Math.round(f.size / 1024)} KB)
                  <button
                    onClick={() =>
                      setAttachments((a) => a.filter((_, j) => j !== i))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button disabled={busy || recording} onClick={submit}>
              Submit feedback
            </button>
              </div>
            </div>
          </section>
        )}
        {page === "Regression" && (
          <section>
            <h2>Persistent regression suite</h2>
            <p className="muted">
              Pinned issues remain available for validation across future
              releases, even after resolution.
            </p>
            {regressions.map((f) => (
              <article key={f.id}>
                <div className="row">
                  <b>
                    #{f.id} {f.title}
                  </b>
                  <span className="pinned">
                    <Pin size={14} /> Always visible
                  </span>
                </div>
                <p>{f.description}</p>
                <div className="muted">
                  Current release result: {f.validation?.result || "Not tested"}
                </div>
                {releaseId > 0 && (
                  <div className="actions">
                    {["Pass", "Fail", "Blocked"].map((result) => (
                      <button
                        className="outline"
                        key={result}
                        onClick={() => {
                          const tester = prompt("Tester name");
                          if (tester)
                            action(async () => {
                              await call("/validations", "POST", {
                                feedback_id: f.id,
                                release_id: releaseId,
                                result,
                                tester,
                                notes: "",
                              });
                              const data = await call(
                                "/regression?release_id=" + releaseId,
                              );
                              setRegressions(data);
                            });
                        }}
                      >
                        {result === "Pass" && <CheckCircle2 size={15} />}{" "}
                        {result}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
            {!regressions.length && (
              <p>No pinned feedback. Pin an item from the feedback queue.</p>
            )}
          </section>
        )}
        {page === "Compare releases" && (
          <section>
            <h2>Release comparison</h2>
            <p className="muted">
              Select two releases from the same application.
            </p>
            <div className="two">
              <label>
                Baseline
                <select
                  value={compareA}
                  onChange={(e) => setCompareA(+e.target.value)}
                >
                  <option value="0">Choose release</option>
                  {availableReleases.map((r) => (
                    <option value={r.id} key={r.id}>
                      {r.version}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Candidate
                <select
                  value={compareB}
                  onChange={(e) => setCompareB(+e.target.value)}
                >
                  <option value="0">Choose release</option>
                  {availableReleases.map((r) => (
                    <option value={r.id} key={r.id}>
                      {r.version}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              onClick={() =>
                action(async () =>
                  setComparison(
                    await call(
                      `/compare?release_a=${compareA}&release_b=${compareB}`,
                    ),
                  ),
                )
              }
            >
              Compare
            </button>
            {comparison && (
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>{comparison.a.release}</th>
                    <th>{comparison.b.release}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    "feedback_count",
                    "open_count",
                    "critical_count",
                    "regression_failures",
                    "regression_passes",
                  ].map((k) => (
                    <tr key={k}>
                      <td>{k.replaceAll("_", " ")}</td>
                      <td>{comparison.a[k]}</td>
                      <td>{comparison.b[k]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
        {page === "Tests" && (
          <>
            <section className="form">
              <h2>
                <FlaskConical size={18} />
                {editingTest ? "Edit test" : "Author a UI test"}
              </h2>
              <p className="muted">
                Steps run in a real headless browser against the target URL
                (localhost or any reachable URL). Works for Angular, React, Vue
                or plain web apps.
              </p>
              {egressPolicy && (
                <p
                  className={
                    "egress-banner " +
                    (egressPolicy.enforced ? "restricted" : "open")
                  }
                >
                  {egressPolicy.enforced ? (
                    <>
                      <ShieldCheck size={14} /> Egress restricted to:{" "}
                      {egressPolicy.patterns.join(", ")}
                    </>
                  ) : (
                    <>
                      <ShieldAlert size={14} /> Egress unrestricted — any
                      reachable URL is allowed (set ALLOWED_TEST_HOSTS on the
                      server to restrict).
                    </>
                  )}
                </p>
              )}
              <div className="two">
                <label>
                  Feature under test
                  <select
                    value={tFeature}
                    onChange={(e) => setTFeature(+e.target.value)}
                    disabled={!!editingTest}
                  >
                    <option value="0">Select feature</option>
                    {availableFeatures.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Test name
                  <input
                    value={tName}
                    onChange={(e) => setTName(e.target.value)}
                    placeholder="e.g. Login and reach dashboard"
                  />
                </label>
              </div>
              <label>
                Target URL
                <input
                  value={tUrl}
                  onChange={(e) => setTUrl(e.target.value)}
                  placeholder="http://localhost:4200/"
                />
              </label>
              <h3 style={{ marginTop: 18 }}>Steps</h3>
              {tSteps.map((st, i) => (
                <div className="step-row" key={i}>
                  <span className="step-num">{i + 1}</span>
                  <select
                    value={st.action}
                    onChange={(e) => updStep(i, { action: e.target.value })}
                  >
                    {ACTIONS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                  {["click", "fill", "expectVisible", "waitFor", "expectText"].includes(
                    st.action,
                  ) && (
                    <input
                      placeholder={
                        st.action === "expectText"
                          ? "CSS selector (blank = whole page)"
                          : "CSS selector"
                      }
                      value={st.selector || ""}
                      onChange={(e) => updStep(i, { selector: e.target.value })}
                    />
                  )}
                  {st.action === "goto" && (
                    <input
                      placeholder="URL (blank = target URL)"
                      value={st.url || ""}
                      onChange={(e) => updStep(i, { url: e.target.value })}
                    />
                  )}
                  {st.action === "fill" && (
                    <input
                      placeholder="value to type"
                      value={st.value || ""}
                      onChange={(e) => updStep(i, { value: e.target.value })}
                    />
                  )}
                  {(st.action === "expectText" || st.action === "waitFor") && (
                    <input
                      placeholder={
                        st.action === "waitFor"
                          ? "text to wait for (optional)"
                          : "expected text"
                      }
                      value={st.text || ""}
                      onChange={(e) => updStep(i, { text: e.target.value })}
                    />
                  )}
                  {st.action === "screenshot" && (
                    <input
                      placeholder="label"
                      value={st.name || ""}
                      onChange={(e) => updStep(i, { name: e.target.value })}
                    />
                  )}
                  {st.action === "wait" && (
                    <input
                      type="number"
                      placeholder="ms"
                      value={st.timeout || ""}
                      onChange={(e) => updStep(i, { timeout: +e.target.value })}
                    />
                  )}
                  <button
                    type="button"
                    className="link del"
                    onClick={() => rmStep(i)}
                    aria-label="Remove step"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <div className="actions">
                <button type="button" className="outline" onClick={addStep}>
                  <Plus size={15} /> Add step
                </button>
                <button type="button" onClick={saveTest} disabled={busy}>
                  {editingTest ? "Save changes" : "Create test"}
                </button>
                {editingTest && (
                  <button type="button" className="outline" onClick={resetBuilder}>
                    Cancel
                  </button>
                )}
              </div>
            </section>

            <section className="form">
              <h2>Import test cases</h2>
              <p className="muted">
                Paste test cases written by your team and consume them directly.
                Select the feature above first. Two formats are accepted:
              </p>
              <ul className="muted" style={{ fontSize: 13 }}>
                <li>
                  <b>JSON</b> — a single test <code>{"{name,target_url,steps}"}</code>{" "}
                  or an array of them.
                </li>
                <li>
                  <b>Plain text</b> — one step per line, e.g.
                  <code>
                    {" "}
                    test: Login / url: http://localhost:4200 / fill #email =
                    a@b.com / click button[type=submit] / expectText h1 ~ Welcome
                  </code>
                </li>
              </ul>
              <div className="row" style={{ justifyContent: "flex-start" }}>
                <label style={{ maxWidth: 180 }}>
                  Format
                  <select
                    value={importFmt}
                    onChange={(e) => setImportFmt(e.target.value)}
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="json">JSON</option>
                    <option value="text">Plain text</option>
                  </select>
                </label>
              </div>
              <textarea
                rows={7}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={
                  "test: Reach dashboard\nurl: http://localhost:4200/\nfill #email = user@test.com\nfill #password = secret\nclick button[type=submit]\nwaitFor .dashboard\nexpectText h1 ~ Dashboard\nscreenshot after-login"
                }
              />
              <div className="actions">
                <button type="button" onClick={importTests} disabled={busy}>
                  Import into tests
                </button>
              </div>
            </section>

            <section>
              <div className="sectionhead">
                <h2>Test suite</h2>
                <span className="muted">
                  Runs against{" "}
                  <b>
                    {releases.find((r) => r.id === releaseId)?.version ||
                      "no release"}
                  </b>{" "}
                  — change the Release filter above to switch.
                </span>
              </div>
              {tests.filter((t) => !appId || t.application_id === appId).length ===
              0 ? (
                <p className="muted">
                  No tests yet. Author one above or import your test cases.
                </p>
              ) : (
                tests
                  .filter((t) => !appId || t.application_id === appId)
                  .map((t) => {
                    const runs = testRuns.filter((r) => r.test_id === t.id);
                    const open = expandedTest === t.id;
                    return (
                      <article key={t.id}>
                        <div className="row">
                          <div>
                            <b>{t.name}</b>{" "}
                            {t.last_run && (
                              <span
                                className={"badge status-" + t.last_run.status}
                              >
                                {t.last_run.status}
                              </span>
                            )}
                            <div className="muted">
                              {t.feature_name} · {t.steps.length} step(s) ·{" "}
                              <span className="page-link">{t.target_url}</span>
                            </div>
                          </div>
                          <div className="actions" style={{ margin: 0 }}>
                            <button onClick={() => runTest(t.id)} disabled={busy}>
                              <PlayCircle size={16} /> Run
                            </button>
                            <button
                              className="outline"
                              onClick={() => editTest(t)}
                            >
                              Edit
                            </button>
                            <button
                              className="outline"
                              onClick={() =>
                                setExpandedTest(open ? null : t.id)
                              }
                            >
                              {open ? "Hide runs" : `Runs (${runs.length})`}
                            </button>
                            <button
                              className="outline del"
                              onClick={() => deleteTest(t.id)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>
                        {open &&
                          (runs.length === 0 ? (
                            <p className="muted">No runs yet.</p>
                          ) : (
                            runs.map((run) => (
                              <div key={run.id} className="runbox">
                                <div className="row">
                                  <b>
                                    <span
                                      className={"badge status-" + run.status}
                                    >
                                      {run.status}
                                    </span>{" "}
                                    Run #{run.id} · {run.duration_ms} ms
                                  </b>
                                  <span className="muted">
                                    {new Date(run.created_at).toLocaleString()}
                                  </span>
                                </div>
                                <ol className="steplog">
                                  {run.steps_log.map((s) => (
                                    <li
                                      key={s.index}
                                      className={s.ok ? "ok" : "bad"}
                                    >
                                      {s.ok ? "✓" : "✗"} {s.action} — {s.message}
                                    </li>
                                  ))}
                                </ol>
                                {run.error && (
                                  <p className="bad">{run.error}</p>
                                )}
                                {run.console_errors.length > 0 && (
                                  <p className="muted">
                                    Console errors: {run.console_errors.length}
                                  </p>
                                )}
                                <div className="shots">
                                  {run.screenshots.map((n) => (
                                    <AuthImage
                                      key={n}
                                      src={`/api/test-runs/${run.id}/artifact/${n}`}
                                      alt={n}
                                      token={token}
                                    />
                                  ))}
                                </div>
                              </div>
                            ))
                          ))}
                      </article>
                    );
                  })
              )}
            </section>
          </>
        )}
        {page === "Setup" && (
          <section>
            <h2>Application & feature discovery</h2>
            <p className="muted">
              Create an application and release manually, or connect its Git
              repository to discover candidate features. Git suggestions require
              human approval.
            </p>
            <div className="actions">
              <button onClick={() => addEntity("applications")}>
                + Application
              </button>
              <button onClick={() => addEntity("feature-groups")}>
                + Feature group
              </button>
              <button onClick={() => addEntity("features")}>
                + Manual feature
              </button>
              <button onClick={() => addEntity("releases")}>+ Release</button>
            </div>
            {apps.map((a) => (
              <article key={a.id}>
                <b>{a.name}</b>
                <div className="muted">
                  Groups:{" "}
                  {groups
                    .filter((g) => g.application_id === a.id)
                    .map((g) => g.name)
                    .join(", ") || "None"}
                </div>
                {features.filter((f) => f.application_id === a.id).length >
                0 ? (
                  <ul className="feature-review-list">
                    {features
                      .filter((f) => f.application_id === a.id)
                      .map((f) => (
                        <li key={f.id}>
                          <span>{f.name}</span>
                          <span className="muted">
                            Reviewer: {f.reviewer || "Unassigned"}
                          </span>
                          <button
                            className="link"
                            onClick={() => setFeatureReviewer(f)}
                          >
                            {f.reviewer ? "Change" : "Set reviewer"}
                          </button>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="muted">No features yet.</p>
                )}
                <div className="muted">
                  Releases:{" "}
                  {releases
                    .filter((r) => r.application_id === a.id)
                    .map((r) => r.version)
                    .join(", ") || "None"}
                </div>
              </article>
            ))}
            <hr />
            <h2>Feature feedback design</h2>
            <p className="muted">
              Select a feature above, then define exactly what users should
              evaluate for that feature.
            </p>
            <button className="outline" onClick={addQuestion}>
              + Feedback question
            </button>
            {featureId > 0 && (
              <ul>
                {questions
                  .filter((q) => q.feature_id === featureId)
                  .map((q) => (
                    <li key={q.id}>
                      {q.prompt} — {q.kind}
                    </li>
                  ))}
              </ul>
            )}
            <hr />
            <h2>
              <GitBranch size={20} /> GitHub / Git feature discovery
            </h2>
            {!appId ? (
              <p className="muted">
                Select one application above before connecting a repository.
              </p>
            ) : (
              <>
                <div className="two">
                  <label>
                    Repository URL
                    <input
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      placeholder="https://github.com/org/project.git"
                    />
                  </label>
                  <label>
                    Branch
                    <input
                      value={repoBranch}
                      onChange={(e) => setRepoBranch(e.target.value)}
                      placeholder="main"
                    />
                  </label>
                </div>
                <button
                  disabled={!repoUrl || busy}
                  onClick={() =>
                    action(async () => {
                      await call("/repositories", "POST", {
                        application_id: appId,
                        url: repoUrl,
                        branch: repoBranch,
                      });
                      setRepoUrl("");
                    })
                  }
                >
                  Connect repository
                </button>
                {repos
                  .filter((r) => r.application_id === appId)
                  .map((r) => (
                    <article key={r.id}>
                      <div className="row">
                        <div>
                          <b>{r.url}</b>
                          <div className="muted">
                            Branch {r.branch}
                            {r.last_commit
                              ? ` · ${r.last_commit.slice(0, 8)}`
                              : ""}
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            action(() =>
                              call(`/repositories/${r.id}/scan`, "POST", {
                                release_id: releaseId || null,
                              }),
                            )
                          }
                        >
                          <Sparkles size={15} /> Scan & discover
                        </button>
                      </div>
                    </article>
                  ))}
                <h3>Suggested features</h3>
                {suggestions.filter((x) => x.application_id === appId)
                  .length === 0 ? (
                  <p className="muted">
                    No pending suggestions. Scan a repository to discover
                    features.
                  </p>
                ) : (
                  suggestions
                    .filter((x) => x.application_id === appId)
                    .map((x) => (
                      <article key={x.id}>
                        <div className="row">
                          <div>
                            <b>{x.name}</b>
                            <div className="muted">
                              {x.category} · {x.confidence}% confidence ·{" "}
                              {x.evidence}
                            </div>
                          </div>
                          <span className="badge">Suggested</span>
                        </div>
                        <div className="actions">
                          <button
                            onClick={() =>
                              action(() =>
                                call(
                                  `/feature-suggestions/${x.id}/action`,
                                  "POST",
                                  { action: "accept" },
                                ),
                              )
                            }
                          >
                            Accept
                          </button>
                          <button
                            className="outline"
                            onClick={() => {
                              const id = prompt(
                                "Existing feature ID to merge into",
                              );
                              if (id)
                                action(() =>
                                  call(
                                    `/feature-suggestions/${x.id}/action`,
                                    "POST",
                                    { action: "merge", merge_feature_id: +id },
                                  ),
                                );
                            }}
                          >
                            Merge
                          </button>
                          <button
                            className="outline"
                            onClick={() =>
                              action(() =>
                                call(
                                  `/feature-suggestions/${x.id}/action`,
                                  "POST",
                                  { action: "ignore" },
                                ),
                              )
                            }
                          >
                            Ignore
                          </button>
                        </div>
                      </article>
                    ))
                )}
              </>
            )}
            <hr />
            <h2>
              <Bot size={20} /> Feature Assistant
            </h2>
            <p className="muted">
              Ask about approved or Git-discovered features, for example “show
              pending Git features” or “show reporting features”.
            </p>
            <div className="assistantbox">
              <textarea
                rows={2}
                value={assistantMsg}
                onChange={(e) => setAssistantMsg(e.target.value)}
                placeholder="Show me the features discovered from Git"
              />
              <button
                disabled={!appId || !assistantMsg.trim()}
                onClick={() =>
                  action(async () =>
                    setAssistantReply(
                      await call("/feature-assistant", "POST", {
                        application_id: appId,
                        message: assistantMsg,
                      }),
                    ),
                  )
                }
              >
                Ask
              </button>
            </div>
            {assistantReply && (
              <article>
                <b>Feature Assistant</b>
                <p>{assistantReply.answer}</p>
                {assistantReply.features?.length > 0 && (
                  <ul>
                    {assistantReply.features.map((f: any) => (
                      <li key={f.type + "-" + f.id}>
                        {f.name}
                        {f.category ? ` — ${f.category}` : ""}
                        {f.confidence ? ` (${f.confidence}%)` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            )}
            <h3>API access</h3>
            <p className="muted">
              For local development, optionally enter API_TOKEN. Production
              deployments should use enterprise SSO and read-only repository
              credentials.
            </p>
            <input
              type="password"
              placeholder="API token"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                try {
                  sessionStorage.setItem("fp_token", e.target.value);
                } catch {
                  // ignore — e.g. a private window that blocks storage; the token still
                  // works for this tab's lifetime via React state
                }
              }}
            />
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<UI />);
