// ============================================================================
// 抖音倒计时提醒插件 —— 后台总指挥（background.js）
// ----------------------------------------------------------------------------
// 这个文件是整个插件的"大脑"，它不依附于任何网页，常驻浏览器后台。
// 职责：保管倒计时数据、监听标签页切换、决定什么时候计时/暂停/提醒。
//
// 为什么计时逻辑放这里而不是放在网页里？
// 因为网页会被刷新、会被关闭，放在网页里的数据会跟着消失；
// 而后台脚本 + chrome.storage 里的数据不随网页刷新而丢失。
// ============================================================================

// ----------------------------------------------------------------------------
// 一、常量与工具函数
// ----------------------------------------------------------------------------

// 默认一轮倒计时的时长：10 分钟。
// JS 里时间单位是毫秒：1 秒 = 1000 毫秒，所以 10 分钟 = 10 * 60 * 1000。
const DEFAULT_DURATION_MS = 10 * 60 * 1000;

// 判断一个标签页(tab)是不是抖音页面。
// tab 对象的 url 属性存放着这个标签页的网址。
function isDouyinTab(tab) {
  // tab.url 可能是 undefined（比如刚打开的空白页），
  // "tab.url && ..." 保证 url 不存在时直接得到 undefined 而不报错，
  // 最后用 Boolean() 把结果统一转成 true / false。
  return Boolean(tab.url && tab.url.includes("douyin.com"));
}

// 从 chrome.storage.local（浏览器提供的本地存储空间）里读出倒计时状态。
// 它就像一个小数据库，刷新网页、重启浏览器都不会丢。
async function getState() {
  // chrome.storage.local.get("timerState") 读出 key 为 timerState 的数据
  const data = await chrome.storage.local.get("timerState");
  // 如果之前从没存过，data.timerState 是 undefined，用 "|| null" 兜底成 null
  return data.timerState || null;
}

// 把倒计时状态写回 chrome.storage.local。
async function setState(next) {
  // chrome.storage.local.set({...}) 写入一个键值对
  await chrome.storage.local.set({ timerState: next });
}

// 读取用户设置（一轮的时长、声音开关）。
async function getSettings() {
  // 一次性把两个 key 都读出来
  const data = await chrome.storage.local.get(["durationMs", "soundEnabled"]);
  // 如果没设置过，就返回默认值：10 分钟、声音开
  return {
    durationMs: data.durationMs || DEFAULT_DURATION_MS,
    soundEnabled: data.soundEnabled !== false,
  };
}

// 计算"此刻"还剩多少毫秒。
// 状态里存的 remainingMs 是"上次开始计时时"的剩余量，
// 如果正在计时中，还要减去从 lastActiveAt 到现在已经流走的时间。
function computeRemainingMs(timer) {
  if (timer.state === "running") {
    // Date.now() 返回当前时间的时间戳（从 1970 年到现在的毫秒数）
    return Math.max(0, timer.remainingMs - (Date.now() - timer.lastActiveAt));
  }
  // 暂停或提醒中：直接返回存的剩余量
  return timer.remainingMs;
}

// ----------------------------------------------------------------------------
// 一点五、任务队列（串行化装置）—— 修复竞态的关键
// ----------------------------------------------------------------------------
// 问题回顾：关闭抖音页的瞬间，多个事件几乎同时触发多个 async 函数，
// 它们各自"读状态 → 计算 → 写回"，交错执行时后写的会把先写的覆盖掉
// （比如"清空"被"写入暂停态"覆盖，导致剩 6 分钟被记住）。
//
// 解决办法：所有会修改状态的操作都必须排队，一次只允许一个在跑。
// 原理类似 C++ 里给临界区上互斥锁，但 JS 单线程下用 Promise 链就能实现：
// 每个新任务都"接"在上一个任务完成之后才开始执行，物理上不可能交错。
//
// taskQueue 是"队尾指针"：永远指向队列中最后一个任务。
// 初始值是一个"立刻就完成"的空 Promise，代表队列一开始是空的。
let taskQueue = Promise.resolve();

