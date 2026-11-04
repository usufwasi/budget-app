/* =================================================================
   Budget app – main logic

   How the money works:
   You have two sides, Personal and Household. For each side, every month:
     brought forward + income − spending ± money moved between sides = balance
   That balance is the side's savings, and it is next month's "brought forward".

   Gold is tracked separately as an asset: its value today is worked out
   from the live international gold price, converted to rupees per tola.

   Read top to bottom: setup → helpers → sheets → sign-in → loading data →
   month maths → drawing the screen → add/edit sheet → starting balances →
   gold → backup → categories → bank SMS → savings goals → wiring → start
   ================================================================= */

// ---------- Setup ----------

// The connection to your Supabase project (values come from config.js).
const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// Created automatically the first time you sign in. You can rename them later.
const DEFAULT_BOOKS = [
  { name: "Personal",  icon: "👤", color: "#364FC7" },
  { name: "Household", icon: "🏡", color: "#0B7285" },
];

const DEFAULT_INCOME_SOURCES = [
  { name: "Salary",        icon: "💼", color: "#2B8A3E" },
  { name: "Rental income", icon: "🏘️", color: "#1971C2" },
  { name: "Other income",  icon: "➕", color: "#495057" },
];

// Expense categories for each side, matched by the side's name.
const DEFAULT_EXPENSES = {
  Household: [
    { name: "Rent",                  icon: "🏠", color: "#4C6EF5" },
    { name: "Groceries",             icon: "🛒", color: "#2F9E44" },
    { name: "Bills & utilities",     icon: "💡", color: "#E8A400" },
    { name: "Transport",             icon: "🚗", color: "#1098AD" },
    { name: "Subscriptions",         icon: "📺", color: "#AE3EC9" },
    { name: "Maintenance & repairs", icon: "🔧", color: "#9C6644" },
    { name: "Health",                icon: "💊", color: "#E64980" },
    { name: "Education",             icon: "📚", color: "#7048E8" },
    { name: "Other",                 icon: "📦", color: "#868E96" },
  ],
  Personal: [
    { name: "Food & eating out",     icon: "🍽️", color: "#F08C00" },
    { name: "Transport",             icon: "🚗", color: "#1098AD" },
    { name: "Subscriptions",         icon: "📺", color: "#AE3EC9" },
    { name: "Shopping",              icon: "🛍️", color: "#4C6EF5" },
    { name: "Health",                icon: "💊", color: "#E64980" },
    { name: "Entertainment",         icon: "🎬", color: "#0CA678" },
    { name: "Family & gifts",        icon: "🎁", color: "#7048E8" },
    { name: "Other",                 icon: "📦", color: "#868E96" },
  ],
};

// Everything the app currently knows, kept in one place (like a global struct).
const state = {
  books: [],                    // the two sides
  categories: [],               // expense categories (per side) and income sources
  transactions: [],             // this month's income and expenses, both sides
  transfers: [],                // this month's moves between sides
  broughtForward: new Map(),    // side id → balance at the start of the month
  month: startOfMonth(new Date()),
  view: "all",                  // "all" or a side's id
  form: null,                   // the add/edit sheet's current details
  userId: null,                 // your Supabase user id, once signed in
  gold: emptyGoldState(),
  editingAssetId: null,         // gold purchase being edited (null = adding)
  catTab: null,                 // categories screen: a side's id, or "income"
  catEditing: null,             // category being edited (null = adding)
  catDraft: null,               // icon and colour picked in the category editor
};
let chart = null;
let goldChart = null;
let goldTimer = null;

function emptyGoldState() {
  return {
    loaded: false,
    assets: [],                 // your gold purchases
    settings: null,             // your local-rate adjustment
    quote: null,                // latest prices: USD per ounce and rupees per USD
    history: [],                // one price per day, for the chart
    problem: null,              // message if prices couldn't be loaded
  };
}

// 1 tola = 11.6638 grams; gold is priced internationally per troy ounce (31.1035 grams).
const GRAMS_PER_TOLA = 11.6638038;
const GRAMS_PER_TROY_OUNCE = 31.1034768;


// ---------- Small helpers ----------

const $ = (id) => document.getElementById(id);

const money = new Intl.NumberFormat(CONFIG.LOCALE, {
  style: "currency",
  currency: CONFIG.CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const currencySymbol =
  money.formatToParts(0).find((part) => part.type === "currency")?.value ?? CONFIG.CURRENCY;

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}
function isThisMonth(month) {
  return month.getTime() === startOfMonth(new Date()).getTime();
}
// Dates are stored as "YYYY-MM-DD" text, using your local calendar day.
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function parseISODate(text) {
  const [y, m, d] = text.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function monthName(date) {
  return date.toLocaleDateString(CONFIG.LOCALE, { month: "long", year: "numeric" });
}
function formatDay(text) {
  const day = parseISODate(text);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysAgo = Math.round((today - day) / 86400000);
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  return day.toLocaleDateString(CONFIG.LOCALE, { weekday: "short", day: "numeric", month: "short" });
}
// "this month" or "in October"
function periodText() {
  return isThisMonth(state.month)
    ? "this month"
    : `in ${state.month.toLocaleDateString(CONFIG.LOCALE, { month: "long" })}`;
}

// "12,500" → 12500. Returns NaN for anything that isn't a number.
function parseAmount(text) {
  const cleaned = String(text).replace(/,/g, "").trim();
  return cleaned === "" ? NaN : Number(cleaned);
}
function round2(value) {
  return Math.round(value * 100) / 100;
}
function amountForInput(value) {
  return String(round2(value));
}
function sumOf(rows) {
  return rows.reduce((sum, row) => sum + Number(row.amount), 0);
}
function signedMoney(value) {
  return `${value >= 0 ? "+" : "−"}${money.format(Math.abs(value))}`;
}
function joinNote(...parts) {
  return parts.filter(Boolean).join(" · ");
}

// A unique id, used to link the personal and household shares of one income.
function newId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}

function bookById(id) {
  return state.books.find((b) => b.id === id);
}
function isBook(id) {
  return state.books.some((b) => b.id === id);
}
function otherBookId(id) {
  return state.books.find((b) => b.id !== id)?.id ?? null;
}
function categoryById(id) {
  return state.categories.find((c) => c.id === id);
}
function expenseCategories(bookId) {
  return state.categories.filter((c) => c.type === "expense" && c.book_id === bookId && !c.archived);
}
function incomeSources() {
  return state.categories.filter((c) => c.type === "income" && !c.archived);
}
function viewBookIds() {
  return state.view === "all" ? state.books.map((b) => b.id) : [state.view];
}

// Remembers small preferences on this device (last side, category, split...).
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: ignore */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

let toastTimer = null;
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = false;
}


// ---------- Sheets (the panels that slide up) ----------

const SHEETS = ["entry-sheet", "balances-sheet", "gold-sheet", "asset-sheet", "backup-sheet", "categories-sheet", "category-sheet", "sms-sheet", "review-sheet", "goal-sheet"];

function showSheet(id) {
  for (const sheet of SHEETS) $(sheet).hidden = sheet !== id;
  $(id).scrollTop = 0; // always open at the top
  $("sheet-backdrop").hidden = false;
}

function closeSheets() {
  for (const sheet of SHEETS) $(sheet).hidden = true;
  $("sheet-backdrop").hidden = true;
  state.form = null;
  state.editingAssetId = null;
  state.catEditing = null;
  state.goalEditing = null;
  // Entries were added from bank messages: reload so they show up.
  if (state.sms?.changed) {
    state.sms.changed = false;
    refresh();
  }
}

function anySheetOpen() {
  return SHEETS.some((sheet) => !$(sheet).hidden);
}


// ---------- Sign-in ----------

function showLogin() {
  $("app-screen").hidden = true;
  $("login-screen").hidden = false;
}

async function handleLogin(event) {
  event.preventDefault();
  $("login-error").hidden = true;
  $("login-btn").disabled = true;

  const { data, error } = await db.auth.signInWithPassword({
    email: $("login-email").value.trim(),
    password: $("login-password").value,
  });

  $("login-btn").disabled = false;
  if (error) return showError("login-error", `Sign-in failed: ${error.message}`);
  state.userId = data.user.id;
  $("login-password").value = "";
  await enterApp();
}

async function handleSignOut() {
  await db.auth.signOut();
  closeSheets();
  state.books = [];
  state.categories = [];
  state.transactions = [];
  state.transfers = [];
  state.broughtForward = new Map();
  state.userId = null;
  state.gold = emptyGoldState();
  state.sms = emptySmsState();
  state.goals = emptyGoalsState();
  renderReviewBanner();
  clearInterval(goldTimer);
  showLogin();
}

async function enterApp() {
  $("login-screen").hidden = true;
  $("app-screen").hidden = false;
  try {
    await loadBooks();
    await loadCategories();
    const savedView = recall("view");
    state.view = isBook(savedView) ? savedView : "all";
    await loadMonth();
  } catch (err) {
    showToast(`Couldn't load your data: ${err.message}`);
  }

  updateBackupReminder();
  refreshGoals();

  // Bank messages: read new ones on the phone, then ask about anything waiting.
  startSms();

  // Gold loads separately, so a slow price service never holds up your budget.
  refreshGold();
  clearInterval(goldTimer);
  goldTimer = setInterval(() => { if (!document.hidden) refreshGold(); }, 10 * 60 * 1000);
}


// ---------- Loading data from Supabase ----------

async function loadBooks() {
  const { data, error } = await db.from("books").select("*").order("sort_order");
  if (error) throw error;

  let books = data;
  if (books.length === 0) {
    // First sign-in: create Personal and Household.
    const rows = DEFAULT_BOOKS.map((book, i) => ({ ...book, sort_order: i }));
    const created = await db.from("books").insert(rows).select();
    if (created.error) throw created.error;
    books = created.data.sort((a, b) => a.sort_order - b.sort_order);
  }
  state.books = books;

  // Label the income split boxes with the sides' names.
  state.books.slice(0, 2).forEach((book, i) => {
    for (const prefix of ["split", "review-split"]) {
      $(`${prefix}-label-${i}`).textContent = `${book.icon} ${book.name}`;
      $(`${prefix}-all-${i}`).textContent = `All ${book.name.toLowerCase()}`;
    }
  });
}

async function loadCategories() {
  const { data, error } = await db.from("categories").select("*").order("sort_order");
  if (error) throw error;

  if (data.length > 0) {
    state.categories = data;
    return;
  }

  // First sign-in: create income sources and each side's expense categories.
  const rows = DEFAULT_INCOME_SOURCES.map((source, i) => ({ ...source, type: "income", sort_order: i }));
  for (const book of state.books) {
    (DEFAULT_EXPENSES[book.name] ?? []).forEach((category, i) => {
      rows.push({ ...category, type: "expense", book_id: book.id, sort_order: i });
    });
  }
  const created = await db.from("categories").insert(rows).select();
  if (created.error) throw created.error;
  state.categories = created.data.sort((a, b) => a.sort_order - b.sort_order);
}

// Every entry is stored permanently with its date. Viewing a month means asking for
// entries from the 1st of that month up to the 1st of the next, plus each side's
// balance just before the month started (worked out by the database).
async function loadMonth() {
  $("month-label").textContent = monthName(state.month);
  const from = toISODate(state.month);
  const to = toISODate(addMonths(state.month, 1));

  const [transactions, transfers, balances] = await Promise.all([
    db.from("transactions").select("*")
      .gte("occurred_on", from).lt("occurred_on", to)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false }),
    db.from("transfers").select("*")
      .gte("occurred_on", from).lt("occurred_on", to)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false }),
    db.rpc("balances_before", { p_date: from }),
  ]);
  for (const result of [transactions, transfers, balances]) {
    if (result.error) throw result.error;
  }

  state.transactions = transactions.data;
  state.transfers = transfers.data;
  state.broughtForward = new Map(balances.data.map((row) => [row.book_id, Number(row.balance)]));
  render();
}

// Reload and redraw, showing a message instead of crashing if the internet drops.
async function refresh() {
  try {
    await loadMonth();
  } catch (err) {
    showToast(`Couldn't load entries: ${err.message}`);
  }
  refreshGoals();
}

function changeMonth(step) {
  state.month = addMonths(state.month, step);
  refresh();
}

function goToThisMonth() {
  state.month = startOfMonth(new Date());
  refresh();
}

function setView(view) {
  state.view = view;
  remember("view", view);
  render();
}


