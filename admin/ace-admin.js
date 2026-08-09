/**
 * ace-admin.js — shared Firebase init + auth gate for the ACE admin panel.
 * Loaded by every page under website/admin/.
 *
 * Config below is the real web app config for dashboard-air-dd713, pulled
 * from Firebase console (Project settings > General > Your apps > Web app,
 * "Dashboard AIR" web app registration) on 2026-07-16.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  getFunctions,
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';
import {
  getFirestore, collection, query, where, orderBy, limit, getDocs, doc, getDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const ACE_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAUJv1P_SuOwly3TSKmdCmbf-rV4qdAbXw',
  authDomain: 'dashboard-air-dd713.firebaseapp.com',
  projectId: 'dashboard-air-dd713',
  storageBucket: 'dashboard-air-dd713.firebasestorage.app',
  messagingSenderId: '807232980244',
  appId: '1:807232980244:web:4cdfb336c2386a786f2e01',
};

const app = initializeApp(ACE_FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
// ACE functions are deployed under the "ace" codebase in a separate region/
// project space than the app's own functions — same project, isolated code.
const functions = getFunctions(app);

// 8/6: replaced the single hardcoded ADMIN_EMAIL gate with a Firestore
// allow-list (gaugesAccess/{email}, field `role`) so team members can be
// added/removed by editing a Firestore doc instead of editing this file and
// redeploying the website. `role` is 'admin' (full admin site, unchanged
// from before) or 'social' (Buffer push tab only — gauges.html filters its
// SECTIONS map on this). Michael's own email is seeded role:'admin' via
// gauges/scripts/seed-admin-access.js. This is a UX convenience only — the
// real security boundary for anything that writes (e.g. pushBufferBatch)
// is the equivalent server-side check in gauges/functions/index.js, which
// never trusts what the client reports here.
async function lookupAccessRole(email) {
  if (!email) return null;
  const snap = await getDoc(doc(db, 'gaugesAccess', email));
  return snap.exists() ? (snap.data().role || null) : null;
}

export const AceAdmin = {
  auth,
  db,
  functions,
  role: null, // set by login()/requireAuth() once resolved — check after awaiting either

  async login() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ hd: '4cylindertechnologies.com' });
    const result = await signInWithPopup(auth, provider);
    const role = await lookupAccessRole(result.user.email);
    if (!role) {
      await signOut(auth);
      throw new Error(`${result.user.email} isn't on the admin access list.`);
    }
    this.role = role;
    return result.user;
  },

  async logout() {
    this.role = null;
    await signOut(auth);
  },

  /**
   * Redirects to index.html (login) if not authenticated AND allow-listed
   * (gaugesAccess/{email} exists). Call at the top of every protected page.
   * Resolves with the user once confirmed, so callers can await it before
   * rendering. Sets AceAdmin.role as a side effect — check it after
   * awaiting this to scope what the page shows (see gauges.html).
   */
  requireAuth() {
    return new Promise((resolve, reject) => {
      onAuthStateChanged(auth, async user => {
        const role = user ? await lookupAccessRole(user.email) : null;
        if (!user || !role) {
          window.location.href = './index.html';
          reject(new Error('Not authenticated'));
          return;
        }
        this.role = role;
        resolve(user);
      });
    });
  },

  // Default client-side callable timeout is 70s, well under a full multi-
  // category run — matched to the server's timeoutSeconds (now 1800s on
  // Gen2) plus a small buffer, so the browser doesn't give up on a run
  // that's still legitimately in progress on the server.
  runACEVoting: (payload) => httpsCallable(functions, 'runACEVoting', { timeout: 1830000 })(payload),
  setACEResultStatus: (payload) => httpsCallable(functions, 'setACEResultStatus')(payload),
  publishACEResults: (payload) => httpsCallable(functions, 'publishACEResults')(payload),
  askJudgePanel: (payload) => httpsCallable(functions, 'askJudgePanel', { timeout: 120000 })(payload),
  getJudgePromptTemplate: () => httpsCallable(functions, 'getJudgePromptTemplate')(),
  setJudgePromptTemplate: (payload) => httpsCallable(functions, 'setJudgePromptTemplate')(payload),
};

/**
 * Counts how many categories each tool wins and what share of decided
 * (non-split) categories that represents. Shared between results.html and
 * dashboard.html so both render identically.
 */