// 把一个函数排进队列执行，返回它的 Promise（调用者可以选择等结果）。
function runSerialized(taskFn) {
  // .then(taskFn) 的意思：等队列里前面所有任务完成后，才轮到 taskFn 执行
  const result = taskQueue.then(taskFn);
  // 更新队尾指针，让下一个任务排在 result 之后
  // .catch(() => {}) 有两个作用：
  //   1. 吞掉上一个任务的报错，避免一个任务出错导致整条队列卡死
  //   2. 防止"未处理的 Promise 拒绝"警告
  taskQueue = result.catch(() => {});
  // 把当前任务的 Promise 返回给调用者
  return result;
}

// ----------------------------------------------------------------------------
// 二、核心动作：开始新一轮 / 定闹钟 / 暂停恢复 / 进入提醒
// ----------------------------------------------------------------------------

// 开始一轮全新的倒计时。
// durationMs：这轮的总时长；activeNow：此刻抖音页面是否在前台。
async function startNewRound(durationMs, activeNow) {
  // 构造倒计时状态对象：
  // remainingMs  —— 还剩多少毫秒
  // lastActiveAt —— 上次"从几点几分开始计时"的时间戳（暂停时为 null）
  // state        —— 三种状态：running 计时中 / paused 已暂停 / reminding 提醒中
  const timer = {
    durationMs: durationMs,
    remainingMs: durationMs,
    lastActiveAt: activeNow ? Date.now() : null,
    state: activeNow ? "running" : "paused",
  };
  // 存进浏览器本地存储（这就是"刷新不断"的秘密）
  await setState(timer);
  // 如果正在计时，就给"到点提醒"定一个精确的闹钟
  if (timer.state === "running") scheduleDeadline(timer);
  // 更新扩展图标上的剩余分钟数
  await updateBadge();
}

// 给"到点"定一个一次性闹钟。
// 为什么用 chrome.alarms 而不是 setInterval？
// 因为后台脚本空闲时会被浏览器"杀掉"省电，setInterval 会跟着死掉；
// 而 chrome.alarms 是浏览器级别的闹钟，到点会自动叫醒后台脚本，绝对可靠。
function scheduleDeadline(timer) {
  // 到点时刻 = 开始计时的时刻 + 剩余毫秒数
  const deadlineTime = timer.lastActiveAt + timer.remainingMs;
  // 创建名为 "deadline" 的闹钟，when 指定精确的触发时间点
  chrome.alarms.create("deadline", { when: deadlineTime });
}

// 检查当前"有没有任何一个处于焦点状态的浏览器窗口，其激活标签页是抖音"。
// 返回 true 表示"用户此刻正在看抖音"。
async function isDouyinActive() {
  // 拿到所有浏览器窗口，populate:true 表示连每个窗口里的标签页一起返回
  const windows = await chrome.windows.getAll({ populate: true });
  // for...of 遍历每个窗口
  for (const win of windows) {
    // 只有获得焦点的窗口才是用户正在操作的窗口，其他跳过
    if (!win.focused) continue;
    // 在这个窗口的所有标签页里，找出激活（显示在最前面）的那一个
    const activeTab = win.tabs.find((t) => t.active);
    // 如果这个激活的标签页是抖音 → 用户正在看抖音
    if (activeTab && isDouyinTab(activeTab)) return true;
  }
  // 遍历完都没找到 → 用户没在看抖音
  return false;
}

// 和上面类似，但返回那个"正在看的抖音标签页"对象本身（用于发消息）。
async function getActiveDouyinTab() {
  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    if (!win.focused) continue;
    const activeTab = win.tabs.find((t) => t.active);
    if (activeTab && isDouyinTab(activeTab)) return activeTab;
  }
  return null;
}