// ---------- Month maths ----------

// Figures for one side, or both together.
// Moves between the two sides cancel out when you look at both together.
function figuresFor(bookIds) {
  const included = new Set(bookIds);
  const forward = bookIds.reduce((sum, id) => sum + (state.broughtForward.get(id) ?? 0), 0);

  // Pending entries (from SMS, later) aren't counted until you confirm them.
  const confirmed = state.transactions.filter((t) => t.status === "confirmed" && included.has(t.book_id));
  const income = sumOf(confirmed.filter((t) => t.type === "income"));
  const spent = sumOf(confirmed.filter((t) => t.type === "expense"));

  let movedIn = 0;
  let movedOut = 0;
  for (const x of state.transfers) {
    const fromIncluded = included.has(x.from_book_id);
    const toIncluded = included.has(x.to_book_id);
    if (toIncluded && !fromIncluded) movedIn += Number(x.amount);
    if (fromIncluded && !toIncluded) movedOut += Number(x.amount);
  }

  const change = income - spent + movedIn - movedOut;
  return { forward, income, spent, movedIn, movedOut, change, balance: forward + change };
}


// ---------- Drawing the screen ----------

function render() {
  renderViewTabs();
  renderSummary();
  renderSides();
  renderGold();
  renderGoals();
  // Savings-by-side and gold only appear in "Both"; hide their column otherwise.
  $("col-assets").hidden = state.view !== "all";
  renderChart();
  renderList();
}

function renderViewTabs() {
  const box = $("view-tabs");
  box.replaceChildren();
  const options = [
    { id: "all", label: "Both" },
    ...state.books.map((book) => ({ id: book.id, label: `${book.icon} ${book.name}` })),
  ];
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    const isActive = option.id === state.view;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
    button.addEventListener("click", () => setView(option.id));
    box.append(button);
  }
}

function renderSummary() {
  const f = figuresFor(viewBookIds());
  const name = state.view === "all" ? "Total savings" : `${bookById(state.view)?.name} savings`;
  $("balance-label").textContent = isThisMonth(state.month)
    ? `${name} now`
    : `${name} at end of ${monthName(state.month)}`;

  $("sum-balance").textContent = money.format(f.balance);
  $("sum-balance").classList.toggle("negative", f.balance < 0);

  const hadActivity = f.income || f.spent || f.movedIn || f.movedOut;
  const changeEl = $("sum-change");
  changeEl.textContent = hadActivity ? `${signedMoney(f.change)} ${periodText()}` : "";
  changeEl.className = `change ${f.change >= 0 ? "up" : "down"}`;

  $("sum-forward").textContent = money.format(f.forward);
  $("sum-income").textContent = money.format(f.income);
  $("sum-expense").textContent = money.format(f.spent);

  const moves = [];
  if (f.movedIn) moves.push(`Moved in ${money.format(f.movedIn)}`);
  if (f.movedOut) moves.push(`Moved out ${money.format(f.movedOut)}`);
  $("sum-transfers").textContent = moves.join(" · ");
  $("sum-transfers").hidden = moves.length === 0;

  // The bar shows spending out of this month's income.
  let width = 0;
  let message = "";
  if (f.income > 0) {
    width = Math.min((f.spent / f.income) * 100, 100);
    message = f.spent <= f.income
      ? `Spent ${Math.round((f.spent / f.income) * 100)}% of this month's income.`
      : `Spent ${money.format(f.spent - f.income)} more than this month's income, so it came out of savings.`;
  } else if (f.spent > 0) {
    width = 100;
    message = "No income recorded this month, so spending is coming out of savings.";
  }
  $("meter-spent").style.width = `${width}%`;
  $("meter-text").textContent = message;
}

function renderSides() {
  $("sides-card").hidden = state.view !== "all";
  if (state.view !== "all") return;

  const list = $("sides-list");
  list.replaceChildren();
  for (const book of state.books) {
    const f = figuresFor([book.id]);
    const hadActivity = f.income || f.spent || f.movedIn || f.movedOut;
    list.append(makeRow({
      icon: book.icon,
      color: book.color,
      name: book.name,
      note: hadActivity ? `${signedMoney(f.change)} ${periodText()}` : "No entries yet",
      amountText: money.format(f.balance),
      amountClass: f.balance < 0 ? "negative" : "",
      onClick: () => setView(book.id),
    }));
  }
}

