const STORE_KEY = "payroll-dashboard-v1";
const AUTH_PREF_KEY = "payroll-auth-prefs-v1";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const CURRENCY = {
  AUD: { symbol: "$", locale: "en-AU" },
  USD: { symbol: "$", locale: "en-US" },
  CNY: { symbol: "¥", locale: "zh-CN" },
  EUR: { symbol: "€", locale: "de-DE" },
  GBP: { symbol: "£", locale: "en-GB" },
};

const initialState = {
  settings: {
    defaultRate: 20,
    currency: "AUD",
    weekStart: 1,
    autoBreak: true,
    defaultBreak: 0,
    decimals: 2,
    darkMode: false,
  },
  records: {},
  meta: {},
};

let state = loadState();
let selectedWeekStart = startOfWeek(new Date(), state.settings.weekStart);
let saveTimer;
let cloudSaveTimer;
let cloudClient = null;
let cloudUser = null;
let cloudReady = false;
let authMode = "login";

const els = {
  appShell: document.querySelector("#app-shell"),
  authScreen: document.querySelector("#auth-screen"),
  authForm: document.querySelector("#auth-form"),
  authTabs: document.querySelectorAll(".auth-tab"),
  authEmail: document.querySelector("#auth-email"),
  authPassword: document.querySelector("#auth-password"),
  rememberLogin: document.querySelector("#remember-login"),
  authSubmit: document.querySelector("#auth-submit"),
  authMessage: document.querySelector("#auth-message"),
  views: document.querySelectorAll(".view"),
  tabs: document.querySelectorAll(".tab"),
  weekRange: document.querySelector("#week-range"),
  prevWeek: document.querySelector("#prev-week"),
  nextWeek: document.querySelector("#next-week"),
  currentWeek: document.querySelector("#current-week"),
  daysGrid: document.querySelector("#days-grid"),
  dayTemplate: document.querySelector("#day-card-template"),
  saveState: document.querySelector("#save-state"),
  summaryPay: document.querySelector("#summary-pay"),
  summaryHours: document.querySelector("#summary-hours"),
  summaryDays: document.querySelector("#summary-days"),
  summaryRate: document.querySelector("#summary-rate"),
  summaryBestDay: document.querySelector("#summary-best-day"),
  summaryLongestDay: document.querySelector("#summary-longest-day"),
  trendChart: document.querySelector("#trend-chart"),
  historyList: document.querySelector("#history-list"),
  monthSummary: document.querySelector("#month-summary"),
  monthGrid: document.querySelector("#month-grid"),
  settingsForm: document.querySelector("#settings-form"),
  defaultRate: document.querySelector("#default-rate"),
  currency: document.querySelector("#currency"),
  weekStart: document.querySelector("#week-start"),
  defaultBreak: document.querySelector("#default-break"),
  decimals: document.querySelector("#decimals"),
  autoBreak: document.querySelector("#auto-break"),
  darkMode: document.querySelector("#dark-mode"),
  settingsSaveState: document.querySelector("#settings-save-state"),
  cloudStatus: document.querySelector("#cloud-status"),
  cloudLogout: document.querySelector("#cloud-logout"),
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    return saved ? mergeState(initialState, saved) : structuredClone(initialState);
  } catch {
    return structuredClone(initialState);
  }
}

function mergeState(base, saved) {
  const merged = {
    settings: { ...base.settings, ...(saved.settings || {}) },
    records: saved.records || {},
    meta: saved.meta || {},
  };

  if (!merged.meta.defaultSettingsV2) {
    if (merged.settings.defaultRate === 28) merged.settings.defaultRate = 20;
    if (merged.settings.defaultBreak === 0.5) merged.settings.defaultBreak = 0;
    merged.meta.defaultSettingsV2 = true;
  }

  return merged;
}