// 这是整个插件最核心的函数：根据"用户现在是否在看抖音"来决定计时走还是停。
// 每次标签页切换、窗口切换时都会调用它。
async function evaluateActivity() {
  // 先读出当前倒计时状态
  const timer = await getState();
  // 没有倒计时，或正处于提醒弹窗阶段 → 只更新图标就返回
  if (!timer || timer.state === "reminding") {
    // 特殊情况：提醒还没被确认，但用户正在看抖音 → 补发一次提醒
    // （应对"闹钟响的瞬间用户刚好切走了"的边角情况）
    if (timer && timer.state === "reminding") {
      const active = await isDouyinActive();
      if (active) {
        const settings = await getSettings();
        const tab = await getActiveDouyinTab();
        if (tab) sendToTab(tab.id, { type: "showReminder", soundEnabled: settings.soundEnabled });
      }
    }
    await updateBadge();
    return;
  }

  // 问一句：用户现在在看抖音吗？
  const active = await isDouyinActive();

  if (timer.state === "running" && !active) {
    // 情况一：本来在计时，但用户切走了 → 执行"暂停"
    const now = Date.now();
    // 把已经流走的时间从剩余时间里扣掉
    timer.remainingMs = Math.max(0, timer.remainingMs - (now - timer.lastActiveAt));
    // 清空"开始计时时刻"的标记
    timer.lastActiveAt = null;
    // 状态改为已暂停
    timer.state = "paused";
    // 保存
    await setState(timer);
    // 取消到点闹钟（否则切走了它还会响）
    await chrome.alarms.clear("deadline");
  } else if (timer.state === "paused" && active) {
    // 情况二：本来暂停着，用户切回抖音了 → 执行"继续"
    // 记下"现在"作为新的计时起点
    timer.lastActiveAt = Date.now();
    timer.state = "running";
    await setState(timer);
    // 重新定一个到点闹钟（终点 = 现在 + 剩余时间）
    scheduleDeadline(timer);
  }
  // 其他情况（running 且 active / paused 且 !active）说明状态没变化，什么都不用做

  // 最后刷新图标上的剩余分钟数
  await updateBadge();
}

// ============================================================================
// 唯一的状态核对入口：reconcile（合并了原来的 checkDouyinPresence）
// ----------------------------------------------------------------------------
// 修复竞态的第二招：单一入口。
// 之前 evaluateActivity 和 checkDouyinPresence 是两个独立函数，
// 关页瞬间它们各跑各的，交错写入互相覆盖。
// 现在所有事件都只触发这一个函数，它内部严格按顺序执行三步检查，
// 并且每一步都是"查完立刻用"，中间不会跳出去干别的。
// 再配合外层的 runSerialized 排队，物理上杜绝了交错。
// ============================================================================
async function reconcile() {
  // 第一步：数一数浏览器里还有几个抖音标签页
  // （这个查询需要 manifest 里的 host_permissions）
  const douyinTabs = await chrome.tabs.query({ url: "*://*.douyin.com/*" });

  if (douyinTabs.length === 0) {
    // 一个抖音页都没有了 → 清空倒计时状态（需求：关闭网页计时停止）
    // 先读后写：只有状态确实还存在时才执行清空，避免重复无效写入
    const timer = await getState();
    if (timer) {
      // 写入 null 表示"没有倒计时"
      await setState(null);
      // 闹钟也取消掉
      await chrome.alarms.clear("deadline");
    }
    await updateBadge();
    // ★ 关键：清空之后立刻 return 返回。
    // 绝不允许执行流继续往下走到任何"写状态"的代码路径，
    // 这就是"写前复查"的保险——即使有旧代码路径意外到达这里，
    // 也不可能把已清空的状态再覆盖回去。
    return;
  }

  // 第二步：还有抖音页。看看倒计时是否存在
  const timer = await getState();
  if (!timer) {
    // 之前被清空过（用户关掉又重新打开了抖音）→ 重新开始一轮
    // 需求：再次打开时重新计时。用的时长是用户上次设定的时长
    const settings = await getSettings();
    await startNewRound(settings.durationMs, await isDouyinActive());
    return;
  }

  // 第三步：倒计时还在 → 核对计时/暂停状态是否正确
  await evaluateActivity();
}