function renderChart() {
  // Add up spending per category. In "Both", categories with the same name
  // (like Transport on each side) are combined.
  const included = new Set(viewBookIds());
  const combineByName = state.view === "all";
  const totals = new Map();

  for (const t of state.transactions) {
    if (t.status !== "confirmed" || t.type !== "expense" || !included.has(t.book_id)) continue;
    const category = categoryById(t.category_id);
    const key = combineByName ? (category?.name ?? "Uncategorized") : (t.category_id ?? "none");
    if (!totals.has(key)) {
      totals.set(key, {
        name: category?.name ?? "Uncategorized",
        icon: category?.icon ?? "❔",
        color: category?.color ?? "#ADB5BD",
        amount: 0,
      });
    }
    totals.get(key).amount += Number(t.amount);
  }

  const rows = [...totals.values()].sort((a, b) => b.amount - a.amount);
  const spent = rows.reduce((sum, r) => sum + r.amount, 0);
  const hasData = rows.length > 0;
  $("chart-wrap").hidden = !hasData;
  $("chart-empty").hidden = hasData;

  const list = $("category-breakdown");
  list.replaceChildren();

  if (chart) { chart.destroy(); chart = null; }
  if (!hasData) return;

  $("chart-total").textContent = money.format(spent);

  const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  chart = new Chart($("expense-chart"), {
    type: "doughnut",
    data: {
      labels: rows.map((r) => r.name),
      datasets: [{
        data: rows.map((r) => r.amount),
        backgroundColor: rows.map((r) => r.color),
        borderColor: surface,
        borderWidth: 3,
      }],
    },
    options: {
      cutout: "64%",
      maintainAspectRatio: false,
      animation: reduceMotion ? false : { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${money.format(ctx.parsed)}` } },
      },
    },
  });

  // The list under the chart: colour, name, share, amount.
  for (const r of rows) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = r.color;
    const name = document.createElement("span");
    name.textContent = `${r.icon} ${r.name}`;
    const share = document.createElement("span");
    share.className = "b-pct";
    share.textContent = `${Math.round((r.amount / spent) * 100)}%`;
    const amount = document.createElement("span");
    amount.className = "b-amount";
    amount.textContent = money.format(r.amount);
    item.append(swatch, name, share, amount);
    list.append(item);
  }
}

// One tappable row: icon, name, optional note, amount.
function makeRow({ icon, color, name, note, amountText, amountClass, onClick }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tx";
  row.addEventListener("click", onClick);

  const iconBox = document.createElement("span");
  iconBox.className = "tx-icon";
  iconBox.style.background = `${color}26`; // the colour at ~15% strength
  iconBox.textContent = icon;

  const main = document.createElement("span");
  main.className = "tx-main";
  const title = document.createElement("span");
  title.className = "tx-name";
  title.textContent = name;
  main.append(title);
  if (note) {
    const noteEl = document.createElement("span");
    noteEl.className = "tx-note";
    noteEl.textContent = note;
    main.append(noteEl);
  }

  const amount = document.createElement("span");
  amount.className = `tx-amount ${amountClass ?? ""}`;
  amount.textContent = amountText;

  row.append(iconBox, main, amount);
  const item = document.createElement("li");
  item.append(row);
  return item;
}

// The month's entries for the current view, newest first.
// In "Both", the personal and household shares of one income are shown as one entry.
function listItems() {
  const included = new Set(viewBookIds());
  const both = state.view === "all";
  const items = [];
  const splitItems = new Map();

  for (const t of state.transactions) {
    if (!included.has(t.book_id)) continue;
    if (both && t.type === "income" && t.split_id) {
      const existing = splitItems.get(t.split_id);
      if (existing) { existing.rows.push(t); continue; }
      const item = { kind: "income", date: t.occurred_on, created: t.created_at, rows: [t] };
      splitItems.set(t.split_id, item);
      items.push(item);
    } else {
      items.push({ kind: t.type, date: t.occurred_on, created: t.created_at, rows: [t] });
    }
  }

  for (const x of state.transfers) {
    if (!both && !included.has(x.from_book_id) && !included.has(x.to_book_id)) continue;
    items.push({ kind: "transfer", date: x.occurred_on, created: x.created_at, transfer: x });
  }

  return items.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.created < b.created ? 1 : a.created > b.created ? -1 : 0;
  });
}

// How each entry is shown in the list.
function describeItem(item) {
  const both = state.view === "all";

  if (item.kind === "transfer") {
    const x = item.transfer;
    const from = bookById(x.from_book_id)?.name ?? "?";
    const to = bookById(x.to_book_id)?.name ?? "?";
    const amount = Number(x.amount);
    if (both) {
      return { icon: "⇄", color: "#868E96", name: `${from} → ${to}`, note: x.note, amountText: money.format(amount) };
    }
    const outgoing = x.from_book_id === state.view;
    return {
      icon: "⇄",
      color: "#868E96",
      name: outgoing ? `Moved to ${to}` : `Moved from ${from}`,
      note: x.note,
      amountText: `${outgoing ? "−" : "+"}${money.format(amount)}`,
      amountClass: outgoing ? "" : "income",
    };
  }

  const first = item.rows[0];
  const category = categoryById(first.category_id);
  const base = {
    icon: category?.icon ?? "❔",
    color: category?.color ?? "#ADB5BD",
    name: category?.name ?? "Uncategorized",
  };
  const total = sumOf(item.rows);

  if (item.kind === "expense") {
    const side = both ? bookById(first.book_id)?.name : null;
    return { ...base, note: joinNote(side, first.note), amountText: `−${money.format(total)}` };
  }

  // Income
  let detail = null;
  if (both) {
    detail = item.rows
      .map((r) => item.rows.length > 1 ? `${bookById(r.book_id)?.name} ${money.format(Number(r.amount))}` : bookById(r.book_id)?.name)
      .join(", ");
  } else if (first.split_id) {
    const whole = sumOf(state.transactions.filter((t) => t.split_id === first.split_id));
    if (whole > total + 0.005) detail = `Share of ${money.format(whole)}`;
  }
  return { ...base, note: joinNote(detail, first.note), amountText: `+${money.format(total)}`, amountClass: "income" };
}

function renderList() {
  const list = $("transaction-list");
  list.replaceChildren();
  const items = listItems();
  $("list-empty").hidden = items.length > 0;

  let currentDay = null;
  let group = null;
  for (const item of items) {
    if (item.date !== currentDay) {
      currentDay = item.date;
      const heading = document.createElement("h3");
      heading.className = "day-heading";
      heading.textContent = formatDay(currentDay);
      group = document.createElement("ul");
      group.className = "tx-group";
      list.append(heading, group);
    }
    group.append(makeRow({ ...describeItem(item), onClick: () => openForm(item) }));
  }
}


// ---------- Add / edit sheet ----------

// Today if you're looking at the current month, otherwise the 1st of the month you're viewing.
function defaultEntryDate() {
  return toISODate(isThisMonth(state.month) ? new Date() : state.month);
}

function rememberedCategory(bookId) {
  const id = recall(`lastCategory:${bookId}`);
  return expenseCategories(bookId).some((c) => c.id === id) ? id : null;
}
function rememberedSource() {
  const id = recall("lastSource");
  return incomeSources().some((c) => c.id === id) ? id : null;
}
// The share of an income that went to the first side (Personal) last time.
function rememberedShare(sourceId) {
  const saved = recall(`split:${sourceId}`);
  const share = saved === null ? NaN : Number(saved);
  return Number.isFinite(share) && share >= 0 && share <= 1 ? share : 0.5;
}

// openForm() adds something new; openForm(item) edits an entry from the list.
function openForm(item = null) {
  const defaultBook = state.view !== "all"
    ? state.view
    : isBook(recall("lastBook")) ? recall("lastBook") : state.books[0]?.id;

  const f = {
    mode: "expense",
    editing: item,
    editRows: [],
    bookId: defaultBook,
    categoryId: null,
    moveFrom: defaultBook,
    moveTo: otherBookId(defaultBook),
    splitShare: null,
  };
  state.form = f;

  $("entry-error").hidden = true;
  $("entry-amount").value = "";
  $("entry-note").value = "";
  $("entry-date").value = defaultEntryDate();
  $("split-0").value = "";
  $("split-1").value = "";

  if (item?.kind === "expense") {
    const t = item.rows[0];
    Object.assign(f, { mode: "expense", bookId: t.book_id, categoryId: t.category_id, editRows: [t] });
    fillCommonFields(Number(t.amount), t.occurred_on, t.note);
  } else if (item?.kind === "income") {
    // Find both shares of this income, even if only one is shown in the current view.
    const first = item.rows[0];
    const rows = first.split_id ? state.transactions.filter((t) => t.split_id === first.split_id) : [first];
    const total = sumOf(rows);
    Object.assign(f, { mode: "income", categoryId: first.category_id, editRows: rows });
    fillCommonFields(total, first.occurred_on, first.note);
    state.books.slice(0, 2).forEach((book, i) => {
      $(`split-${i}`).value = amountForInput(sumOf(rows.filter((r) => r.book_id === book.id)));
    });
    f.splitShare = total > 0 ? parseAmount($("split-0").value) / total : 0.5;
  } else if (item?.kind === "transfer") {
    const x = item.transfer;
    Object.assign(f, { mode: "move", moveFrom: x.from_book_id, moveTo: x.to_book_id });
    fillCommonFields(Number(x.amount), x.occurred_on, x.note);
  }

  const editing = Boolean(item);
  $("sheet-title").textContent = editing ? "Edit" : "Add";
  $("mode-tabs").hidden = editing;
  $("delete-btn").hidden = !editing;
  $("save-another-btn").hidden = editing;

  setMode(f.mode);
  showSheet("entry-sheet");
  setTimeout(() => $("entry-amount").focus(), 60);
}

function fillCommonFields(amount, date, note) {
  $("entry-amount").value = amountForInput(amount);
  $("entry-date").value = date;
  $("entry-note").value = note ?? "";
}

function setMode(mode) {
  const f = state.form;
  f.mode = mode;

  document.querySelectorAll("#mode-tabs button").forEach((button) => {
    const isActive = button.dataset.mode === mode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  $("side-picker").hidden = mode !== "expense";
  $("move-picker").hidden = mode !== "move";
  $("category-chips").hidden = mode === "move";
  $("split-box").hidden = mode !== "income";

  const captions = { expense: "", income: "Total received", move: "Amount to move" };
  $("amount-caption").textContent = captions[mode];
  $("amount-caption").hidden = !captions[mode];

  // Pre-select what you used last time.
  if (mode === "expense" && !expenseCategories(f.bookId).some((c) => c.id === f.categoryId)) {
    f.categoryId = rememberedCategory(f.bookId);
  }
  if (mode === "income" && !incomeSources().some((c) => c.id === f.categoryId)) {
    f.categoryId = rememberedSource();
  }
  if (mode === "income" && !f.editing) {
    applyShare(rememberedShare(f.categoryId));
  }

  renderSidePicker();
  renderMovePicker();
  renderFormChips();
}

function renderSegmented(boxId, options, activeValue, onPick) {
  const box = $(boxId);
  box.replaceChildren();
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    const isActive = option.value === activeValue;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
    button.addEventListener("click", () => onPick(option.value));
    box.append(button);
  }
}

// A row of tappable chips (categories, income sources...), with one selected.
function renderChipList(boxId, items, selectedId, onPick) {
  const box = $(boxId);
  box.replaceChildren();
  for (const item of items) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = `${item.icon} ${item.name}`;
    const isSelected = item.id === selectedId;
    chip.classList.toggle("selected", isSelected);
    chip.setAttribute("aria-pressed", String(isSelected));
    chip.style.setProperty("--chip-color", item.color);
    chip.addEventListener("click", () => onPick(item.id));
    box.append(chip);
  }
}

function renderSidePicker() {
  const f = state.form;
  const options = state.books.map((book) => ({ value: book.id, label: `${book.icon} ${book.name}` }));
  renderSegmented("side-picker", options, f.bookId, (bookId) => {
    f.bookId = bookId;
    f.categoryId = rememberedCategory(bookId);
    renderSidePicker();
    renderFormChips();
  });
}

function renderMovePicker() {
  const f = state.form;
  const [a, b] = state.books;
  if (!a || !b) return;
  const options = [
    { value: a.id, label: `${a.icon} ${a.name} → ${b.icon} ${b.name}` },
    { value: b.id, label: `${b.icon} ${b.name} → ${a.icon} ${a.name}` },
  ];
  renderSegmented("move-picker", options, f.moveFrom, (fromId) => {
    f.moveFrom = fromId;
    f.moveTo = otherBookId(fromId);
    renderMovePicker();
  });
}

function renderFormChips() {
  const f = state.form;
  const items = f.mode === "income" ? incomeSources() : expenseCategories(f.bookId);
  const box = $("category-chips");
  box.replaceChildren();
  for (const item of items) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = `${item.icon} ${item.name}`;
    const isSelected = item.id === f.categoryId;
    chip.classList.toggle("selected", isSelected);
    chip.setAttribute("aria-pressed", String(isSelected));
    chip.style.setProperty("--chip-color", item.color);
    chip.addEventListener("click", () => {
      f.categoryId = item.id;
      // Picking an income source brings back how you split it last time.
      if (f.mode === "income" && !f.editing) applyShare(rememberedShare(item.id));
      renderFormChips();
    });
    box.append(chip);
  }
}

// Fill the two split boxes from the total, giving `share` (0 to 1) to the first side.
function applyShare(share) {
  state.form.splitShare = share;
  const total = parseAmount($("entry-amount").value);
  if (!(total > 0)) {
    $("split-0").value = "";
    $("split-1").value = "";
    return;
  }
  const first = round2(total * share);
  $("split-0").value = amountForInput(first);
  $("split-1").value = amountForInput(total - first);
}

// Typing in one split box fills in the other with whatever is left of the total.
function onSplitInput(index) {
  const total = parseAmount($("entry-amount").value);
  const typed = parseAmount($(`split-${index}`).value);
  if (!(total > 0) || !Number.isFinite(typed)) return;
  $(`split-${1 - index}`).value = amountForInput(Math.max(total - typed, 0));
  const first = index === 0 ? typed : total - typed;
  state.form.splitShare = Math.min(Math.max(first / total, 0), 1);
}

function setFormBusy(busy) {
  $("save-btn").disabled = busy;
  $("save-another-btn").disabled = busy;
  $("delete-btn").disabled = busy;
}

async function saveExpense(f, amount, date, note) {
  if (!f.categoryId) return "Pick a category.";
  const row = {
    book_id: f.bookId,
    type: "expense",
    amount: round2(amount),
    category_id: f.categoryId,
    occurred_on: date,
    note,
  };
  const { error } = f.editRows.length
    ? await db.from("transactions").update(row).eq("id", f.editRows[0].id)
    : await db.from("transactions").insert(row);
  if (error) return `Couldn't save: ${error.message}`;

  remember("lastBook", f.bookId);
  remember(`lastCategory:${f.bookId}`, f.categoryId);
  return null;
}

async function saveIncome(f, amount, date, note) {
  if (!f.categoryId) return "Pick where the money came from.";

  const shares = [0, 1].map((i) => {
    const text = $(`split-${i}`).value.trim();
    return text === "" ? 0 : parseAmount(text);
  });
  if (shares.some((v) => !Number.isFinite(v) || v < 0)) return "Split amounts must be zero or more.";
  if (Math.abs(shares[0] + shares[1] - amount) > 0.005) {
    return `The split adds up to ${money.format(shares[0] + shares[1])}, but the total is ${money.format(amount)}.`;
  }

  // Each side's share is stored as its own row, linked by the same split_id.
  const splitId = newId();
  const rows = state.books.slice(0, 2).map((book, i) => ({
    book_id: book.id,
    type: "income",
    amount: round2(shares[i]),
    category_id: f.categoryId,
    split_id: splitId,
    occurred_on: date,
    note,
  })).filter((row) => row.amount > 0);

  const { error } = await db.from("transactions").insert(rows);
  if (error) return `Couldn't save: ${error.message}`;

  // When editing: the new version is saved first, then the old one is removed.
  if (f.editRows.length) {
    const removed = await db.from("transactions").delete().in("id", f.editRows.map((r) => r.id));
    if (removed.error) return `Saved the new version, but couldn't remove the old one: ${removed.error.message}`;
  }

  remember("lastSource", f.categoryId);
  remember(`split:${f.categoryId}`, String(shares[0] / amount));
  return null;
}

async function saveTransfer(f, amount, date, note) {
  if (!f.moveFrom || !f.moveTo || f.moveFrom === f.moveTo) return "Pick which way to move the money.";
  const row = {
    from_book_id: f.moveFrom,
    to_book_id: f.moveTo,
    amount: round2(amount),
    occurred_on: date,
    note,
  };
  const { error } = f.editing
    ? await db.from("transfers").update(row).eq("id", f.editing.transfer.id)
    : await db.from("transfers").insert(row);
  return error ? `Couldn't save: ${error.message}` : null;
}

async function saveForm(keepOpen = false) {
  const f = state.form;
  if (!f) return;
  $("entry-error").hidden = true;

  const amount = parseAmount($("entry-amount").value);
  const date = $("entry-date").value;
  const note = $("entry-note").value.trim() || null;
  if (!(amount > 0)) return showError("entry-error", "Enter an amount greater than zero.");
  if (!date) return showError("entry-error", "Pick a date.");

  const savers = { expense: saveExpense, income: saveIncome, move: saveTransfer };
  setFormBusy(true);
  const problem = await savers[f.mode](f, amount, date, note);
  setFormBusy(false);
  if (problem) return showError("entry-error", problem);

  const savedMonth = startOfMonth(parseISODate(date));
  const otherMonth = savedMonth.getTime() !== state.month.getTime();
  showToast(otherMonth ? `Saved to ${monthName(savedMonth)}` : f.editing ? "Changes saved" : "Saved");

  if (keepOpen) {
    $("entry-amount").value = "";
    $("entry-note").value = "";
    $("split-0").value = "";
    $("split-1").value = "";
    $("entry-amount").focus();
  } else {
    closeSheets();
  }
  await refresh();
}

async function deleteFromForm() {
  const f = state.form;
  if (!f?.editing) return;
  const question = f.mode === "income" && f.editRows.length > 1
    ? "Delete this income, including both sides' shares? This can't be undone."
    : "Delete this entry? This can't be undone.";
  if (!confirm(question)) return;

  setFormBusy(true);
  const { error } = f.mode === "move"
    ? await db.from("transfers").delete().eq("id", f.editing.transfer.id)
    : await db.from("transactions").delete().in("id", f.editRows.map((r) => r.id));
  setFormBusy(false);

  if (error) return showError("entry-error", `Couldn't delete: ${error.message}`);
  closeSheets();
  showToast("Deleted");
  await refresh();
}


// ---------- Starting balances ----------

function openBalancesSheet() {
  const box = $("balances-fields");
  box.replaceChildren();
  for (const book of state.books) {
    const label = document.createElement("label");
    label.textContent = `${book.icon} ${book.name}`;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.dataset.book = book.id;
    input.value = amountForInput(Number(book.opening_balance));
    label.append(input);
    box.append(label);
  }
  $("balances-error").hidden = true;
  showSheet("balances-sheet");
}

async function saveBalances(event) {
  event.preventDefault();
  $("balances-error").hidden = true;

  const updates = [];
  for (const input of document.querySelectorAll("#balances-fields input")) {
    const value = input.value.trim() === "" ? 0 : parseAmount(input.value);
    if (!Number.isFinite(value)) return showError("balances-error", "Enter numbers only.");
    updates.push({ id: input.dataset.book, value: round2(value) });
  }

  $("balances-save").disabled = true;
  const results = await Promise.all(updates.map((u) =>
    db.from("books").update({ opening_balance: u.value }).eq("id", u.id)));
  $("balances-save").disabled = false;

  const failed = results.find((r) => r.error);
  if (failed) return showError("balances-error", `Couldn't save: ${failed.error.message}`);

  closeSheets();
  showToast("Starting balances saved");
  try {
    await loadBooks();
  } catch (err) {
    showToast(`Couldn't reload: ${err.message}`);
  }
  await refresh();
}


// ---------- Gold ----------

// Rupees per tola from the international price, plus your local-rate adjustment.
function tolaRate(usdPerOunce, rupeesPerDollar, premium) {
  return usdPerOunce * rupeesPerDollar * (GRAMS_PER_TOLA / GRAMS_PER_TROY_OUNCE) * (1 + premium);
}

function goldPremium() {
  return Number(state.gold.settings?.gold_premium_pct ?? 0);
}

function liveTolaRate(premium = goldPremium()) {
  const q = state.gold.quote;
  if (!q?.usd_per_oz || !q?.usd_pkr) return null;
  return tolaRate(Number(q.usd_per_oz), Number(q.usd_pkr), premium);
}

function goldHoldings() {
  let quantity = 0;
  let cost = 0;
  for (const a of state.gold.assets) {
    quantity += Number(a.quantity);
    cost += Number(a.quantity) * Number(a.cost_per_unit);
  }
  return { quantity, cost, averageCost: quantity > 0 ? cost / quantity : 0 };
}

const tolaFormat = new Intl.NumberFormat(CONFIG.LOCALE, { maximumFractionDigits: 3 });
const compactFormat = new Intl.NumberFormat(CONFIG.LOCALE, { notation: "compact", maximumFractionDigits: 1 });

async function loadGold() {
  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);

  // Ask for the price first, so today's price is in the history below.
  const quote = await db.rpc("gold_quote");
  const [assets, settings, history] = await Promise.all([
    db.from("assets").select("*").order("created_at"),
    db.from("user_settings").select("*").maybeSingle(),
    db.from("gold_daily").select("*").gte("day", toISODate(yearAgo)).order("day"),
  ]);
  for (const result of [assets, settings, history]) {
    if (result.error) throw result.error;
  }

  state.gold.assets = assets.data;
  state.gold.settings = settings.data;
  state.gold.history = history.data;
  state.gold.quote = quote.error ? null : quote.data;
  state.gold.problem = quote.error ? `Couldn't get the gold price: ${quote.error.message}` : quote.data?.problem ?? null;
  state.gold.loaded = true;
}

async function refreshGold() {
  try {
    await loadGold();
  } catch (err) {
    state.gold.loaded = true;
    state.gold.problem = `Couldn't load gold: ${err.message}`;
  }
  renderGold();
  if (!$("gold-sheet").hidden) renderGoldSheet();
}

function renderGold() {
  const card = $("gold-card");
  card.hidden = state.view !== "all" || !state.gold.loaded;
  if (card.hidden) return;

  const { quantity, cost, averageCost } = goldHoldings();
  const hasGold = quantity > 0;
  $("gold-empty").hidden = hasGold;
  $("gold-body").hidden = !hasGold;
  if (!hasGold) return;

  const rate = liveTolaRate();
  const changeEl = $("gold-change");
  if (rate) {
    const value = quantity * rate;
    const change = value - cost;
    const percent = cost > 0 ? (change / cost) * 100 : 0;
    $("gold-value").textContent = money.format(value);
    changeEl.textContent = `${signedMoney(change)} (${percent >= 0 ? "+" : "−"}${Math.abs(percent).toFixed(1)}%) since you bought it`;
    changeEl.className = `change ${change >= 0 ? "up" : "down"}`;
    $("gold-detail").textContent =
      `${tolaFormat.format(quantity)} tola · bought at ${money.format(averageCost)} per tola · now ${money.format(rate)} per tola`;
  } else {
    $("gold-value").textContent = "–";
    changeEl.textContent = "The live price isn't available right now.";
    changeEl.className = "change";
    $("gold-detail").textContent = `${tolaFormat.format(quantity)} tola · bought at ${money.format(averageCost)} per tola`;
  }

  // Where the numbers came from, and when.
  const status = [];
  const q = state.gold.quote;
  if (q?.gold_time) {
    const when = new Date(q.gold_time).toLocaleString(CONFIG.LOCALE, {
      day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    });
    status.push(`Price as of ${when}`);
  }
  if (goldPremium() !== 0) status.push("adjusted to your local rate");
  if (state.gold.problem) status.push(state.gold.problem);
  status.push("Prices: gold-api.com and ExchangeRate-API");
  $("gold-status").textContent = status.join(" · ");

  renderGoldChart(averageCost);
}

function renderGoldChart(averageCost) {
  const premium = goldPremium();
  const points = state.gold.history.map((day) => ({
    label: parseISODate(day.day).toLocaleDateString(CONFIG.LOCALE, { day: "numeric", month: "short" }),
    rate: tolaRate(Number(day.usd_per_oz), Number(day.usd_pkr), premium),
  }));

  const enoughData = points.length >= 2;
  $("gold-chart-wrap").hidden = !enoughData;
  $("gold-legend").hidden = !enoughData;
  $("gold-chart-note").hidden = enoughData;

  if (goldChart) { goldChart.destroy(); goldChart = null; }
  if (!enoughData) return;

  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const muted = css.getPropertyValue("--muted").trim();
  const line = css.getPropertyValue("--line").trim();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  goldChart = new Chart($("gold-chart"), {
    type: "line",
    data: {
      labels: points.map((p) => p.label),
      datasets: [
        {
          label: "Price per tola",
          data: points.map((p) => p.rate),
          borderColor: accent,
          backgroundColor: accent,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.25,
        },
        {
          label: "Your purchase price",
          data: points.map(() => averageCost),
          borderColor: muted,
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 0,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      animation: reduceMotion ? false : { duration: 400 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${money.format(ctx.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: muted, maxTicksLimit: 5, maxRotation: 0 } },
        y: { grid: { color: line }, ticks: { color: muted, maxTicksLimit: 4, callback: (v) => compactFormat.format(v) } },
      },
    },
  });
}

// --- Gold sheet: purchases and local-rate adjustment ---

function openGoldSheet() {
  $("calibrate-error").hidden = true;
  $("calibrate-rate").value = "";
  renderGoldSheet();
  showSheet("gold-sheet");
}

function renderGoldSheet() {
  const list = $("gold-purchases");
  list.replaceChildren();
  $("gold-purchases-empty").hidden = state.gold.assets.length > 0;

  for (const asset of state.gold.assets) {
    const quantity = Number(asset.quantity);
    const costPerTola = Number(asset.cost_per_unit);
    const bought = asset.acquired_on
      ? parseISODate(asset.acquired_on).toLocaleDateString(CONFIG.LOCALE, { day: "numeric", month: "short", year: "numeric" })
      : null;
    list.append(makeRow({
      icon: "Au",
      color: "#E8A400",
      name: `${tolaFormat.format(quantity)} tola at ${money.format(costPerTola)} per tola`,
      note: joinNote(bought, asset.note),
      amountText: money.format(quantity * costPerTola),
      onClick: () => openAssetSheet(asset),
    }));
  }

  const settings = state.gold.settings;
  const premium = goldPremium();
  if (premium !== 0 && settings) {
    const on = settings.gold_calibrated_on
      ? parseISODate(settings.gold_calibrated_on).toLocaleDateString(CONFIG.LOCALE, { day: "numeric", month: "short", year: "numeric" })
      : "earlier";
    const rate = settings.gold_calibrated_rate ? ` from ${money.format(Number(settings.gold_calibrated_rate))} per tola` : "";
    $("calibrate-status").textContent =
      `Adjusted ${premium > 0 ? "+" : "−"}${Math.abs(premium * 100).toFixed(1)}% from the international price, set on ${on}${rate}.`;
  } else {
    $("calibrate-status").textContent = "Using the international price as is.";
  }
  $("calibrate-reset").hidden = premium === 0;
}

async function saveGoldSettings(values) {
  const { error } = await db.from("user_settings").upsert({
    user_id: state.userId,
    ...values,
    updated_at: new Date().toISOString(),
  });
  return error;
}

async function applyCalibration(event) {
  event.preventDefault();
  $("calibrate-error").hidden = true;

  const localRate = parseAmount($("calibrate-rate").value);
  if (!(localRate > 0)) return showError("calibrate-error", "Enter today's local rate for 24K gold per tola.");

  const international = liveTolaRate(0);
  if (!international) return showError("calibrate-error", "The live price isn't available right now. Try again later.");

  // How far the local rate is from the international price, e.g. 0.012 = 1.2% higher.
  const premium = Math.round((localRate / international - 1) * 1e8) / 1e8;
  if (Math.abs(premium) > 0.25) {
    return showError("calibrate-error",
      `That's more than 25% away from the international price (${money.format(international)} per tola). Check it's the 24K rate per tola.`);
  }

  $("calibrate-save").disabled = true;
  const error = await saveGoldSettings({
    gold_premium_pct: premium,
    gold_calibrated_rate: round2(localRate),
    gold_calibrated_on: toISODate(new Date()),
  });
  $("calibrate-save").disabled = false;
  if (error) return showError("calibrate-error", `Couldn't save: ${error.message}`);

  $("calibrate-rate").value = "";
  showToast("Gold price adjusted to your local rate");
  await refreshGold();
}

async function resetCalibration() {
  const error = await saveGoldSettings({ gold_premium_pct: 0, gold_calibrated_rate: null, gold_calibrated_on: null });
  if (error) return showError("calibrate-error", `Couldn't save: ${error.message}`);
  showToast("Using the international price");
  await refreshGold();
}

// --- Add / edit one purchase ---

function openAssetSheet(asset = null) {
  state.editingAssetId = asset?.id ?? null;
  $("asset-title").textContent = asset ? "Edit purchase" : "Add gold";
  $("asset-qty").value = asset ? amountForInput(Number(asset.quantity)) : "";
  $("asset-cost").value = asset ? amountForInput(Number(asset.cost_per_unit)) : "";
  $("asset-date").value = asset?.acquired_on ?? "";
  $("asset-note").value = asset?.note ?? "";
  $("asset-error").hidden = true;
  $("asset-delete").hidden = !asset;
  showSheet("asset-sheet");
  setTimeout(() => $("asset-qty").focus(), 60);
}

function setAssetBusy(busy) {
  $("asset-save").disabled = busy;
  $("asset-delete").disabled = busy;
}

async function saveAsset(event) {
  event.preventDefault();
  $("asset-error").hidden = true;

  const quantity = parseAmount($("asset-qty").value);
  const cost = parseAmount($("asset-cost").value);
  if (!(quantity > 0)) return showError("asset-error", "Enter how many tola, more than zero.");
  if (!(cost >= 0)) return showError("asset-error", "Enter the price you paid per tola.");

  const row = {
    name: "24K gold",
    kind: "gold_24k",
    unit: "tola",
    quantity: Math.round(quantity * 10000) / 10000,
    cost_per_unit: round2(cost),
    acquired_on: $("asset-date").value || null,
    note: $("asset-note").value.trim() || null,
  };

  setAssetBusy(true);
  const { error } = state.editingAssetId
    ? await db.from("assets").update(row).eq("id", state.editingAssetId)
    : await db.from("assets").insert(row);
  setAssetBusy(false);
  if (error) return showError("asset-error", `Couldn't save: ${error.message}`);

  showToast("Saved");
  await refreshGold();
  openGoldSheet();
}

async function deleteAsset() {
  if (!state.editingAssetId) return;
  if (!confirm("Delete this purchase? This can't be undone.")) return;

  setAssetBusy(true);
  const { error } = await db.from("assets").delete().eq("id", state.editingAssetId);
  setAssetBusy(false);
  if (error) return showError("asset-error", `Couldn't delete: ${error.message}`);

  showToast("Deleted");
  await refreshGold();
  openGoldSheet();
}


// ---------- Backup and export ----------

const BACKUP_REMINDER_DAYS = 30;

function lastBackupDate() {
  const saved = recall("lastBackup");
  return saved ? new Date(saved) : null;
}

// The footer button turns red as a reminder if this device hasn't made a backup in 30 days.
function updateBackupReminder() {
  const last = lastBackupDate();
  const due = !last || (Date.now() - last.getTime()) > BACKUP_REMINDER_DAYS * 86400000;
  $("open-backup").textContent = due ? "Backup due" : "Backup";
  $("open-backup").classList.toggle("due", due);
}

function openBackupSheet() {
  $("backup-error").hidden = true;
  const last = lastBackupDate();
  $("backup-status").textContent = last
    ? `Last download on this device: ${last.toLocaleDateString(CONFIG.LOCALE, { day: "numeric", month: "long", year: "numeric" })}.`
    : "No backup downloaded on this device yet.";
  showSheet("backup-sheet");
}

// Supabase returns at most 1,000 rows per request, so ask in pages until everything is in.
async function fetchAll(table, orderColumn = "created_at") {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from(table)
      .select("*")
      .order(orderColumn)
      .order(table === "user_settings" ? "user_id" : "id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

// One spreadsheet cell: quoted if it contains commas, quotes or line breaks.
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  let text = String(value);
  // Stop spreadsheet programs treating typed text like "=SUM(...)" as a formula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function downloadFile(filename, text, mimeType) {
  // The invisible character at the start (a "BOM") tells Excel the file is UTF-8,
  // so emoji and non-English text show correctly.
  const blob = new Blob([mimeType === "text/csv" ? "\uFEFF" + text : text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setBackupBusy(busy) {
  $("export-csv").disabled = busy;
  $("export-json").disabled = busy;
}

function finishBackup(message) {
  remember("lastBackup", new Date().toISOString());
  updateBackupReminder();
  closeSheets();
  showToast(message);
}

async function exportCsv() {
  $("backup-error").hidden = true;
  setBackupBusy(true);
  try {
    const [books, categories, transactions, transfers] = await Promise.all([
      fetchAll("books"), fetchAll("categories"), fetchAll("transactions"), fetchAll("transfers"),
    ]);
    const bookName = (id) => books.find((b) => b.id === id)?.name ?? "";
    const categoryName = (id) => categories.find((c) => c.id === id)?.name ?? "Uncategorized";

    const rows = [
      ...transactions.map((t) => ({
        date: t.occurred_on,
        created: t.created_at,
        cells: [
          t.occurred_on,
          bookName(t.book_id),
          t.type === "income" ? "Income" : "Expense",
          categoryName(t.category_id),
          t.type === "income" ? Number(t.amount) : -Number(t.amount),
          t.note,
          t.status === "pending" ? "Pending" : "Confirmed",
          t.source,
        ],
      })),
      ...transfers.map((x) => ({
        date: x.occurred_on,
        created: x.created_at,
        cells: [x.occurred_on, `${bookName(x.from_book_id)} → ${bookName(x.to_book_id)}`, "Move", "", Number(x.amount), x.note, "Confirmed", "manual"],
      })),
    ].sort((a, b) => (a.date === b.date ? (a.created < b.created ? -1 : 1) : a.date < b.date ? -1 : 1));

    const header = ["Date", "Side", "Type", "Category", `Amount (${CONFIG.CURRENCY})`, "Note", "Status", "Added by"];
    downloadFile(`budget-entries-${toISODate(new Date())}.csv`, toCsv([header, ...rows.map((r) => r.cells)]), "text/csv");
    finishBackup(`Downloaded ${rows.length} entries`);
  } catch (err) {
    showError("backup-error", `Couldn't export: ${err.message}`);
  } finally {
    setBackupBusy(false);
  }
}

async function exportJson() {
  $("backup-error").hidden = true;
  setBackupBusy(true);
  try {
    const [books, categories, transactions, transfers, assets, settings, rules, imports, goals] = await Promise.all([
      fetchAll("books"), fetchAll("categories"), fetchAll("transactions"),
      fetchAll("transfers"), fetchAll("assets"), fetchAll("user_settings", "updated_at"),
      fetchAll("merchant_rules"), fetchAll("sms_imports"), fetchAll("savings_goals"),
    ]);
    const backup = {
      app: "Budget",
      backup_version: 1,
      exported_at: new Date().toISOString(),
      books, categories, transactions, transfers, assets, user_settings: settings,
      merchant_rules: rules, sms_imports: imports, savings_goals: goals,
    };
    downloadFile(`budget-backup-${toISODate(new Date())}.json`, JSON.stringify(backup, null, 2), "application/json");
    finishBackup("Full backup downloaded");
  } catch (err) {
    showError("backup-error", `Couldn't back up: ${err.message}`);
  } finally {
    setBackupBusy(false);
  }
}


// ---------- Categories ----------

// Emoji chosen because every version of Windows 10 and 11 and Android can display them.
const CATEGORY_ICONS = [
  "🏠", "🏡", "💡", "🔌", "💧", "🔥", "📶", "📱", "🧹", "🔧", "🛋️", "🧾",
  "🛒", "🍽️", "🍔", "☕", "🍕", "🍎", "🥖", "🍰",
  "🚗", "⛽", "🚌", "🚕", "🏍️", "✈️", "🅿️",
  "💊", "🏥", "🦷", "📚", "🎓", "✏️", "👶", "🐾",
  "🛍️", "👕", "👟", "💄", "💇", "🎁", "💍",
  "🎬", "🎮", "🎵", "📺", "⚽", "🏋️", "🌴", "🎉",
  "💼", "💰", "💵", "💳", "🏦", "📈", "🏘️", "🤲", "🕌", "➕", "📦",
];
const CATEGORY_COLORS = [
  "#4C6EF5", "#364FC7", "#1098AD", "#0B7285", "#2F9E44", "#0CA678", "#E8A400",
  "#F08C00", "#E64980", "#C2255C", "#AE3EC9", "#7048E8", "#9C6644", "#868E96",
];

// All categories on one tab (including hidden ones), in their display order.
function categoriesForTab(tab) {
  return state.categories
    .filter((c) => (tab === "income" ? c.type === "income" : c.type === "expense" && c.book_id === tab))
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

function tabLabel(tab) {
  if (tab === "income") return "Income source";
  const book = bookById(tab);
  return book ? `${book.name} expense` : "";
}

async function reloadCategories() {
  const { data, error } = await db.from("categories").select("*").order("sort_order");
  if (error) throw error;
  state.categories = data;
  render();
}

function openCategoriesSheet(tab = null) {
  const validTab = tab === "income" || isBook(tab);
  state.catTab = validTab ? tab : (state.view !== "all" ? state.view : state.books[0]?.id);
  renderCategoriesSheet();
  showSheet("categories-sheet");
}

function renderCategoriesSheet() {
  const options = [
    ...state.books.map((book) => ({ value: book.id, label: `${book.icon} ${book.name}` })),
    { value: "income", label: "💼 Income" },
  ];
  renderSegmented("cat-tabs", options, state.catTab, (tab) => {
    state.catTab = tab;
    renderCategoriesSheet();
  });

  const list = $("cat-list");
  list.replaceChildren();
  const categories = categoriesForTab(state.catTab);

  categories.forEach((category, index) => {
    const row = makeRow({
      icon: category.icon,
      color: category.color,
      name: category.name,
      onClick: () => openCategoryEditor(category),
    });
    row.classList.add("cat-row");
    row.classList.toggle("hidden-cat", category.archived);
    if (category.archived) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "Hidden";
      row.querySelector(".tx-name").append(tag);
    }

    const up = document.createElement("button");
    up.type = "button";
    up.className = "order-btn";
    up.textContent = "↑";
    up.setAttribute("aria-label", `Move ${category.name} up`);
    up.disabled = index === 0;
    up.addEventListener("click", () => moveCategory(category.id, -1));

    const down = document.createElement("button");
    down.type = "button";
    down.className = "order-btn";
    down.textContent = "↓";
    down.setAttribute("aria-label", `Move ${category.name} down`);
    down.disabled = index === categories.length - 1;
    down.addEventListener("click", () => moveCategory(category.id, 1));

    row.append(up, down);
    list.append(row);
  });

  $("cat-add").textContent = state.catTab === "income" ? "Add income source" : "Add category";
}

async function moveCategory(id, step) {
  const categories = categoriesForTab(state.catTab);
  const from = categories.findIndex((c) => c.id === id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= categories.length) return;

  // Swap, then number them 0, 1, 2... and save only the ones whose number changed.
  [categories[from], categories[to]] = [categories[to], categories[from]];
  const changed = [];
  categories.forEach((category, index) => {
    if (category.sort_order !== index) {
      category.sort_order = index;
      changed.push(category);
    }
  });
  renderCategoriesSheet();

  const results = await Promise.all(changed.map((c) =>
    db.from("categories").update({ sort_order: c.sort_order }).eq("id", c.id)));
  const failed = results.find((r) => r.error);
  if (failed) showToast(`Couldn't save the new order: ${failed.error.message}`);
  try {
    await reloadCategories();
  } catch (err) {
    showToast(`Couldn't reload categories: ${err.message}`);
  }
  if (!$("categories-sheet").hidden) renderCategoriesSheet();
}

// openCategoryEditor() adds a new category to the current tab; openCategoryEditor(category) edits one.
async function openCategoryEditor(category = null) {
  state.catEditing = category;
  state.catDraft = {
    icon: category?.icon ?? CATEGORY_ICONS[0],
    color: category?.color ?? CATEGORY_COLORS[0],
  };

  const noun = state.catTab === "income" ? "income source" : "category";
  $("category-title").textContent = category ? `Edit ${noun}` : `Add ${noun}`;
  $("cat-name").value = category?.name ?? "";
  $("cat-icon-custom").value = CATEGORY_ICONS.includes(state.catDraft.icon) ? "" : state.catDraft.icon;
  $("cat-preview-side").textContent = tabLabel(state.catTab);
  $("category-error").hidden = true;

  // Hide and Delete only make sense for an existing category.
  $("cat-hide").hidden = !category;
  $("cat-hide").textContent = category?.archived ? "Show again" : "Hide";
  $("cat-delete").hidden = true;
  $("cat-usage").textContent = "";

  renderCategoryEditor();
  showSheet("category-sheet");
  if (!category) setTimeout(() => $("cat-name").focus(), 60);

  // A category can only be deleted if no entries use it; otherwise it can be hidden.
  if (category) {
    const { count, error } = await db
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("category_id", category.id);
    if (state.catEditing?.id !== category.id) return; // the editor was closed or changed meanwhile
    if (error) {
      $("cat-usage").textContent = "Couldn't check whether any entries use this.";
    } else if (count > 0) {
      $("cat-usage").textContent = `Used by ${count} ${count === 1 ? "entry" : "entries"}, so it can't be deleted. Hide it instead to stop it appearing when you add entries.`;
    } else {
      $("cat-usage").textContent = "No entries use this yet.";
      $("cat-delete").hidden = false;
    }
  }
}

function renderCategoryEditor() {
  const draft = state.catDraft;
  const preview = $("cat-preview-icon");
  preview.textContent = draft.icon;
  preview.style.background = `${draft.color}26`;
  $("cat-preview-name").textContent = $("cat-name").value.trim() || "New category";

  const icons = $("cat-icons");
  icons.replaceChildren();
  for (const icon of CATEGORY_ICONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = icon;
    button.classList.toggle("selected", icon === draft.icon);
    button.setAttribute("aria-pressed", String(icon === draft.icon));
    button.addEventListener("click", () => {
      draft.icon = icon;
      $("cat-icon-custom").value = "";
      renderCategoryEditor();
    });
    icons.append(button);
  }

  const colors = $("cat-colors");
  colors.replaceChildren();
  for (const color of CATEGORY_COLORS) {
    const button = document.createElement("button");
    button.type = "button";
    button.style.background = color;
    button.setAttribute("aria-label", `Colour ${color}`);
    button.classList.toggle("selected", color === draft.color);
    button.setAttribute("aria-pressed", String(color === draft.color));
    button.addEventListener("click", () => {
      draft.color = color;
      renderCategoryEditor();
    });
    colors.append(button);
  }
}

function setCategoryBusy(busy) {
  for (const id of ["cat-save", "cat-hide", "cat-delete", "cat-back"]) $(id).disabled = busy;
}

async function finishCategoryChange(message) {
  const tab = state.catTab;
  try {
    await reloadCategories();
  } catch (err) {
    showToast(`Couldn't reload categories: ${err.message}`);
  }
  showToast(message);
  openCategoriesSheet(tab);
}

async function saveCategory(event) {
  event.preventDefault();
  $("category-error").hidden = true;

  const name = $("cat-name").value.trim();
  if (!name) return showError("category-error", "Give it a name.");
  const editing = state.catEditing;
  const siblings = categoriesForTab(state.catTab).filter((c) => c.id !== editing?.id);
  if (siblings.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return showError("category-error", `There's already one called "${name}" here.`);
  }

  const values = { name, icon: state.catDraft.icon, color: state.catDraft.color };
  setCategoryBusy(true);
  const { error } = editing
    ? await db.from("categories").update(values).eq("id", editing.id)
    : await db.from("categories").insert({
        ...values,
        type: state.catTab === "income" ? "income" : "expense",
        book_id: state.catTab === "income" ? null : state.catTab,
        sort_order: siblings.reduce((max, c) => Math.max(max, c.sort_order), -1) + 1,
      });
  setCategoryBusy(false);
  if (error) return showError("category-error", `Couldn't save: ${error.message}`);

  await finishCategoryChange(editing ? "Saved" : `Added ${name}`);
}

async function toggleCategoryHidden() {
  const category = state.catEditing;
  if (!category) return;
  const hiding = !category.archived;

  // Keep at least one visible category on each tab, so you can always add entries.
  if (hiding) {
    const visible = categoriesForTab(state.catTab).filter((c) => !c.archived);
    if (visible.length <= 1) return showError("category-error", "This is the only visible one here, so it can't be hidden.");
  }

  setCategoryBusy(true);
  const { error } = await db.from("categories").update({ archived: hiding }).eq("id", category.id);
  setCategoryBusy(false);
  if (error) return showError("category-error", `Couldn't save: ${error.message}`);

  await finishCategoryChange(hiding ? `${category.name} is now hidden` : `${category.name} is visible again`);
}

async function deleteCategory() {
  const category = state.catEditing;
  if (!category) return;
  if (categoriesForTab(state.catTab).length <= 1) {
    return showError("category-error", "This is the only one here, so it can't be deleted.");
  }
  if (!confirm(`Delete "${category.name}"? This can't be undone.`)) return;

  setCategoryBusy(true);
  const { error } = await db.from("categories").delete().eq("id", category.id);
  setCategoryBusy(false);
  if (error) return showError("category-error", `Couldn't delete: ${error.message}`);

  await finishCategoryChange(`Deleted ${category.name}`);
}


// ---------- Bank SMS: reading, review and merchant rules ----------

// True when this page is running inside the Android app rather than a browser.
// The Android app provides "androidBridge" for talking to its native code.
const IS_ANDROID_APP = Boolean(window.androidBridge);

// Your bank's SMS sender. Messages from anyone else are never read.
const BANK_SENDERS = ["8079", "MBL"];

// Starter rules, created once. Side and category are matched by name, so if you've renamed
// a category the rule just suggests the side, and you pick the category the first time.
const PRESET_RULES = [
  { keyword: "FOODPANDA", side: "Personal", category: "Food & eating out" },
  { keyword: "CHEEZIOUS", side: "Personal", category: "Food & eating out" },
  { keyword: "IESCO", side: "Household", category: "Bills & utilities" },
  { keyword: "SNGPL", side: "Household", category: "Bills & utilities" },
  { keyword: "NAYATEL", side: "Household", category: "Bills & utilities" },
  { keyword: "JAZZ PREPAID", side: "Personal", category: null },
  { keyword: "UFONE", side: "Personal", category: null },
];

// Kinds of message where remembering is usually wanted
// (shops, bills and cash withdrawals, rather than one-off transfers to people).
const MERCHANT_KINDS = ["Online purchase", "Card purchase", "Bill or top-up", "Cash withdrawal"];

// The Android app builds a small "bridge" into every page it shows (window.Capacitor),
// which can call our native SMS reader directly. Nothing needs downloading for this.
function getSmsInbox() {
  if (!IS_ANDROID_APP) throw new Error("Reading SMS only works in the Android app.");
  const bridge = window.Capacitor;
  if (!bridge?.nativePromise) {
    throw new Error("The connection to the phone isn't ready. Close the app fully, reopen it and try again.");
  }
  return {
    read: (options) => bridge.nativePromise("SmsInbox", "read", options),
    checkPermissions: () => bridge.nativePromise("SmsInbox", "checkPermissions", {}),
  };
}

// Stop waiting for the phone after a while, so nothing spins forever.
function withTimeout(promise, seconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), seconds * 1000)),
  ]);
}

function emptySmsState() {
  return {
    pending: [],        // messages waiting for review
    rules: [],          // merchant rules
    settings: null,     // where the phone got up to
    index: 0,           // which pending message the review sheet is showing
    form: null,         // choices on the review sheet
    changed: false,     // entries were added, so the month needs reloading
    syncing: false,
    lastSync: 0,
  };
}
state.sms = emptySmsState();

async function saveSmsSettings(values) {
  const { error } = await db.from("user_settings").upsert({
    user_id: state.userId,
    ...values,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  state.sms.settings = { ...(state.sms.settings ?? {}), ...values };
}

// Load what's waiting for review, the rules and the phone's progress (works on any device).
async function loadSmsData() {
  const [pending, rules, settings] = await Promise.all([
    db.from("sms_imports").select("*").eq("status", "pending").order("received_at"),
    db.from("merchant_rules").select("*").order("keyword"),
    db.from("user_settings").select("sms_checked_until, sms_rules_seeded").maybeSingle(),
  ]);
  for (const result of [pending, rules, settings]) {
    if (result.error) throw result.error;
  }
  state.sms.pending = pending.data;
  state.sms.rules = rules.data;
  state.sms.settings = settings.data ?? {};

  if (!state.sms.settings.sms_rules_seeded) await seedPresetRules();
  renderReviewBanner();
}

async function seedPresetRules() {
  const rows = [];
  for (const preset of PRESET_RULES) {
    const book = state.books.find((b) => b.name === preset.side);
    if (!book) continue;
    const category = preset.category
      ? state.categories.find((c) => c.type === "expense" && c.book_id === book.id && c.name === preset.category)
      : null;
    rows.push({
      user_id: state.userId,
      keyword: preset.keyword,
      direction: "out",
      action: "categorize",
      book_id: book.id,
      category_id: category?.id ?? null,
    });
  }
  if (rows.length) {
    const { error } = await db.from("merchant_rules")
      .upsert(rows, { onConflict: "user_id,keyword,direction", ignoreDuplicates: true });
    if (error) throw error;
  }
  await saveSmsSettings({ sms_rules_seeded: true });
  const { data, error } = await db.from("merchant_rules").select("*").order("keyword");
  if (error) throw error;
  state.sms.rules = data;
}

// On the phone: read new bank messages and save the transactions in them for review.
// Returns how many transactions were found.
async function syncSms() {
  if (!IS_ANDROID_APP || state.sms.syncing) return 0;
  state.sms.syncing = true;
  try {
    // First time: from the 1st of this month. After that: only newer than the last check.
    const since = Number(state.sms.settings?.sms_checked_until) || startOfMonth(new Date()).getTime();
    const { messages } = await withTimeout(
      getSmsInbox().read({ since, senders: BANK_SENDERS }),
      30,
      "The phone didn't answer within 30 seconds."
    );

    let latest = since;
    const rows = [];
    for (const message of messages) {
      latest = Math.max(latest, message.date);
      const parsed = BankSms.parseBankSms(message.body, message.date);
      if (!parsed) continue; // not a transaction (OTP, promotion...)
      const rule = BankSms.matchRule(parsed, state.sms.rules);
      rows.push({
        user_id: state.userId,
        sms_key: BankSms.smsKey(message),
        sender: message.sender,
        body: message.body,
        received_at: new Date(message.date).toISOString(),
        direction: parsed.direction,
        amount: parsed.amount,
        counterparty: parsed.counterparty,
        kind: parsed.kind,
        occurred_on: parsed.occurredOn,
        reference: parsed.reference,
        status: rule?.action === "ignore" ? "ignored" : "pending",
      });
    }

    if (rows.length) {
      const { error } = await db.from("sms_imports")
        .upsert(rows, { onConflict: "user_id,sms_key", ignoreDuplicates: true });
      if (error) throw error;
    }
    if (latest > since) await saveSmsSettings({ sms_checked_until: latest });
    state.sms.lastSync = Date.now();
    return rows.length;
  } finally {
    state.sms.syncing = false;
  }
}

// When the app opens: read new messages (on the phone), then ask about anything waiting.
async function startSms() {
  try {
    await loadSmsData();
    if (IS_ANDROID_APP) {
      await syncSms();
      await loadSmsData();
    }
    if (state.sms.pending.length && !anySheetOpen()) openReview();
  } catch (err) {
    showToast(`Bank SMS: ${err.message}`);
  }
}

// Coming back to the app on the phone: check again if it's been more than a minute.
async function resumeSms() {
  if (!IS_ANDROID_APP || !state.userId || Date.now() - state.sms.lastSync < 60 * 1000) return;
  try {
    const found = await syncSms();
    await loadSmsData();
    if (found && state.sms.pending.length && !anySheetOpen()) openReview();
  } catch (err) {
    showToast(`Bank SMS: ${err.message}`);
  }
}

function renderReviewBanner() {
  const count = state.sms.pending.length;
  $("review-banner").hidden = count === 0;
  $("review-banner").textContent = `📩 ${count} bank ${count === 1 ? "transaction" : "transactions"} to review →`;
}

// --- The review sheet ---

function openReview() {
  if (!state.sms.pending.length) return showToast("Nothing to review");
  state.sms.index = 0;
  showSheet("review-sheet");
  renderReviewItem();
}

function reviewTimeText(item) {
  const parsed = BankSms.parseBankSms(item.body, Date.parse(item.received_at));
  const date = parseISODate(item.occurred_on).toLocaleDateString(CONFIG.LOCALE, { weekday: "short", day: "numeric", month: "short" });
  if (!parsed?.time) return date;
  const [h, m] = parsed.time.split(":").map(Number);
  const time = new Date(2000, 0, 1, h, m).toLocaleTimeString(CONFIG.LOCALE, { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

function renderReviewItem() {
  const item = state.sms.pending[state.sms.index];
  if (!item) {
    closeSheets();
    showToast(state.sms.pending.length ? "The rest are saved for later" : "All reviewed");
    return;
  }

  const rule = BankSms.matchRule(item, state.sms.rules);
  const moneyIn = item.direction === "in";
  const lastBook = recall("lastBook");
  const f = {
    item,
    rule,
    bookId: rule?.book_id && isBook(rule.book_id) ? rule.book_id : isBook(lastBook) ? lastBook : state.books[0]?.id,
    categoryId: null,
    share: null,
  };
  if (moneyIn) {
    f.categoryId = incomeSources().some((c) => c.id === rule?.category_id) ? rule.category_id : null;
    f.share = rule?.split_share != null ? Number(rule.split_share) : rememberedShare(f.categoryId);
  } else if (expenseCategories(f.bookId).some((c) => c.id === rule?.category_id)) {
    f.categoryId = rule.category_id;
  }
  state.sms.form = f;

  const total = state.sms.pending.length;
  $("review-progress").textContent = total > 1 ? `${state.sms.index + 1} of ${total}` : "";
  $("review-amount").textContent = `${moneyIn ? "+" : "−"}${money.format(Number(item.amount))}`;
  $("review-amount").classList.toggle("income", moneyIn);
  $("review-who").textContent = item.counterparty || (moneyIn ? "Money received" : "Payment");
  $("review-meta").textContent = `${item.kind ?? (moneyIn ? "Money in" : "Money out")} · ${reviewTimeText(item)}`;
  $("review-body").textContent = item.body;
  document.querySelector(".review-original").open = false;

  $("review-rule").hidden = !rule;
  if (rule) {
    $("review-rule").textContent = rule.action === "ignore"
      ? `Your rule for ${rule.keyword} says to skip these.`
      : `Filled in from your rule for ${rule.keyword}.`;
  }

  $("review-out").hidden = moneyIn;
  $("review-in").hidden = !moneyIn;
  $("review-note").value = item.counterparty ?? "";
  $("review-error").hidden = true;

  // "Remember": ticked for shops and bills that don't have a rule yet.
  $("review-remember-row").hidden = !item.counterparty;
  $("review-remember").checked = !rule && MERCHANT_KINDS.includes(item.kind);
  $("review-keyword").value = rule?.keyword ?? BankSms.suggestKeyword(item.counterparty);
  $("review-keyword").disabled = !$("review-remember").checked;

  if (moneyIn) {
    reviewApplyShare(f.share);
    renderReviewSources();
  } else {
    renderReviewSide();
    renderReviewCategories();
  }
  $("review-sheet").scrollTop = 0;
}

function renderReviewSide() {
  const f = state.sms.form;
  const options = state.books.map((book) => ({ value: book.id, label: `${book.icon} ${book.name}` }));
  renderSegmented("review-side", options, f.bookId, (bookId) => {
    f.bookId = bookId;
    if (!expenseCategories(bookId).some((c) => c.id === f.categoryId)) f.categoryId = null;
    renderReviewSide();
    renderReviewCategories();
  });
}

function renderReviewCategories() {
  const f = state.sms.form;
  renderChipList("review-categories", expenseCategories(f.bookId), f.categoryId, (id) => {
    f.categoryId = id;
    renderReviewCategories();
  });
}

function renderReviewSources() {
  const f = state.sms.form;
  renderChipList("review-sources", incomeSources(), f.categoryId, (id) => {
    f.categoryId = id;
    if (!f.rule) reviewApplyShare(rememberedShare(id));
    renderReviewSources();
  });
}

// Split the received amount, giving `share` (0 to 1) to the first side.
function reviewApplyShare(share) {
  const f = state.sms.form;
  f.share = share;
  const total = Number(f.item.amount);
  const first = round2(total * share);
  $("review-split-0").value = amountForInput(first);
  $("review-split-1").value = amountForInput(total - first);
}

function onReviewSplitInput(index) {
  const f = state.sms.form;
  const total = Number(f.item.amount);
  const typed = parseAmount($(`review-split-${index}`).value);
  if (!Number.isFinite(typed)) return;
  $(`review-split-${1 - index}`).value = amountForInput(Math.max(total - typed, 0));
  const first = index === 0 ? typed : total - typed;
  f.share = Math.min(Math.max(first / total, 0), 1);
}

function setReviewBusy(busy) {
  for (const id of ["review-add", "review-skip", "review-later"]) $(id).disabled = busy;
}

async function saveRule(values) {
  const keyword = $("review-keyword").value.trim().toUpperCase();
  if (!BankSms.normalizeKey(keyword)) throw new Error("Enter a name to remember, or untick Remember.");
  const { error } = await db.from("merchant_rules").upsert({
    user_id: state.userId,
    keyword,
    direction: state.sms.form.item.direction,
    split_share: null,
    book_id: null,
    category_id: null,
    ...values,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,keyword,direction" });
  if (error) throw error;
  const rules = await db.from("merchant_rules").select("*").order("keyword");
  if (!rules.error) state.sms.rules = rules.data;
}

// Done with the current message: take it off the list and show the next one.
function finishReviewItem() {
  state.sms.pending.splice(state.sms.index, 1);
  renderReviewBanner();
  renderReviewItem();
}

async function addReviewed() {
  const f = state.sms.form;
  const item = f.item;
  $("review-error").hidden = true;
  const note = $("review-note").value.trim() || null;
  const amount = Number(item.amount);
  const rememberRule = $("review-remember").checked && !$("review-remember-row").hidden;

  let rows;
  if (item.direction === "out") {
    if (!f.categoryId) return showError("review-error", "Pick a category.");
    rows = [{
      book_id: f.bookId, type: "expense", amount, category_id: f.categoryId,
      occurred_on: item.occurred_on, note, source: "sms",
    }];
  } else {
    if (!f.categoryId) return showError("review-error", "Pick where the money came from.");
    const shares = [0, 1].map((i) => {
      const text = $(`review-split-${i}`).value.trim();
      return text === "" ? 0 : parseAmount(text);
    });
    if (shares.some((v) => !Number.isFinite(v) || v < 0)) return showError("review-error", "Split amounts must be zero or more.");
    if (Math.abs(shares[0] + shares[1] - amount) > 0.005) {
      return showError("review-error", `The split adds up to ${money.format(shares[0] + shares[1])}, but ${money.format(amount)} was received.`);
    }
    const splitId = newId();
    rows = state.books.slice(0, 2).map((book, i) => ({
      book_id: book.id, type: "income", amount: round2(shares[i]), category_id: f.categoryId,
      split_id: splitId, occurred_on: item.occurred_on, note, source: "sms",
    })).filter((row) => row.amount > 0);
    f.share = shares[0] / amount;
  }

  setReviewBusy(true);
  try {
    const inserted = await db.from("transactions").insert(rows).select("id");
    if (inserted.error) throw inserted.error;
    const marked = await db.from("sms_imports")
      .update({ status: "added", transaction_ids: inserted.data.map((r) => r.id) })
      .eq("id", item.id);
    if (marked.error) throw marked.error;
    state.sms.changed = true;

    if (item.direction === "out") {
      remember("lastBook", f.bookId);
      remember(`lastCategory:${f.bookId}`, f.categoryId);
    } else {
      remember("lastSource", f.categoryId);
      remember(`split:${f.categoryId}`, String(f.share));
    }
    if (rememberRule) {
      await saveRule(item.direction === "out"
        ? { action: "categorize", book_id: f.bookId, category_id: f.categoryId }
        : { action: "categorize", category_id: f.categoryId, split_share: Math.round(f.share * 1e6) / 1e6 });
    }
    showToast("Added");
    finishReviewItem();
  } catch (err) {
    showError("review-error", `Couldn't save: ${err.message}`);
  } finally {
    setReviewBusy(false);
  }
}

async function skipReviewed() {
  const item = state.sms.form.item;
  $("review-error").hidden = true;
  const rememberRule = $("review-remember").checked && !$("review-remember-row").hidden;
  setReviewBusy(true);
  try {
    const { error } = await db.from("sms_imports").update({ status: "ignored" }).eq("id", item.id);
    if (error) throw error;
    if (rememberRule) await saveRule({ action: "ignore" });
    showToast(rememberRule ? "Skipped, and messages like this will be skipped from now on" : "Skipped");
    finishReviewItem();
  } catch (err) {
    showError("review-error", `Couldn't save: ${err.message}`);
  } finally {
    setReviewBusy(false);
  }
}

function reviewLater() {
  state.sms.index += 1;
  renderReviewItem();
}

// --- The Bank SMS sheet: status and rules ---

function openSmsSheet() {
  $("sms-error").hidden = true;
  renderSmsSheet();
  showSheet("sms-sheet");
}

function renderSmsSheet() {
  const checked = Number(state.sms.settings?.sms_checked_until);
  const lastText = checked
    ? `Up to date to ${new Date(checked).toLocaleString(CONFIG.LOCALE, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.`
    : "Not checked yet.";
  $("sms-intro").textContent = IS_ANDROID_APP
    ? "Each time you open the app, it reads new messages from your bank (MBL, 8079) and asks you about the transactions in them. Messages from anyone else are never read."
    : "Bank messages are read by the Android app on your phone. Anything it finds waiting for review shows up here too.";
  $("sms-check").hidden = !IS_ANDROID_APP;
  $("sms-status").textContent = IS_ANDROID_APP ? lastText : "";

  const count = state.sms.pending.length;
  $("sms-review").hidden = count === 0;
  $("sms-review").textContent = `Review ${count} waiting`;

  const list = $("sms-rules");
  list.replaceChildren();
  $("sms-rules-empty").hidden = state.sms.rules.length > 0;
  for (const rule of state.sms.rules) {
    const book = bookById(rule.book_id);
    const category = categoryById(rule.category_id);
    let target;
    if (rule.action === "ignore") target = "Always skip";
    else if (rule.direction === "in") {
      const share = rule.split_share != null ? Math.round(Number(rule.split_share) * 100) : null;
      target = [category?.name ?? "Pick source", share != null ? `${share}% ${state.books[0]?.name ?? ""}`.trim() : null].filter(Boolean).join(" · ");
    } else {
      target = [book?.name, category?.name ?? "pick category"].filter(Boolean).join(" · ");
    }
    list.append(makeRow({
      icon: rule.action === "ignore" ? "🚫" : category?.icon ?? book?.icon ?? "🏷️",
      color: category?.color ?? book?.color ?? "#868E96",
      name: rule.keyword,
      note: `${rule.direction === "in" ? "Money in" : "Money out"} → ${target}`,
      amountText: "",
      onClick: () => deleteRule(rule),
    }));
  }
}

async function deleteRule(rule) {
  if (!confirm(`Delete the rule for ${rule.keyword}? Messages mentioning it will no longer be filled in automatically.`)) return;
  const { error } = await db.from("merchant_rules").delete().eq("id", rule.id);
  if (error) return showError("sms-error", `Couldn't delete: ${error.message}`);
  state.sms.rules = state.sms.rules.filter((r) => r.id !== rule.id);
  renderSmsSheet();
  showToast("Rule deleted");
}

async function checkSmsNow() {
  $("sms-error").hidden = true;
  $("sms-check").disabled = true;
  $("sms-status").textContent = "Checking…";
  try {
    const found = await syncSms();
    await loadSmsData();
    renderSmsSheet();
    showToast(found ? `Found ${found} new ${found === 1 ? "transaction" : "transactions"}` : "No new transactions");
    if (state.sms.pending.length) openReview();
  } catch (err) {
    const denied = /not allowed|denied/i.test(err.message);
    showError("sms-error", denied
      ? "SMS access wasn't allowed. To allow it: open your phone's Settings → Apps → Budget → Permissions → SMS → Allow."
      : `Couldn't check messages: ${err.message}`);
    renderSmsSheet();
  } finally {
    $("sms-check").disabled = false;
  }
}


// ---------- Savings goals ----------

// A goal: "Emergency fund, Rs 600,000 in 12 months" on one side.
// Progress = what you'd already saved towards it + how much that side's savings
// have grown since the goal was set (your leftover each month is your savings).

// Calendar months from one date to another: 4 Nov → 4 Feb is exactly 3,
// and part-months count by days (4 Nov → 19 Nov is about half a month).
function calendarMonthsBetween(from, to) {
  const whole = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  const daysInMonth = new Date(to.getFullYear(), to.getMonth() + 1, 0).getDate();
  return whole + (to.getDate() - from.getDate()) / daysInMonth;
}

function emptyGoalsState() {
  return { list: [], balanceNow: new Map(), loaded: false, error: null };
}
state.goals = emptyGoalsState();
state.goalEditing = null;
state.goalBook = null;

async function loadGoals() {
  // Each side's savings right now (everything up to and including today).
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const [goals, balances] = await Promise.all([
    db.from("savings_goals").select("*").order("created_at"),
    db.rpc("balances_before", { p_date: toISODate(tomorrow) }),
  ]);
  if (goals.error) throw goals.error;
  if (balances.error) throw balances.error;
  state.goals.list = goals.data;
  state.goals.balanceNow = new Map(balances.data.map((row) => [row.book_id, Number(row.balance)]));
  state.goals.loaded = true;
  state.goals.error = null;
}

async function refreshGoals() {
  try {
    await loadGoals();
  } catch (err) {
    state.goals.error = err.message;
  }
  renderGoals();
}

function monthYear(date) {
  return date.toLocaleDateString(CONFIG.LOCALE, { month: "short", year: "numeric" });
}

function goalDeadline(startISO, months) {
  const start = parseISODate(startISO);
  return new Date(start.getFullYear(), start.getMonth() + months, start.getDate());
}

// All the numbers for one goal.
function goalFigures(goal) {
  const target = Number(goal.target_amount);
  const already = Number(goal.already_saved);
  const months = Number(goal.months);
  const balance = state.goals.balanceNow.get(goal.book_id) ?? Number(goal.start_balance);
  const saved = Math.max(0, already + (balance - Number(goal.start_balance)));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = parseISODate(goal.start_date);
  const deadline = goalDeadline(goal.start_date, months);
  const monthsGone = Math.min(Math.max(calendarMonthsBetween(start, today), 0), months);
  const monthsLeft = Math.max(calendarMonthsBetween(today, deadline), 0);

  const planMonthly = Math.max(target - already, 0) / months; // the plan when you set it
  const remaining = Math.max(target - saved, 0);
  // From now on: spread what's left over the months left (all of it if under a month remains).
  const neededNow = remaining === 0 ? 0 : monthsLeft >= 1 ? remaining / monthsLeft : remaining;
  // Where the plan says you should be by today.
  const expected = Math.min(already + planMonthly * monthsGone, target);

  let status;
  let statusClass;
  if (remaining === 0) {
    status = "Reached 🎉";
    statusClass = "good";
  } else if (monthsLeft <= 0) {
    status = `Target date passed, ${money.format(remaining)} still to go`;
    statusClass = "late";
  } else if (saved >= expected - 1) {
    status = "On track";
    statusClass = "good";
  } else {
    status = `Behind plan by ${money.format(expected - saved)}`;
    statusClass = "behind";
  }

  return {
    target, saved, remaining, planMonthly, neededNow, deadline, monthsLeft,
    percent: Math.min((saved / target) * 100, 100),
    active: remaining > 0 && monthsLeft > 0,
    status, statusClass,
  };
}

function renderGoals() {
  const goals = state.goals.list.filter((g) => state.view === "all" || g.book_id === state.view);
  const list = $("goals-list");
  list.replaceChildren();

  $("goals-error").hidden = !state.goals.error;
  if (state.goals.error) {
    $("goals-error").textContent = `Couldn't load goals: ${state.goals.error}`;
  }
  $("goals-empty").hidden = goals.length > 0 || Boolean(state.goals.error);

  for (const goal of goals) {
    const f = goalFigures(goal);
    const book = bookById(goal.book_id);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "goal";
    button.addEventListener("click", () => openGoalSheet(goal));

    const top = document.createElement("div");
    top.className = "goal-top";
    const name = document.createElement("span");
    name.className = "goal-name";
    name.textContent = state.view === "all" && book ? `${goal.name} · ${book.icon} ${book.name}` : goal.name;
    const percent = document.createElement("span");
    percent.className = "goal-percent";
    percent.textContent = `${Math.floor(f.percent)}%`;
    top.append(name, percent);

    const bar = document.createElement("div");
    bar.className = "goal-bar";
    bar.classList.toggle("behind", f.statusClass !== "good");
    const fill = document.createElement("div");
    fill.style.width = `${f.percent}%`;
    bar.append(fill);

    const progress = document.createElement("p");
    progress.className = "goal-line";
    progress.textContent = `${money.format(f.saved)} of ${money.format(f.target)} · by ${monthYear(f.deadline)}`;

    const plan = document.createElement("p");
    plan.className = "goal-line";
    if (f.active) {
      const left = Math.ceil(f.monthsLeft);
      plan.textContent = `Save ${money.format(f.neededNow)} a month for ${left} more ${left === 1 ? "month" : "months"}`;
    } else if (f.remaining === 0) {
      plan.textContent = "Target reached";
    } else {
      plan.textContent = "Extend the time or lower the target to make a new plan";
    }

    const status = document.createElement("p");
    status.className = `goal-status ${f.statusClass}`;
    status.textContent = f.status;

    button.append(top, bar, progress, plan, status);
    const item = document.createElement("li");
    item.append(button);
    list.append(item);
  }

  // Several goals on one side share its savings, so show what they need together.
  for (const book of state.books) {
    const active = goals.filter((g) => g.book_id === book.id).map(goalFigures).filter((f) => f.active);
    if (active.length < 2) continue;
    const total = active.reduce((sum, f) => sum + f.neededNow, 0);
    const note = document.createElement("li");
    note.className = "goals-together";
    note.textContent = `${book.icon} ${book.name} goals share its savings: together they need about ${money.format(total)} a month.`;
    list.append(note);
  }
}

// --- Add / edit a goal ---

function openGoalSheet(goal = null) {
  state.goalEditing = goal;
  state.goalBook = goal?.book_id ?? (state.view !== "all" ? state.view : state.books[0]?.id);
  $("goal-title").textContent = goal ? "Edit savings goal" : "New savings goal";
  $("goal-name").value = goal?.name ?? "";
  $("goal-target").value = goal ? amountForInput(Number(goal.target_amount)) : "";
  $("goal-months").value = goal ? String(goal.months) : "";
  $("goal-already").value = goal && Number(goal.already_saved) ? amountForInput(Number(goal.already_saved)) : "";
  $("goal-error").hidden = true;
  $("goal-delete").hidden = !goal;
  $("goal-side-note").hidden = true;
  renderGoalSide();
  updateGoalPreview();
  showSheet("goal-sheet");
  if (!goal) setTimeout(() => $("goal-name").focus(), 60);
}

function renderGoalSide() {
  const options = state.books.map((book) => ({ value: book.id, label: `${book.icon} ${book.name}` }));
  renderSegmented("goal-side", options, state.goalBook, (bookId) => {
    state.goalBook = bookId;
    renderGoalSide();
    $("goal-side-note").hidden = !(state.goalEditing && bookId !== state.goalEditing.book_id);
    updateGoalPreview();
  });
}

// What the form would save, or null if it isn't complete yet.
function goalDraft() {
  const target = parseAmount($("goal-target").value);
  const monthsText = $("goal-months").value.trim();
  const months = /^\d+$/.test(monthsText) ? Number(monthsText) : NaN;
  const alreadyText = $("goal-already").value.trim();
  const already = alreadyText === "" ? 0 : parseAmount(alreadyText);
  return { target, months, already };
}

// Live preview: "Rs 50,000 a month to reach Rs 600,000 by Nov 2027".
function updateGoalPreview() {
  const { target, months, already } = goalDraft();
  const box = $("goal-preview");
  box.replaceChildren();
  const valid = target > 0 && months >= 1 && months <= 600 && already >= 0;
  box.hidden = !valid;
  if (!valid) return;

  const editing = state.goalEditing;
  const sameSide = editing && editing.book_id === state.goalBook;
  const startISO = sameSide ? editing.start_date : toISODate(new Date());
  const deadline = goalDeadline(startISO, months);

  const headline = document.createElement("strong");
  const line = document.createElement("p");
  if (already >= target) {
    headline.textContent = "Already reached";
    line.textContent = `You've saved ${money.format(already)} towards a target of ${money.format(target)}.`;
  } else {
    headline.textContent = `${money.format((target - already) / months)} a month`;
    line.textContent = `to reach ${money.format(target)} by ${monthYear(deadline)}${already > 0 ? `, counting the ${money.format(already)} already saved` : ""}.`;
  }
  box.append(headline, line);

  // When editing, also show where things stand today.
  if (sameSide) {
    const f = goalFigures({ ...editing, target_amount: target, months, already_saved: already });
    const now = document.createElement("p");
    now.textContent = f.active
      ? `So far: ${money.format(f.saved)} saved. From now on that's ${money.format(f.neededNow)} a month.`
      : f.remaining === 0 ? `So far: ${money.format(f.saved)} saved. Target reached.` : `The target date has passed.`;
    box.append(now);
  }
}

async function saveGoal(event) {
  event.preventDefault();
  $("goal-error").hidden = true;
  const name = $("goal-name").value.trim();
  const { target, months, already } = goalDraft();
  if (!name) return showError("goal-error", "Give the goal a name.");
  if (!(target > 0)) return showError("goal-error", "Enter a target amount greater than zero.");
  if (!(months >= 1 && months <= 600)) return showError("goal-error", "Enter the number of months as a whole number, from 1 to 600.");
  if (!(already >= 0)) return showError("goal-error", "Already saved must be zero or more.");

  const editing = state.goalEditing;
  const row = {
    book_id: state.goalBook,
    name,
    target_amount: round2(target),
    months,
    already_saved: round2(already),
  };
  // New goal, or moved to the other side: start tracking from today's savings.
  if (!editing || editing.book_id !== state.goalBook) {
    row.start_date = toISODate(new Date());
    row.start_balance = round2(state.goals.balanceNow.get(state.goalBook) ?? 0);
  }

  $("goal-save").disabled = true;
  const { error } = editing
    ? await db.from("savings_goals").update(row).eq("id", editing.id)
    : await db.from("savings_goals").insert(row);
  $("goal-save").disabled = false;
  if (error) return showError("goal-error", `Couldn't save: ${error.message}`);

  closeSheets();
  showToast(editing ? "Goal saved" : `Goal added: ${name}`);
  await refreshGoals();
}

async function deleteGoal() {
  const goal = state.goalEditing;
  if (!goal || !confirm(`Delete the goal "${goal.name}"? Your savings aren't affected.`)) return;
  $("goal-delete").disabled = true;
  const { error } = await db.from("savings_goals").delete().eq("id", goal.id);
  $("goal-delete").disabled = false;
  if (error) return showError("goal-error", `Couldn't delete: ${error.message}`);
  closeSheets();
  showToast("Goal deleted");
  await refreshGoals();
}


// ---------- Wiring up buttons ----------

function wireEvents() {
  $("login-form").addEventListener("submit", handleLogin);
  $("sign-out").addEventListener("click", handleSignOut);
  $("open-balances").addEventListener("click", openBalancesSheet);
  $("open-backup").addEventListener("click", openBackupSheet);

  // Savings goals
  $("goal-add").addEventListener("click", () => openGoalSheet());
  $("goal-form").addEventListener("submit", saveGoal);
  $("goal-delete").addEventListener("click", deleteGoal);
  for (const id of ["goal-target", "goal-months", "goal-already"]) {
    $(id).addEventListener("input", updateGoalPreview);
  }

  // Bank SMS and review
  $("open-sms").addEventListener("click", openSmsSheet);
  $("sms-check").addEventListener("click", checkSmsNow);
  $("sms-review").addEventListener("click", openReview);
  $("review-banner").addEventListener("click", openReview);
  $("review-add").addEventListener("click", addReviewed);
  $("review-skip").addEventListener("click", skipReviewed);
  $("review-later").addEventListener("click", reviewLater);
  $("review-remember").addEventListener("change", () => {
    $("review-keyword").disabled = !$("review-remember").checked;
  });
  $("review-split-0").addEventListener("input", () => onReviewSplitInput(0));
  $("review-split-1").addEventListener("input", () => onReviewSplitInput(1));
  document.querySelectorAll("[data-review-split]").forEach((button) => {
    button.addEventListener("click", () => reviewApplyShare(Number(button.dataset.reviewSplit)));
  });
  // Coming back to the app on the phone: check for new messages.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resumeSms();
  });

  // Categories
  $("open-categories").addEventListener("click", () => openCategoriesSheet());
  $("cat-add").addEventListener("click", () => openCategoryEditor());
  $("category-form").addEventListener("submit", saveCategory);
  $("cat-back").addEventListener("click", () => openCategoriesSheet(state.catTab));
  $("cat-hide").addEventListener("click", toggleCategoryHidden);
  $("cat-delete").addEventListener("click", deleteCategory);
  $("cat-name").addEventListener("input", renderCategoryEditor);
  $("cat-icon-custom").addEventListener("input", () => {
    const typed = $("cat-icon-custom").value.trim();
    if (typed) {
      state.catDraft.icon = typed;
      renderCategoryEditor();
    }
  });
  $("export-csv").addEventListener("click", exportCsv);
  $("export-json").addEventListener("click", exportJson);
  $("balances-form").addEventListener("submit", saveBalances);

  $("prev-month").addEventListener("click", () => changeMonth(-1));
  $("next-month").addEventListener("click", () => changeMonth(1));
  $("month-label").addEventListener("click", goToThisMonth);

  $("add-btn").addEventListener("click", () => openForm());
  $("add-btn-top").addEventListener("click", () => openForm());
  document.querySelectorAll(".sheet-close").forEach((button) => button.addEventListener("click", closeSheets));
  $("sheet-backdrop").addEventListener("click", closeSheets);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && anySheetOpen()) closeSheets();
  });

  document.querySelectorAll("#mode-tabs button").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  // Income split: changing the total re-splits it; typing one share fills in the other.
  $("entry-amount").addEventListener("input", () => {
    if (state.form?.mode === "income") applyShare(state.form.splitShare ?? 0.5);
  });
  $("split-0").addEventListener("input", () => onSplitInput(0));
  $("split-1").addEventListener("input", () => onSplitInput(1));
  document.querySelectorAll(".split-quick button").forEach((button) => {
    button.addEventListener("click", () => applyShare(Number(button.dataset.split)));
  });

  $("entry-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveForm(false);
  });
  $("save-another-btn").addEventListener("click", () => saveForm(true));
  $("delete-btn").addEventListener("click", deleteFromForm);

  // Gold
  $("gold-manage").addEventListener("click", openGoldSheet);
  $("gold-add-first").addEventListener("click", () => openAssetSheet());
  $("gold-add").addEventListener("click", () => openAssetSheet());
  $("asset-form").addEventListener("submit", saveAsset);
  $("asset-delete").addEventListener("click", deleteAsset);
  $("calibrate-form").addEventListener("submit", applyCalibration);
  $("calibrate-reset").addEventListener("click", resetCalibration);
}


// ---------- Start ----------

async function start() {
  document.querySelectorAll(".currency-symbol").forEach((el) => { el.textContent = currencySymbol; });
  wireEvents();

  // If you signed in before on this device, Supabase remembers the session.
  const { data } = await db.auth.getSession();
  if (data.session) {
    state.userId = data.session.user.id;
    await enterApp();
  } else {
    showLogin();
  }
}

start();

// Register the service worker, which makes the app installable and quick to open.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker not registered:", err));
}