function persist() {
  clearTimeout(saveTimer);
  state.meta = { ...(state.meta || {}), updatedAt: new Date().toISOString() };
  els.saveState.textContent = "保存中";
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    els.saveState.textContent = "已保存";
  }, 180);
  scheduleCloudSave();
}

function setCloudStatus(message) {
  if (els.cloudStatus) els.cloudStatus.textContent = message;
}

function setAuthMessage(message) {
  if (els.authMessage) els.authMessage.textContent = message;
}

function loadAuthPrefs() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_PREF_KEY)) || {};
  } catch {
    return {};
  }
}

function applyAuthPrefs() {
  const prefs = loadAuthPrefs();
  els.rememberLogin.checked = Boolean(prefs.remember);
  els.authEmail.value = prefs.remember ? prefs.email || "" : "";
}

function saveAuthPrefs(email) {
  if (els.rememberLogin.checked) {
    localStorage.setItem(AUTH_PREF_KEY, JSON.stringify({ remember: true, email }));
  } else {
    localStorage.removeItem(AUTH_PREF_KEY);
  }
}

function showAuth() {
  els.authScreen.classList.remove("is-hidden");
  els.appShell.classList.add("is-hidden");
}

function showApp() {
  els.authScreen.classList.add("is-hidden");
  els.appShell.classList.remove("is-hidden");
  render();
}

function updateAuthMode(mode) {
  authMode = mode;
  els.authTabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.authMode === mode));
  els.authSubmit.textContent = mode === "login" ? "登录" : "注册";
  els.authPassword.autocomplete = mode === "login" ? "current-password" : "new-password";
  setAuthMessage(mode === "login" ? "输入邮箱和密码登录。" : "注册后会直接进入，不再走邮箱验证。");
}

function getCloudConfig() {
  const config = window.PAYROLL_CLOUD_CONFIG || {};
  const supabaseUrl = (config.supabaseUrl || "").trim();
  const supabaseAnonKey = (config.supabaseAnonKey || "").trim();
  return { supabaseUrl, supabaseAnonKey };
}

function canUseCloud() {
  const config = getCloudConfig();
  return Boolean(window.supabase && config.supabaseUrl && config.supabaseAnonKey);
}

async function initCloud() {
  if (!canUseCloud()) {
    setCloudStatus("未配置云端服务，当前使用本地存储。");
    setAuthMessage("还没有配置 Supabase，暂时无法注册或登录。");
    showAuth();
    return;
  }

  const config = getCloudConfig();
  cloudClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  cloudReady = true;
  setCloudStatus("云端服务已配置，登录后会自动同步。");

  const { data } = await cloudClient.auth.getSession();
  if (data.session?.user) {
    cloudUser = data.session.user;
    await loadCloudState();
    showApp();
  } else {
    setAuthMessage("输入邮箱和密码登录，或切换到注册。");
    showAuth();
  }

  cloudClient.auth.onAuthStateChange(async (_event, session) => {
    cloudUser = session?.user || null;
    if (cloudUser) {
      await loadCloudState();
      showApp();
    } else {
      setCloudStatus("云端服务已配置，尚未登录。登录后会自动同步。");
      showAuth();
    }
  });
}

async function loadCloudState() {
  if (!cloudReady || !cloudUser) return;
  setCloudStatus(`已登录 ${cloudUser.email || ""}，正在同步...`);

  const { data, error } = await cloudClient
    .from("payroll_data")
    .select("data, updated_at")
    .eq("user_id", cloudUser.id)
    .maybeSingle();

  if (error) {
    setCloudStatus(`云端读取失败：${error.message}`);
    return;
  }

  if (data?.data) {
    state = mergeState(initialState, {
      ...data.data,
      records: { ...(data.data.records || {}), ...(state.records || {}) },
      settings: { ...(data.data.settings || {}), ...(state.settings || {}) },
    });
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    render();
  }

  await saveCloudState();
}

function scheduleCloudSave() {
  if (!cloudReady || !cloudUser) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(saveCloudState, 600);
}