// 向某个标签页里的 content script 发消息，出错也不抛异常（比如页面刚刷新还没准备好）。
function sendToTab(tabId, message) {
  // chrome.tabs.sendMessage 向指定标签页发送消息，.catch() 吞掉可能的发送失败
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ----------------------------------------------------------------------------
// 三、到点提醒
// ----------------------------------------------------------------------------

// 时间到！进入"提醒中"状态。
async function enterReminding() {
  const timer = await getState();
  // 只处理正在计时的情况，防止重复触发
  if (!timer || timer.state !== "running") return;

  // 剩余时间归零，暂停计时标记
  timer.remainingMs = 0;
  timer.lastActiveAt = null;
  // 状态改为提醒中
  timer.state = "reminding";
  await setState(timer);
  // 到点闹钟已完成使命，清掉
  await chrome.alarms.clear("deadline");
  // 图标显示感叹号提醒
  await updateBadge();

  // 读声音设置
  const settings = await getSettings();
  // 找到用户正在看的那个抖音标签页
  const tab = await getActiveDouyinTab();
  if (tab) {
    // 给它注入的 content script 发消息："显示提醒弹窗+放声音"
    sendToTab(tab.id, { type: "showReminder", soundEnabled: settings.soundEnabled });
  }
}

// 修改剩余时间（加时/减时）。deltaMs 正数加时间，负数减时间。
async function adjustRemaining(deltaMs) {
  const timer = await getState();
  // 没有倒计时、或正处于提醒弹窗阶段时不处理
  if (!timer || timer.state === "reminding") return;

  if (timer.state === "running") {
    // 计时中修改：先算出此刻真实剩余量，加上增量，最短留 1 秒
    timer.remainingMs = Math.max(1000, computeRemainingMs(timer) + deltaMs);
    // 修改后要以"现在"为新起点重新计时
    timer.lastActiveAt = Date.now();
    await setState(timer);
    // 闹钟也要按新的剩余时间重定
    scheduleDeadline(timer);
  } else {
    // 暂停中修改：直接改存量即可
    timer.remainingMs = Math.max(1000, timer.remainingMs + deltaMs);
    await setState(timer);
  }
  await updateBadge();
}

// ----------------------------------------------------------------------------
// 四、图标显示
// ----------------------------------------------------------------------------

// 更新浏览器右上角扩展图标上的角标文字（badge）。
async function updateBadge() {
  const timer = await getState();
  // 默认：不显示任何文字
  let text = "";
  // 默认：抖音红的角标底色
  let color = "#FE2C55";

  if (timer && timer.state === "running") {
    // 计时中：显示剩余分钟数，向上取整（比如还剩 4 分 20 秒显示 5）
    const minutes = Math.ceil(computeRemainingMs(timer) / 60000);
    text = String(minutes);
  } else if (timer && timer.state === "paused") {
    // 暂停中：显示双竖线（暂停符号）
    text = "||";
    // 灰色表示"没在计时"
    color = "#888888";
  } else if (timer && timer.state === "reminding") {
    // 提醒中：显示感叹号
    text = "!";
    // 醒目的红色
    color = "#E60000";
  }

  // 把文字和颜色真正写到扩展图标上
  await chrome.action.setBadgeText({ text: text });
  await chrome.action.setBadgeBackgroundColor({ color: color });
}

// ----------------------------------------------------------------------------
// 五、事件监听：插件"感知世界"的方式
// ----------------------------------------------------------------------------

// 用户切换了标签页（在同一个窗口里点了另一个标签）→ 核对计时状态
// 注意：统一通过 runSerialized 排队执行，并发事件不会交错
chrome.tabs.onActivated.addListener(() => {
  runSerialized(reconcile);
});

// 某个标签页发生了变化（打开了新网址、加载完成等）→ 核对抖音页的存在
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 只在网址变化或加载完成时才检查，避免过于频繁
  if (changeInfo.url || changeInfo.status === "complete") {
    runSerialized(reconcile);
  }
});

// 某个标签页被关闭 → 核对抖音页是否全军覆没
// （修复前：它和 onActivated 触发的两个函数并发交错，引发竞态；
//   修复后：两个事件都排进同一条队列，一前一后顺序执行）
chrome.tabs.onRemoved.addListener(() => {
  runSerialized(reconcile);
});