export function computeToolOwnership(categories) {
  const counts = {};
  let decidedTotal = 0;
  categories.forEach(cat => {
    if (!cat.winner) return; // split / no consensus — excluded from denominator
    decidedTotal += 1;
    counts[cat.winner] = (counts[cat.winner] || 0) + 1;
  });
  const rows = Object.entries(counts)
    .map(([tool, count]) => ({ tool, count, pct: decidedTotal ? (count / decidedTotal) * 100 : 0 }))
    .sort((a, b) => b.count - a.count);
  return { rows, decidedTotal, totalCategories: categories.length };
}

/**
 * Renders a horizontal bar chart into `container` (a DOM element) from a
 * categories array. A bar chart reads more clearly than a line chart here —
 * this is category-share data with no time axis, not a trend over time.
 */
export function renderOwnershipChart(container, categories) {
  const { rows, decidedTotal, totalCategories } = computeToolOwnership(categories);
  const splitCount = totalCategories - decidedTotal;

  if (totalCategories === 0) {
    container.innerHTML = '<p style="color: var(--muted); font-size: 13px;">No categories to summarize.</p>';
    return;
  }

  const maxPct = rows.length ? Math.max(...rows.map(r => r.pct)) : 0;
  const bars = rows.map(r => `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">
      <div style="width:170px; font-size:13px; color: var(--text); flex-shrink:0;">${toolLabel(r.tool)}</div>
      <div style="flex:1; background: rgba(255,255,255,0.04); border-radius: 6px; overflow:hidden; height: 20px;">
        <div style="height:100%; width:${maxPct ? (r.pct / maxPct) * 100 : 0}%; background: linear-gradient(90deg, var(--gold), var(--orange)); border-radius: 6px;"></div>
      </div>
      <div style="width:96px; font-size:13px; color: var(--muted); flex-shrink:0; text-align:right;">${r.count} · ${r.pct.toFixed(1)}%</div>
    </div>
  `).join('');

  const familyNote = rows.some(r => r.tool === 'chatgpt' || r.tool === 'copilot')
    ? `<div style="font-size:12px; color: var(--muted); margin-top:8px;">ChatGPT and Copilot are separate tools from the same model family (OpenAI) — family votes are discounted in tie-breaks. See Judge Self-Preference Bias.</div>`
    : '';

  const splitNote = splitCount > 0
    ? `<div style="font-size:12px; color: var(--muted); margin-top:8px;">${splitCount} categor${splitCount === 1 ? 'y' : 'ies'} had no consensus and ${splitCount === 1 ? 'is' : 'are'} excluded above.</div>`
    : '';

  container.innerHTML = bars + familyNote + splitNote;
}

/**
 * Fetches the last `maxRuns` ACE runs for an app, each with its full
 * categories subcollection attached — the base dataset for every analytics
 * view below (category history, tool trend, judge bias). Ordered oldest to
 * newest so trend tables read left-to-right chronologically.
 */
export async function fetchRunHistory(db, appId, maxRuns = 12) {
  const runsQuery = query(
    collection(db, 'ace_results'),
    where('appId', '==', appId),
    orderBy('runDate', 'desc'),
    limit(maxRuns)
  );
  const runsSnap = await getDocs(runsQuery);
  const runs = await Promise.all(
    runsSnap.docs.map(async (runDoc) => {
      const catsSnap = await getDocs(collection(db, 'ace_results', runDoc.id, 'categories'));
      return {
        runId: runDoc.id,
        runDate: runDoc.data().runDate,
        status: runDoc.data().status,
        categories: catsSnap.docs.map(d => d.data()),
      };
    })
  );
  return runs.reverse(); // oldest first
}

function shortDate(ts) {
  return ts?.toDate?.().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) ?? '—';
}

function longDate(ts) {
  return ts?.toDate?.().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) ?? '—';
}

/**
 * How long has the CURRENT winner actually held a category, in terms of
 * real assignment changes rather than raw run count?
 *
 * Only a run where run.status === 'published' AND that category's own
 * subdoc status === 'approved' ever touches live routing (see
 * publishACEResults in ace/functions/index.js — a category left pending or
 * explicitly rejected within an otherwise-published run is simply never
 * written to `categories.toolId`, so the prior assignment silently carries
 * forward). So a rejected/pending/unpublished run must not start OR break a
 * streak here — it's excluded from the timeline entirely, not just hidden.
 *
 * `runs` is fetchRunHistory()'s oldest-first output. Returns one row per
 * category ever seen (even ones with zero qualifying runs, so a category
 * that's only ever been rejected/pending doesn't just silently vanish),
 * sorted longest-current-streak first.
 */
