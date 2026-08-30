// ============================================================================
// 抖音倒计时提醒插件 —— 页面内提醒（content.js）
// ----------------------------------------------------------------------------
// 这个文件会被"注入"到每一个抖音网页里，和网页融为一体。
// 职责只有一件事：收到后台发来的"时间到"消息后，
// 在抖音页面上弹出全屏提醒遮罩 + 循环播放提示音，直到用户点确认。
// ============================================================================

// 保存"循环响铃"的定时器编号；null 表示当前没在响铃。
// （JS 的 setInterval 会返回一个编号，拿着它才能用 clearInterval 停掉）
let soundLoopId = null;

// ----------------------------------------------------------------------------
// 一、提示音：用 Web Audio API 现场合成一声"叮"，不需要任何音频文件
// ----------------------------------------------------------------------------

function playBeep() {
  // 整个用 try...catch 包住：万一浏览器不让播放，也不让插件报错崩溃
  try {
    // AudioContext 是浏览器提供的"音频工具箱"，先创建一个
    const ctx = new AudioContext();
    // 振荡器(oscillator)：能发出指定频率声音的"电子蜂鸣器"
    const osc = ctx.createOscillator();
    // 音量控制器(gain)：调节声音大小
    const gain = ctx.createGain();
    // 把蜂鸣器接到音量控制器，再接到扬声器（destination），像接水管一样
    osc.connect(gain);
    gain.connect(ctx.destination);
    // 音色选 sine（正弦波），听起来是最柔和的"嘟——"声
    osc.type = "sine";
    // 频率 880 赫兹，比标准音 A(440Hz) 高一个八度，清脆不刺耳
    osc.frequency.value = 880;
    // 初始音量 0.3（30% 大小）
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    // 让音量在 0.8 秒内平滑衰减到接近 0，形成"叮——"的渐弱尾音
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    // 现在开始发声
    osc.start();
    // 0.8 秒后停止发声
    osc.stop(ctx.currentTime + 0.8);
    // 1 秒后彻底关闭音频工具箱，释放资源
    setTimeout(() => ctx.close(), 1000);
  } catch (e) {
    // 播放失败就安静地跳过（比如浏览器自动播放策略拦截了）
  }
}

// ----------------------------------------------------------------------------
// 二、提醒弹窗：全屏遮罩 + 中央卡片 + 确认按钮
// ----------------------------------------------------------------------------

// 显示提醒弹窗。soundEnabled 为 false 时只弹窗不出声（需求：声音可关闭）。
function showReminder(soundEnabled) {
  // 如果弹窗已经在屏幕上了，不要重复创建
  if (document.getElementById("dcy-overlay")) return;

  // 创建最外层的全屏遮罩层（一个 div 方块元素）
  const overlay = document.createElement("div");
  // 给它一个 id，方便上面那行代码判断"是否已存在"
  overlay.id = "dcy-overlay";

  // 中间的白色提醒卡片（样式全写在 content.css 里）
  const card = document.createElement("div");
  card.className = "dcy-card";
  // innerHTML 一次性写入卡片内部的全部内容（表情、标题、说明、按钮）
  card.innerHTML =
    '<div class="dcy-emoji">⏰</div>' + // 大闹钟表情
    '<div class="dcy-title">时间到！</div>' + // 醒目标题
    '<div class="dcy-text">本轮倒计时结束了，起来活动一下吧～</div>' + // 提示语 1
    '<div class="dcy-text">点击按钮确认，将自动开始下一轮倒计时</div>'; // 提示语 2

  // 创建"确认"按钮
  const confirmBtn = document.createElement("button");
  // 给按钮加样式类名
  confirmBtn.className = "dcy-btn";
  // 按钮上显示的文字
  confirmBtn.textContent = "确认，开始下一轮";
  // 监听点击事件：用户点下按钮时执行花括号里的代码
  confirmBtn.addEventListener("click", () => {
    // 停止循环响铃
    stopSoundLoop();
    // 把遮罩从页面上移除
    overlay.remove();
    // 通知后台："用户已确认" → 后台会自动开始下一轮
    chrome.runtime.sendMessage({ type: "reminderConfirm" });
  });

  // 把按钮放进卡片
  card.appendChild(confirmBtn);
  // 把卡片放进遮罩
  overlay.appendChild(card);
  // 把遮罩放进抖音页面（document.body 是网页的根容器）
  document.body.appendChild(overlay);

  // 如果声音开关是开的：立刻响一声，然后每 3 秒再响一声（持续提醒直到确认）
  if (soundEnabled) {
    playBeep();
    soundLoopId = setInterval(playBeep, 3000);
  }
}

// 停止循环响铃。
function stopSoundLoop() {
  // 只有定时器存在时才需要停
  if (soundLoopId !== null) {
    // clearInterval 按编号取消循环
    clearInterval(soundLoopId);
    // 恢复成"没在响"的标记
    soundLoopId = null;
  }
}

// ----------------------------------------------------------------------------
// 三、消息接收：两种场景
// ----------------------------------------------------------------------------

// 场景 A：插件正在运行时，后台发来"时间到"的消息。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 只处理 showReminder（显示提醒）这一种消息
  if (message.type === "showReminder") {
    // 弹窗（是否出声由后台传来的开关决定）
    showReminder(message.soundEnabled);
    // 回复后台"收到"
    sendResponse({ ok: true });
  }
});

// 场景 B：这个抖音页面刚被打开/刚被刷新。
// 插件自己刚注入进来，主动问后台"现在是什么状态"。
// 目的：如果用户在提醒弹窗没确认时刷新了页面，刷新后要重新把弹窗弹出来。
chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
  // chrome.runtime.lastError 存在说明后台暂时联系不上（比如刚装好插件），直接放弃
  if (chrome.runtime.lastError) return;
  // 后台回复说"正处于提醒中" → 重新显示提醒弹窗
  if (response && response.state === "reminding") {
    showReminder(response.soundEnabled);
  }
});
