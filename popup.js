// ============================================================================
// 抖音倒计时提醒插件 —— 设置弹窗逻辑（popup.js）
// ----------------------------------------------------------------------------
// 用户点击浏览器右上角扩展图标时，popup.html 界面出现，这个脚本开始工作。
// 职责：展示实时状态、把用户的每个操作（设时长/调整/开关声音）转发给后台。
// ============================================================================

// ----------------------------------------------------------------------------
// 一、把 HTML 里要用到的元素抓到 JS 里（通过 id 查找）
// ----------------------------------------------------------------------------

// 状态文字元素（显示"计时中/已暂停"等）
const stateLabel = document.getElementById("state-label");
// 剩余时间大数字元素
const remainingEl = document.getElementById("remaining");
// 自定义分钟数的输入框
const customMinutesInput = document.getElementById("custom-minutes");
// 自定义"开始"按钮
const customStartBtn = document.getElementById("custom-start");
// 声音开关的勾选框
const soundToggle = document.getElementById("sound-toggle");

// ----------------------------------------------------------------------------
// 二、工具函数：把毫秒格式化成人类看得懂的时间
// ----------------------------------------------------------------------------

// 例如 594000 毫秒 → "09:54"；超过 1 小时则显示 "1:05:00"
function formatTime(ms) {
  // 毫秒换算成总秒数（向下取整，Math.max(0,...) 防止出现负数）
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  // 总秒数里含有几个完整小时
  const h = Math.floor(totalSeconds / 3600);
  // 剩下的秒数里有几个完整分钟
  const m = Math.floor((totalSeconds % 3600) / 60);
  // 最后剩下的秒数
  const s = totalSeconds % 60;
  // padStart(2, "0") 把 9 变成 "09"，保证两位对齐
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  // 超过 1 小时的格式是 时:分:秒，否则 分:秒
  if (h > 0) return h + ":" + mm + ":" + ss;
  return mm + ":" + ss;
}

// ----------------------------------------------------------------------------
// 三、刷新界面：向后台要一份最新状态，然后更新显示
// ----------------------------------------------------------------------------

async function refresh() {
  // 向后台发一条 {type:"getStatus"} 消息，await 等后台回复状态对象
  const status = await chrome.runtime.sendMessage({ type: "getStatus" });
  // 后台没回复（极端情况）就放弃本轮刷新
  if (!status) return;

  // 根据状态值显示对应的中文说明
  if (status.state === "running") {
    stateLabel.textContent = "计时中（抖音在前台）";
  } else if (status.state === "paused") {
    stateLabel.textContent = "已暂停（不在抖音页面）";
  } else if (status.state === "reminding") {
    stateLabel.textContent = "时间到，提醒中！";
  } else {
    // idle：还没有倒计时
    stateLabel.textContent = "未开始";
  }

  // 更新剩余时间大数字；未开始时显示占位符
  remainingEl.textContent =
    status.state === "idle" ? "--:--" : formatTime(status.remainingMs);

  // 把声音开关的勾选状态同步成后台存的值
  soundToggle.checked = status.soundEnabled;
}

// 每 500 毫秒（半秒）自动刷新一次界面，这样剩余时间是"活的"
setInterval(refresh, 500);
// 弹窗刚打开时立刻先刷新一次，不用等半秒
refresh();

// ----------------------------------------------------------------------------
// 四、预设档位按钮：5/10/15/30/60 分钟
// ----------------------------------------------------------------------------

// querySelectorAll("button.preset") 找到所有 class 含 preset 的按钮
// forEach 给每个按钮都挂上点击监听
document.querySelectorAll("button.preset").forEach(function (btn) {
  // 点击某个按钮时执行：
  btn.addEventListener("click", async function () {
    // dataset.min 读的是 HTML 里写死的 data-min 属性值（字符串）
    // parseInt(..., 10) 把 "15" 这样的字符串转成数字 15
    const minutes = parseInt(btn.dataset.min, 10);
    // 告诉后台：开始一个 minutes 分钟的倒计时（分钟 × 60 × 1000 = 毫秒）
    await chrome.runtime.sendMessage({
      type: "startTimer",
      durationMs: minutes * 60 * 1000,
    });
    // 立刻刷新界面看效果
    refresh();
  });
});

// ----------------------------------------------------------------------------
// 五、自定义开始按钮
// ----------------------------------------------------------------------------

customStartBtn.addEventListener("click", async function () {
  // 读取输入框里的字符串并转成数字
  const minutes = parseInt(customMinutesInput.value, 10);
  // 输入无效（空/非数字/小于等于 0）就不处理
  if (!minutes || minutes <= 0) return;
  // 同样通知后台开始
  await chrome.runtime.sendMessage({
    type: "startTimer",
    durationMs: minutes * 60 * 1000,
  });
  refresh();
});

// ----------------------------------------------------------------------------
// 六、调整剩余时间按钮：-5 / -1 / +1 / +5 分钟
// ----------------------------------------------------------------------------

document.querySelectorAll("button.adjust").forEach(function (btn) {
  btn.addEventListener("click", async function () {
    // data-delta 属性存的是增减的分钟数（-5、-1、1、5）
    const deltaMinutes = parseInt(btn.dataset.delta, 10);
    // 告诉后台调整剩余时间（deltaMs 正数加时、负数减时）
    await chrome.runtime.sendMessage({
      type: "adjustRemaining",
      deltaMs: deltaMinutes * 60 * 1000,
    });
    refresh();
  });
});

// ----------------------------------------------------------------------------
// 七、声音开关
// ----------------------------------------------------------------------------

// change 事件：勾选框的选中状态发生变化时触发
soundToggle.addEventListener("change", async function () {
  // 把新的开关状态（checked 是 true/false）告诉后台
  await chrome.runtime.sendMessage({
    type: "setSoundEnabled",
    value: soundToggle.checked,
  });
});