export function computeAssignmentStreaks(runs) {
  const allNames = new Map(); // categoryId -> name, from ANY run regardless of status
  const events = new Map();   // categoryId -> [{runId, runDate, winner}], published+approved only, oldest first

  runs.forEach(run => {
    run.categories.forEach(cat => {
      if (!allNames.has(cat.categoryId)) allNames.set(cat.categoryId, cat.categoryName);
    });
    if (run.status !== 'published') return;
    run.categories.forEach(cat => {
      if (cat.status !== 'approved' || !cat.winner) return;
      if (!events.has(cat.categoryId)) events.set(cat.categoryId, []);
      events.get(cat.categoryId).push({ runId: run.runId, runDate: run.runDate, winner: cat.winner });
    });
  });

  const results = [];
  allNames.forEach((name, categoryId) => {
    const evs = events.get(categoryId) || [];
    if (evs.length === 0) {
      results.push({ categoryId, name, currentTool: null, heldSinceDate: null, streakRuns: 0, totalQualifyingRuns: 0, totalFlips: 0 });
      return;
    }
    const current = evs[evs.length - 1];
    let streakRuns = 1;
    let heldSinceIdx = evs.length - 1;
    for (let i = evs.length - 2; i >= 0; i--) {
      if (evs[i].winner === current.winner) {
        streakRuns += 1;
        heldSinceIdx = i;
      } else {
        break;
      }
    }
    const totalFlips = evs.slice(1).filter((e, i) => e.winner !== evs[i].winner).length;
    results.push({
      categoryId,
      name,
      currentTool: current.winner,
      heldSinceDate: evs[heldSinceIdx].runDate,
      streakRuns,
      totalQualifyingRuns: evs.length,
      totalFlips,
    });
  });

  return results.sort((a, b) => b.streakRuns - a.streakRuns || a.name.localeCompare(b.name));
}

/**
 * Renders computeAssignmentStreaks() as a table — current tool, held-since
 * date, and streak length (in qualifying runs) per category, longest-held
 * incumbents first so a long-tenured winner (e.g. "how long has Perplexity
 * hung onto this category") is easy to spot without scrolling the full
 * run-by-run grid.
 */