// 焦点切换到了别的窗口/别的软件 → 也核对计时状态
// （额外福利：不仅切网页会暂停，切到微信、游戏等其他软件也会暂停）
chrome.windows.onFocusChanged.addListener(() => {
  runSerialized(reconcile);
});

// 闹钟响了 → 处理到点逻辑（enterReminding 会写状态，同样排队防交错）
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "deadline") {
    // 到点闹钟：先确认状态还在计时
    const timer = await getState();
    if (!timer || timer.state !== "running") return;
    // 算出理论到点时刻
    const deadline = timer.lastActiveAt + timer.remainingMs;
    if (Date.now() >= deadline) {
      // 真到点了 → 进入提醒（排进队列执行）
      await runSerialized(enterReminding);
    } else {
      // 还没到（中途调整过时间）→ 重新定一个闹钟
      scheduleDeadline(timer);
    }
  } else if (alarm.name === "badgeTick") {
    // 心跳闹钟：每 30 秒刷新一次图标上的分钟数
    await updateBadge();
  }
});

// 收到来自弹窗(popup)或页面(content)的消息 → 分发处理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 用立即执行的 async 函数包一层，这样才能用 await
  (async () => {
    if (message.type === "getStatus") {
      // 弹窗/页面询问当前状态 → 把算好的状态回给它
      const timer = await getState();
      const settings = await getSettings();
      sendResponse({
        state: timer ? timer.state : "idle",
        remainingMs: timer ? computeRemainingMs(timer) : 0,
        durationMs: settings.durationMs,
        soundEnabled: settings.soundEnabled,
      });
    } else if (message.type === "startTimer") {
      // 用户在弹窗里设定了新时长并开始
      // 先记住这个时长（关闭重开后自动重开新一轮时用它）
      await chrome.storage.local.set({ durationMs: message.durationMs });
      // 开始新一轮；是否马上计时取决于现在是否在看抖音
      // （startNewRound 会写状态，排队执行；箭头函数标 async 才能用 await）
      await runSerialized(async () => startNewRound(message.durationMs, await isDouyinActive()));
      sendResponse({ ok: true });
    } else if (message.type === "adjustRemaining") {
      // 用户调整了剩余时间（adjustRemaining 会写状态，排队执行）
      await runSerialized(() => adjustRemaining(message.deltaMs)); // 排队执行，箭头函数本身不需要 async
      sendResponse({ ok: true });
    } else if (message.type === "setSoundEnabled") {
      // 用户切换了声音开关
      await chrome.storage.local.set({ soundEnabled: message.value });
      sendResponse({ ok: true });
    } else if (message.type === "reminderConfirm") {
      // 用户在提醒弹窗上点了"确认" → 自动开始下一轮（需求：自动循环同时长）
      // （startNewRound 会写状态，排队执行）
      const settings = await getSettings();
      await runSerialized(async () => startNewRound(settings.durationMs, await isDouyinActive()));
      sendResponse({ ok: true });
    } else {
      // 未知消息类型
      sendResponse({ ok: false });
    }
  })();
  // 返回 true 告诉浏览器"我会异步回复"，这是 Chrome 消息机制的规定写法
  return true;
});

// ----------------------------------------------------------------------------
// 六、启动初始化
// ----------------------------------------------------------------------------

// 创建一个每 30 秒响一次的"心跳"闹钟，专门用来刷新图标上的分钟数。
// 闹钟名相同会自动覆盖，所以重复创建也没关系。
// （Chrome 规定闹钟最小间隔是 0.5 分钟 = 30 秒）
chrome.alarms.create("badgeTick", { periodInMinutes: 0.5 });

// 后台脚本每次被唤醒时（浏览器重启、闹钟叫醒、事件触发），
// 都核对一遍抖音页面的存在性，保证状态和现实一致。
// （同样排队执行，和事件触发进入的是同一条队列）
runSerialized(reconcile);