async function saveCloudState() {
  if (!cloudReady || !cloudUser) return;

  const payload = {
    user_id: cloudUser.id,
    data: state,
    updated_at: new Date().toISOString(),
  };

  const { error } = await cloudClient.from("payroll_data").upsert(payload);
  if (error) {
    setCloudStatus(`云端保存失败：${error.message}`);
    return;
  }
  setCloudStatus(`已同步到云端：${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
}

async function submitAuth(event) {
  event.preventDefault();

  if (!cloudReady) {
    setAuthMessage("还没有填写 Supabase 配置，无法注册或登录。");
    return;
  }

  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  if (!email || password.length < 6) {
    setAuthMessage("请输入邮箱和至少 6 位密码。");
    return;
  }

  els.authSubmit.disabled = true;
  setAuthMessage(authMode === "login" ? "正在登录..." : "正在注册...");

  const result =
    authMode === "login"
      ? await cloudClient.auth.signInWithPassword({ email, password })
      : await cloudClient.auth.signUp({ email, password });

  els.authSubmit.disabled = false;

  if (result.error) {
    setAuthMessage(result.error.message);
    return;
  }

  saveAuthPrefs(email);

  if (authMode === "signup" && !result.data.session) {
    setAuthMessage("账号已创建，但 Supabase 后台仍开启了邮箱验证。请在 Authentication > Providers > Email 里关闭 Confirm email。");
    return;
  }

  cloudUser = result.data.user;
  setAuthMessage("登录成功，正在进入...");
  await loadCloudState();
  showApp();
}

async function logoutFromCloud() {
  if (!cloudReady) return;
  await cloudClient.auth.signOut();
  cloudUser = null;
  setCloudStatus("已退出登录，当前仅保存到本机浏览器。");
  setAuthMessage("已退出登录。");
  showAuth();
}

function startOfWeek(date, weekStart) {
  const current = new Date(date);
  current.setHours(0, 0, 0, 0);
  const diff = (current.getDay() - Number(weekStart) + 7) % 7;
  current.setDate(current.getDate() - diff);
  return current;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function shortDate(date) {
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function formatMoney(amount) {
  const currency = CURRENCY[state.settings.currency] || CURRENCY.AUD;
  const value = Number.isFinite(amount) ? amount : 0;
  return `${currency.symbol}${value.toLocaleString(currency.locale, {
    minimumFractionDigits: Number(state.settings.decimals),
    maximumFractionDigits: Number(state.settings.decimals),
  })}`;
}

function formatHours(hours) {
  const value = Number.isFinite(hours) ? hours : 0;
  return `${Number(value.toFixed(2)).toLocaleString("zh-CN")} h`;
}

function emptyRecord() {
  return {
    isWorkday: false,
    start: "",
    end: "",
    breakHours: state.settings.autoBreak ? Number(state.settings.defaultBreak) : 0,
    rate: Number(state.settings.defaultRate),
    note: "",
  };
}

function getRecord(key) {
  if (!state.records[key]) state.records[key] = emptyRecord();
  return state.records[key];
}

function parseTime(value) {
  if (!value) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function calculate(record) {
  if (!record.isWorkday) return { hours: 0, pay: 0, error: "" };

  const start = parseTime(record.start);
  const end = parseTime(record.end);
  const rate = Number(record.rate);
  const breakHours = Number(record.breakHours) || 0;

  if (rate < 0) return { hours: 0, pay: 0, error: "时薪不能为负数" };
  if (breakHours < 0) return { hours: 0, pay: 0, error: "休息时间不能为负数" };
  if (start === null || end === null) return { hours: 0, pay: 0, error: "" };
  if (end <= start) return { hours: 0, pay: 0, error: "请检查结束时间" };

  const grossHours = (end - start) / 60;
  if (breakHours > grossHours) return { hours: 0, pay: 0, error: "休息时间超过上班时长" };

  const hours = Math.max(0, grossHours - breakHours);
  return { hours, pay: hours * Math.max(rate, 0), error: "" };
}

function weekDates() {
  return Array.from({ length: 7 }, (_, index) => addDays(selectedWeekStart, index));
}

function weekKeyFromDate(date) {
  return dateKey(startOfWeek(date, state.settings.weekStart));
}

function getWeekSummary(startDate) {
  const dates = Array.from({ length: 7 }, (_, index) => addDays(startDate, index));
  const daily = dates.map((date) => {
    const key = dateKey(date);
    const record = state.records[key] || emptyRecord();
    return { date, key, record, ...calculate(record) };
  });

  const workdays = daily.filter((day) => day.record.isWorkday);
  const totalHours = daily.reduce((sum, day) => sum + day.hours, 0);
  const totalPay = daily.reduce((sum, day) => sum + day.pay, 0);
  const averageRate = totalHours > 0 ? totalPay / totalHours : 0;
  const bestDay = daily.reduce((best, day) => (day.pay > best.pay ? day : best), daily[0]);
  const longestDay = daily.reduce((best, day) => (day.hours > best.hours ? day : best), daily[0]);

  return { daily, workdays, totalHours, totalPay, averageRate, bestDay, longestDay };
}

function render() {
  document.body.classList.toggle("dark", state.settings.darkMode);
  renderSettings();
  renderWeek();
  renderHistory();
}

function renderSettings() {
  els.defaultRate.value = state.settings.defaultRate;
  els.currency.value = state.settings.currency;
  els.weekStart.value = state.settings.weekStart;
  els.defaultBreak.value = state.settings.defaultBreak;
  els.decimals.value = state.settings.decimals;
  els.autoBreak.checked = state.settings.autoBreak;
  els.darkMode.checked = state.settings.darkMode;
  els.settingsSaveState.textContent = "修改设置后点击保存。";
}

function renderWeek() {
  renderWeekStats();
  els.daysGrid.innerHTML = "";
  weekDates().forEach((date) => renderDayCard(date));
}

function renderWeekStats() {
  const dates = weekDates();
  const summary = getWeekSummary(selectedWeekStart);
  els.weekRange.textContent = `${shortDate(dates[0])} - ${shortDate(dates[6])} ${dates[6].getFullYear()}`;

  els.summaryPay.textContent = formatMoney(summary.totalPay);
  els.summaryHours.textContent = formatHours(summary.totalHours);
  els.summaryDays.textContent = `${summary.workdays.length} 天`;
  els.summaryRate.textContent = `${formatMoney(summary.averageRate)} / h`;
  els.summaryBestDay.textContent = summary.bestDay.pay > 0 ? `最高收入 ${WEEKDAYS[summary.bestDay.date.getDay()]}` : "最高收入 -";
  els.summaryLongestDay.textContent = summary.longestDay.hours > 0 ? `最长工作 ${WEEKDAYS[summary.longestDay.date.getDay()]}` : "最长工作 -";

  renderTrend(summary.daily);
}

function renderDayCard(date) {
  const key = dateKey(date);
  const record = getRecord(key);
  const result = calculate(record);
  const node = els.dayTemplate.content.firstElementChild.cloneNode(true);
  const todayKey = dateKey(new Date());

  node.dataset.key = key;
  node.classList.toggle("is-off", !record.isWorkday);
  node.classList.toggle("is-today", key === todayKey);
  node.querySelector(".day-name").textContent = WEEKDAYS[date.getDay()];
  node.querySelector(".day-date").textContent = shortDate(date);
  node.querySelector(".is-workday").checked = record.isWorkday;
  node.querySelector(".start-time").value = record.start || "";
  node.querySelector(".end-time").value = record.end || "";
  node.querySelector(".break-hours").value = record.breakHours ?? 0;
  node.querySelector(".hourly-rate").value = record.rate ?? state.settings.defaultRate;
  node.querySelector(".note").value = record.note || "";
  node.querySelector(".error-text").textContent = result.error;
  node.querySelector(".hours-result").textContent = formatHours(result.hours);
  node.querySelector(".pay-result").textContent = formatMoney(result.pay);
  els.daysGrid.appendChild(node);
}

function refreshDayCard(card, record) {
  const result = calculate(record);
  card.classList.toggle("is-off", !record.isWorkday);
  card.querySelector(".error-text").textContent = result.error;
  card.querySelector(".hours-result").textContent = formatHours(result.hours);
  card.querySelector(".pay-result").textContent = formatMoney(result.pay);
}

function renderTrend(daily) {
  const maxPay = Math.max(...daily.map((day) => day.pay), 1);
  els.trendChart.innerHTML = daily
    .map((day) => {
      const height = Math.max(4, (day.pay / maxPay) * 100);
      return `
        <div class="bar-wrap">
          <div class="bar" style="height:${height}%"></div>
          <span class="bar-value">${day.pay ? formatMoney(day.pay) : "-"}</span>
          <span class="bar-label">${WEEKDAYS[day.date.getDay()].slice(1)}</span>
        </div>
      `;
    })
    .join("");
}

function renderHistory() {
  const weekMap = new Map();
  Object.keys(state.records).forEach((key) => {
    const date = new Date(`${key}T00:00:00`);
    const start = weekKeyFromDate(date);
    weekMap.set(start, getWeekSummary(new Date(`${start}T00:00:00`)));
  });

  const weeks = [...weekMap.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .filter(([, summary]) => summary.totalHours > 0 || summary.workdays.length > 0);

  els.historyList.innerHTML = weeks.length
    ? weeks
        .map(([key, summary]) => {
          const start = new Date(`${key}T00:00:00`);
          const end = addDays(start, 6);
          return `
            <button class="history-item" data-week="${key}">
              <span><strong>${shortDate(start)} - ${shortDate(end)} ${end.getFullYear()}</strong>${formatHours(summary.totalHours)} · ${summary.workdays.length} 天</span>
              <b class="history-money">${formatMoney(summary.totalPay)}</b>
            </button>
          `;
        })
        .join("")
    : `<div class="history-item"><span><strong>暂无记录</strong>完成一周后会显示在这里</span><b class="history-money">${formatMoney(0)}</b></div>`;

  renderMonths();
}

function renderMonths() {
  const months = new Map();
  Object.keys(state.records).forEach((key) => {
    const record = state.records[key];
    const result = calculate(record);
    const monthKey = key.slice(0, 7);
    const current = months.get(monthKey) || { pay: 0, hours: 0, days: 0 };
    current.pay += result.pay;
    current.hours += result.hours;
    current.days += record.isWorkday ? 1 : 0;
    months.set(monthKey, current);
  });

  const nowKey = dateKey(new Date()).slice(0, 7);
  const nowMonth = months.get(nowKey) || { pay: 0, hours: 0 };
  els.monthSummary.textContent = `本月 ${formatMoney(nowMonth.pay)} · ${formatHours(nowMonth.hours)}`;

  const rows = [...months.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .filter(([, item]) => item.hours > 0 || item.days > 0);

  els.monthGrid.innerHTML = rows.length
    ? rows
        .map(([key, item]) => `
          <div class="month-item">
            <span><strong>${key}</strong>${formatHours(item.hours)} · ${item.days} 天</span>
            <b class="history-money">${formatMoney(item.pay)}</b>
          </div>
        `)
        .join("")
    : `<div class="month-item"><span><strong>暂无月份数据</strong>开始记录后自动汇总</span><b class="history-money">${formatMoney(0)}</b></div>`;
}

function updateRecordFromInput(target) {
  const card = target.closest(".day-card");
  if (!card) return;

  const record = getRecord(card.dataset.key);
  if (target.classList.contains("is-workday")) record.isWorkday = target.checked;
  if (target.classList.contains("start-time")) record.start = target.value;
  if (target.classList.contains("end-time")) record.end = target.value;
  if (target.classList.contains("break-hours")) record.breakHours = Number(target.value);
  if (target.classList.contains("hourly-rate")) record.rate = Number(target.value);
  if (target.classList.contains("note")) record.note = target.value;

  persist();
  refreshDayCard(card, record);
  renderWeekStats();
  renderHistory();
}

els.daysGrid.addEventListener("input", (event) => updateRecordFromInput(event.target));
els.daysGrid.addEventListener("change", (event) => updateRecordFromInput(event.target));

els.prevWeek.addEventListener("click", () => {
  selectedWeekStart = addDays(selectedWeekStart, -7);
  renderWeek();
});

els.nextWeek.addEventListener("click", () => {
  selectedWeekStart = addDays(selectedWeekStart, 7);
  renderWeek();
});

els.currentWeek.addEventListener("click", () => {
  selectedWeekStart = startOfWeek(new Date(), state.settings.weekStart);
  renderWeek();
});

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.tabs.forEach((item) => item.classList.toggle("is-active", item === tab));
    els.views.forEach((view) => view.classList.toggle("is-active", view.id === `${tab.dataset.view}-view`));
  });
});

els.historyList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-week]");
  if (!item) return;
  selectedWeekStart = new Date(`${item.dataset.week}T00:00:00`);
  document.querySelector('[data-view="dashboard"]').click();
  renderWeek();
});

function markSettingsDirty(event) {
  if (event?.target?.closest(".cloud-box")) return;
  els.settingsSaveState.textContent = "有未保存的设置。";
}

function updateSettings(event) {
  event.preventDefault();

  const previousWeekStart = state.settings.weekStart;
  const previousDefaultRate = Number(state.settings.defaultRate);
  const previousDefaultBreak = Number(state.settings.defaultBreak);
  const previousAutoBreak = Boolean(state.settings.autoBreak);
  state.settings.defaultRate = Number(els.defaultRate.value);
  state.settings.currency = els.currency.value;
  state.settings.weekStart = Number(els.weekStart.value);
  state.settings.defaultBreak = Number(els.defaultBreak.value);
  state.settings.decimals = Number(els.decimals.value);
  state.settings.autoBreak = els.autoBreak.checked;
  state.settings.darkMode = els.darkMode.checked;

  if (previousWeekStart !== state.settings.weekStart) {
    selectedWeekStart = startOfWeek(selectedWeekStart, state.settings.weekStart);
  }

  updateCurrentWeekDefaults(previousDefaultRate, previousDefaultBreak, previousAutoBreak);

  persist();
  render();
  els.settingsSaveState.textContent = "设置已保存。";
}

function updateCurrentWeekDefaults(previousRate, previousBreak, previousAutoBreak) {
  weekDates().forEach((date) => {
    const record = getRecord(dateKey(date));
    const rateWasDefault = Number(record.rate) === previousRate;
    const breakWasDefault = previousAutoBreak
      ? Number(record.breakHours) === previousBreak
      : Number(record.breakHours) === 0;

    if (rateWasDefault) record.rate = Number(state.settings.defaultRate);
    if (breakWasDefault) {
      record.breakHours = state.settings.autoBreak ? Number(state.settings.defaultBreak) : 0;
    }
  });
}

els.settingsForm.addEventListener("input", markSettingsDirty);
els.settingsForm.addEventListener("change", markSettingsDirty);
els.settingsForm.addEventListener("submit", updateSettings);
els.cloudLogout.addEventListener("click", logoutFromCloud);
els.authForm.addEventListener("submit", submitAuth);
els.authTabs.forEach((tab) => {
  tab.addEventListener("click", () => updateAuthMode(tab.dataset.authMode));
});

showAuth();
updateAuthMode("login");
applyAuthPrefs();
initCloud();