export function renderAssignmentStreaks(container, runs) {
  const rows = computeAssignmentStreaks(runs);
  if (rows.length === 0) {
    container.innerHTML = '<p style="color: var(--muted); font-size: 13px;">No runs yet for this app.</p>';
    return;
  }

  const bodyRows = rows.map(r => {
    if (!r.currentTool) {
      return `
        <tr>
          <td>${r.name}</td>
          <td colspan="3" style="color: var(--muted);">No published/approved assignment yet in this window</td>
        </tr>
      `;
    }
    const longHeld = r.streakRuns >= 3;
    const streakBadge = `<span class="badge ${longHeld ? 'approved' : 'pending'}">${r.streakRuns} run${r.streakRuns === 1 ? '' : 's'}</span>`;
    const flipNote = r.totalFlips > 0
      ? `<span style="color: var(--muted); font-size: 12px; margin-left: 8px;">(${r.totalFlips} flip${r.totalFlips > 1 ? 's' : ''} in window)</span>`
      : '';
    return `
      <tr>
        <td>${r.name}</td>
        <td style="text-transform:capitalize;">${toolLabel(r.currentTool)}</td>
        <td>${longDate(r.heldSinceDate)}</td>
        <td>${streakBadge}${flipNote}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="ace-table">
      <thead><tr><th>Category</th><th>Current Tool</th><th>Held Since</th><th>Streak</th></tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <p style="color: var(--muted); font-size: 12px; margin-top: 12px;">
      "Held since" and streak only count runs that were actually published with this category approved — a rejected,
      pending, or never-published run never changed live routing, so it can't start or break a streak. Sorted
      longest-held first. Widen the window (fetchRunHistory's maxRuns) if a long-tenured category's true start
      predates the oldest loaded run — that case shows its streak as of the oldest qualifying run in view, not
      necessarily the true original start.
    </p>
  `;
}

/**
 * Per-category winner across every run — each row is a category, each
 * column a run, so you can see at a glance whether a category's winner is
 * stable or keeps flipping between runs.
 */
export function renderCategoryHistory(container, runs) {
  if (runs.length === 0) {
    container.innerHTML = '<p style="color: var(--muted); font-size: 13px;">No runs yet for this app.</p>';
    return;
  }

  const categoryMap = new Map(); // categoryId -> { name, byRun: { runId: winner|null } }
  runs.forEach(run => {
    run.categories.forEach(cat => {
      if (!categoryMap.has(cat.categoryId)) {
        categoryMap.set(cat.categoryId, { name: cat.categoryName, byRun: {} });
      }
      categoryMap.get(cat.categoryId).byRun[run.runId] = cat.winner;
    });
  });

  const headerCells = runs.map(r => `<th>${shortDate(r.runDate)}</th>`).join('');
  const bodyRows = Array.from(categoryMap.entries())
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([categoryId, entry]) => {
      const cells = runs.map(r => {
        const w = entry.byRun[r.runId];
        return `<td>${w ?? '<span style="color:var(--muted);">—</span>'}</td>`;
      }).join('');

      // Flag categories whose winner changed between any two consecutive runs they appeared in.
      const seen = runs.map(r => entry.byRun[r.runId]).filter(Boolean);
      const flips = seen.slice(1).filter((w, i) => w !== seen[i]).length;
      const flipBadge = flips > 0 ? `<span class="badge split" style="margin-left:6px;">${flips} flip${flips > 1 ? 's' : ''}</span>` : '';

      return `<tr><td>${entry.name}${flipBadge}</td>${cells}</tr>`;
    }).join('');

  container.innerHTML = `
    <table class="ace-table">
      <thead><tr><th>Category</th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

/**
 * Each tool's % share of decided categories, per run — rendered as one bar
 * chart per run (most recent first) so trend is scannable at a glance
 * instead of read off a grid of numbers. With only one run so far this is a
 * single chart; as more runs accumulate, each gets its own labeled block
 * stacked below, making it easy to flip through and compare visually.
 */
export function renderToolTrend(container, runs) {
  if (runs.length === 0) {
    container.innerHTML = '<p style="color: var(--muted); font-size: 13px;">No runs yet for this app.</p>';
    return;
  }

  const perRun = runs.map(r => ({ run: r, ...computeToolOwnership(r.categories) }));

  const blocks = perRun
    .slice()
    .reverse() // most recent run first
    .map(({ run, rows, decidedTotal, totalCategories }) => {
      const splitCount = totalCategories - decidedTotal;
      if (rows.length === 0) {
        return `
          <div style="margin-bottom:24px;">
            <div style="font-size:13px; color: var(--text); font-weight:600; margin-bottom:8px;">${shortDate(run.runDate)}</div>
            <p style="color: var(--muted); font-size: 13px;">No decided categories in this run.</p>
          </div>
        `;
      }
      const maxPct = Math.max(...rows.map(r => r.pct));
      const bars = rows.map(r => `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
          <div style="width:100px; font-size:12px; color: var(--text); flex-shrink:0; text-transform: capitalize;">${r.tool}</div>
          <div style="flex:1; background: rgba(255,255,255,0.04); border-radius: 6px; overflow:hidden; height: 16px;">
            <div style="height:100%; width:${maxPct ? (r.pct / maxPct) * 100 : 0}%; background: linear-gradient(90deg, var(--gold), var(--orange)); border-radius: 6px;"></div>
          </div>
          <div style="width:80px; font-size:12px; color: var(--muted); flex-shrink:0; text-align:right;">${r.pct.toFixed(0)}%</div>
        </div>
      `).join('');
      const splitNote = splitCount > 0
        ? `<div style="font-size:11px; color: var(--muted); margin-top:4px;">${splitCount} categor${splitCount === 1 ? 'y' : 'ies'} excluded (no consensus).</div>`
        : '';

      return `
        <div style="margin-bottom:24px;">
          <div style="font-size:13px; color: var(--text); font-weight:600; margin-bottom:8px;">${shortDate(run.runDate)}</div>
          ${bars}
          ${splitNote}
        </div>
      `;
    }).join('');

  container.innerHTML = blocks;
}

// Maps a judge's own provider to the tool it would be self-interested in
// favoring. Judges with no corresponding entry in TOOL_CATALOG (there
// isn't one here) would simply never show up as biased.
// Family-aware: kept in sync with ace/functions/index.js — gpt4o and
// copilot are both OpenAI-lineage, so each is "interested" in both tools.
// NOTE (Michael, 2026-07-19): if the bias analytics show the two routinely
// DIVERGING (they did in early runs), remove the family pairing — this is
// instrumentation, not dogma.
const JUDGE_SELF_TOOL = {
  claude: ['claude'],
  gpt4o: ['chatgpt', 'copilot'],
  copilot: ['copilot', 'chatgpt'],
  perplexity: ['perplexity'],
  grok: ['grok'],
  gemini: ['gemini'],
};

// Distinct display labels so the two OpenAI-family TOOLS never read as one
// entity in charts (raw ids were shown title-cased, "Chatgpt").
const TOOL_LABELS = {
  chatgpt: 'ChatGPT (OpenAI)',
  copilot: 'Copilot (Azure OpenAI)',
  claude: 'Claude',
  perplexity: 'Perplexity',
  grok: 'Grok',
  gemini: 'Gemini',
  wolfram: 'Wolfram Alpha',
  firefly: 'Adobe Firefly',
  runway: 'Runway',
  elevenlabs: 'ElevenLabs',
  suno: 'Suno',
  kling: 'Kling',
  canva: 'Canva',
  cleo: 'Cleo',
  wysa: 'Wysa',
  ada: 'Ada',
};
export const toolLabel = (id) => TOOL_LABELS[id] || id;

/**
 * Mirrors ace/functions/index.js's TOOL_CATALOG (judging candidates) cross-
 * referenced against each app's REAL client-side wiring, confirmed by direct
 * code read on 2026-07-29:
 *   - dashboardair/functions/index.js: REAL_API_TOOLS (genuine in-app answer
 *     via a real provider call) + BEST_FIT_ANSWER_ENGINE (honest stand-in
 *     engine for tools with no API of their own, e.g. cleo -> perplexity).
 *     Everything else is 'deeplink' — no in-app answer, straight to the tool
 *     (faking those would be worse than not answering).
 *   - DashboardAskAir/app/answer.tsx TOOLS map (AskAIR's Continue-button
 *     deep link target) + dashboardair/deeplinks.js DEEP_LINKS map
 *     (DashboardAIR's equivalent).
 * Kept in sync BY HAND, same as JUDGE_SELF_TOOL above — this admin repo is
 * intentionally isolated and can't import the other two repos' source at
 * runtime. Update this whenever a tool is added to/removed from
 * TOOL_CATALOG, or either app's deep-link map changes.
 *
 * Found and fixed 2026-07-29: cleo/wysa/ada were missing from
 * dashboardair/deeplinks.js entirely (DashboardAIR's own ACE run had just
 * picked Cleo for Finance & Investing via tie-break, with no working
 * Continue button), and kling was missing from AskAIR's TOOLS map. Both
 * fixed same day — this table exists so the next gap like that shows up
 * here, not as a dead button for a real user.
 */
const TOOL_WIRING = {
  claude:     { tier: 'real-api', askair: true, dashboardair: true },
  chatgpt:    { tier: 'real-api', askair: true, dashboardair: true },
  perplexity: { tier: 'real-api', askair: true, dashboardair: true },
  grok:       { tier: 'real-api', askair: true, dashboardair: true },
  gemini:     { tier: 'real-api', askair: true, dashboardair: true },
  copilot:    { tier: 'real-api', askair: true, dashboardair: true },
  wysa:       { tier: 'fallback', askair: true, dashboardair: true },
  ada:        { tier: 'fallback', askair: true, dashboardair: true },
  cleo:       { tier: 'fallback', askair: true, dashboardair: true },
  wolfram:    { tier: 'deeplink', askair: true, dashboardair: true },
  canva:      { tier: 'deeplink', askair: true, dashboardair: true },
  firefly:    { tier: 'deeplink', askair: true, dashboardair: true },
  runway:     { tier: 'deeplink', askair: true, dashboardair: true },
  elevenlabs: { tier: 'deeplink', askair: true, dashboardair: true },
  suno:       { tier: 'deeplink', askair: true, dashboardair: true },
  kling:      { tier: 'deeplink', askair: true, dashboardair: true },
};

const TIER_LABELS = {
  'real-api': 'Real API \u2014 genuine in-app answer',
  'fallback': 'Fallback engine \u2014 honest stand-in answer + recommendation',
  'deeplink': 'Deeplink-only \u2014 no in-app answer, straight to the tool',
};

export function renderToolWiringStatus(container) {
  const gaps = [];
  const rows = Object.entries(TOOL_WIRING).map(([id, w]) => {
    if (!w.askair) gaps.push(`${toolLabel(id)} missing from AskAIR`);
    if (!w.dashboardair) gaps.push(`${toolLabel(id)} missing from DashboardAIR`);
    const okBadge = (ok) => ok
      ? '<span class="badge approved">wired</span>'
      : '<span class="badge rejected">missing</span>';
    return `
      <tr>
        <td>${toolLabel(id)}</td>
        <td>${TIER_LABELS[w.tier]}</td>
        <td>${okBadge(w.askair)}</td>
        <td>${okBadge(w.dashboardair)}</td>
      </tr>
    `;
  }).join('');

  const banner = gaps.length === 0
    ? `<p style="color: var(--ace-muted); font-size: 13px; margin-bottom: 12px;">\u2705 No wiring gaps \u2014 every catalog tool has a working path in both apps.</p>`
    : `<p style="color: #f87171; font-size: 13px; margin-bottom: 12px; font-weight: 600;">\u26a0\ufe0f ${gaps.length} wiring gap${gaps.length > 1 ? 's' : ''} detected: ${gaps.join('; ')}. A category that resolves to one of these will silently dead-end for real users \u2014 fix before publishing any run that could pick it.</p>`;

  container.innerHTML = `
    ${banner}
    <table class="ace-table">
      <thead><tr><th>Tool</th><th>Answer Tier</th><th>AskAIR</th><th>DashboardAIR</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color: var(--ace-muted); font-size: 12px; margin-top: 12px;">
      Manually-maintained mirror of the real wiring in each app's code (this admin page can't read the other two
      repos at runtime) \u2014 update TOOL_WIRING above whenever TOOL_CATALOG or either app's deep-link map changes.
    </p>
  `;
}

/**
 * For each judge, compares how often it votes for its own corresponding
 * tool against how often the OTHER four judges vote for that same tool.
 * A judge picking its own tool meaningfully more than its peers do is a
 * self-preference signal worth flagging — this is the "AI bully" check.
 */
export function renderJudgeBias(container, runs) {
  const allCategories = runs.flatMap(r => r.categories);
  if (allCategories.length === 0) {
    container.innerHTML = '<p style="color: var(--muted); font-size: 13px;">No runs yet for this app.</p>';
    return;
  }

  const rows = Object.entries(JUDGE_SELF_TOOL).map(([judge, selfTools]) => {
    let selfVotesForSelf = 0;
    let selfTotalVotes = 0;
    let othersVotesForSelfTool = 0;
    let othersTotalVotes = 0;

    allCategories.forEach(cat => {
      Object.entries(cat.votes || {}).forEach(([voter, vote]) => {
        if (!vote?.tool) return;
        if (voter === judge) {
          selfTotalVotes += 1;
          if (selfTools.includes(vote.tool)) selfVotesForSelf += 1;
        } else {
          othersTotalVotes += 1;
          if (selfTools.includes(vote.tool)) othersVotesForSelfTool += 1;
        }
      });
    });

    const selfRate = selfTotalVotes ? (selfVotesForSelf / selfTotalVotes) * 100 : 0;
    const othersRate = othersTotalVotes ? (othersVotesForSelfTool / othersTotalVotes) * 100 : 0;
    const bias = selfRate - othersRate;

    return { judge, selfTool: selfTools.map(toolLabel).join(' + '), selfRate, othersRate, bias, selfTotalVotes };
  }).sort((a, b) => b.bias - a.bias);

  const bodyRows = rows.map(r => {
    // Flag if this judge picks its own tool at least 15 percentage points
    // more often than its peers do — an arbitrary but reasonable threshold
    // for "notably" self-preferential given typical run sizes.
    const flagged = r.bias >= 15;
    return `
      <tr>
        <td style="text-transform:capitalize;">${r.judge}</td>
        <td style="text-transform:capitalize;">${r.selfTool}</td>
        <td>${r.selfRate.toFixed(1)}%</td>
        <td>${r.othersRate.toFixed(1)}%</td>
        <td>${flagged ? `<span class="badge rejected">+${r.bias.toFixed(1)}pt self-bias</span>` : `${r.bias >= 0 ? '+' : ''}${r.bias.toFixed(1)}pt`}</td>
        <td style="color:var(--muted); font-size:12px;">${r.selfTotalVotes} votes</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="ace-table">
      <thead><tr><th>Judge</th><th>Own Tool</th><th>Picks Own Tool</th><th>Peers Pick It</th><th>Bias</th><th></th></tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <p style="color: var(--muted); font-size: 12px; margin-top: 12px;">
      "Bias" is how many percentage points more often a judge picks its own tool compared to how often its peers pick that same tool.
      Flagged (red) at +15pts or more. Small vote counts make this noisy early on — treat as a signal to watch, not a verdict, until more runs accumulate.
    </p>
  `;
}
